# NEXUS AI UNIVERSAL STUDIO

**Created by Rivansh Trivedi** · Version **0.1 Alpha**

A self-contained, **zero-dependency** Node.js AI Creative Operating System —
a full-stack workspace built on Node's built-in `http`/`fetch` APIs. No npm
packages at all.

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
- **Image Studio**: GPT-Image-2 + Gemini 3.1 Flash Image, a **prompt builder**
  (subject / style / lighting / camera / mood), **negative prompt**, size
  selector and plan-aware provider options.
- **Video Studio**: Veo 3.1 long-running operations with a **duration selector**
  (8s → 5 min) and server-enforced duration tiers per plan; videos stream
  through the server so provider keys never touch the browser.
- **Plans enforced server-side** with per-user monthly credit wallets
  (AI / image / video; 10 video credits = 1 video):
  - **Free $0** — auto routing, one video up to 2 minutes
  - **Go $5** — Gemini + Veo, videos up to 5 minutes
  - **Pro $15** — all providers, videos up to 5 minutes
  - **VIP $17** — highest limits, videos up to 5 minutes
- **Access codes**: a code box in Billing lets users unlock **Go, Pro or VIP**
  with the code you give them (default `9999` in dev; credits top up to the
  chosen plan). Disabled automatically when Stripe billing is active.
- **Dashboard**: quick actions, continue-working (last studio/session),
  system status, and **Analyze Screen** — Nexus gathers structured app context
  (studio, plan, credits, provider state) and the AI returns
  SUMMARY / ISSUES / SUGGESTIONS / ACTIONS.
- **Command palette** (Ctrl/⌘+K) for instant studio switching.
- **AI assistant with workspace awareness** — chats include the current studio,
  plan and credit state as context.
- **Session persistence** — the last studio is restored on reload.
- **Auth**: local dev session cookies (`omni_session`), Google OAuth hooks.
- **Payments**: Stripe Checkout + signed webhooks when Stripe creds are
  configured; dev billing simulation otherwise.
- **Studio shells**: Smart Merge, document, research, app builder, image,
  video, sandboxed-iframe playground.
- **UI**: glassmorphism dark theme with animated backgrounds, mobile
  bottom-nav, settings overlay, reduced-motion and touch/mouse awareness.

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

Environment variables (put them in `.env` locally, or the host's env UI):

| Variable | Purpose |
| --- | --- |
| `HOST` / `PORT` | Bind address (default `0.0.0.0:8787`) |
| `SESSION_SECRET` | Cookie signing secret (ephemeral one is generated if unset) |
| `OPENAI_API_KEY` | OpenAI text + image generation |
| `OPENAI_TEXT_MODEL` / `OPENAI_IMAGE_MODEL` | Override models (defaults: `gpt-5.6-luna`, `gpt-image-2`) |
| `GEMINI_API_KEY` | Gemini text/image + Veo |
| `GEMINI_TEXT_MODEL` / `GEMINI_IMAGE_MODEL` | Override models (defaults: `gemini-3.8-flash`, `gemini-3.1-flash-image`) |
| `VEO_MODEL` | Veo model (default `veo-3.1-generate-preview`) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | Stripe Checkout + webhook verification |
| `STRIPE_PRICE_GO` / `STRIPE_PRICE_PRO` / `STRIPE_PRICE_VIP` | Pre-created Stripe prices (optional) |
| `DEV_AUTH` / `DEV_BILLING` | Dev conveniences (force-disabled when Stripe creds are set) |
| `VIP_ACCESS_CODE` | Access-code unlock code (default `9999`) |
| `DATA_DIR` | Where user/usage JSON state is persisted (default `.data/`) |

Keys live server-side only — the frontend never receives them.

## Video duration tiers

| Plan | Max video length | Monthly video allowance |
| --- | --- | --- |
| Free | 2 minutes | 1 video (10 credits) |
| Go / Pro / VIP | 5 minutes | 20 / 60 / 300 videos (200/600/3000 credits) |

Duration limits are enforced **server-side** in `/api/veo/generate`; the UI
selector disables and locks options above the current plan's cap.

## Access codes

`POST /api/access/unlock` with `{ "code": "9999", "plan": "go|pro|vip" }`
upgrades the current session's plan and tops the wallet up to that plan.
The endpoint only exists while dev billing is active (`accessCodeEnabled` in
`/api/settings`); adding real Stripe credentials removes it entirely.

## API surface (summary)

| Endpoint | Purpose |
| --- | --- |
| `POST /api/auth/session` | Bootstrap dev session |
| `GET /api/auth/session` | Read session |
| `POST /api/auth/dev-login` | Email login (dev auth only) |
| `GET /api/auth/google/start` → `/callback` | Google OAuth |
| `GET /api/me` | Current user + plan + credit wallets |
| `GET /api/usage` | Per-user usage counters |
| `POST /api/generate` | Text generation (`auto\|openai\|gemini`) |
| `POST /api/image` | Image generation (`openai\|gemini`) |
| `POST /api/veo/generate` | Start Veo op (10 credits; duration tiered) |
| `GET /api/veo/status?id=` | Poll Veo operation |
| `GET /api/veo/file?ref=` | Server-side video proxy |
| `POST /api/access/unlock` | Access-code plan unlock (dev only) |
| `POST /api/checkout` | Create Stripe Checkout session |
| `POST /api/stripe/webhook` | Signed webhook fulfillment |
| `GET /api/settings` | Public settings: plans, video limits, flags (never secrets) |
| `GET /api/health` | Liveness |

## Production caveats

- **Dev auth must be replaced with a real identity provider** before production
  (Google OAuth hooks are included; session cookies are HttpOnly/SameSite=Lax).
- **No hardcoded VIP codes or payment bypasses in production** — the access-code
  endpoint and dev billing are force-disabled the moment real Stripe
  credentials are present.
- **Password-protected files are only processed with the correct user password** —
  no encryption cracking.
- Credits, plan entitlements and **video duration tiers** are enforced
  server-side on every AI/image/veo call.

## Smoke tests

`npm test` boots the server on port `18787` with a temp data dir and verifies:
NEXUS shell serving (no stale branding), session bootstrap, credit wallets
(Free = 10 video credits = 1 video), plan gating (Free blocked from Gemini),
**video duration tiers** (Free 60s allowed, 180s rejected; Pro 300s allowed),
**access-code unlock** (wrong code 403, `9999` → Pro with topped-up wallet,
legacy VIP route removed), settings payload carrying dev flags but never
secrets, and graceful failure without provider keys.
