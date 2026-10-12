"""Run the same security and RAG suite against disposable PostgreSQL, Qdrant and MinIO.
Requires a running Docker daemon. Credentials are generated in temporary private files.
No production project or persistent Docker volume is touched.
"""
import concurrent.futures
import json
import os
import secrets
import shutil
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def run(args, **kwargs):
    return subprocess.run(args, check=True, text=True, timeout=600, **kwargs)


def port(name, number):
    output = run(["docker", "port", name, f"{number}/tcp"], capture_output=True).stdout.strip()
    return int(output.splitlines()[0].rsplit(":", 1)[1])


def verify():
    suffix = secrets.token_hex(4)
    postgres = f"atlas-test-pg-{suffix}"
    minio = f"atlas-test-s3-{suffix}"
    qdrant = f"atlas-test-vector-{suffix}"
    password = secrets.token_hex(24)
    storage_secret = secrets.token_hex(24)
    with tempfile.TemporaryDirectory(prefix="atlas-services-") as folder:
        folder = Path(folder)
        pg_env = folder / "postgres.env"
        pg_env.write_text(f"POSTGRES_USER=atlas\nPOSTGRES_DB=atlas\nPOSTGRES_PASSWORD={password}\n")
        s3_env = folder / "minio.env"
        s3_env.write_text(f"MINIO_ROOT_USER=atlas-test-root\nMINIO_ROOT_PASSWORD={storage_secret}\n")
        pg_env.chmod(0o600)
        s3_env.chmod(0o600)
        try:
            print("Starting disposable PostgreSQL, Qdrant and MinIO…", flush=True)
            commands = [
                ["docker", "run", "-d", "--name", qdrant, "-p", "127.0.0.1::6333", "qdrant/qdrant:v1.15.4"],
                ["docker", "run", "-d", "--name", postgres, "--env-file", str(pg_env), "-p", "127.0.0.1::5432", "postgres:17-alpine"],
                ["docker", "run", "-d", "--name", minio, "--env-file", str(s3_env), "-p", "127.0.0.1::9000", "minio/minio:RELEASE.2025-09-07T16-13-09Z", "server", "/data"],
            ]
            with concurrent.futures.ThreadPoolExecutor() as executor:
                futures = [executor.submit(run, command, stdout=subprocess.DEVNULL) for command in commands]
                for future in futures:
                    future.result()
            vector_port = port(qdrant, 6333)
            pg_port = port(postgres, 5432)
            s3_port = port(minio, 9000)
            for _ in range(60):
                pg_ready = subprocess.run(["docker", "exec", postgres, "pg_isready", "-U", "atlas", "-d", "atlas"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
                try:
                    with urllib.request.urlopen(f"http://127.0.0.1:{s3_port}/minio/health/live", timeout=2) as response:
                        s3_ready = response.status == 200
                except Exception:
                    s3_ready = False
                try:
                    with urllib.request.urlopen(f"http://127.0.0.1:{vector_port}/readyz", timeout=2) as response:
                        vector_ready = response.status == 200
                except Exception:
                    vector_ready = False
                if pg_ready and s3_ready and vector_ready:
                    break
                time.sleep(1)
            else:
                raise RuntimeError("Verification services did not become ready")
            run(["docker", "run", "--rm", "--network", f"container:{minio}", "--env-file", str(s3_env), "--entrypoint", "/bin/sh", "minio/mc:RELEASE.2025-08-13T08-35-41Z", "-c", 'mc alias set local http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc mb local/atlas-test'])
            environment = dict(os.environ)
            environment.update({"ATLAS_TEST_QDRANT_URL": f"http://127.0.0.1:{vector_port}","ATLAS_TEST_DATABASE_URL": f"postgresql://atlas:{password}@127.0.0.1:{pg_port}/atlas", "ATLAS_TEST_S3_ENDPOINT": f"http://127.0.0.1:{s3_port}", "ATLAS_TEST_S3_ACCESS_KEY": "atlas-test-root", "ATLAS_TEST_S3_SECRET_KEY": storage_secret})
            cargo = shutil.which("cargo") or str(Path.home() / ".cargo/bin/cargo")
            print("Running security, indexing and multimodal tests against real services…", flush=True)
            run([cargo, "test", "--workspace", "--locked"], cwd=ROOT, env=environment)
            result = {"database": "PostgreSQL 17", "vectors": "Qdrant 1.15.4", "storage": "MinIO S3", "result": "passed", "suite": "backend/tests/security.rs", "time_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
            (ROOT / "docs/service-verification.json").write_text(json.dumps(result, indent=2) + "\n")
        finally:
            subprocess.run(["docker", "rm", "-f", postgres, minio, qdrant], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            print("Disposable verification containers removed.", flush=True)


if __name__ == "__main__":
    verify()
