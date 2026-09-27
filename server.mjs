#!/usr/bin/env node
/**
 * NEXUS AI UNIVERSAL STUDIO — single-file, zero-dependency creative OS (v0.1 Alpha, by Rivansh Trivedi).
 *
 * Backend  : Node built-ins only (http, crypto, fs, fetch).
 * Frontend : inline glassmorphism SPA served from the SPA_HTML template below.
 * Storage  : JSON files in DATA_DIR (default .data/).
 * Providers: OpenAI (Responses API, GPT-Image-2), Gemini (3.8 Flash / 3.1 Flash Image),
 *            Veo 3.1 long-running video ops, Stripe Checkout + signed webhooks.
 *
 * Run: node server.mjs  → http://localhost:8787 (binds 0.0.0.0 by default)
 */
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/* ══════════════════════════ 1. Config & env ══════════════════════════ */

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = path.resolve(process.env.DATA_DIR || ".data");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_TEXT_MODEL = process.env.OPENAI_TEXT_MODEL || "gpt-5.6-luna";
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || "gpt-image-2";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || "gemini-3.8-flash";
const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image";
const VEO_MODEL = process.env.VEO_MODEL || "veo-3.1-generate-preview";
const VEO_CREDIT_COST = 10;
const VEO_FREE_MAX_SECONDS = 120; // Free plan: one video, up to 2 minutes
const VEO_PAID_MAX_SECONDS = 300; // Go/Pro/VIP: up to 5 minutes

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";

const stripeConfigured = Boolean(STRIPE_SECRET_KEY);
// Dev conveniences are force-disabled the moment real Stripe creds exist.
const DEV_AUTH = !stripeConfigured && (process.env.DEV_AUTH ?? "true") !== "false";
const DEV_BILLING = !stripeConfigured && (process.env.DEV_BILLING ?? "true") !== "false";
const VIP_ACCESS_CODE = process.env.VIP_ACCESS_CODE || "9999";

const OPENAI_BASE = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const GEMINI_BASE =
  process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta";
const STRIPE_API = "https://api.stripe.com/v1";

/* ══════════════════════════ 2. Plans & credits ═════════════════════════ */

/** Wallets reset at the start of each month. veo costs 10 per video op. */
const PLANS = {
  free: {
    key: "free", name: "Free", price: 0, tagline: "Kick the tires",
    wallet: { ai: 20, image: 5, veo: 10 },
    maxVideoSeconds: VEO_FREE_MAX_SECONDS, videoLabel: "one video, up to 2 min",
    maxPrompt: 2_000, maxOutput: 1_024,
    features: ["Auto provider routing (OpenAI first)", "Text + image basics", "One video, up to 2 minutes", "Community limits"],
  },
  go: {
    key: "go", name: "Go", price: 5, tagline: "Gemini + Veo starter",
    wallet: { ai: 200, image: 60, veo: 200 },
    maxVideoSeconds: VEO_PAID_MAX_SECONDS, videoLabel: "up to 5 min videos",
    maxPrompt: 8_000, maxOutput: 2_048,
    features: ["Everything in Free", "Gemini 3.8 Flash text", "Gemini 3.1 Flash Image", "Veo 3.1 video starter"],
  },
  pro: {
    key: "pro", name: "Pro", price: 15, tagline: "All providers, all tools",
    wallet: { ai: 800, image: 250, veo: 600 },
    maxVideoSeconds: VEO_PAID_MAX_SECONDS, videoLabel: "up to 5 min videos",
    maxPrompt: 16_000, maxOutput: 4_096,
    features: ["Everything in Go", "All providers unlocked", "GPT-Image-2", "Higher rate limits"],
  },
  vip: {
    key: "vip", name: "VIP", price: 17, tagline: "Highest limits",
    wallet: { ai: 3000, image: 1000, veo: 3000 },
    maxVideoSeconds: VEO_PAID_MAX_SECONDS, videoLabel: "up to 5 min videos",
    maxPrompt: 32_000, maxOutput: 8_192,
    features: ["Everything in Pro", "Highest credit wallets", "Priority fallbacks", "Longest outputs"],
  },
};

/** Which text/image providers a plan may call directly. */
function planAllowsProvider(planKey, provider) {
  const p = PLANS[planKey] ? planKey : "free";
  if (provider === "auto" || provider === "openai") return true; // auto routes OpenAI-first
  if (provider === "gemini") return p !== "free";
  return false;
}
function planAllowsVeo(planKey, seconds) {
  const p = PLANS[planKey] || PLANS.free;
  const max = p.maxVideoSeconds || VEO_FREE_MAX_SECONDS;
  if (!(seconds > 0)) return (p.wallet && p.wallet.veo) > 0;
  return seconds <= max;
}

/* ══════════════════════════ 3. Tiny JSON store ═════════════════════════ */

fs.mkdirSync(DATA_DIR, { recursive: true });
const USERS_FILE = path.join(DATA_DIR, "users.json");
const USAGE_FILE = path.join(DATA_DIR, "usage.json");

function loadJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function saveJSON(file, data) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

/** users: email → {id, email, name, plan, createdAt, billing} */
const users = loadJSON(USERS_FILE, {});
/** usage: email → {month, credits:{ai,image,veo}, used:{ai,image,veo}, calls:{...}} */
const usage = loadJSON(USAGE_FILE, {});

function monthKey(d = new Date()) {
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0");
}
function normalizeEmail(e) {
  return String(e || "").trim().toLowerCase();
}
function ensureUser(email, name) {
  const key = normalizeEmail(email);
  if (!key) return null;
  if (!users[key]) {
    users[key] = {
      id: "u_" + crypto.randomBytes(8).toString("hex"),
      email: key,
      name: name || key.split("@")[0],
      plan: "free",
      billing: null,
      createdAt: new Date().toISOString(),
    };
    saveJSON(USERS_FILE, users);
  }
  return users[key];
}
function ensureUsage(email) {
  const key = normalizeEmail(email);
  const plan = PLANS[users[key]?.plan] || PLANS.free;
  let u = usage[key];
  if (!u) {
    u = usage[key] = {
      month: monthKey(),
      credits: { ...plan.wallet },
      used: { ai: 0, image: 0, veo: 0 },
      calls: { text: 0, image: 0, veo: 0 },
    };
  }
  if (u.month !== monthKey()) {
    u.month = monthKey();
    u.credits = { ...plan.wallet };
    u.used = { ai: 0, image: 0, veo: 0 };
  }
  // If plan changed since wallet was minted, top up to the new plan wallet (never subtract).
  for (const k of ["ai", "image", "veo"]) {
    u.credits[k] = Math.max(u.credits[k] ?? 0, 0);
  }
  return u;
}
function creditError(message) {
  const e = new Error(message);
  e.code = "insufficient_credits";
  return e;
}
function spendCredit(email, kind, amount) {
  const u = ensureUsage(email);
  if ((u.credits[kind] ?? 0) < amount) {
    throw creditError(
      "Not enough " + kind.toUpperCase() + " credits (need " + amount + ", have " + (u.credits[kind] ?? 0) + "). Upgrade your plan or wait for the monthly reset.",
    );
  }
  u.credits[kind] -= amount;
  u.used[kind] += amount;
  return u;
}
function refundCredit(email, kind, amount) {
  const u = ensureUsage(email);
  u.credits[kind] = (u.credits[kind] ?? 0) + amount;
}
function publicMe(user) {
  const u = ensureUsage(user.email);
  return {
    email: user.email,
    name: user.name,
    id: user.id,
    plan: user.plan,
    planName: (PLANS[user.plan] || PLANS.free).name,
    credits: { ...u.credits },
    used: { ...u.used },
    calls: { ...u.calls },
  };
}

/* ══════════════════════════ 4. Sessions (HMAC cookies) ═════════════════ */

const SESSION_SECRET =
  process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const COOKIE_NAME = "omni_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days
const sessions = new Map(); // sid → { email, exp }

function sign(value) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("base64url");
}
function makeToken(sid) {
  return sid + "." + sign(sid);
}
function parseToken(token) {
  if (!token || typeof token !== "string") return null;
  const idx = token.indexOf(".");
  if (idx < 0) return null;
  const sid = token.slice(0, idx);
  const mac = token.slice(idx + 1);
  const expect = sign(sid);
  const a = Buffer.from(mac);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return sid;
}
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function createSession(email) {
  const sid = crypto.randomBytes(24).toString("base64url");
  sessions.set(sid, { email: normalizeEmail(email), exp: Date.now() + SESSION_TTL_MS });
  if (sessions.size > 5000) {
    const cutoff = Date.now();
    for (const [k, v] of sessions) if (v.exp < cutoff) sessions.delete(k);
  }
  return makeToken(sid);
}
function sessionCookie(token) {
  return (
    COOKIE_NAME + "=" + encodeURIComponent(token) +
    "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + Math.floor(SESSION_TTL_MS / 1000)
  );
}
const CLEAR_COOKIE = COOKIE_NAME + "=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";
function getSessionUser(req) {
  const sid = parseToken(parseCookies(req)[COOKIE_NAME]);
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s || s.exp < Date.now()) {
    sessions.delete(sid);
    return null;
  }
  return users[s.email] || null;
}
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/* ══════════════════════════ 5. Outbound fetch helpers ══════════════════ */

async function fetchJSON(url, options = {}, timeoutMs = 60_000) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    const msg =
      json?.error?.message || json?.error || json?.message ||
      (text ? text.slice(0, 300) : "HTTP " + res.status);
    const err = new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}
function deepFindUri(obj, depth = 0) {
  if (depth > 8 || obj == null) return null;
  if (Array.isArray(obj)) {
    for (const v of obj) { const f = deepFindUri(v, depth + 1); if (f) return f; }
    return null;
  }
  if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string" && (k === "uri" || k === "videoUri") && v.startsWith("http")) return v;
      const f = deepFindUri(v, depth + 1);
      if (f) return f;
    }
  }
  return null;
}

/* ══════════════════════════ 5b. Provider issue tracking ═══════════════ */

/**
 * Last failure per provider/capability, surfaced in the Billing view as a hint
 * card so users can tell billing/quota problems apart from app bugs. Values are
 * redacted (no keys, no emails) and capped; purely informational.
 */
const providerIssues = new Map(); // id → { provider, capability, kind, status, message, at }
const PROVIDER_ISSUE_MESSAGE_MAX = 500;

function recordProviderIssue(provider, capability, err) {
  try {
    const message = String(err?.message || err || "Unknown provider error.").slice(0, PROVIDER_ISSUE_MESSAGE_MAX);
    const lower = message.toLowerCase();
    let kind = "error";
    if (err?.code === "insufficient_credits" || /no credits remaining|insufficient_quota|billing|exceeded your current quota|limit: 0|resource_exhausted/.test(lower)) {
      kind = "billing";
    } else if (/quota/i.test(lower)) {
      kind = "quota";
    } else if (/invalid api key|unauthenticated|api key not valid|permission denied|401|403/.test(lower)) {
      kind = "auth";
    }
    const status = typeof err?.status === "number" ? err.status : null;
    providerIssues.set(provider + ":" + capability, {
      provider,
      capability,
      kind,
      status,
      message,
      at: new Date().toISOString(),
    });
  } catch {
    /* never let issue tracking break a request */
  }
}

function clearProviderIssue(provider, capability) {
  providerIssues.delete(provider + ":" + capability);
}

/** Sorted list for publicSettings(). */
function listProviderIssues() {
  return [...providerIssues.values()].sort((a, b) => (a.provider + a.capability).localeCompare(b.provider + b.capability));
}

/* ══════════════════════════ 6. AI providers ════════════════════════════ */

function providerConfigured(provider) {
  if (provider === "openai") return Boolean(OPENAI_API_KEY);
  if (provider === "gemini") return Boolean(GEMINI_API_KEY);
  return Boolean(OPENAI_API_KEY) || Boolean(GEMINI_API_KEY);
}

