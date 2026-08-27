"use strict";
/*
 * Lotus Guest Atelier — AI concierge proxy (zero dependencies).
 * Listens on 127.0.0.1 only; reachable exclusively through nginx (/api/),
 * which enforces basic auth. The API key is read from the environment and
 * never leaves the server. Supports Azure OpenAI and OpenAI.
 */
const http = require("http");
const crypto = require("crypto");

const PORT = parseInt(process.env.BACKEND_PORT || "8787", 10);
const PROVIDER = (process.env.AI_PROVIDER || "azure").toLowerCase();
const API_KEY = process.env.AI_API_KEY || "";
const AUTH_MODE = (process.env.AI_AUTH_MODE || (API_KEY ? "key" : "entra")).toLowerCase();
const ENDPOINT = (process.env.AI_ENDPOINT || "").replace(/\/+$/, "");
const DEPLOYMENT = process.env.AI_DEPLOYMENT || "";
const API_VERSION = process.env.AI_API_VERSION || "2024-08-01-preview";
const MODEL = process.env.AI_MODEL || "gpt-4o-mini";
const MAX_TOKENS = parseInt(process.env.AI_MAX_TOKENS || "600", 10);
const TEMPERATURE = parseFloat(process.env.AI_TEMPERATURE || "0.6");

const SYSTEM_PROMPT = process.env.AI_SYSTEM_PROMPT ||
  "You are the Lotus Hotels \"Guest Atelier\" AI concierge, assisting front-desk staff. " +
  "Given a guest's dossier and a staff question, respond with concise, warm, immediately actionable guidance " +
  "(dining picks, room prep, special touches, activities, pre-arrival steps). " +
  "Treat any dietary restriction or allergy as a hard safety constraint and never suggest anything that violates it. " +
  "Ground every answer in the provided dossier; do not invent facts, allergies, or bookings. " +
  "Keep it under ~140 words, use short paragraphs or bullet points, and do not use markdown headers.";

const configured = PROVIDER === "openai"
  ? Boolean(API_KEY && MODEL)
  : Boolean(ENDPOINT && DEPLOYMENT && (API_KEY || AUTH_MODE === "entra"));

// ---- Keyless Entra ID auth via managed identity (Azure Container Apps) ----
let _token = { value: null, exp: 0 };
async function getEntraToken() {
  const now = Date.now();
  if (_token.value && now < _token.exp - 120000) return _token.value;
  const resource = "https://cognitiveservices.azure.com";
  const idEndpoint = process.env.IDENTITY_ENDPOINT;
  const idHeader = process.env.IDENTITY_HEADER;
  let url, headers;
  if (idEndpoint && idHeader) {
    url = `${idEndpoint}?resource=${encodeURIComponent(resource)}&api-version=2019-08-01`;
    headers = { "X-IDENTITY-HEADER": idHeader };
  } else {
    url = `http://169.254.169.254/metadata/identity/oauth2/token?resource=${encodeURIComponent(resource)}&api-version=2018-02-01`;
    headers = { "Metadata": "true" };
  }
  const resp = await fetch(url, { headers });
  if (!resp.ok) throw new Error(`identity token ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 200)}`);
  const j = await resp.json();
  const ttl = parseInt(j.expires_in || "3600", 10) * 1000;
  _token = { value: j.access_token, exp: now + (ttl > 0 ? ttl : 3600000) };
  return _token.value;
}

// ---- Staff login (reuses the existing basic-auth secret by default) ----
const STAFF_USER = process.env.STAFF_USER || process.env.BASIC_AUTH_USER || "lotus";
const STAFF_PASS = process.env.STAFF_PASS || process.env.BASIC_AUTH_PASSWORD || "lotus";

function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  try { return crypto.timingSafeEqual(A, B); } catch (e) { return false; }
}
function credsOk(user, pass) {
  return safeEqual(user, STAFF_USER) && safeEqual(pass, STAFF_PASS);
}
function basicAuthOk(req) {
  const h = req.headers["authorization"] || "";
  const m = /^Basic\s+(.+)$/i.exec(h);
  if (!m) return false;
  let dec = "";
  try { dec = Buffer.from(m[1], "base64").toString("utf8"); } catch (e) { return false; }
  const i = dec.indexOf(":");
  if (i < 0) return false;
  return credsOk(dec.slice(0, i), dec.slice(i + 1));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function callModel(messages) {
  let url, headers;
  if (PROVIDER === "openai") {
    url = "https://api.openai.com/v1/chat/completions";
    headers = { "Content-Type": "application/json", "Authorization": `Bearer ${API_KEY}` };
  } else {
    url = `${ENDPOINT}/openai/deployments/${DEPLOYMENT}/chat/completions?api-version=${API_VERSION}`;
    if (API_KEY) {
      headers = { "Content-Type": "application/json", "api-key": API_KEY };
    } else {
      const token = await getEntraToken();
      headers = { "Content-Type": "application/json", "Authorization": `Bearer ${token}` };
    }
  }
  const payload = { messages, temperature: TEMPERATURE, max_tokens: MAX_TOKENS };
  if (PROVIDER === "openai") payload.model = MODEL;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload), signal: controller.signal });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new Error(`${PROVIDER} ${resp.status}: ${detail.slice(0, 300)}`);
    }
    const json = await resp.json();
    return (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content || "").trim();
  } finally {
    clearTimeout(timer);
  }
}

const server = http.createServer(async (req, res) => {
  const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };

  if (req.method === "GET" && req.url.startsWith("/api/health")) {
    return send(200, { ok: true, configured, provider: PROVIDER });
  }

  if (req.method === "POST" && req.url.startsWith("/api/login")) {
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (credsOk(String(body.user || ""), String(body.pass || ""))) {
        return send(200, { ok: true });
      }
      return send(401, { error: "Invalid staff credentials" });
    } catch (e) {
      return send(400, { error: "bad request" });
    }
  }

  if (req.method === "POST" && req.url.startsWith("/api/chat")) {
    if (!basicAuthOk(req)) return send(401, { error: "unauthorized" });
    if (!configured) return send(503, { error: "AI backend not configured" });
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      const query = String(body.query || body.message || "").slice(0, 4000).trim();
      const context = String(body.context || "").slice(0, 8000);
      if (!query) return send(400, { error: "empty query" });
      const messages = [
        { role: "system", content: SYSTEM_PROMPT + (context ? `\n\nGuest dossier & context:\n${context}` : "") },
        { role: "user", content: query }
      ];
      const text = await callModel(messages);
      if (!text) return send(502, { error: "empty completion" });
      return send(200, { text });
    } catch (e) {
      return send(502, { error: String((e && e.message) || e) });
    }
  }

  send(404, { error: "not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[backend] listening on 127.0.0.1:${PORT} provider=${PROVIDER} configured=${configured}`);
});
