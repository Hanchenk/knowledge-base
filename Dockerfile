FROM node:22-bookworm-slim AS web
WORKDIR /build/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend ./
RUN npm run build

FROM rust:1.99-bookworm AS rust
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY backend ./backend
COPY docs ./docs
RUN cargo build --release --locked

FROM node:22-bookworm-slim AS agent
WORKDIR /build/agent-runtime
COPY agent-runtime/package*.json ./
RUN npm ci --ignore-scripts
COPY agent-runtime/*.mjs ./

FROM docker:29-cli AS docker-cli

FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 git && rm -rf /var/lib/apt/lists/*
RUN groupadd --gid 10001 atlas && useradd --uid 10001 --gid atlas --create-home atlas
WORKDIR /app
COPY processor/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir --require-hashes -r /tmp/requirements.txt
COPY --from=rust /build/target/release/atlas-server /usr/local/bin/atlas-server
COPY --from=web /build/frontend/dist ./frontend/dist
COPY --from=agent /usr/local/bin/node /usr/local/bin/node
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=agent /build/agent-runtime ./agent-runtime
COPY processor/extract.py processor/tables.py ./processor/
RUN mkdir -p /app/data/files /app/data/harness && chown -R atlas:atlas /app
USER atlas
ENV BIND_ADDRESS=0.0.0.0:8000 PROCESSOR_PYTHON=/usr/local/bin/python PROCESSOR_SCRIPT=/app/processor/extract.py
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=3)"
ENTRYPOINT ["atlas-server"]
