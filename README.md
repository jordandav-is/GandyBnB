# Gandy House

A single-property family beach-house calendar with home-rolled authentication, atomic SQLite reservations, and live WebSocket updates on a Cloudflare Durable Object.

## Local development

Requires Node.js 22 or newer. Wrangler runs the Cloudflare Worker and its SQLite-backed Durable Object locally.

```bash
npm install
npm run api
```

In a second terminal:

```bash
npm run dev
```

The frontend runs at `http://localhost:3000`; the API defaults to `http://localhost:8787`.

The frontend reads one public build-time variable:

```text
NEXT_PUBLIC_API_URL=http://localhost:8787
```

Worker development settings—including allowed browser origins—live in `wrangler.jsonc`.

## Verification

```bash
npm test
npm run lint
npm run build
```

## Deployment

1. Authenticate the Cloudflare CLI:

   ```bash
   npx wrangler login
   ```

2. Deploy the Worker and its SQLite-backed Durable Object:

   ```bash
   npm run deploy:api
   ```

3. Copy the resulting `https://gandy-house-api.<account>.workers.dev` URL into the GitHub repository secret `NEXT_PUBLIC_API_URL`.
4. In GitHub **Settings → Pages**, select **GitHub Actions** as the source.
5. Run `.github/workflows/deploy-pages.yml`; it builds the static frontend and deploys `out/`.

`ALLOWED_ORIGINS` in `wrangler.jsonc` must contain the GitHub Pages origin, currently `https://jordandav-is.github.io`. The Worker stores passwords as salted PBKDF2 hashes, stores only hashed session tokens, uses one-time WebSocket tickets, and serializes booking conflict checks inside a Durable Object SQLite transaction.

## Password resets

There is no email service, so resets are personal: the superadmin (the `SUPERADMIN_EMAIL` account from `wrangler.jsonc`) issues a one-time code from the admin panel's family-member list and shares it privately. The member uses **Forgot your password?** on the sign-in screen with that code. Codes expire after an hour, are single-use, and a successful reset signs out every existing session for that account.

If the superadmin is ever locked out, set a break-glass secret and use it as the reset code for the superadmin email:

```bash
npx wrangler secret put RECOVERY_CODE
```
