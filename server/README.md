# Core tournament server

A free, self-hostable tournament management server. See
`../docs/superpowers/specs/` for the full design.

## Requirements

- Python 3.11 or newer

## Setup

```bash
cd server
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
```

## Run the tests

```bash
pytest tests/ -v
```

## Run the dev server

```bash
python -m tournament_server.main
```

Then, in another terminal:

```bash
curl http://127.0.0.1:8000/health
# {"status":"ok"}
```

On first run, with no tournament chosen yet, the server serves a small
picker UI (in the admin app) for creating or opening a tournament file;
it auto-reopens the last-used tournament on every subsequent restart. For
scripted or single-tournament deployments, the legacy `TOURNAMENT_DB_PATH`
environment variable skips the picker entirely and pins a fixed database
path:

```bash
TOURNAMENT_DB_PATH=/path/to/my-event.db python -m tournament_server.main
```
