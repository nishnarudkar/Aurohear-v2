# Deploying AuroHear v2

> **Never put real credentials in this repository** — not in docs, examples, tests or
> commit messages. Use placeholders here and set real values only in the host's secret
> store. `backend/tests/test_no_secrets.py` fails the test suite if a credential-shaped
> string (a database URL with a password, a JWT, a private key) is committed.

AuroHear v2 is two deployables:

| Part | Stack | Build / start |
|---|---|---|
| Backend API | Python 3.11+, FastAPI, SQLAlchemy, Alembic | `pip install ./backend` → `alembic upgrade head` → `uvicorn` |
| Frontend | TypeScript, React, Vite (static files) | `npm ci && npm run build` → serve `frontend/dist/` |

## 1. Backend

### Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `AUROHEAR_DATABASE_URL` | yes (production) | SQLAlchemy URL. Production: PostgreSQL, e.g. `postgresql+psycopg://<user>:<password>@<host>:5432/<db>`. Default: a local SQLite file (development only). |
| `AUROHEAR_CORS_ORIGINS` | yes (production) | Comma-separated origins allowed to call the API, e.g. `https://<your-frontend-host>` |
| `AUROHEAR_ADMIN_TOKEN` | optional | Bearer token for the admin-only NLP endpoints. Unset → those endpoints are disabled (403). Generate with `python -c "import secrets; print(secrets.token_urlsafe(32))"`. |

PostgreSQL needs a driver that is not a core dependency: `pip install "psycopg[binary]"`.

### Steps

```bash
cd backend
pip install . "psycopg[binary]" uvicorn
python -m alembic upgrade head          # run on every deploy, before starting the app
uvicorn aurohear.api.app:create_app --factory --host 0.0.0.0 --port $PORT
```

Always run migrations against the real database before starting the new version; the
app does not create tables itself.

## 2. Frontend

```bash
cd frontend
npm ci
VITE_API_BASE_URL=https://<your-api-host> npm run build
```

Serve `frontend/dist/` from any static host over **HTTPS** — browsers only allow
microphone access (the ambient-noise gate) on secure origins.

## 3. Security checklist

- [ ] No credentials in the repository (the test suite checks this).
- [ ] Database password and any API keys live only in the host's secret store.
- [ ] HTTPS on both frontend and API.
- [ ] `AUROHEAR_CORS_ORIGINS` lists only your frontend origin.
- [ ] `AUROHEAR_ADMIN_TOKEN` is long and random, or unset.
- [ ] Database encrypted at rest, with backups (spec §12.3).

> Not yet production-ready for identifiable health data: there is no user authentication
> or role-based access yet (spec §12.3). Deploy for development or a supervised,
> ethics-approved study only.
