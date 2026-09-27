/**
 * Zero-dependency smoke tests for NEXUS AI UNIVERSAL STUDIO.
 *
 * Boots server.mjs on an ephemeral port and asserts the critical paths:
 *   • static shell (NEXUS branding) + .well-known/com.chrome.devtools.json
 *   • session bootstrap (POST /api/auth/session)
 *   • me/usage/session GETs
 *   • credit wallets appear in /api/me (Free now includes 1 video credit)
 *   • settings payload: plans with maxVideoSeconds, videoLimits, accessCodeEnabled, no secrets
 *   • access-code unlock: wrong code 403, code 9999 upgrades Free → Go/Pro/VIP
 *   • video duration tiers: Free ≤120s allowed, >120s rejected with upgrade hint
 *   • plan gating (Free rejected for gemini; openai/auto allowed)
 *   • graceful provider failure without keys
 *
 * Run: node scripts/smoke.mjs   (also wired to `npm test`)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const SERVER = join(ROOT, "server.mjs");
const PORT = 18787;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;

function check(name, ok, extra = "") {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name} ${extra}`);
  }
}

async function waitForServer(proc, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`server exited early with code ${proc.exitCode}`);
    }
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await delay(250);
  }
  throw new Error("server did not become ready in time");
}

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), "nexus-smoke-"));
  const proc = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      DATA_DIR: dataDir,
      DEV_AUTH: "true",
      DEV_BILLING: "true",
      VIP_ACCESS_CODE: "9999",
      SESSION_SECRET: "smoke-test-secret",
      // No provider keys: AI endpoints must fail gracefully, not crash.
      OPENAI_API_KEY: "",
      GEMINI_API_KEY: "",
      STRIPE_SECRET_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  proc.stderr.on("data", (d) => {
    stderr += String(d);
  });
  proc.stdout.on("data", (d) => {
    process.stdout.write(String(d));
  });

  try {
    await waitForServer(proc);
    console.log(`\n[smoke] server up at ${BASE}\n`);

    const gate = async (path, body, headers = {}) => {
      const res = await fetch(`${BASE}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) ?? {};
      return { res, json };
    };

    // ── Static shell ──────────────────────────────────────────────────────
    const shell = await fetch(`${BASE}/`);
    const shellText = await shell.text();
    check("GET / serves shell", shell.ok && shellText.includes("NEXUS"));
    check("shell has no stale branding", !shellText.includes("OmniFormat"));
    check("shell has CSP meta", shellText.includes("Content-Security-Policy"));

    const devtools = await fetch(
      `${BASE}/.well-known/appspecific/com.chrome.devtools.json`,
    );
    check("chrome devtools well-known served", devtools.ok);
    const dtBody = (await devtools.json()) ?? {};
    check(
      "devtools payload shape",
      typeof dtBody?.["workspace"]?.root === "string" &&
        typeof dtBody?.workspace?.uuid === "string",
    );

    // ── Health & settings ────────────────────────────────────────────────
    const health = await fetch(`${BASE}/api/health`);
    const healthBody = (await health.json()) ?? {};
    check("health ok:true", health.ok && healthBody?.ok === true);

    const settings = await fetch(`${BASE}/api/settings`);
    const settingsBody = (await settings.json()) ?? {};
    check("settings exposes devAuth flag", typeof settingsBody?.devAuth === "boolean");
    check(
      "settings exposes no secret material",
      !JSON.stringify(settingsBody).toLowerCase().includes("secret"),
    );
    check(
      "settings plans present",
      Array.isArray(settingsBody?.plans) && settingsBody.plans.length >= 4,
    );
    check(
      "plans carry video duration tiers",
      settingsBody.plans?.every?.((p) => Number.isFinite(p.maxVideoSeconds)) &&
        settingsBody.plans?.find((p) => p.key === "free")?.maxVideoSeconds === 120 &&
        settingsBody.plans?.find((p) => p.key === "pro")?.maxVideoSeconds === 300,
    );
    check(
      "videoLimits exposed",
      settingsBody?.videoLimits?.freeMaxSeconds === 120 &&
        settingsBody?.videoLimits?.paidMaxSeconds === 300 &&
        settingsBody?.videoLimits?.costPerVideo === 10,
    );
    check("accessCodeEnabled exposed", settingsBody?.accessCodeEnabled === true);

    // ── Session bootstrap ────────────────────────────────────────────────
    const boot = await fetch(`${BASE}/api/auth/session`, { method: "POST" });
    const bootBody = (await boot.json()) ?? {};
    check("POST /api/auth/session ok", boot.ok && bootBody?.ok === true);
    check("bootstrap returns email", typeof bootBody?.user?.email === "string");
    const cookie = (boot.headers.get("set-cookie") ?? "").split(";")[0];
    check("session cookie issued", cookie.startsWith("omni_session="));
    const authHeaders = cookie ? { cookie } : {};

    // ── Me / usage ───────────────────────────────────────────────────────
    const me = await fetch(`${BASE}/api/me`, { headers: authHeaders });
    const meBody = (await me.json()) ?? {};
    check("GET /api/me ok", me.ok && typeof meBody?.email === "string");
    check(
      "me carries credit wallets (Free = 10 credits = 1 video)",
      meBody?.credits &&
        Number.isFinite(meBody.credits.ai) &&
        Number.isFinite(meBody.credits.image) &&
        meBody.credits.veo === 10,
    );
    check("me carries plan", typeof meBody?.plan === "string");

    const usage = await fetch(`${BASE}/api/usage`, { headers: authHeaders });
    check("GET /api/usage ok", usage.ok);

    // ── Plan gating ──────────────────────────────────────────────────────
    const gem = await gate("/api/generate", { provider: "gemini", prompt: "test" }, authHeaders);
    check("Free plan blocked from gemini", gem.res.status === 402 || gem.res.status === 403);

    const oai = await gate("/api/generate", { provider: "openai", prompt: "test" }, authHeaders);
    check("Free plan allowed for openai", oai.res.status !== 402 && oai.res.status !== 403);
    check(
      "openai graceful failure (502/no-key)",
      oai.res.ok || oai.res.status === 502 || oai.res.status === 503,
    );

    const badProvider = await gate("/api/generate", { provider: "nope", prompt: "x" }, authHeaders);
    check("unknown provider rejected", badProvider.res.status === 400);

    // ── Video duration tiers (Free: ≤120s allowed, >120s rejected) ──────
    const veoFreeOk = await gate(
      "/api/veo/generate",
      { prompt: "test clip", seconds: 60 },
      authHeaders,
    );
    check(
      "Free 60s video passes plan gating",
      veoFreeOk.res.status !== 402 && veoFreeOk.res.status !== 403,
    );
    check(
      "Free 60s video graceful provider failure (502/no-key)",
      veoFreeOk.res.ok || veoFreeOk.res.status === 502,
    );

    const veoFreeOver = await gate(
      "/api/veo/generate",
      { prompt: "test clip", seconds: 180 },
      authHeaders,
    );
    check("Free 180s video rejected (402)", veoFreeOver.res.status === 402);
    check(
      "duration error mentions upgrade",
      /upgrade|minutes/i.test(veoFreeOver.json?.error ?? ""),
    );

    // ── Access-code unlock (code 9999 → Go/Pro/VIP) ─────────────────────
    const badCode = await gate(
      "/api/access/unlock",
      { code: "0000", plan: "pro" },
      authHeaders,
    );
    check("wrong access code rejected 403", badCode.res.status === 403);

    const oldRoute = await gate("/api/dev/unlock-vip", { code: "9999" }, authHeaders);
    check("legacy unlock-vip route removed (404)", oldRoute.res.status === 404);

    const unlock = await gate(
      "/api/access/unlock",
      { code: "9999", plan: "pro" },
      authHeaders,
    );
    check("code 9999 unlocks pro", unlock.res.ok && unlock.json?.plan === "pro");
    check(
      "unlock tops up wallet",
      unlock.json?.user?.credits?.veo >= 600 && unlock.json?.user?.credits?.ai >= 800,
    );

    const veoPro = await gate(
      "/api/veo/generate",
      { prompt: "test clip", seconds: 300 },
      authHeaders,
    );
    check(
      "Pro 300s video passes plan gating",
      veoPro.res.status !== 402 && veoPro.res.status !== 403,
    );
    check(
      "Pro 300s graceful provider failure (502/no-key)",
      veoPro.res.ok || veoPro.res.status === 502,
    );

    // ── Authed-only route ────────────────────────────────────────────────
    const anonMe = await fetch(`${BASE}/api/me`);
    check("anon /api/me rejected 401", anonMe.status === 401);
  } finally {
    proc.kill("SIGTERM");
    await delay(300);
    rmSync(dataDir, { recursive: true, force: true });
  }

  console.log(`\n[smoke] ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error("[smoke] stderr tail:\n" + stderr.split("\n").slice(-20).join("\n"));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[smoke] fatal:", err);
  process.exit(1);
});