async function openaiText({ prompt, system, maxOutput }) {
  if (!OPENAI_API_KEY) throw new Error("OpenAI is not configured (set OPENAI_API_KEY).");
  const input = [];
  if (system) input.push({ role: "system", content: [{ type: "input_text", text: system }] });
  input.push({ role: "user", content: [{ type: "input_text", text: prompt }] });
  const data = await fetchJSON(
    OPENAI_BASE + "/responses",
    {
      method: "POST",
      headers: { authorization: "Bearer " + OPENAI_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({
        model: OPENAI_TEXT_MODEL,
        input,
        max_output_tokens: maxOutput,
      }),
    },
    90_000,
  );
  let text = data?.output_text || "";
  if (!text && Array.isArray(data?.output)) {
    for (const item of data.output) {
      if (item?.type === "message" && Array.isArray(item.content)) {
        for (const c of item.content) if (typeof c.text === "string") text += c.text;
      }
    }
  }
  if (!text) throw new Error("OpenAI returned an empty response.");
  return { text, provider: "openai", model: OPENAI_TEXT_MODEL };
}

async function geminiText({ prompt, system, maxOutput }) {
  if (!GEMINI_API_KEY) throw new Error("Gemini is not configured (set GEMINI_API_KEY).");
  const contents = [{ role: "user", parts: [{ text: prompt }] }];
  if (system) contents[0].parts.unshift({ text: system });
  const data = await fetchJSON(
    GEMINI_BASE + "/models/" + encodeURIComponent(GEMINI_TEXT_MODEL) + ":generateContent?key=" + encodeURIComponent(GEMINI_API_KEY),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents, generationConfig: { maxOutputTokens: maxOutput } }),
    },
    90_000,
  );
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts.map((p) => p.text || "").join("").trim();
  if (!text) throw new Error("Gemini returned an empty response.");
  return { text, provider: "gemini", model: GEMINI_TEXT_MODEL };
}

async function generateText({ provider, prompt, system, plan, maxOutput }) {
  const limits = PLANS[plan] || PLANS.free;
  const cap = Math.min(maxOutput || limits.maxOutput, limits.maxOutput);
  const order = provider === "auto" ? ["openai", "gemini"] : [provider];
  let lastErr = null;
  for (const p of order) {
    if (!planAllowsProvider(plan, p)) continue; // entitlement filter (auto fallback respects plans)
    if (!providerConfigured(p)) { lastErr = lastErr || new Error(p + " is not configured."); continue; }
    try {
      return p === "openai"
        ? await openaiText({ prompt, system, maxOutput: cap })
        : await geminiText({ prompt, system, maxOutput: cap });
    } catch (err) {
      recordProviderIssue(p, "text", err);
      lastErr = err;
    }
  }
  throw lastErr || new Error("No provider available for plan '" + plan + "'.");
}

async function openaiImage({ prompt, size }) {
  if (!OPENAI_API_KEY) throw new Error("OpenAI is not configured (set OPENAI_API_KEY).");
  const data = await fetchJSON(
    OPENAI_BASE + "/images/generations",
    {
      method: "POST",
      headers: { authorization: "Bearer " + OPENAI_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({ model: OPENAI_IMAGE_MODEL, prompt, size: size || "1024x1024", n: 1 }),
    },
    180_000,
  );
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI image response missing b64_json.");
  return { b64, mime: "image/png", provider: "openai", model: OPENAI_IMAGE_MODEL };
}

async function geminiImage({ prompt }) {
  if (!GEMINI_API_KEY) throw new Error("Gemini is not configured (set GEMINI_API_KEY).");
  const data = await fetchJSON(
    GEMINI_BASE + "/models/" + encodeURIComponent(GEMINI_IMAGE_MODEL) + ":generateContent?key=" + encodeURIComponent(GEMINI_API_KEY),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
      }),
    },
    180_000,
  );
  const parts = data?.candidates?.[0]?.content?.parts || [];
  for (const p of parts) {
    if (p?.inlineData?.data) {
      return {
        b64: p.inlineData.data,
        mime: p.inlineData.mimeType || "image/png",
        provider: "gemini",
        model: GEMINI_IMAGE_MODEL,
      };
    }
  }
  throw new Error("Gemini image response contained no image.");
}

/** Veo 3.1 long-running operation starter. Returns the operation name. */
async function veoStart({ prompt, seconds }) {
  if (!GEMINI_API_KEY) throw new Error("Veo is not configured (set GEMINI_API_KEY).");
  const data = await fetchJSON(
    GEMINI_BASE + "/models/" + encodeURIComponent(VEO_MODEL) + ":predictLongRunning?key=" + encodeURIComponent(GEMINI_API_KEY),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        instances: [{ prompt }],
        parameters: { durationSeconds: Math.min(Math.max(seconds || 8, 4), VEO_PAID_MAX_SECONDS) },
      }),
    },
    120_000,
  );
  const name = data?.name;
  if (!name) throw new Error("Veo did not return an operation name.");
  return name;
}

/** Veo LRO poller — returns {done, uris[], error} (URIs fetched server-side with the key). */
async function veoStatus(opName) {
  if (!GEMINI_API_KEY) throw new Error("Veo is not configured (set GEMINI_API_KEY).");
  const data = await fetchJSON(
    GEMINI_BASE + "/" + opName.replace(/^operations\/?/, "operations/") + "?key=" + encodeURIComponent(GEMINI_API_KEY),
    { method: "GET" },
    60_000,
  );
  if (data?.error) return { done: true, uris: [], error: data.error.message || "Veo operation failed." };
  if (!data?.done) return { done: false, uris: [] };
  const uri = deepFindUri(data?.response || data);
  return { done: true, uris: uri ? [uri] : [], error: uri ? null : "Veo finished but returned no video." };
}

/* ══════════════════════════ 7. Billing (Stripe REST) ═══════════════════ */

const stripeOps = {
  async createCheckout({ planKey, user, origin }) {
    const plan = PLANS[planKey];
    if (!plan || plan.price === 0) throw new Error("Unknown or free plan.");
    const params = new URLSearchParams();
    const priceId =
      planKey === "go" ? process.env.STRIPE_PRICE_GO :
      planKey === "pro" ? process.env.STRIPE_PRICE_PRO :
      planKey === "vip" ? process.env.STRIPE_PRICE_VIP : "";
    params.set("mode", "subscription");
    params.set("success_url", origin + "/billing?checkout=success");
    params.set("cancel_url", origin + "/billing?checkout=cancel");
    params.set("client_reference_id", user.id);
    params.set("customer_email", user.email);
    params.set("metadata[userId]", user.id);
    params.set("metadata[plan]", planKey);
    params.set("line_items[0][quantity]", "1");
    if (priceId) {
      params.set("line_items[0][price]", priceId);
    } else {
      params.set("line_items[0][price_data][currency]", "usd");
      params.set("line_items[0][price_data][unit_amount]", String(plan.price * 100));
      params.set("line_items[0][price_data][recurring][interval]", "month");
      params.set("line_items[0][price_data][product_data][name]", "OmniFormat AI Studio — " + plan.name);
    }
    const res = await fetch(STRIPE_API + "/checkout/sessions", {
      method: "POST",
      headers: {
        authorization: "Bearer " + STRIPE_SECRET_KEY,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
      signal: AbortSignal.timeout(30_000),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.url) {
      throw new Error(json?.error?.message || "Stripe checkout creation failed.");
    }
    return json;
  },
  verifySignature(rawBody, header) {
    if (!STRIPE_WEBHOOK_SECRET || !header) return false;
    const parts = {};
    for (const piece of String(header).split(",")) {
      const i = piece.indexOf("=");
      if (i > 0) parts[piece.slice(0, i).trim()] = piece.slice(i + 1).trim();
    }
    if (!parts.t || !parts.v1) return false;
    const expected = crypto
      .createHmac("sha256", STRIPE_WEBHOOK_SECRET)
      .update(parts.t + "." + rawBody)
      .digest("hex");
    return safeEqual(expected, parts.v1);
  },
  handleEvent(event) {
    const type = event?.type || "";
    const obj = event?.data?.object || {};
    const meta = obj.metadata || {};
    const emailKey = meta.email ? normalizeEmail(meta.email) : null;
    const userId = meta.userId || obj.client_reference_id || null;
    const target = emailKey
      ? users[emailKey]
      : Object.values(users).find((u) => u.id === userId);
    if (type === "checkout.session.completed" && target) {
      target.plan = meta.plan && PLANS[meta.plan] ? meta.plan : target.plan;
      target.billing = { provider: "stripe", sessionId: obj.id, at: new Date().toISOString() };
      const u = ensureUsage(target.email);
      const wallet = (PLANS[target.plan] || PLANS.free).wallet;
      for (const k of ["ai", "image", "veo"]) u.credits[k] = Math.max(u.credits[k], wallet[k]);
      saveJSON(USERS_FILE, users);
      return { handled: true, plan: target.plan };
    }
    if (type === "customer.subscription.deleted" && target) {
      target.plan = "free";
      target.billing = { provider: "stripe", ended: true, at: new Date().toISOString() };
      saveJSON(USERS_FILE, users);
      return { handled: true, plan: "free" };
    }
    return { handled: false };
  },
};

/* ══════════════════════════ 8. HTTP plumbing ═══════════════════════════ */

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

function sendJSON(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...SECURITY_HEADERS,
    ...extraHeaders,
  });
  res.end(body);
}
function sendError(res, status, message, code) {
  sendJSON(res, status, { ok: false, error: message, ...(code ? { code } : {}) });
}
function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error("Payload too large."), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
async function readJSON(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error("Invalid JSON body."), { status: 400 });
  }
}

// Naive per-IP sliding-window rate limiter for /api/*.
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_MIN || 240);
const rateBuckets = new Map();
function rateLimited(ip) {
  const now = Date.now();
  let b = rateBuckets.get(ip);
  if (!b || now > b.resetAt) {
    b = { count: 0, resetAt: now + 60_000 };
    rateBuckets.set(ip, b);
    if (rateBuckets.size > 10_000) rateBuckets.clear();
  }
  b.count += 1;
  return b.count > RATE_LIMIT;
}

/* ══════════════════════════ 9. API routes ══════════════════════════════ */

const veoOps = new Map(); // localId → { opName, email, plan, prompt, status, uris, error, createdAt }

function publicSettings(origin) {
  return {
    ok: true,
    app: "NEXUS AI UNIVERSAL STUDIO",
    version: "0.1 Alpha",
    creator: "Rivansh Trivedi",
    devAuth: DEV_AUTH,
    devBilling: DEV_BILLING,
    billingMode: stripeConfigured ? "stripe" : "dev",
    accessCodeEnabled: DEV_BILLING,
    videoLimits: { freeMaxSeconds: VEO_FREE_MAX_SECONDS, paidMaxSeconds: VEO_PAID_MAX_SECONDS, freeVideos: 1, costPerVideo: VEO_CREDIT_COST },
    google: { enabled: Boolean(GOOGLE_CLIENT_ID) },
    providers: {
      openai: { configured: Boolean(OPENAI_API_KEY), textModel: OPENAI_TEXT_MODEL, imageModel: OPENAI_IMAGE_MODEL },
      gemini: { configured: Boolean(GEMINI_API_KEY), textModel: GEMINI_TEXT_MODEL, imageModel: GEMINI_IMAGE_MODEL },
      veo: { configured: Boolean(GEMINI_API_KEY), model: VEO_MODEL, cost: VEO_CREDIT_COST },
    },
    providerIssues: listProviderIssues(),
    plans: Object.values(PLANS).map((p) => ({
      key: p.key, name: p.name, price: p.price, tagline: p.tagline, features: p.features,
      wallet: p.wallet, maxVideoSeconds: p.maxVideoSeconds, videoLabel: p.videoLabel,
    })),
    origin,
  };
}

