#!/usr/bin/env bash
# Túnel rápido Cloudflare → app local na porta 8787 (HTTPS público trycloudflare.com).
# Requisitos: cloudflared no PATH; Flask/Gunicorn já rodando em 127.0.0.1:8787

set -euo pipefail
UPSTREAM="${1:-http://127.0.0.1:8787}"
echo "Subindo túnel para ${UPSTREAM} …"
exec cloudflared tunnel --no-autoupdate --url "${UPSTREAM}"
