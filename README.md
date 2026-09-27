# OmniFormat AI Studio Max

A self-contained, **zero-dependency** Node.js AI studio — a full-stack SaaS-style
workspace built on Node's built-in `http`/`fetch` APIs. No npm packages at all.

## Architecture

| File | Role |
| --- | --- |
| `server.mjs` | The entire backend **and** the frontend (serves an inline HTML/CSS/JS SPA) |
| `index.html` / `src/main.tsx` | Minimal Vite-style shell entry (title page + module mount) |
| `scripts/build.mjs` | Static build step → emits shell into `dist/` |
| `scripts/smoke.mjs` | Zero-dependency smoke tests (`npm test`) |
| `.env` | Server-side credentials only (keys never hit the frontend) |

## What it does

- **AI text generation** via OpenAI Responses API (`gpt-5.6-luna`) and Gemini
  (`gemini-3.8-flash`), with **auto fallback** (OpenAI → Gemini).
- **Image generation** via OpenAI GPT-Image-2 and Gemini 3.1 Flash Image.
- **Video generation** starter via Veo 3.1 long-running operations (costs 10 credits).
- **Monetization plans enforced server-side**: Free ($0, auto only), Go ($5,
  Gemini + Veo), Pro ($15, all providers), VIP ($17, highest limits) — with
  per-user AI/image/Veo **credit wallets** that deplete per call.
- **Auth**: local dev session cookies (`omni_session`), Google OAuth hooks,
  VIP access code (default `9999` in dev).
- **Payments**: Stripe Checkout + signed webhooks when Stripe creds are configured;
  dev billing simulation otherwise.
- **Studio shells**: Smart Merge, document, research, app, and vision tools, plus a
  sandboxed-iframe playground.
- **UI**: glassmorphism dark theme with animated backgrounds, mobile bottom-nav,
  settings overlay, reduced-motion and touch/mouse device awareness.

## Run it

```bash
node server.mjs        # then open http://localhost:8787
```

Server binds `0.0.0.0`, so you can test from a phone via your LAN IP.

```bash
npm run dev            # same as start
npm test               # smoke tests (boots server on port 18787)
npm run build          # emits static shell into dist/
```

## Configuration

Copy `.env.example` to `.env` and fill in what you need:

| Variable | Purpose |
| --- | --- |
| `HOST` / `PORT` | Bind address (default `0.0.0.0:8787`) |
| `SESSION_SECRET` | Cookie signing secret (ephemeral one is generated if unset) |
| `OPENAI_API_KEY` | OpenAI text + image generation |
| `OPENAI_TEXT_MODEL` / `OPENAI_IMAGE_MODEL` | Override models (defaults: `gpt-5.6-luna`, `gpt-image-2`) |
| `GEMINI_API_KEY` | Gemini text + image generation |
| `GEMINI_TEXT_MODEL` / `GEMINI_IMAGE_MODEL` | Override models (defaults: `gemini-3.8-flash`, `gemini-3.1-flash-image`) |
| `VEO_MODEL` | Veo model (default `veo-3.1-generate-preview`) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | Stripe Checkout + webhook verification |
| `DEV_AUTH` / `DEV_BILLING` | Dev conveniences (auto-disabled when Stripe creds are set) |
| `VIP_ACCESS_CODE` | Dev VIP unlock code (default `9999`) |
| `DATA_DIR` | Where user/usage JSON state is persisted (default `.data/`) |

Keys live server-side only — the frontend never receives them.

## API surface (summary)

| Endpoint | Purpose |
| --- | --- |
| `POST /api/auth/session` | Bootstrap/get dev session |
| `GET/POST /api/auth/session` | Read/refresh session |
| `GET /api/me` | Current user + plan + credit wallets |
| `GET /api/usage` | Per-user usage counters |
| `POST /api/generate` | Text generation (`provider: auto\|openai\|gemini`) |
| `POST /api/image` | Image generation (`openai\|gemini`) |
| `POST /api/veo/generate` | Start Veo video op (10 credits) |
| `GET /api/veo/status?id=` | Poll Veo operation |
| `POST /api/checkout` | Create Stripe Checkout session |
| `POST /api/stripe/webhook` | Signed webhook fulfillment |
| `POST /api/dev/unlock-vip` | Dev VIP access code (disabled in prod) |
| `GET /api/settings` | Public settings: plans, dev flags (never secrets) |
| `GET /api/health` | Liveness |

## Production caveats

- **Dev auth must be replaced with a real identity provider** before production
  (Google OAuth hooks are included; session cookies are HttpOnly/SameSite=Lax).
- **No hardcoded VIP codes or payment bypasses** — `VIP_ACCESS_CODE` and dev
  billing are force-disabled the moment real Stripe credentials are present.
- **Password-protected files are only processed with the correct user password** —
  no encryption cracking.
- Credits and entitlements are enforced server-side on every AI/image/veo call.

## Smoke tests

`npm test` boots the server on port `18787` with a temp data dir and verifies:
static shell serving, session bootstrap, plan gating (Free blocked from Gemini +
Veo, allowed for OpenAI/auto), credit wallets in `/api/me`, settings payload
carrying dev flags but never secrets, and graceful failure without provider keys.