async function handleApi(req, res, pathname, query, origin) {
  const method = req.method || "GET";

  /* ---- public ---- */
  if (method === "GET" && pathname === "/api/health") {
    return sendJSON(res, 200, { ok: true, app: "nexus-ai-universal-studio", time: new Date().toISOString() });
  }
  if (method === "GET" && pathname === "/api/settings") {
    return sendJSON(res, 200, publicSettings(origin));
  }
  if (method === "POST" && pathname === "/api/stripe/webhook") {
    const raw = await readBody(req, 1024 * 1024);
    if (!stripeOps.verifySignature(raw, req.headers["stripe-signature"])) {
      return sendError(res, 400, "Invalid Stripe signature.");
    }
    let event = null;
    try { event = JSON.parse(raw); } catch { return sendError(res, 400, "Invalid webhook payload."); }
    const result = stripeOps.handleEvent(event);
    return sendJSON(res, 200, { received: true, ...result });
  }

  /* ---- session bootstrap (dev) ---- */
  if (method === "POST" && pathname === "/api/auth/session") {
    let user = getSessionUser(req);
    let setCookie = null;
    if (!user) {
      if (!DEV_AUTH) return sendError(res, 503, "Dev auth is disabled. Sign in with Google.");
      const guestEmail = "guest-" + crypto.randomBytes(4).toString("hex") + "@omniformat.dev";
      user = ensureUser(guestEmail, "Guest");
      setCookie = sessionCookie(createSession(user.email));
    }
    return sendJSON(res, 200, { ok: true, user: publicMe(user) }, setCookie ? { "set-cookie": setCookie } : {});
  }
  if (method === "GET" && pathname === "/api/auth/session") {
    const user = getSessionUser(req);
    return sendJSON(res, 200, user ? { ok: true, user: publicMe(user) } : { ok: false });
  }

  /* ---- everything below requires a session ---- */
  const user = getSessionUser(req);
  const authed = Boolean(user);

  if (method === "POST" && pathname === "/api/auth/dev-login") {
    if (!DEV_AUTH) return sendError(res, 503, "Dev auth is disabled.");
    const body = await readJSON(req);
    const email = normalizeEmail(body.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendError(res, 400, "Enter a valid email address.");
    const u = ensureUser(email, body.name);
    return sendJSON(res, 200, { ok: true, user: publicMe(u) }, { "set-cookie": sessionCookie(createSession(u.email)) });
  }
  if (method === "POST" && pathname === "/api/auth/logout") {
    return sendJSON(res, 200, { ok: true }, { "set-cookie": CLEAR_COOKIE });
  }
  if (method === "GET" && pathname === "/api/auth/google/start") {
    if (!GOOGLE_CLIENT_ID) return sendError(res, 503, "Google OAuth is not configured.");
    const state = crypto.randomBytes(16).toString("hex");
    oauthStates.set(state, { at: Date.now() });
    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: origin + "/api/auth/google/callback",
      response_type: "code",
      scope: "openid email profile",
      state,
    });
    res.writeHead(302, { location: "https://accounts.google.com/o/oauth2/v2/auth?" + params.toString(), ...SECURITY_HEADERS });
    return res.end();
  }
  if (method === "GET" && pathname === "/api/auth/google/callback") {
    const code = query.get("code");
    const state = query.get("state");
    if (!code || !state || !oauthStates.has(state)) return sendError(res, 400, "Invalid OAuth state.");
    oauthStates.delete(state);
    try {
      const token = await fetchJSON("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          redirect_uri: origin + "/api/auth/google/callback",
          grant_type: "authorization_code",
        }).toString(),
      }, 30_000);
      const profile = await fetchJSON("https://openidconnect.googleapis.com/v1/userinfo", {
        headers: { authorization: "Bearer " + token.access_token },
      }, 30_000);
      if (!profile.email) throw new Error("Google profile missing email.");
      const u = ensureUser(profile.email, profile.name);
      res.writeHead(302, { location: "/", "set-cookie": sessionCookie(createSession(u.email)), ...SECURITY_HEADERS });
      return res.end();
    } catch (err) {
      return sendError(res, 502, "Google sign-in failed: " + err.message);
    }
  }

  if (method === "GET" && pathname === "/api/me") {
    if (!authed) return sendError(res, 401, "Sign in required.");
    return sendJSON(res, 200, publicMe(user));
  }
  if (method === "GET" && pathname === "/api/usage") {
    if (!authed) return sendError(res, 401, "Sign in required.");
    const u = ensureUsage(user.email);
    return sendJSON(res, 200, {
      ok: true, month: u.month, credits: u.credits, used: u.used, calls: u.calls,
      plan: user.plan, wallet: (PLANS[user.plan] || PLANS.free).wallet,
    });
  }

  if (!authed) return sendError(res, 401, "Sign in required.");

  /* ---- dev VIP unlock ---- */
  if (method === "POST" && pathname === "/api/access/unlock") {
    if (!DEV_BILLING) return sendError(res, 403, "Access codes are disabled when Stripe billing is active.");
    const body = await readJSON(req);
    if (!safeEqual(String(body.code || ""), VIP_ACCESS_CODE)) return sendError(res, 403, "Invalid access code.");
    const planKey = ["go", "pro", "vip"].includes(body.plan) ? body.plan : "pro";
    user.plan = planKey;
    saveJSON(USERS_FILE, users);
    const u = ensureUsage(user.email);
    const wallet = (PLANS[planKey] || PLANS.free).wallet;
    for (const k of ["ai", "image", "veo"]) u.credits[k] = Math.max(u.credits[k], wallet[k]);
    return sendJSON(res, 200, { ok: true, plan: planKey, user: publicMe(user) });
  }

  /* ---- text generation ---- */
  if (method === "POST" && pathname === "/api/generate") {
    const body = await readJSON(req);
    const provider = String(body.provider || "auto");
    const prompt = String(body.prompt || "").trim();
    const system = body.system ? String(body.system).slice(0, 4_000) : undefined;
    if (!["auto", "openai", "gemini"].includes(provider)) return sendError(res, 400, "Unknown provider. Use auto, openai or gemini.");
    if (!prompt) return sendError(res, 400, "Prompt is required.");
    const limits = PLANS[user.plan] || PLANS.free;
    if (prompt.length > limits.maxPrompt) {
      return sendError(res, 413, "Prompt exceeds your plan limit of " + limits.maxPrompt.toLocaleString() + " characters. Upgrade for longer prompts.");
    }
    if (provider !== "auto" && !planAllowsProvider(user.plan, provider)) {
      return sendError(res, 402, "Your " + (PLANS[user.plan]?.name || "Free") + " plan does not include " + provider + ". Upgrade to Go, Pro or VIP to unlock it.");
    }
    spendCredit(user.email, "ai", 1);
    try {
      const result = await generateText({
        provider, prompt, system, plan: user.plan, maxOutput: body.maxOutput,
      });
      const u = ensureUsage(user.email);
      u.calls.text += 1;
      return sendJSON(res, 200, { ok: true, ...result, credits: u.credits });
    } catch (err) {
      refundCredit(user.email, "ai", 1);
      const status = err.code === "insufficient_credits" ? 402 : 502;
      return sendError(res, status, err.message || "Generation failed.", err.code);
    }
  }

  /* ---- image generation ---- */
  if (method === "POST" && pathname === "/api/image") {
    const body = await readJSON(req);
    const provider = String(body.provider || "openai");
    const prompt = String(body.prompt || "").trim();
    const size = String(body.size || "1024x1024");
    if (!["openai", "gemini"].includes(provider)) return sendError(res, 400, "Unknown image provider. Use openai or gemini.");
    if (!prompt) return sendError(res, 400, "Prompt is required.");
    if (!planAllowsProvider(user.plan, provider)) {
      return sendError(res, 402, "Your " + (PLANS[user.plan]?.name || "Free") + " plan does not include " + provider + " images. Upgrade to Go, Pro or VIP.");
    }
    spendCredit(user.email, "image", 1);
    try {
      const result = provider === "openai"
        ? await openaiImage({ prompt, size })
        : await geminiImage({ prompt });
      clearProviderIssue(provider, "image");
      const u = ensureUsage(user.email);
      u.calls.image += 1;
      return sendJSON(res, 200, {
        ok: true, provider: result.provider, model: result.model, mime: result.mime,
        dataUrl: "data:" + result.mime + ";base64," + result.b64, credits: u.credits,
      });
    } catch (err) {
      refundCredit(user.email, "image", 1);
      if (err.code !== "insufficient_credits") recordProviderIssue(provider, "image", err);
      const status = err.code === "insufficient_credits" ? 402 : 502;
      return sendError(res, status, err.message || "Image generation failed.", err.code);
    }
  }

  /* ---- Veo video ---- */
  if (method === "POST" && pathname === "/api/veo/generate") {
    const body = await readJSON(req);
    const prompt = String(body.prompt || "").trim();
    if (!prompt) return sendError(res, 400, "Prompt is required.");
    const seconds = Math.min(Math.max(Number(body.seconds) || 8, 4), VEO_PAID_MAX_SECONDS);
    const maxSec = (PLANS[user.plan] || PLANS.free).maxVideoSeconds || VEO_FREE_MAX_SECONDS;
    if (!planAllowsVeo(user.plan, seconds)) {
      if (seconds > maxSec) {
        return sendError(res, 402, "Your " + (PLANS[user.plan]?.name || "Free") + " plan allows videos up to " + Math.round(maxSec / 60) + " minutes. Upgrade to Go, Pro or VIP for up to 5 minute videos.");
      }
      return sendError(res, 402, "No Veo credits left on your plan. Upgrade to keep generating video.");
    }
    spendCredit(user.email, "veo", VEO_CREDIT_COST);
    try {
      const opName = await veoStart({ prompt, seconds });
      clearProviderIssue("veo", "video");
      const localId = "veo_" + crypto.randomBytes(8).toString("hex");
      veoOps.set(localId, {
        opName, email: user.email, prompt, status: "running",
        uris: [], error: null, createdAt: Date.now(),
      });
      const u = ensureUsage(user.email);
      u.calls.veo += 1;
      return sendJSON(res, 200, { ok: true, id: localId, status: "running", cost: 10, credits: u.credits });
    } catch (err) {
      refundCredit(user.email, "veo", 10);
      if (err.code !== "insufficient_credits") recordProviderIssue("veo", "video", err);
      const status = err.code === "insufficient_credits" ? 402 : 502;
      return sendError(res, status, err.message || "Veo submission failed.", err.code);
    }
  }
  if (method === "GET" && pathname === "/api/veo/status") {
    const id = query.get("id") || "";
    const op = veoOps.get(id);
    if (!op || op.email !== user.email) return sendError(res, 404, "Unknown Veo operation.");
    if (op.status === "running") {
      try {
        const s = await veoStatus(op.opName);
        if (s.done) {
          op.status = s.error ? "failed" : "done";
          op.uris = s.uris;
          op.error = s.error;
          if (s.error && s.error !== "Veo finished but returned no video.") {
            refundCredit(user.email, "veo", 10);
          } else if (s.error) {
            refundCredit(user.email, "veo", 10);
          }
        }
      } catch (err) {
        op.status = "failed";
        op.error = err.message;
        recordProviderIssue("veo", "video", err);
        refundCredit(user.email, "veo", 10);
      }
    }
    return sendJSON(res, 200, {
      ok: true, id, status: op.status, error: op.error,
      fileReady: op.uris.length > 0, credits: ensureUsage(user.email).credits,
    });
  }
  if (method === "GET" && pathname === "/api/veo/file") {
    const id = query.get("ref") || "";
    const idx = Number(query.get("i") || 0);
    const op = veoOps.get(id);
    if (!op || op.email !== user.email) return sendError(res, 404, "Unknown Veo operation.");
    const uri = op.uris[idx];
    if (!uri) return sendError(res, 404, "Video not ready.");
    try {
      const dl = await fetch(uri + (uri.includes("?") ? "&" : "?") + "key=" + encodeURIComponent(GEMINI_API_KEY), {
        signal: AbortSignal.timeout(120_000),
      });
      if (!dl.ok || !dl.body) return sendError(res, 502, "Video download failed.");
      res.writeHead(200, {
        "content-type": dl.headers.get("content-type") || "video/mp4",
        "cache-control": "private, max-age=3600",
        ...SECURITY_HEADERS,
      });
      const reader = dl.body.getReader();
      const pump = async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return res.end();
          if (!res.write(value)) {
            await new Promise((r) => res.once("drain", r));
          }
        }
      };
      req.on("close", () => reader.cancel().catch(() => {}));
      return pump();
    } catch (err) {
      return sendError(res, 502, "Video proxy failed: " + err.message);
    }
  }

  /* ---- checkout ---- */
  if (method === "POST" && pathname === "/api/checkout") {
    const body = await readJSON(req);
    const planKey = String(body.plan || "");
    if (!PLANS[planKey] || PLANS[planKey].price === 0) return sendError(res, 400, "Choose a paid plan (go, pro, vip).");
    if (stripeConfigured) {
      try {
        const session = await stripeOps.createCheckout({ planKey, user, origin });
        return sendJSON(res, 200, { ok: true, url: session.url, mode: "stripe" });
      } catch (err) {
        return sendError(res, 502, "Stripe checkout failed: " + err.message);
      }
    }
    if (!DEV_BILLING) return sendError(res, 403, "Billing is not configured.");
    // Dev simulation: instant upgrade, clearly flagged.
    user.plan = planKey;
    saveJSON(USERS_FILE, users);
    const u = ensureUsage(user.email);
    const wallet = (PLANS[planKey] || PLANS.free).wallet;
    for (const k of ["ai", "image", "veo"]) u.credits[k] = Math.max(u.credits[k], wallet[k]);
    return sendJSON(res, 200, { ok: true, devCheckout: true, plan: planKey, user: publicMe(user) });
  }

  return sendError(res, 404, "Unknown API route: " + method + " " + pathname);
}

