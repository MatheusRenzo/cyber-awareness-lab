# Cyber Awareness Lab

Painel web em **Flask** para ver coletas (foto, GPS, dispositivos agrupados) e link **`/b`** para o telemóvel enviar dados. Os dados ficam em **SQLite** (ficheiro `instance/lab.sqlite`) ou em **PostgreSQL** se configurares `DATABASE_URL` ou as variáveis `POSTGRES_*` (ver `.env.example`).

## Requisitos

- Python 3.10+
- `pip install -r requirements.txt`

## Correr em local

```bash
cd cyber-awareness-lab
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python app.py
```

Por omissão o serviço fica em `http://0.0.0.0:8787`. Abre **`/`** ou **`/ver`** para o painel; **`/b`** para o fluxo de envio no telemóvel (HTTPS recomendado — podes usar o script `scripts/cloudflare-quick-tunnel.sh` com `cloudflared`).

## Produção (Gunicorn)

```bash
gunicorn -w 2 -b 0.0.0.0:8787 wsgi:app
```

## Licença

MIT — ver ficheiro `LICENSE`.
