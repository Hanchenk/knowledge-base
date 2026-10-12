#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -f .env ]; then cp .env.example .env; fi
if ! command -v cargo >/dev/null; then export PATH="$HOME/.cargo/bin:$PATH"; fi
if ! command -v cargo >/dev/null; then echo 'Install Rust using rustup, then rerun this script.' >&2; exit 1; fi
command -v uv >/dev/null || { echo 'Install uv to prepare the document processor.' >&2; exit 1; }
uv sync --project processor --frozen
npm ci --prefix agent-runtime --ignore-scripts
npm ci --prefix frontend
cargo build --locked
pids=()
cleanup() { for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM
target/debug/atlas-server &
pids+=("$!")
npm run dev --prefix frontend &
pids+=("$!")
wait