const oauthStates = new Map(); // state → {at}

/* ══════════════════════════ 10. Static shell ═══════════════════════════ */

function serveShell(res) {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    ...SECURITY_HEADERS,
  });
  res.end(SPA_HTML);
}

/* ══════════════════════════ 11. Server ═════════════════════════════════ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://" + (req.headers.host || "localhost"));
  const pathname = decodeURIComponent(url.pathname);
  const origin = req.headers.origin
    ? String(req.headers.origin)
    : "http://" + (req.headers.host || "localhost:" + PORT);

  try {
    if (pathname.startsWith("/api/") || pathname === "/api") {
      if (rateLimited(req.socket.remoteAddress || "?")) {
        return sendError(res, 429, "Too many requests. Slow down.");
      }
      return await handleApi(req, res, pathname, url.searchParams, origin);
    }

    // Chrome DevTools workspace mapping (used by Codebuff/Chrome tooling)
    if (pathname === "/.well-known/appspecific/com.chrome.devtools.json") {
      return sendJSON(res, 200, {
        workspace: {
          root: process.cwd(),
          uuid: crypto.createHash("sha256").update(process.cwd()).digest("hex").slice(0, 32),
        },
      });
    }

    if (req.method === "GET" || req.method === "HEAD") {
      if (pathname === "/favicon.ico") {
        res.writeHead(204, SECURITY_HEADERS);
        return res.end();
      }
      return serveShell(res); // SPA fallback for all non-API GETs
    }

    return sendError(res, 405, "Method not allowed.");
  } catch (err) {
    const status = err?.status && Number.isInteger(err.status) ? err.status : 500;
    if (!res.headersSent) return sendError(res, status, err?.message || "Internal server error.");
    res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log("");
  console.log("  ✦ NEXUS AI UNIVERSAL STUDIO");
  console.log("    http://localhost:" + PORT + "   (bound to " + HOST + ") · v0.1 Alpha · by Rivansh Trivedi · v0.1 Alpha · by Rivansh Trivedi");
  console.log("    providers: openai " + (OPENAI_API_KEY ? "✓" : "—") + "  gemini " + (GEMINI_API_KEY ? "✓" : "—") + "  veo " + (GEMINI_API_KEY ? "✓" : "—"));
  console.log("    billing: " + (stripeConfigured ? "stripe" : "dev simulation") + "   auth: " + (DEV_AUTH ? "dev sessions" : "google oauth"));
  console.log("    data dir: " + DATA_DIR);
  console.log("");
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));

/* ════════════════════════════════════════════════════════════════════════
   12. Inline SPA — glassmorphism dark theme.
   NOTE: the client JS below intentionally avoids backticks and ${} so it
   can live inside this outer template literal without escaping hazards.
   ═══════════════════════════════════════════════════════════════════════ */
