#!/usr/bin/env python3
"""Diagnose/recover only the new memory networks from a server console.

Default: read-only diagnosis. Pass --recover only to stop/remove this release's
memory containers and conflicting networks. Existing application/data volumes
are never removed. Recreate providers using the explicit-subnet overlay later.
"""

import argparse
import ipaddress
import json
import subprocess

PROJECT = "atlas-knowledge"
SERVICES = {"memory-core", "memory-knowledge", "memory-gateway"}
NETWORKS = [f"{PROJECT}_memory-private", f"{PROJECT}_memory-egress"]


def output(*args):
    return subprocess.check_output(args, text=True).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--client-ip", default="172.27.238.192")
    parser.add_argument("--recover", action="store_true")
    args = parser.parse_args()
    address = ipaddress.ip_address(args.client_ip)
    conflicting = []
    for name in NETWORKS:
        result = subprocess.run(
            ["docker", "network", "inspect", name], capture_output=True, text=True
        )
        if result.returncode:
            continue
        network = json.loads(result.stdout)[0]
        if network.get("Labels", {}).get("com.docker.compose.project") != PROJECT:
            raise SystemExit("Refusing network with unexpected project identity")
        subnets = [item["Subnet"] for item in network["IPAM"]["Config"]]
        overlap = any(address in ipaddress.ip_network(subnet) for subnet in subnets)
        print(json.dumps({"network": name, "subnets": subnets, "vpn_overlap": overlap}))
        if overlap:
            conflicting.append(network)
    print(output("ip", "route", "get", str(address)))
    if not args.recover:
        return
    if not conflicting:
        raise SystemExit("No confirmed overlap; no containers or networks changed")
    containers = {}
    for service in SERVICES:
        name = f"{PROJECT}-{service}-1"
        result = subprocess.run(
            ["docker", "inspect", name], capture_output=True, text=True
        )
        if result.returncode:
            continue
        container = json.loads(result.stdout)[0]
        labels = container["Config"].get("Labels", {})
        if (
            labels.get("com.docker.compose.project") != PROJECT
            or labels.get("com.docker.compose.service") != service
        ):
            raise SystemExit("Refusing container with unexpected service identity")
        containers[container["Id"]] = name
    for network in conflicting:
        if set(network.get("Containers", {})) - set(containers):
            raise SystemExit("Conflicting network has other containers; no changes made")
    for name in containers.values():
        subprocess.run(["docker", "stop", "-t", "20", name], check=True)
        subprocess.run(["docker", "rm", name], check=True)
    for network in conflicting:
        subprocess.run(["docker", "network", "rm", network["Name"]], check=True)
    print("Removed only new memory containers/conflicting networks; all volumes retained")
    print(output("ip", "route", "get", str(address)))


if __name__ == "__main__":
    main()
