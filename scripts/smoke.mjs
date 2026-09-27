/**
 * Zero-dependency smoke tests for OmniFormat AI Studio Max.
 *
 * Boots server.mjs on an ephemeral port and asserts the critical paths:
 *   • static shell (index.html) + .well-known/com.chrome.devtools.json
 *   • session bootstrap (POST /api/auth/session)
 *   • me/usage/session GETs
 *   • plan gating (Free plan rejected for gemini & veo; openai allowed)
 *   • credit wallets appear in /api/me
 *   • settings payload carries dev flags, never secrets
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
  const dataDir = mkdtempSync(join(tmpdir(), "omniformat-smoke-"));
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

    // ── Static shell ──────────────────────────────────────────────────────
    const shell = await fetch(`${BASE}/`);
    const shellText = await shell.text();
    check("GET / serves shell", shell.ok && shellText.includes("OmniFormat"));
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
      "me carries credit wallets",
      meBody?.credits &&
        Number.isFinite(meBody.credits.ai) &&
        Number.isFinite(meBody.credits.image) &&
        Number.isFinite(meBody.credits.veo),
    );
    check("me carries plan", typeof meBody?.plan === "string");

    const usage = await fetch(`${BASE}/api/usage`, { headers: authHeaders });
    check("GET /api/usage ok", usage.ok);

    const sessionGet = await fetch(`${BASE}/api/auth/session`, {
      headers: authHeaders,
    });
    check("GET /api/auth/session ok", sessionGet.ok);

    // ── Plan gating ──────────────────────────────────────────────────────
    const gate = async (path, body) => {
      const res = await fetch(`${BASE}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) ?? {};
      return { res, json };
    };

    const veo = await gate("/api/veo/generate", { prompt: "test clip" });
    check("Free plan blocked from Veo", veo.res.status === 402 || veo.res.status === 403);
    check("veo error message mentions plan/upgrade", /plan|upgrade/i.test(veo.json?.error ?? ""));

    const gem = await gate("/api/generate", { provider: "gemini", prompt: "test" });
    check("Free plan blocked from gemini", gem.res.status === 402 || gem.res.status === 403);

    // openai is allowed on Free; without keys it must fail gracefully
    const oai = await gate("/api/generate", { provider: "openai", prompt: "test" });
    check("Free plan allowed for openai", oai.res.status !== 402 && oai.res.status !== 403);
    check(
      "openai graceful failure (502/no-key)",
      oai.res.ok || oai.res.status === 502 || oai.res.status === 503,
    );

    const badProvider = await gate("/api/generate", { provider: "nope", prompt: "x" });
    check("unknown provider rejected", badProvider.res.status === 400);

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
