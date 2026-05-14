<div align="center">

# Cyber Awareness Lab

**Laboratório educativo** em Python/Flask para **consciencialização em cibersegurança**: ver o que o **navegador e o servidor** expõem (metadados HTTP, impressão leve do dispositivo, permissões como câmara/GPS em contexto controlado) e reunir **coletas** num painel web.

[![Python](https://img.shields.io/badge/Python-3.10%2B-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![Flask](https://img.shields.io/badge/Flask-3.1-000000?logo=flask&logoColor=white)](https://flask.palletsprojects.com/)
[![Gunicorn](https://img.shields.io/badge/Gunicorn-26-499848?logo=gunicorn&logoColor=white)](https://gunicorn.org/)
[![SQLite](https://img.shields.io/badge/SQLite-padrão-003B57?logo=sqlite&logoColor=white)](https://www.sqlite.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-opcional-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![Repo](https://img.shields.io/badge/GitHub-cyber--awareness--lab-181717?logo=github)](https://github.com/MatheusRenzo/cyber-awareness-lab)

*Uso ético e legal apenas — ambiente de formação ou com consentimento explícito.*

</div>

---

## O que é (e o que não é)

| É | Não é |
|---|--------|
| Painel + API para **ensaiar** o que um site “vê” e o que um fluxo `/b` pode recolher com permissões do browser | Ferramenta de intrusão ou OSINT contra terceiros sem autorização |
| Código aberto para **aulas**, demos e **awareness** de superfície de ataque | Produto “anónimo” pronto para abuso |

---

## Funcionalidades

- **Painel** (`/` ou `/ver`): lista de coletas agrupadas por “dispositivo” (hash leve a partir de fingerprint + UA, etc.), foto em base64, GPS, chips de estado (HTTPS, câmara, GPS), JSON por captura.
- **Beacon** (`/b`): página mínima que pede permissões e envia o pacote para o servidor (precisa de **HTTPS** para câmara/GPS na maioria dos browsers).
- **Nomes amigáveis**: query `?nome=` no `/b` ou campo “Nome no painel” + **Guardar** (persistente na BD).
- **Apagar tudo**: botão **«Apagar todas as coletas…»** + `POST /api/lab-reset` com confirmação JSON (irreversível).
- **Proteção opcional do painel**: `LAB_PANEL_PASSWORD` → login em `/lab-login`, sessão assinada com `FLASK_SECRET_KEY`. O link **`/b`** e **`GET /api/server-meta`** + **`POST /api/lab-report`** permanecem **públicos** para o alvo não precisar da senha do operador.
- **Persistência**: **SQLite** (`instance/lab.sqlite`) por omissão; **PostgreSQL** se definires `DATABASE_URL` ou `POSTGRES_*`.
- **Proxy**: `TRUST_PROXY` + opcional `TRUST_X_FORWARDED_PREFIX` para correr atrás de nginx/Traefik com prefixo.

---

## Requisitos

- **Python 3.10+**
- `pip` (ou `uv pip`)

Para **túnel HTTPS rápido** (câmara/GPS no telemóvel):

- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/) (`cloudflared` no `PATH`)

---

## Instalação

```bash
git clone https://github.com/MatheusRenzo/cyber-awareness-lab.git
cd cyber-awareness-lab

python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

Copia variáveis de ambiente (opcional):

```bash
cp .env.example .env
# Edita .env — nunca commites este ficheiro (já está no .gitignore).
```

---

## Correr em desenvolvimento

```bash
source .venv/bin/activate
python app.py
```

Por omissão o app escuta em **`http://0.0.0.0:8787`**.

| URL | Descrição |
|-----|------------|
| **`/`** ou **`/ver`** | Painel de coletas |
| **`/b`** | Página de envio (beacon) |
| **`/lab-login`** | Login (só se `LAB_PANEL_PASSWORD` estiver definida) |

---

## Produção (Gunicorn)

```bash
source .venv/bin/activate
gunicorn -w 2 -b 127.0.0.1:8787 --access-logfile - --error-logfile - wsgi:app
```

### systemd (Linux)

No repositório existe um exemplo de unidade com **`EnvironmentFile`** para carregar `.env` (senha do painel, segredo de sessão, etc.):

```bash
sudo cp deploy/cyber-awareness-lab.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cyber-awareness-lab.service
sudo journalctl -u cyber-awareness-lab.service -f
```

Ajusta `WorkingDirectory`, utilizador e caminho do `.env` ao teu ambiente.

---

## Túnel Cloudflare (Try Cloudflare) — HTTPS para o `/b`

Geolocalização e câmara em browsers modernos exigem **contexto seguro (HTTPS)** ou `localhost`. Para testares a partir do telemóvel contra um Flask na tua máquina ou VPS:

### 1. Instalar `cloudflared`

- **Linux (deb)**: segue a [documentação oficial](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/) (repositório Cloudflare ou binário).
- **macOS**: `brew install cloudflare/cloudflare/cloudflared`
- **Windows**: instalador na página de releases do Cloudflare.

### 2. Arrancar o lab na porta local

Garante que o app está acessível em **`http://127.0.0.1:8787`** (Gunicorn ou `python app.py`).

### 3. Subir o túnel rápido

No repositório há um script mínimo:

```bash
chmod +x scripts/cloudflare-quick-tunnel.sh
./scripts/cloudflare-quick-tunnel.sh
# ou outro upstream:
# ./scripts/cloudflare-quick-tunnel.sh http://127.0.0.1:8787
```

O `cloudflared` imprime um URL **`https://….trycloudflare.com`**. Esse hostname **muda** quando reinicias o túnel (é normal no modo “quick tunnel”).

### 4. Usar no telemóvel

1. Abre **`https://<teu-subdomínio>.trycloudflare.com/b`** (ou partilha esse link aos participantes com **consentimento**).
2. Abre **`https://…/ver`** no PC para veres as coletas (se tiveres **`LAB_PANEL_PASSWORD`**, faz primeiro login em **`/lab-login`**).

### 5. Dicas

- Mantém o terminal do túnel aberto enquanto testas.
- Se usares **senha no painel** + HTTPS no túnel, define no `.env`: **`FLASK_SESSION_COOKIE_SECURE=1`** para o cookie de sessão ser marcado como *Secure*.
- Atrás de **nginx** com prefixo ou cabeçalhos `X-Forwarded-*`, vê `.env.example` (`TRUST_PROXY`, `TRUST_X_FORWARDED_PREFIX`).

---

## Variáveis de ambiente (resumo)

Documentação completa em **`.env.example`**. Destaques:

| Variável | Função |
|----------|--------|
| `LAB_PANEL_PASSWORD` | Se definida, exige login no painel (`/lab-login`). |
| `FLASK_SECRET_KEY` | Assina a sessão; **obrigatória** em produção com senha (senão reinício invalida sessões de forma imprevisível). |
| `FLASK_SESSION_COOKIE_SECURE` | `1` se o site for só HTTPS. |
| `DATABASE_URL` / `POSTGRES_*` | PostgreSQL em vez de SQLite. |
| `LAB_BEACON_MAX` / `LAB_AUDIT_MAX` | Limites de linhas (SQLite tem cap por omissão nas coletas). |
| `TRUST_PROXY` / `TRUST_X_FORWARDED_PREFIX` | Ajuste de IP/esquema/prefixo atrás de proxy. |

**APIs protegidas** (com senha ativa): exigem cookie de sessão **ou** cabeçalho `Authorization: Bearer <LAB_PANEL_PASSWORD>` para scripts.

---

## API (visão geral)

| Método | Caminho | Notas |
|--------|---------|--------|
| `GET` | `/api/ping` | Diagnóstico (rotas registadas) — **com senha ativa requer sessão/Bearer**. |
| `GET` | `/api/server-meta` | O que o handshake HTTP expõe — **público** (beacon). |
| `POST` | `/api/lab-report` | Pacote do cliente; com `beacon_capture` grava coleta — **público** (beacon). |
| `GET` | `/api/beacon-tail` | Lista para o painel — **protegido** se `LAB_PANEL_PASSWORD`. |
| `POST` | `/api/device-label` | Nome amigável por `device_key` — **protegido**. |
| `POST` | `/api/lab-reset` | Apaga coletas + nomes + auditoria — **protegido**. |
| `GET` | `/api/audit-tail` | Eventos de auditoria — **protegido**. |

---

## Segurança e ética

- Usa apenas em **ambiente controlado** e com **consentimento** dos participantes.
- **Senha no painel** não substitui controlo de acesso ao servidor (SSH, firewall, segredos no `.env`).
- O endpoint público **`POST /api/lab-report`** pode ser abusado para *spam* de dados; em exposição na Internet considera *rate limiting* à frente (nginx, Cloudflare, etc.).

---

## Licença

**MIT** — ver o ficheiro [`LICENSE`](./LICENSE).

---

## Créditos

Projeto mantido por **[MatheusRenzo](https://github.com/MatheusRenzo)** e contribuidores. Sugestões e *pull requests* são bem-vindos.
