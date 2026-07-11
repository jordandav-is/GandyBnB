# Gandy House

A single-property family beach-house calendar with home-rolled authentication, atomic SQLite reservations, and live Server-Sent Events.

## Local development

Requires Node.js 22 or newer because the API uses Node's built-in SQLite module.

```bash
npm install
npm run api
```

In a second terminal:

```bash
npm run dev
```

The frontend runs at `http://localhost:3000`; the API defaults to `http://localhost:8787`.

Configuration:

```text
NEXT_PUBLIC_API_URL=http://localhost:8787
PORT=8787
DATA_FILE=./data/gandybnb.sqlite
ALLOWED_ORIGINS=http://localhost:3000
```

## Verification

```bash
npm test
npm run lint
npm run build
```

## Deployment

- `render.yaml` deploys the custom Node API with a persistent SQLite disk.
- Add the deployed API origin to the API's `ALLOWED_ORIGINS`.
- Add the API URL as the GitHub repository secret `NEXT_PUBLIC_API_URL`.
- `.github/workflows/deploy-pages.yml` builds the static frontend and deploys `out/` to GitHub Pages.

The frontend and API must use HTTPS in production. Never place credentials or private keys in `NEXT_PUBLIC_*` variables.
