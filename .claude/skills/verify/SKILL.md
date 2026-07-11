---
name: verify
description: Build, launch, and drive GandyBnB end-to-end to verify changes at the browser surface.
---

# Verifying GandyBnB

Two processes: the Cloudflare Worker API (Durable Object + SQLite) and the Next.js frontend.

## Launch

```bash
npm install
npx wrangler dev --ip 127.0.0.1 --port 8787 --persist-to <fresh-tmp-dir> &   # API (frontend defaults to :8787)
npm run dev &                                                                # frontend on :3000
curl -s http://127.0.0.1:8787/health                                         # {"status":"ok",...}
```

Always use a fresh `--persist-to` dir per run — signups collide (409) against a reused database.

## Drive

Playwright is installed globally, not in the project. Import it by absolute path and point at the preinstalled Chromium:

```js
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
```

(Check `ls /opt/pw-browsers/` for the current chromium-NNNN dir.)

Flows worth driving: signup ("Join the family" tab, password ≥10 chars), booking (date inputs + "Reserve these dates"), live updates (open two browser contexts — changes propagate over WebSocket without reload), the superadmin panel (sign up as the `SUPERADMIN_EMAIL` from wrangler.jsonc to get the Admin toggle in the header).

## Gotchas

- Signups and logins share a 10/minute rate limit per IP; keep scripted account creation under that.
- `npm test` boots its own wrangler dev on a random port; don't run it while another wrangler holds a lock on the same persist dir.