const SPA_HTML = `<!doctype html>
<html lang="en" class="dark">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>
<meta name="referrer" content="no-referrer"/>
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; media-src 'self' blob: data:; frame-src 'self' data: blob:; font-src 'self' data:"/>
<title>NEXUS AI UNIVERSAL STUDIO</title>
<meta name="description" content="Zero-dependency AI studio: text, image and video generation with plans, credit wallets and billing."/>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%23818cf8'/%3E%3Cstop offset='1' stop-color='%2322d3ee'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect x='4' y='4' width='56' height='56' rx='16' fill='%230b1020'/%3E%3Cpath d='M18 40 L32 16 L46 40 Z' fill='url(%23g)'/%3E%3Ccircle cx='32' cy='45' r='5' fill='url(%23g)'/%3E%3C/svg%3E"/>
<style>
:root{
  --bg:#05070f; --bg2:#0a0f1f;
  --glass:rgba(255,255,255,.045); --glass2:rgba(255,255,255,.08);
  --border:rgba(255,255,255,.09); --border2:rgba(255,255,255,.16);
  --text:#e8edfb; --muted:#93a0bf; --faint:#5b6785;
  --accent:#818cf8; --accent2:#22d3ee; --danger:#fb7185; --ok:#34d399; --warn:#fbbf24;
  --grad:linear-gradient(120deg,#818cf8,#22d3ee);
  --radius:18px; --shadow:0 18px 50px rgba(0,0,0,.45);
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{
  font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Inter,sans-serif;
  background:var(--bg); color:var(--text); overflow:hidden;
  -webkit-font-smoothing:antialiased;
}
/* animated aurora background */
.aurora{position:fixed;inset:0;z-index:0;overflow:hidden;pointer-events:none}
.aurora span{position:absolute;border-radius:50%;filter:blur(90px);opacity:.5;will-change:transform}
.aurora .a1{width:46vw;height:46vw;background:#312e81;top:-12%;left:-8%;animation:drift1 26s ease-in-out infinite alternate}
.aurora .a2{width:40vw;height:40vw;background:#0e7490;bottom:-14%;right:-6%;animation:drift2 32s ease-in-out infinite alternate}
.aurora .a3{width:28vw;height:28vw;background:#4c1d95;top:38%;left:56%;animation:drift3 38s ease-in-out infinite alternate;opacity:.35}
@keyframes drift1{to{transform:translate(9vw,7vh) scale(1.12)}}
@keyframes drift2{to{transform:translate(-8vw,-6vh) scale(1.08)}}
@keyframes drift3{to{transform:translate(-6vw,5vh) scale(1.15)}}
.reduce-motion .aurora span,.reduce-motion *{animation:none!important;transition:none!important}
@media (prefers-reduced-motion: reduce){.aurora span{animation:none!important}}
.grain{position:fixed;inset:0;z-index:0;pointer-events:none;opacity:.05;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence baseFrequency='.85' numOctaves='2'/%3E%3C/filter%3E%3Crect width='120' height='120' filter='url(%23n)' opacity='.6'/%3E%3C/svg%3E")}
/* layout */
.app{position:relative;z-index:1;display:grid;grid-template-rows:56px 1fr;height:100%}
.topbar{display:flex;align-items:center;gap:12px;padding:0 16px;
  background:rgba(8,11,22,.72);backdrop-filter:blur(18px) saturate(1.4);
  border-bottom:1px solid var(--border)}
.brand{display:flex;align-items:center;gap:9px;font-weight:800;letter-spacing:-.02em}
.brand .logo{width:26px;height:26px;border-radius:8px;background:var(--grad);display:grid;place-items:center;color:#0b1020;font-size:14px;font-weight:900}
.brand small{color:var(--faint);font-weight:600;font-size:11px;letter-spacing:.08em;text-transform:uppercase}
.pill{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;
  padding:4px 10px;border-radius:999px;border:1px solid var(--border2);color:var(--muted)}
.pill.plan-free{color:#a5b4fc;border-color:rgba(129,140,248,.4)}
.pill.plan-go{color:#67e8f9;border-color:rgba(34,211,238,.4)}
.pill.plan-pro{color:#c4b5fd;border-color:rgba(167,139,250,.5)}
.pill.plan-vip{color:#fcd34d;border-color:rgba(251,191,36,.5);background:rgba(251,191,36,.08)}
.chip{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--muted);
  padding:4px 9px;border-radius:999px;background:var(--glass);border:1px solid var(--border)}
.chip b{color:var(--text);font-variant-numeric:tabular-nums}
.chip .bar{width:34px;height:4px;border-radius:99px;background:rgba(255,255,255,.1);overflow:hidden}
.chip .bar i{display:block;height:100%;background:var(--grad);border-radius:99px}
.spacer{flex:1}
.iconbtn{width:34px;height:34px;border-radius:10px;border:1px solid var(--border);background:var(--glass);
  color:var(--muted);font-size:15px;cursor:pointer;display:grid;place-items:center;transition:.18s}
.iconbtn:hover{color:var(--text);border-color:var(--border2);background:var(--glass2)}
.body{display:grid;grid-template-columns:224px 1fr;min-height:0}
.rail{display:flex;flex-direction:column;gap:4px;padding:14px 10px;border-right:1px solid var(--border);
  background:rgba(8,11,22,.5);backdrop-filter:blur(14px);overflow-y:auto}
.nav{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:12px;border:1px solid transparent;
  color:var(--muted);font-size:13.5px;font-weight:600;cursor:pointer;background:none;text-align:left;transition:.18s;width:100%}
.nav:hover{color:var(--text);background:var(--glass)}
.nav.active{color:var(--text);background:var(--glass2);border-color:var(--border2)}
.nav .ic{width:20px;text-align:center;opacity:.9}
.rail .railhead{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);padding:10px 12px 4px}
.rail .foot{margin-top:auto;padding:12px;font-size:11px;color:var(--faint);line-height:1.5}
main{min-width:0;min-height:0;overflow-y:auto;padding:22px 26px 90px}
.view{max-width:980px;margin:0 auto;display:grid;gap:16px}
h1.vt{font-size:22px;font-weight:800;letter-spacing:-.02em}
h1.vt small{display:block;font-size:12.5px;color:var(--muted);font-weight:500;margin-top:4px;letter-spacing:0}
.card{background:var(--glass);border:1px solid var(--border);border-radius:var(--radius);
  backdrop-filter:blur(18px) saturate(1.3);box-shadow:var(--shadow)}
.card.pad{padding:18px}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
label.fl{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);font-weight:700;display:block;margin:0 0 6px 2px}
input[type=text],input[type=email],input[type=password],textarea,select{
  width:100%;background:rgba(6,9,18,.6);border:1px solid var(--border);color:var(--text);
  border-radius:12px;padding:10px 13px;font-size:14px;font-family:inherit;outline:none;transition:.18s}
input:focus,textarea:focus,select:focus{border-color:rgba(129,140,248,.55);box-shadow:0 0 0 3px rgba(129,140,248,.14)}
textarea{resize:vertical;min-height:96px;line-height:1.55}
select option{background:#0b1020;color:var(--text)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;border:none;cursor:pointer;
  font-family:inherit;font-size:13.5px;font-weight:700;padding:10px 18px;border-radius:12px;transition:.18s;
  background:var(--grad);color:#0b1020}
.btn:hover{filter:brightness(1.1);transform:translateY(-1px)}
.btn:active{transform:translateY(0)}
.btn:disabled{opacity:.45;cursor:not-allowed;transform:none}
.btn.ghost{background:var(--glass);border:1px solid var(--border2);color:var(--text)}
.btn.ghost:hover{background:var(--glass2)}
.btn.danger{background:rgba(251,113,133,.14);border:1px solid rgba(251,113,133,.4);color:#fda4af}
.btn.sm{padding:7px 13px;font-size:12.5px;border-radius:10px}
.msgs{display:grid;gap:12px;padding:4px 0}
.msg{max-width:84%;padding:11px 15px;border-radius:16px;font-size:14px;line-height:1.6;white-space:pre-wrap;word-break:break-word}
.msg.user{justify-self:end;background:linear-gradient(120deg,rgba(129,140,248,.22),rgba(34,211,238,.16));border:1px solid rgba(129,140,248,.3)}
.msg.ai{justify-self:start;background:var(--glass);border:1px solid var(--border)}
.msg .meta{font-size:10.5px;color:var(--faint);margin-top:7px;letter-spacing:.04em}
.output{background:rgba(4,6,12,.65);border:1px solid var(--border);border-radius:14px;padding:16px;
  font-size:14px;line-height:1.65;white-space:pre-wrap;word-break:break-word;max-height:420px;overflow-y:auto}
.output.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px}
.imgwrap{display:grid;place-items:center;padding:12px}
.imgwrap img{max-width:100%;max-width:520px;border-radius:14px;border:1px solid var(--border2)}
.video-wrap video{width:100%;max-width:640px;border-radius:14px;border:1px solid var(--border2);background:#000}
.hint{font-size:12px;color:var(--faint);line-height:1.55}
.err{background:rgba(251,113,133,.1);border:1px solid rgba(251,113,133,.35);color:#fda4af;
  padding:10px 14px;border-radius:12px;font-size:13px;line-height:1.5}
.oknote{background:rgba(52,211,153,.09);border:1px solid rgba(52,211,153,.3);color:#6ee7b7;
  padding:10px 14px;border-radius:12px;font-size:13px}
.lock{font-size:10px;padding:2px 7px;border-radius:99px;background:rgba(251,191,36,.12);
  border:1px solid rgba(251,191,36,.35);color:#fcd34d;font-weight:700;letter-spacing:.05em}
.plans{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:14px}
.plan{padding:18px;display:flex;flex-direction:column;gap:10px;position:relative}
.plan.current{border-color:rgba(129,140,248,.6);box-shadow:0 0 0 1px rgba(129,140,248,.35),var(--shadow)}
.plan .pname{font-weight:800;font-size:16px}
.plan .pprice{font-size:26px;font-weight:800;letter-spacing:-.03em}
.plan .pprice span{font-size:12px;color:var(--faint);font-weight:600}
.plan ul{list-style:none;display:grid;gap:6px;font-size:12.5px;color:var(--muted)}
.plan ul li:before{content:"✦ ";color:var(--accent)}
.plan .badge{position:absolute;top:-10px;right:14px;font-size:10px;font-weight:800;letter-spacing:.08em;
  text-transform:uppercase;background:var(--grad);color:#0b1020;padding:4px 10px;border-radius:99px}
.toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%) translateY(20px);z-index:60;
  background:rgba(10,14,26,.92);border:1px solid var(--border2);color:var(--text);padding:11px 18px;
  border-radius:14px;font-size:13.5px;opacity:0;pointer-events:none;transition:.25s;backdrop-filter:blur(14px);
  box-shadow:var(--shadow);max-width:88vw}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
.toast.err{border-color:rgba(251,113,133,.5)}
.overlay{position:fixed;inset:0;z-index:50;background:rgba(3,5,10,.6);backdrop-filter:blur(6px);
  display:grid;place-items:center;padding:20px}
.overlay .sheet{width:min(520px,94vw);max-height:86vh;overflow-y:auto;padding:22px}
.overlay.hidden{display:none}
.authwrap{min-height:calc(100vh - 56px);display:grid;place-items:center;padding:20px}
.authcard{width:min(420px,94vw);padding:26px;display:grid;gap:14px;text-align:center}
.authcard h2{font-size:20px;font-weight:800;letter-spacing:-.02em}
.authcard p{font-size:13px;color:var(--muted);line-height:1.55}
.or{display:flex;align-items:center;gap:10px;color:var(--faint);font-size:11px;letter-spacing:.1em}
.or:before,.or:after{content:"";flex:1;height:1px;background:var(--border)}
.playground iframe{width:100%;height:420px;border:none;border-radius:14px;background:#fff}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px}
.stat{padding:14px;border-radius:14px;background:var(--glass);border:1px solid var(--border)}
.stat b{display:block;font-size:22px;font-variant-numeric:tabular-nums}
.stat span{font-size:11px;color:var(--faint);letter-spacing:.06em;text-transform:uppercase;font-weight:700}
.pgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.pal{position:fixed;inset:0;z-index:70;background:rgba(3,5,10,.65);backdrop-filter:blur(6px);display:grid;place-items:start center;padding-top:12vh}
.pal.hidden{display:none}
.pal .sheet{width:min(560px,92vw);padding:12px}
.pal input{margin-bottom:8px}
.pal .cmd{display:flex;align-items:center;gap:10px;width:100%;padding:10px 12px;border-radius:10px;border:none;background:none;color:var(--text);font-size:14px;cursor:pointer;text-align:left;font-family:inherit}
.pal .cmd:hover{background:var(--glass2)}
/* mobile bottom nav */
.bottomnav{display:none}
@media (max-width:880px){
  .body{grid-template-columns:1fr}
  .rail{display:none}
  main{padding:16px 14px 110px}
  .bottomnav{display:flex;position:fixed;left:10px;right:10px;bottom:10px;z-index:40;
    background:rgba(10,14,26,.9);backdrop-filter:blur(20px) saturate(1.5);border:1px solid var(--border2);
    border-radius:18px;padding:8px;gap:2px;box-shadow:var(--shadow);overflow-x:auto}
  .bottomnav .nav{flex-direction:column;gap:3px;font-size:10px;padding:8px 10px;border-radius:12px;min-width:62px;align-items:center;text-align:center}
  .bottomnav .nav .ic{font-size:17px}
  .chip{font-size:10.5px}
  .hide-sm{display:none}
}
.touch .btn,.touch .nav,.touch .iconbtn{min-height:44px}
</style>
</head>
<body>
<div class="aurora"><span class="a1"></span><span class="a2"></span><span class="a3"></span></div>
<div class="grain"></div>
<div id="app"></div>
<div class="toast" id="toast"></div>
<script>
(function(){
"use strict";
var S = { me:null, settings:null, view:"chat", thread:[], busy:false, veoPoll:null, playgroundSrc:"" };
function $(s){ return document.querySelector(s); }
function esc(s){ return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function api(path, opts){
  opts = opts || {};
  opts.headers = Object.assign({"Content-Type":"application/json"}, opts.headers||{});
  return fetch(path, opts).then(function(r){
    return r.text().then(function(t){
      var j = null; try{ j = t?JSON.parse(t):null; }catch(e){}
      if(!r.ok){ var err = new Error((j&&j.error)||("HTTP "+r.status)); err.status=r.status; err.body=j; throw err; }
      return j;
    });
  });
}
var toastTimer=null;
function toast(msg, isErr){
  var el=$("#toast"); el.textContent=msg; el.className="toast show"+(isErr?" err":"");
  clearTimeout(toastTimer); toastTimer=setTimeout(function(){ el.className="toast"; }, 3400);
}
function copy(text){
  if(navigator.clipboard&&navigator.clipboard.writeText){ navigator.clipboard.writeText(text).then(function(){toast("Copied to clipboard");},function(){toast("Copy failed",true);}); }
  else toast("Clipboard unavailable",true);
}
function refreshMotion(){
  var pref=null; try{ pref=localStorage.getItem("omni-reduce-motion"); }catch(e){}
  var reduce = pref==="1" || (pref===null && window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  document.documentElement.classList.toggle("reduce-motion", !!reduce);
  if(window.matchMedia&&window.matchMedia("(pointer: coarse)").matches) document.documentElement.classList.add("touch");
}

/* ── nav model ─────────────────────────────────────────── */
var NAV=[
 {k:"dashboard",ic:"◈", label:"Dashboard"},
 {k:"chat",   ic:"✦", label:"Smart Merge"},
 {k:"doc",    ic:"📄", label:"Document"},
 {k:"research",ic:"🔬", label:"Research"},
 {k:"app",    ic:"🧩", label:"App Builder"},
 {k:"image",  ic:"🎨", label:"Vision"},
 {k:"video",  ic:"🎬", label:"Video"},
 {k:"play",   ic:"⚗️", label:"Playground"},
 {k:"billing",ic:"💳", label:"Billing"}
];
function planAllowsProvider(p){
  if(!S.me) return false;
  if(p==="auto"||p==="openai") return true;
  if(p==="gemini") return S.me.plan!=="free";
  return false;
}
function currentPlan(){
  var plans=(S.settings&&S.settings.plans)||[];
  for(var i=0;i<plans.length;i++){ if(plans[i].key===(S.me&&S.me.plan)) return plans[i]; }
  return {key:"free",name:"Free",wallet:{ai:20,image:5,veo:1},maxVideoSeconds:120};
}
function planAllowsVeo(seconds){
  if(!S.me) return false;
  if(seconds&&seconds>0) return seconds<=(currentPlan().maxVideoSeconds||120);
  return S.me.credits.veo>0;
}
function providerOptions(sel){
  var opts=[["auto","Auto (OpenAI → Gemini)"],["openai","OpenAI · "+prov("openai").textModel],["gemini","Gemini · "+prov("gemini").textModel]];
  return opts.map(function(o){
    var ok=planAllowsProvider(o[0]);
    return '<option value="'+o[0]+'"'+(sel===o[0]?" selected":"")+(ok?"":" disabled")+'>'+o[1]+(ok?"":"  🔒")+'</option>';
  }).join("");
}
function prov(name){ return (S.settings&&S.settings.providers[name])||{configured:false,textModel:"",imageModel:""}; }
function providerTag(p){ return p==="openai"?"OpenAI":(p==="gemini"?"Gemini":"Auto"); }

/* ── top-level render ──────────────────────────────────── */
function render(){
  refreshMotion();
  var app=$("#app");
  var top =
   '<header class="topbar">'+
     '<div class="brand"><span class="logo">◆</span> NEXUS <small class="hide-sm">AI Universal Studio</small></div>'+
     (S.me?'<span class="pill plan-'+S.me.plan+'">'+esc(S.me.planName)+'</span>'+
       '<span class="chip hide-sm" title="AI credits">✦ <b>'+S.me.credits.ai+'</b><span class="bar"><i style="width:'+barPct("ai")+'%"></i></span></span>'+
       '<span class="chip hide-sm" title="Image credits">🎨 <b>'+S.me.credits.image+'</b></span>'+
       '<span class="chip hide-sm" title="Veo credits">🎬 <b>'+S.me.credits.veo+'</b></span>'
      :'<span class="pill">Signed out</span>')+
     '<div class="spacer"></div>'+
     '<button class="iconbtn" id="btn-settings" title="Settings">⚙</button>'+
   '</header>';
  if(!S.me){
    app.innerHTML = top + '<div class="authwrap">'+authCard()+'</div>'+overlayHtml()+'<nav class="bottomnav"></nav>';
    bindAuth(); bindOverlay(); return;
  }
  var rail = '<aside class="rail"><div class="railhead">Studio</div>';
  NAV.forEach(function(n){
    rail += '<button class="nav'+(S.view===n.k?" active":"")+'" data-view="'+n.k+'"><span class="ic">'+n.ic+'</span>'+n.label+'</button>';
  });
  rail += '<div class="foot">Nexus build<br>v0.1 Alpha · '+(S.settings&&S.settings.billingMode==="stripe"?"Stripe billing":"dev billing")+'</div></aside>';
  app.innerHTML = top + '<div class="body">'+rail+'<main><div class="view" id="view">'+viewHtml(S.view)+'</div></main></div>'+overlayHtml()+bottomNav();
  bindNav(); bindOverlay(); bindView(S.view);
}
function barPct(kind){
  if(!S.me||!S.settings) return 0;
  var plan=S.settings.plans.filter(function(p){return p.key===S.me.plan;})[0];
  var w=plan?plan.wallet[kind]||0:0;
  if(!w) return 0;
  return Math.max(4, Math.round(100*S.me.credits[kind]/w));
}
function bottomNav(){
  var h='<nav class="bottomnav">';
  NAV.forEach(function(n){
    h+='<button class="nav'+(S.view===n.k?" active":"")+'" data-view="'+n.k+'"><span class="ic">'+n.ic+'</span>'+n.label+'</button>';
  });
  return h+'</nav>';
}
function bindNav(){
  var btns=document.querySelectorAll(".nav[data-view]");
  for(var i=0;i<btns.length;i++){
    btns[i].addEventListener("click", function(){
      S.view=this.getAttribute("data-view");
      try{ localStorage.setItem("nexus-view",S.view); localStorage.setItem("nexus-last",JSON.stringify({view:S.view,label:(this.textContent||"").trim(),at:new Date().toLocaleTimeString()})); }catch(e){}
      if(S.veoPoll){ clearInterval(S.veoPoll); S.veoPoll=null; }
      render();
    });
  }
}

/* ── auth card ─────────────────────────────────────────── */
function authCard(){
  return '<div class="card authcard">'+
    '<div class="brand" style="justify-content:center"><span class="logo">◆</span> NEXUS <small>AI Universal Studio</small></div>'+
    '<h2>Welcome to the Studio</h2>'+
    '<p>Text · Image · Video generation with credit wallets and plans. Start instantly with a dev session'+
    (S.settings&&S.settings.google.enabled?', or continue with Google.':'.')+'</p>'+
    (S.settings&&S.settings.google.enabled?'<button class="btn ghost" id="btn-google">Continue with Google</button><div class="or">or</div>':"")+
    (S.settings&&S.settings.devAuth
      ?'<input type="email" id="auth-email" placeholder="you@company.com" autocomplete="email"/>'+
       '<button class="btn" id="btn-devlogin">Start creating →</button>'+
       '<div class="hint">Dev session auth — replace with your identity provider before production.</div>'
      :'<div class="hint">Dev auth is disabled. Use Google sign-in.</div>')+
    '</div>';
}
function bindAuth(){
  var dl=$("#btn-devlogin");
  if(dl) dl.addEventListener("click", function(){
    var email=($("#auth-email").value||"").trim();
    if(!email){ toast("Enter your email first",true); return; }
    api("/api/auth/dev-login",{method:"POST",body:JSON.stringify({email:email})})
      .then(function(r){ S.me=r.user; toast("Welcome, "+r.user.name); S.view="chat"; render(); loadMe(); })
      .catch(function(e){ toast(e.message,true); });
  });
  var gg=$("#btn-google");
  if(gg) gg.addEventListener("click", function(){ location.href="/api/auth/google/start"; });
}

/* ── views ─────────────────────────────────────────────── */
function viewHtml(v){
  if(v==="dashboard") return dashboardView();
  if(v==="chat")    return chatView();
  if(v==="doc")     return toolView("doc");
  if(v==="research")return toolView("research");
  if(v==="app")     return toolView("app");
  if(v==="image")   return imageView();
  if(v==="video")   return videoView();
  if(v==="play")    return playgroundView();
  if(v==="billing") return billingView();
  return chatView();
}
function genHeader(title, sub, withProvider, provSel){
  return '<div class="row" style="justify-content:space-between">'+
    '<h1 class="vt">'+title+'<small>'+sub+'</small></h1>'+
    (withProvider?'<select id="provider" style="max-width:250px">'+providerOptions(provSel||"auto")+'</select>':"")+
    '</div>';
}
function dashboardView(){
  var last=null; try{ last=JSON.parse(localStorage.getItem("nexus-last")||"null"); }catch(e){}
  return genHeader("Dashboard","Your Nexus home — continue where you left off","")+
    '<div class="plans">'+
      '<div class="card plan"><div class="pname">Quick Actions</div>'+
        '<div class="row">'+
        '<button class="btn sm qa" data-view="chat">✦ New Chat</button>'+
        '<button class="btn ghost sm qa" data-view="image">🎨 Generate Image</button>'+
        '<button class="btn ghost sm qa" data-view="video">🎬 Generate Video</button>'+
        '<button class="btn ghost sm qa" data-view="billing">💳 Upgrade</button>'+
        '</div></div>'+
      '<div class="card plan"><div class="pname">Continue Working</div>'+
        '<div class="hint">'+(last?("Last studio: "+esc(last.label||last.view)+" · "+esc(last.at||"")):"No recent activity yet — pick a studio to begin.")+'</div>'+
        (last?'<button class="btn sm qa" data-view="'+esc(last.view)+'">Resume →</button>':"")+
      '</div>'+
      '<div class="card plan"><div class="pname">System Status</div>'+
        '<div class="hint" id="dash-status"></div></div>'+
    '</div>'+
    '<div class="card pad"><label class="fl">Analyze Screen (AI)</label>'+
      '<div class="hint" style="margin-bottom:10px">Nexus gathers structured app context — current studio, plan, credits, provider state — and sends it to the assistant for a SUMMARY / ISSUES / SUGGESTIONS / ACTIONS report.</div>'+
      '<button class="btn" id="analyze-run" '+(S.busy?"disabled":"")+'>Analyze Screen ✦</button>'+
      '<div id="analyze-out" style="margin-top:12px"></div></div>';
}
function palCmds(){ return [
  {t:"◈ Open Dashboard",fn:function(){ S.view="dashboard"; render(); }},
  {t:"✦ Smart Merge (Chat)",fn:function(){ S.view="chat"; render(); }},
  {t:"📄 Document Studio",fn:function(){ S.view="doc"; render(); }},
  {t:"🔬 Research Desk",fn:function(){ S.view="research"; render(); }},
  {t:"🧩 App Builder",fn:function(){ S.view="app"; render(); }},
  {t:"🎨 Image Studio",fn:function(){ S.view="image"; render(); }},
  {t:"🎬 Video Studio",fn:function(){ S.view="video"; render(); }},
  {t:"⚗️ Playground",fn:function(){ S.view="play"; render(); }},
  {t:"💳 Plans & Billing",fn:function(){ S.view="billing"; render(); }},
  {t:"⚙ Settings",fn:function(){ var b=document.getElementById("btn-settings"); if(b) b.click(); }},
];}
function togglePalette(){
  var ex=document.getElementById("pal");
  if(ex){ ex.classList.toggle("hidden"); var inp=ex.querySelector("input"); if(inp&&!ex.classList.contains("hidden")) inp.focus(); return; }
  var ov=document.createElement("div"); ov.id="pal"; ov.className="pal";
  ov.innerHTML='<div class="card sheet"><input type="text" id="pal-q" placeholder="Type a command…  (Ctrl+K)"/><div id="pal-list"></div></div>';
  document.body.appendChild(ov);
  ov.addEventListener("click",function(e){ if(e.target===ov) ov.classList.add("hidden"); });
  var q=ov.querySelector("#pal-q"), list=ov.querySelector("#pal-list");
  function draw(){
    var f=(q.value||"").toLowerCase();
    var cmds=palCmds().filter(function(c){ return !f||c.t.toLowerCase().indexOf(f)>=0; });
    list.innerHTML=cmds.map(function(c,i){ return '<button class="cmd" data-i="'+i+'">'+esc(c.t)+'</button>'; }).join("")||'<div class="hint" style="padding:8px">No matches</div>';
    var bs=list.querySelectorAll(".cmd");
    for(var i=0;i<bs.length;i++){ bs[i].addEventListener("click",function(){ cmds[Number(this.getAttribute("data-i"))].fn(); ov.classList.add("hidden"); }); }
  }
  q.addEventListener("input",draw); draw(); q.focus();
}
function chatView(){
  return genHeader("Smart Merge Studio","Conversational generation with automatic provider fallback",true)+
    '<div class="card pad"><div class="msgs" id="msgs">'+
      (S.thread.length?S.thread.map(msgHtml).join(""):'<div class="hint">Ask anything. Auto mode tries OpenAI first, then falls back to Gemini when your plan allows it.</div>')+
    '</div></div>'+
    '<div class="card pad"><div class="row">'+
      '<textarea id="chat-in" placeholder="Message the studio…  (Enter to send, Shift+Enter for newline)" style="flex:1;min-height:64px"></textarea>'+
    '</div><div class="row" style="margin-top:10px;justify-content:flex-end">'+
      (S.thread.length?'<button class="btn ghost sm" id="chat-clear">Clear</button>':"")+
      '<button class="btn" id="chat-send" '+(S.busy?"disabled":"")+'>'+(S.busy?"Thinking…":"Send ✦")+'</button>'+
    '</div></div>';
}
function msgHtml(m){
  if(m.role==="user") return '<div class="msg user">'+esc(m.text)+'</div>';
  return '<div class="msg ai">'+esc(m.text)+
    '<div class="meta">'+providerTag(m.provider)+' · '+esc(m.model||"")+' · 1 AI credit</div></div>';
}
var TOOLS={
 doc:{ title:"Document Studio", sub:"Draft specs, posts and emails with one prompt",
   presets:[["Blog post outline","Write a tight outline for a blog post about"],["Product spec","Write a crisp product spec for"],["Professional email","Draft a professional, friendly email about"]],
   tpl:function(topic,p){ return p+" "+topic+". Use clear structure, headings, and a strong close."; } },
 research:{ title:"Research Desk", sub:"Structured briefs, comparisons and summaries",
   presets:[["Competitive brief","Build a competitive research brief for"],["Explainer","Explain simply, with structure:"],["Pros & cons","Give a balanced pros/cons analysis of"]],
   tpl:function(topic,p){ return p+" "+topic+". Structure: summary, key findings, risks, open questions. Note where sources would be needed."; } },
 app:{ title:"App Builder", sub:"Describe an app — get a single-file HTML prototype",
   presets:[["Landing page","A landing page for"],["Mini game","A playable browser mini game:"],"Dashboard".toLowerCase()],
   tpl:function(topic){ return "Build a complete single-file HTML app (inline CSS/JS, dark theme): "+topic+". Return ONLY the HTML inside a single \x60\x60\x60html code block."; } }
};
function toolView(kind){
  var t=TOOLS[kind];
  var presets=t.presets.map(function(p,i){
    var label=Array.isArray(p)?p[0]:p, phrase=Array.isArray(p)?p[1]:p;
    return '<button class="btn ghost sm preset" data-i="'+i+'">'+esc(label)+'</button>';
  }).join("");
  return genHeader(t.title,t.sub,true)+
    '<div class="card pad"><label class="fl">Topic</label>'+
    '<input type="text" id="tool-topic" placeholder="Describe what you need…"/>'+
    '<div class="row" style="margin-top:10px">'+presets+'</div>'+
    '<div class="row" style="margin-top:14px;justify-content:flex-end">'+
      '<button class="btn" id="tool-run" '+(S.busy?"disabled":"")+'>'+(S.busy?"Working…":"Generate ✦")+'</button></div></div>'+
    '<div id="tool-out"></div>';
}
function imageView(){
  return genHeader("Image Studio","Text-to-image with GPT-Image-2 and Gemini Flash Image",true,"openai")+
    '<div class="card pad"><label class="fl">Prompt Builder</label>'+
    '<div class="pgrid">'+
      '<input type="text" id="img-subject" placeholder="Subject — a glass fox sculpture"/>'+
      '<input type="text" id="img-style" placeholder="Style — cinematic, anime, watercolor"/>'+
      '<input type="text" id="img-light" placeholder="Lighting — golden hour, neon rim"/>'+
      '<input type="text" id="img-cam" placeholder="Camera — 85mm, macro, aerial"/>'+
      '<input type="text" id="img-mood" placeholder="Mood — serene, ominous, playful"/>'+
    '</div>'+
    '<label class="fl" style="margin-top:12px">Negative prompt (things to avoid)</label>'+
    '<input type="text" id="img-negative" placeholder="blurry, low quality, distorted hands"/>'+
    '<label class="fl" style="margin-top:12px">Full prompt (optional, overrides builder)</label>'+
    '<textarea id="img-prompt" placeholder="A glass sculpture of a fox on a dark pedestal, cinematic rim light…"></textarea>'+
    '<div class="row" style="margin-top:12px;justify-content:space-between">'+
      '<select id="img-size" style="max-width:170px"><option value="1024x1024">1024 × 1024</option><option value="1536x1024">1536 × 1024</option><option value="1024x1536">1024 × 1536</option></select>'+
      '<button class="btn" id="img-run" '+(S.busy?"disabled":"")+'>'+(S.busy?"Rendering…":"Generate 🎨")+'</button>'+
    '</div><div class="hint" style="margin-top:8px">1 image credit per render · failed renders are refunded automatically.</div></div>'+
    '<div id="img-out"></div>';
}
function videoView(){
  var plan=currentPlan();
  var vLim=(S.settings&&S.settings.videoLimits)||{freeMaxSeconds:120,paidMaxSeconds:300,costPerVideo:10};
  var maxS=plan.maxVideoSeconds||vLim.freeMaxSeconds;
  var can=S.me&&S.me.credits.veo>0;
  var opts=[[8,"8 seconds"],[30,"30 seconds"],[60,"1 minute"],[120,"2 minutes"],[180,"3 minutes"],[240,"4 minutes"],[300,"5 minutes"]];
  var sel='<select id="veo-dur" style="max-width:190px">'+
    opts.map(function(o){ return '<option value="'+o[0]+'"'+(o[0]>maxS?" disabled":"")+(o[0]===8?" selected":"")+'>'+o[1]+(o[0]>maxS?"  🔒":"")+'</option>'; }).join("")+'</select>';
  return genHeader("Video Studio","Cinematic text-to-video via Veo 3.1 long-running operations","")+
    '<div class="card pad">'+
    (can
      ?'<label class="fl">Scene prompt</label>'+
       '<textarea id="veo-prompt" placeholder="A neon koi swimming through a rainy cyberpunk alley, slow motion, reflections…"></textarea>'+
       '<div class="row" style="margin-top:12px">'+
        '<label class="fl" style="margin:0 6px 0 0">Duration</label>'+sel+
        '<span class="hint">'+esc(plan.videoLabel||("up to "+Math.round(maxS/60)+" min"))+' · '+vLim.costPerVideo+' Veo credits per video</span></div>'+
       '<div class="row" style="margin-top:12px;justify-content:flex-end">'+
        '<button class="btn" id="veo-run" '+(S.busy?"disabled":"")+'>Generate 🎬</button></div>'+
       '<div class="hint" style="margin-top:8px">Veo runs asynchronously — keep this tab open and we will poll the operation for you. Longer durations take longer to render.</div>'
      :'<div class="err">You are out of Veo credits on the '+esc(S.me.planName||"Free")+' plan. <b>Upgrade to Go, Pro or VIP</b> in Billing for up to 5 minute videos.</div>')+
    '</div><div id="veo-out"></div>';
}
function playgroundView(){
  return genHeader("Playground","Sandboxed iframe — prototype HTML safely (no access to this page)","")+
    '<div class="card pad playground"><label class="fl">HTML source</label>'+
    '<textarea id="pg-src" class="mono" style="min-height:150px" spellcheck="false">'+
    esc(S.playgroundSrc||"<!doctype html>\\n<html>\\n<body style=\\"font-family:sans-serif;background:#0b1020;color:#e2e8f0;display:grid;place-items:center;height:100vh\\">\\n  <h1>Hello from the sandbox 🧪</h1>\\n</body>\\n</html>")+
    '</textarea><div class="row" style="margin-top:10px;justify-content:flex-end">'+
    '<button class="btn ghost sm" id="pg-clear">Reset</button>'+
    '<button class="btn sm" id="pg-run">Run ▶</button></div>'+
    '<div style="margin-top:12px"><iframe id="pg-frame" sandbox="allow-scripts" title="Sandbox preview"></iframe></div></div>';
}
function providerIssueHintHtml(){
  var issues=(S.settings&&Array.isArray(S.settings.providerIssues))?S.settings.providerIssues:[];
  var unconfigured=[];
  if(S.me){
    if(!prov("openai").configured) unconfigured.push("OpenAI (OPENAI_API_KEY)");
    if(!prov("gemini").configured) unconfigured.push("Gemini (GEMINI_API_KEY)");
  }
  if(!issues.length&&!unconfigured.length) return "";
  var items=[];
  for(var i=0;i<unconfigured.length;i++){
    items.push('<div style="margin-top:8px"><b>'+esc(unconfigured[i])+' not configured</b><div class="hint">Add the API key and restart — then run a generation to see live provider status here.</div></div>');
  }
  issues.forEach(function(iss){
    if(/not configured/i.test(iss.message||"")) return;
    var label=String(iss.provider||"").toUpperCase()+" · "+iss.capability;
    items.push('<div style="margin-top:8px"><b>'+esc(label)+'</b> <span class="badge">'+esc(iss.kind||"error")+'</span>'+
      '<div class="err">'+esc(iss.message||"")+'</div>'+
      '<div class="hint">Last seen '+esc(String(iss.at||"").replace("T"," ").slice(0,19))+' UTC'+(iss.status?' · HTTP '+esc(String(iss.status)):'')+'</div></div>');
  });
  return '<div class="card pad" id="provider-issues"><h1 class="vt" style="font-size:16px">⚠️ Provider issues</h1>'+
    '<div class="hint">The exact errors each provider returned — usually billing or quota on your API account, not app bugs.</div>'+
    items.join("")+'</div>';
}
function billingView(){
  var plans=S.settings?S.settings.plans:[];
  var stripe=S.settings&&S.settings.billingMode==="stripe";
  var cards=plans.map(function(p){
    var cur=S.me.plan===p.key;
    return '<div class="card plan'+(cur?" current":"")+'">'+
      (cur?'<span class="badge">Current</span>':"")+
      '<div class="pname">'+esc(p.name)+'</div>'+
      '<div class="pprice">$'+p.price+'<span>/mo</span></div>'+
      '<div class="hint">'+esc(p.tagline)+'</div>'+
      '<ul>'+p.features.map(function(f){return "<li>"+esc(f)+"</li>";}).join("")+'</ul>'+
      '<div class="hint">✦ '+p.wallet.ai+' AI · 🎨 '+p.wallet.image+' · 🎬 '+p.wallet.veo+' Veo credits /mo</div>'+
      (cur?'<button class="btn ghost sm" disabled>Active plan</button>'
          :(p.price===0?'<button class="btn ghost sm" id="downgrade">Downgrade</button>'
          :'<button class="btn sm upgrade" data-plan="'+p.key+'">Upgrade to '+esc(p.name)+'</button>'))+
      '</div>';
  }).join("");
  return genHeader("Plans & Billing","Server-enforced plans with monthly credit wallets","")+
    (stripe?'<div class="oknote">Stripe billing is active — upgrades open a secure Stripe Checkout.</div>'
           :'<div class="hint">Running in dev billing simulation: upgrades apply instantly and cost nothing. Add STRIPE_SECRET_KEY to switch to real Stripe Checkout.</div>')+
    '<div class="plans">'+cards+'</div>'+
    providerIssueHintHtml()+
    (S.settings&&S.settings.accessCodeEnabled
      ?'<div class="card pad"><label class="fl">Have an access code?</label>'+
       '<div class="hint" style="margin-bottom:10px">Enter the code you received to unlock Go, Pro or VIP instantly — credits top up to the chosen plan.</div>'+
       '<div class="row">'+
       '<select id="access-plan" style="max-width:160px"><option value="go">Go</option><option value="pro" selected>Pro</option><option value="vip">VIP</option></select>'+
       '<input type="password" id="access-code" placeholder="Access code" style="max-width:220px"/>'+
       '<button class="btn sm" id="access-unlock">Unlock</button></div></div>' :"")+
    '<div class="card pad"><h1 class="vt" style="font-size:16px">Usage this month</h1><div class="stats" style="margin-top:10px">'+
      '<div class="stat"><b>'+S.me.used.ai+'</b><span>AI calls</span></div>'+
      '<div class="stat"><b>'+S.me.used.image+'</b><span>Images</span></div>'+
      '<div class="stat"><b>'+S.me.used.veo+'</b><span>Veo ops</span></div>'+
      '<div class="stat"><b>'+S.me.credits.ai+'</b><span>AI left</span></div>'+
    '</div></div>';
}

/* ── settings overlay ──────────────────────────────────── */
function overlayHtml(){
  return '<div class="overlay hidden" id="overlay"><div class="card sheet">'+
    '<div class="row" style="justify-content:space-between"><h1 class="vt" style="font-size:18px">Settings</h1>'+
    '<button class="iconbtn" id="ov-close">✕</button></div>'+
    '<div style="display:grid;gap:14px;margin-top:16px">'+
      '<div class="card pad"><b style="font-size:13px">Session</b><div class="hint" style="margin-top:6px" id="ov-session"></div>'+
        '<button class="btn danger sm" id="ov-logout" style="margin-top:10px">Sign out</button></div>'+
      '<div class="card pad"><b style="font-size:13px">Motion</b><div class="hint" style="margin-top:6px">Reduce animated backgrounds and transitions.</div>'+
        '<button class="btn ghost sm" id="ov-motion" style="margin-top:10px">Toggle reduced motion</button></div>'+
      '<div class="card pad"><b style="font-size:13px">Providers</b><div class="hint" style="margin-top:6px" id="ov-prov"></div></div>'+
    '</div></div></div>';
}
function bindOverlay(){
  var ov=$("#overlay"); if(!ov) return;
  $("#btn-settings").addEventListener("click",function(){
    var sess=$("#ov-session"), pr=$("#ov-prov");
    if(sess&&S.me) sess.textContent=S.me.email+" · "+S.me.planName+" plan";
    if(pr) pr.textContent="OpenAI "+(prov("openai").configured?"✓":"—")+" · Gemini "+(prov("gemini").configured?"✓":"—")+" · Veo "+(prov("veo").configured?"✓":"—");
    ov.classList.remove("hidden");
  });
  $("#ov-close").addEventListener("click",function(){ ov.classList.add("hidden"); });
  ov.addEventListener("click",function(e){ if(e.target===ov) ov.classList.add("hidden"); });
  $("#ov-logout").addEventListener("click",function(){
    api("/api/auth/logout",{method:"POST"}).then(function(){ S.me=null; S.thread=[]; render(); }).catch(function(e){ toast(e.message,true); });
  });
  $("#ov-motion").addEventListener("click",function(){
    var cur="0"; try{ cur=localStorage.getItem("omni-reduce-motion")||"0"; }catch(e){}
    try{ localStorage.setItem("omni-reduce-motion", cur==="1"?"0":"1"); }catch(e){}
    refreshMotion(); toast("Motion preference saved");
  });
}

/* ── per-view behaviour ────────────────────────────────── */
function refreshMe(){
  return api("/api/me").then(function(me){ S.me=me; renderTopOnly(); }).catch(function(){});
}
function renderTopOnly(){
  // lightweight: re-render chips by full render (views keep state via S)
  render();
}
function sendChat(){
  var inp=$("#chat-in"); var text=(inp.value||"").trim(); if(!text||S.busy) return;
  S.thread.push({role:"user",text:text}); S.busy=true;
  inp.value=""; render();
  var provider=($("#provider")&&$("#provider").value)||"auto";
  var ctx=(S.me?("Workspace context: studio="+S.view+", plan="+S.me.planName+", credits(AI/image/video)="+S.me.credits.ai+"/"+S.me.credits.image+"/"+S.me.credits.veo+"."):"");
  var convo=(ctx?ctx+"\\n":"")+S.thread.map(function(m){return (m.role==="user"?"User: ":"Assistant: ")+m.text;}).join("\\n");
  api("/api/generate",{method:"POST",body:JSON.stringify({provider:provider,prompt:convo})})
    .then(function(r){
      S.thread.push({role:"ai",text:r.text,provider:r.provider,model:r.model});
      S.busy=false; S.me.credits=r.credits; render();
      var box=$("#chat-in"); if(box) box.focus();
    })
    .catch(function(e){ S.busy=false; S.thread.pop(); render(); toast(e.message,true); });
}
function runTool(kind){
  var topic=($("#tool-topic").value||"").trim();
  if(!topic){ toast("Describe what you need first",true); return; }
  var provider=($("#provider")&&$("#provider").value)||"auto";
  var t=TOOLS[kind];
  var presetIdx=kind+"-preset";
  var phrase=(t.presets[0]&&t.presets[0][1])||"";
  var prompt=t.tpl(topic,phrase);
  var out=$("#tool-out");
  S.busy=true; render(); out=$("#tool-out");
  out.innerHTML='<div class="card pad hint">Working…</div>';
  api("/api/generate",{method:"POST",body:JSON.stringify({provider:provider,prompt:prompt})})
    .then(function(r){
      S.busy=false; S.me.credits=r.credits; render();
      out=$("#tool-out");
      var isApp=kind==="app";
      out.innerHTML='<div class="card pad">'+
        '<div class="row" style="justify-content:space-between;margin-bottom:10px">'+
        '<span class="hint">'+providerTag(r.provider)+' · '+esc(r.model||"")+'</span>'+
        '<div class="row">'+
        (isApp?'<button class="btn ghost sm" id="to-playground">Open in Playground →</button>':"")+
        '<button class="btn ghost sm" id="copy-out">Copy</button></div></div>'+
        '<div class="output'+(isApp?" mono":"")+'" id="out-text">'+esc(r.text)+'</div></div>';
      $("#copy-out").addEventListener("click",function(){ copy(r.text); });
      if(isApp){ var tp=$("#to-playground"); if(tp) tp.addEventListener("click",function(){
        var m=r.text.match(/\x60\x60\x60(?:html)?\s*([\s\S]*?)\x60\x60\x60/);
        S.playgroundSrc=m?m[1]:r.text; S.view="play"; render(); toast("Loaded into playground");
      }); }
    })
    .catch(function(e){ S.busy=false; render(); toast(e.message,true); });
}
function runImage(){
  var b={subject:$("#img-subject"),style:$("#img-style"),light:$("#img-light"),cam:$("#img-cam"),mood:$("#img-mood")};
  var segs=[];
  if(b.subject&&b.subject.value.trim()) segs.push(b.subject.value.trim());
  if(b.style&&b.style.value.trim()) segs.push("style: "+b.style.value.trim());
  if(b.light&&b.light.value.trim()) segs.push("lighting: "+b.light.value.trim());
  if(b.cam&&b.cam.value.trim()) segs.push("camera: "+b.cam.value.trim());
  if(b.mood&&b.mood.value.trim()) segs.push("mood: "+b.mood.value.trim());
  var manual=($("#img-prompt").value||"").trim();
  var prompt=segs.length?(segs.join(", ")+(manual?" — "+manual:"")):manual;
  if(!prompt){ toast("Describe the image first (builder or full prompt)",true); return; }
  var neg=($("#img-negative").value||"").trim();
  if(neg) prompt+="\\n\\nAvoid: "+neg;
  var provider=($("#provider").value)||"openai";
  if(!planAllowsProvider(provider)){ toast("Your plan does not include "+provider+" images",true); return; }
  var size=($("#img-size").value)||"1024x1024";
  S.busy=true; render();
  var out=$("#img-out"); out.innerHTML='<div class="card pad hint">Rendering…</div>';
  api("/api/image",{method:"POST",body:JSON.stringify({provider:provider,prompt:prompt,size:size})})
    .then(function(r){
      S.busy=false; S.me.credits=r.credits; render();
      out=$("#img-out");
      out.innerHTML='<div class="card pad"><div class="imgwrap"><img alt="Generated" src="'+r.dataUrl+'"/></div>'+
        '<div class="row" style="margin-top:10px;justify-content:space-between">'+
        '<span class="hint">'+providerTag(r.provider)+' · '+esc(r.model||"")+'</span>'+
        '<a class="btn ghost sm" href="'+r.dataUrl+'" download="nexus-image.png">Download ⬇</a></div></div>';
    })
    .catch(function(e){ S.busy=false; render(); toast(e.message,true); });
}
function runVeo(){
  var prompt=($("#veo-prompt").value||"").trim();
  if(!prompt){ toast("Describe the scene first",true); return; }
  var secs=($("#veo-dur")?Number($("#veo-dur").value):8)||8;
  if(!S.me.credits.veo){ toast("No Veo credits left — upgrade in Billing",true); return; }
  if(secs>(currentPlan().maxVideoSeconds||120)){ toast("Your plan allows up to "+Math.round(currentPlan().maxVideoSeconds/60)+" minute videos — upgrade for longer",true); return; }
  S.busy=true; render();
  var out=$("#veo-out"); out.innerHTML='<div class="card pad hint">Submitting to Veo…</div>';
  api("/api/veo/generate",{method:"POST",body:JSON.stringify({prompt:prompt,seconds:secs})})
    .then(function(r){
      S.busy=false; S.me.credits=r.credits; render();
      out=$("#veo-out");
      out.innerHTML='<div class="card pad" id="veo-card"><span class="hint">🎬 Operation '+esc(r.id)+' queued — polling every 5s…</span>'+
        '<div class="progress" style="margin-top:12px;height:5px;border-radius:99px;background:rgba(255,255,255,.08);overflow:hidden">'+
        '<i style="display:block;height:100%;width:40%;background:var(--grad);animation:vslide 1.6s ease-in-out infinite alternate"></i></div></div>';
      if(S.veoPoll) clearInterval(S.veoPoll);
      S.veoPoll=setInterval(function(){ pollVeo(r.id); },5000);
      pollVeo(r.id);
    })
    .catch(function(e){ S.busy=false; render(); toast(e.message,true); });
}
function pollVeo(id){
  api("/api/veo/status?id="+encodeURIComponent(id)).then(function(r){
    if(r.status==="running") return;
    if(S.veoPoll){ clearInterval(S.veoPoll); S.veoPoll=null; }
    S.me.credits=r.credits||S.me.credits;
    var out=$("#veo-out");
    if(r.status==="done"&&r.fileReady){
      out.innerHTML='<div class="card pad video-wrap"><video controls src="/api/veo/file?ref='+encodeURIComponent(id)+'&i=0"></video>'+
        '<div class="hint" style="margin-top:8px">Rendered with Veo 3.1 · streamed server-side (your keys never touch the browser)</div></div>';
    }else{
      out.innerHTML='<div class="card pad"><div class="err">Veo failed'+(r.error?": "+esc(r.error):".")+' — credits were refunded.</div></div>';
    }
  }).catch(function(e){ if(S.veoPoll){clearInterval(S.veoPoll);S.veoPoll=null;} toast(e.message,true); });
}
function bindView(v){
  if(v==="dashboard"){
    var st=document.getElementById("dash-status");
    if(st) st.textContent="OpenAI "+(prov("openai").configured?"● connected":"○ not configured")+" · Gemini "+(prov("gemini").configured?"● connected":"○ not configured")+" · Veo "+(prov("veo").configured?"● connected":"○ not configured")+" · billing "+((S.settings&&S.settings.billingMode)||"dev");
    var qs=document.querySelectorAll(".qa");
    for(var qi=0;qi<qs.length;qi++){ qs[qi].addEventListener("click",function(){
      S.view=this.getAttribute("data-view");
      try{ localStorage.setItem("nexus-view",S.view); }catch(e){}
      render();
    }); }
    var ar=document.getElementById("analyze-run");
    if(ar) ar.addEventListener("click",function(){
      var out=document.getElementById("analyze-out");
      out.innerHTML='<div class="hint">Analyzing…</div>';
      var p="Analyze this workspace snapshot and reply with SUMMARY, ISSUES, SUGGESTIONS, ACTIONS. Context: studio="+S.view+"; plan="+(S.me&&S.me.planName)+"; credits="+(S.me?JSON.stringify(S.me.credits):"n/a")+"; providers openai="+(prov("openai").configured?"on":"off")+", gemini="+(prov("gemini").configured?"on":"off")+", veo="+(prov("veo").configured?"on":"off")+".";
      api("/api/generate",{method:"POST",body:JSON.stringify({provider:"auto",prompt:p})})
        .then(function(r){ out.innerHTML='<div class="output">'+esc(r.text)+'</div>'; })
        .catch(function(e){ out.innerHTML='<div class="err">'+esc(e.message)+'</div>'; });
    });
  }
  if(v==="chat"){
    var send=$("#chat-send"); if(send) send.addEventListener("click",sendChat);
    var inp=$("#chat-in"); if(inp) inp.addEventListener("keydown",function(e){
      if(e.key==="Enter"&&!e.shiftKey){ e.preventDefault(); sendChat(); }});
    var cl=$("#chat-clear"); if(cl) cl.addEventListener("click",function(){ S.thread=[]; render(); });
  }
  if(v==="doc"||v==="research"||v==="app"){
    var run=$("#tool-run"); if(run) run.addEventListener("click",function(){ runTool(v); });
    var pr=document.querySelectorAll(".preset");
    for(var i=0;i<pr.length;i++){ pr[i].addEventListener("click",function(){
      var t=TOOLS[v].presets[Number(this.getAttribute("data-i"))];
      $("#tool-topic").value=t&&t[0]?t[0]:t;
    }); }
  }
  if(v==="image"){ var r=$("#img-run"); if(r) r.addEventListener("click",runImage); }
  if(v==="video"){ var vr=$("#veo-run"); if(vr) vr.addEventListener("click",runVeo); }
  if(v==="play"){
    var pr2=$("#pg-run"); if(pr2) pr2.addEventListener("click",function(){
      S.playgroundSrc=$("#pg-src").value; $("#pg-frame").srcdoc=S.playgroundSrc;
    });
    var pc=$("#pg-clear"); if(pc) pc.addEventListener("click",function(){ S.playgroundSrc=""; render(); });
  }
  if(v==="billing"){
    var ups=document.querySelectorAll(".upgrade");
    for(var j=0;j<ups.length;j++){ ups[j].addEventListener("click",function(){
      var plan=this.getAttribute("data-plan");
      api("/api/checkout",{method:"POST",body:JSON.stringify({plan:plan})})
        .then(function(r){
          if(r.url){ location.href=r.url; return; }
          S.me=r.user; toast("Dev upgrade applied — welcome to "+(r.user.planName||r.plan)); render();
        })
        .catch(function(e){ toast(e.message,true); });
    }); }
    var dg=$("#downgrade"); if(dg) dg.addEventListener("click",function(){
      api("/api/checkout",{method:"POST",body:JSON.stringify({plan:"free"})}).catch(function(){}); // free is rejected; kept for clarity
      toast("Use Sign out to start a fresh Free session");
    });
    var au=$("#access-unlock"); if(au) au.addEventListener("click",function(){
      api("/api/access/unlock",{method:"POST",body:JSON.stringify({code:($("#access-code").value||""),plan:($("#access-plan").value||"pro")})})
        .then(function(r){ S.me=r.user; toast("Unlocked "+String(r.plan).toUpperCase()+" 🔓"); render(); })
        .catch(function(e){ toast(e.message,true); });
    });
  }
}

/* ── boot ──────────────────────────────────────────────── */
function loadMe(){ return api("/api/me").then(function(me){ S.me=me; render(); }).catch(function(){ S.me=null; render(); }); }
try{ var sv=localStorage.getItem("nexus-view"); if(sv){ S.view=sv; } }catch(e){}
document.addEventListener("keydown",function(e){ if((e.ctrlKey||e.metaKey)&&(e.key==="k"||e.key==="K")){ e.preventDefault(); togglePalette(); } });
api("/api/settings").then(function(s){ S.settings=s; render(); }).catch(function(){
  S.settings={plans:[],providers:{openai:{},gemini:{},veo:{}},devAuth:true,devBilling:true,billingMode:"dev"}; render();
});
api("/api/auth/session",{method:"POST"}).then(function(r){
  if(r&&r.ok&&r.user){ S.me=r.user; render(); } else { loadMe(); }
}).catch(function(){ loadMe(); });
})();
</script>
<style>@keyframes vslide{from{width:30%}to{width:85%}}</style>
</body>
</html>`;
