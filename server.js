// RTO Shield — zero-dependency Node server (Cloud Run).
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { todaysQueue } from "./server/data.js";
import { score, recommend, simulate, DEFAULT_RULES, ACTION_LABEL, WEIGHTS } from "./server/engine.js";
import { checkAddress, draftMessage, agentInstructions, agentReply, analyzeCall } from "./server/ai.js";
import { geminiReady, liveToken, fsSet, fsList, fsDelete, firestoreState, TEXT_MODEL, LIVE_MODEL } from "./server/google.js";

const ROOT = fileURLToPath(new URL("./public", import.meta.url));
const PORT = process.env.PORT || 8080;

// ---------------- State ----------------
const BASE = todaysQueue();
const overlay = new Map();         // id -> mutable fields (status, actions, call result, fixed address...)
let rules = { ...DEFAULT_RULES };
const log = [];                    // recent actions across all orders

async function loadState() {
  const [r, o, a] = await Promise.all([fsList("rules"), fsList("orders"), fsList("actions")]);
  if (r) { const d = r.find(x => x.id === "default"); if (d) { delete d.id; rules = { ...DEFAULT_RULES, ...d }; } }
  if (o) for (const d of o) { const { id, ...rest } = d; overlay.set(id, rest); }
  if (a) log.push(...a.sort((x, y) => y.at - x.at).slice(0, 100));
  console.log(`State loaded. Firestore: ${firestoreState()}. Gemini: ${geminiReady() ? "ready" : "no key (offline mode)"}`);
}

function view(o) {
  const ov = overlay.get(o.id) || {};
  const merged = { ...o, ...ov, customer: { ...o.customer, ...(ov.customer || {}) } };
  const s = score(merged);
  const original = ov.addressFixed ? score({ ...o }) : s;
  const action = recommend(merged, original, rules);
  return {
    ...merged,
    p: original.p, reasons: original.reasons, weakAddress: original.weakAddress,
    pAfter: ov.pAfter ?? null,
    action, actionLabel: ACTION_LABEL[action],
    status: ov.status || "open",
    actions: ov.actions || [],
  };
}
const find = id => BASE.find(o => o.id === id);
const get = id => { const o = find(id); if (!o) throw { code: 404, message: "Order not found" }; return view(o); };

async function update(id, patch, entry) {
  const cur = overlay.get(id) || {};
  const next = { ...cur, ...patch };
  if (entry) {
    const e = { at: Date.now(), orderId: id, ...entry };
    next.actions = [...(cur.actions || []), e];
    log.unshift(e); log.length = Math.min(log.length, 100);
    fsSet("actions", `${id}-${e.at}`, e);
  }
  overlay.set(id, next);
  await fsSet("orders", id, next);
  return view(find(id));
}

// ---------------- HTTP helpers ----------------
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json" };
function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}
async function body(req) {
  let s = ""; for await (const c of req) { s += c; if (s.length > 2e6) throw new Error("Body too large"); }
  return s ? JSON.parse(s) : {};
}
async function serveStatic(res, path) {
  const p = normalize(join(ROOT, path === "/" ? "index.html" : path));
  if (!p.startsWith(ROOT)) return send(res, 403, { error: "Forbidden" });
  try { send(res, 200, await readFile(p), TYPES[extname(p)] || "application/octet-stream"); }
  catch { send(res, 200, await readFile(join(ROOT, "index.html")), TYPES[".html"]); }
}

// ---------------- Routes ----------------
const routes = [
  ["GET", /^\/api\/health$/, async () => ({ ok: true, gemini: geminiReady(), textModel: TEXT_MODEL, liveModel: LIVE_MODEL, firestore: firestoreState() })],

  ["GET", /^\/api\/orders$/, async () => ({ orders: BASE.map(view), rules, weights: WEIGHTS })],

  ["GET", /^\/api\/orders\/([\w-]+)$/, async (m) => get(m[1])],

  ["POST", /^\/api\/orders\/([\w-]+)\/address-check$/, async (m) => {
    const o = get(m[1]);
    const result = await checkAddress(o);
    const v = await update(o.id, { addressCheck: result }, { type: "address_check", detail: `${result.quality} address${result.missing?.length ? `, missing ${result.missing.join(", ")}` : ""}` });
    return { result, order: v };
  }],

  ["POST", /^\/api\/orders\/([\w-]+)\/address-apply$/, async (m, b) => {
    const o = get(m[1]);
    const addr = String(b.address || o.addressCheck?.normalized || "").slice(0, 300);
    if (!addr) throw { code: 400, message: "No address to apply" };
    return update(o.id, { address: addr, addressFixed: true }, { type: "address_fix", detail: addr });
  }],

  ["POST", /^\/api\/orders\/([\w-]+)\/message$/, async (m, b) => {
    const o = get(m[1]);
    const kind = b.kind === "token" ? "token" : "prepaid";
    const result = await draftMessage(o, kind, rules);
    const v = await update(o.id, { message: result, ...(o.status === "open" ? { status: "offer_sent" } : {}) }, { type: kind === "token" ? "token_request" : "prepaid_nudge", detail: `${kind === "token" ? "Token request" : "Prepaid offer"} sent on WhatsApp (Gemini draft)` });
    return { result, order: v };
  }],

  // Demo stand-in for a payment webhook: mark the WhatsApp outcome.
  ["POST", /^\/api\/orders\/([\w-]+)\/payment$/, async (m, b) => {
    const o = get(m[1]);
    const map = {
      paid_full: [{ status: "converted_prepaid", payment: "Prepaid", pAfter: 97 }, "Customer paid in full online"],
      paid_token: [{ status: "token_paid", pAfter: Math.min(95, o.p + 45) }, `Token of ₹${rules.tokenAmount} paid`],
      declined: [{ status: o.action === "token" ? "held" : "open" }, o.action === "token" ? "Token not paid, order held" : "Customer kept cash on delivery"],
    };
    const x = map[b.outcome]; if (!x) throw { code: 400, message: "Unknown outcome" };
    return update(o.id, x[0], { type: "payment", detail: x[1] });
  }],

  ["POST", /^\/api\/orders\/([\w-]+)\/status$/, async (m, b) => {
    const ok = ["open", "shipped", "held", "call_queued"]; if (!ok.includes(b.status)) throw { code: 400, message: "Unknown status" };
    get(m[1]);
    return update(m[1], { status: b.status }, { type: "status", detail: `Marked ${b.status}` });
  }],


  // Bulk actions from the order desk. Gemini work runs 4 at a time.
  ["POST", /^\/api\/bulk$/, async (m, b) => {
    const ids = (Array.isArray(b.ids) ? b.ids : []).filter(id => find(id)).slice(0, 60);
    const action = String(b.action || "");
    const ACTIONS = ["recommended", "prepaid", "token", "address", "call_queue", "ship", "hold", "reopen"];
    if (!ACTIONS.includes(action)) throw { code: 400, message: "Unknown bulk action" };
    const results = [];
    const one = async (id) => {
      const o = get(id);
      let kind = action;
      if (action === "recommended") kind = { prepaid_nudge: "prepaid", token: "token", address_fix: "address", call: "call_queue", ship: "ship" }[o.action] || "skip";
      try {
        if (kind === "prepaid" || kind === "token") {
          if (o.payment !== "COD") return results.push({ id, skipped: "already prepaid" });
          const msg = await draftMessage(o, kind, rules);
          await update(id, { message: msg, ...(o.status === "open" ? { status: "offer_sent" } : {}) }, { type: kind === "token" ? "token_request" : "prepaid_nudge", detail: `${kind === "token" ? "Token request" : "Prepaid offer"} sent on WhatsApp (bulk, Gemini draft)` });
        } else if (kind === "address") {
          const r = await checkAddress(o);
          const patch = { addressCheck: r };
          if (r.quality === "weak" && r.normalized) Object.assign(patch, { address: r.normalized, addressFixed: true });
          await update(id, patch, { type: "address_check", detail: `Bulk address check: ${r.quality}${patch.addressFixed ? ", cleaned" : ""}` });
        } else if (kind === "call_queue") {
          await update(id, { status: "call_queued" }, { type: "status", detail: "Queued for Gemini voice call" });
        } else if (kind === "ship") {
          await update(id, { status: "shipped" }, { type: "status", detail: "Marked shipped (bulk)" });
        } else if (kind === "hold") {
          await update(id, { status: "held" }, { type: "status", detail: "Held before dispatch (bulk)" });
        } else if (kind === "reopen") {
          await update(id, { status: "open" }, { type: "status", detail: "Reopened" });
        } else return results.push({ id, skipped: "control group" });
        results.push({ id, ok: true, kind });
      } catch (e) { results.push({ id, error: e.message }); }
    };
    const queue = [...ids];
    await Promise.all(Array.from({ length: 4 }, async () => { while (queue.length) await one(queue.shift()); }));
    return { results, orders: BASE.map(view) };
  }],
  ["POST", /^\/api\/orders\/([\w-]+)\/call-session$/, async (m) => {
    const o = get(m[1]);
    const instructions = agentInstructions(o, o, o.action, rules, o.addressCheck);
    let live = null, liveError = null;
    try { live = await liveToken(); } catch (e) { liveError = e.message; }
    return { live, liveError, instructions, voice: "Kore" };
  }],

  ["POST", /^\/api\/orders\/([\w-]+)\/chat$/, async (m, b) => {
    const o = get(m[1]);
    const system = agentInstructions(o, o, o.action, rules, o.addressCheck);
    const turns = Array.isArray(b.turns) ? b.turns.slice(-30) : [];
    return { reply: await agentReply(system, turns) };
  }],

  ["POST", /^\/api\/orders\/([\w-]+)\/call-result$/, async (m, b) => {
    const o = get(m[1]);
    const transcript = (Array.isArray(b.transcript) ? b.transcript : []).filter(t => t?.text).slice(0, 200);
    const r = await analyzeCall(o, transcript);
    const patch = { callResult: { ...r, transcript, mode: b.mode || "voice", at: Date.now() } };
    let p = o.p;
    if (r.outcome === "cancelled" || r.wants_order === "no") { patch.status = "cancelled"; p = null; }
    else {
      if (r.outcome === "rescheduled") patch.status = "rescheduled";
      else if (r.outcome === "confirmed") patch.status = "confirmed";
      p = Math.max(p, Math.round(r.intent_score ?? p));
      if (r.address_updated && r.new_address) { patch.address = r.new_address; patch.addressFixed = true; p = Math.min(96, p + 8); }
      if (r.payment_choice === "prepaid") p = Math.max(p, 90);
    }
    patch.pAfter = p;
    const v = await update(o.id, patch, { type: "call", detail: `${r.outcome}, ${r.sentiment} — ${r.summary}` });
    return { result: r, order: v };
  }],

  // Demo reset: clears today's order changes and the activity log (rules are kept). POST /api/admin/reset?confirm=yes
  ["POST", /^\/api\/admin\/reset$/, async (m, b, url) => {
    if (url.searchParams.get("confirm") !== "yes") throw { code: 400, message: "Add ?confirm=yes" };
    const [o, a] = await Promise.all([fsList("orders"), fsList("actions")]);
    await Promise.all([...(o || []).map(d => fsDelete("orders", d.id)), ...(a || []).map(d => fsDelete("actions", d.id))]);
    overlay.clear(); log.length = 0;
    return { ok: true, cleared: { orders: o?.length || 0, actions: a?.length || 0 } };
  }],

  ["GET", /^\/api\/rules$/, async () => ({ rules, defaults: DEFAULT_RULES })],
  ["PUT", /^\/api\/rules$/, async (m, b) => {
    const n = (k, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(b[k] ?? rules[k]))));
    const next = { callBelow: n("callBelow", 5, 95), nudgeBelow: n("nudgeBelow", 5, 99), discountPct: n("discountPct", 0, 30),
      tokenAmount: n("tokenAmount", 0, 2000), tokenMinPastRto: n("tokenMinPastRto", 1, 5), controlPct: n("controlPct", 0, 50) };
    if (next.nudgeBelow < next.callBelow) next.nudgeBelow = next.callBelow;
    rules = next;
    const saved = await fsSet("rules", "default", rules);
    return { rules, saved };
  }],

  ["POST", /^\/api\/impact\/preview$/, async (m, b) => simulate({ ...rules, ...b })],
  ["GET", /^\/api\/impact$/, async () => {
    const live = BASE.map(view);
    const tally = k => live.filter(o => o.status === k).length;
    return {
      sim: simulate(rules),
      today: {
        orders: live.length, risky: live.filter(o => o.action !== "ship").length,
        calls: live.filter(o => o.callResult).length, confirmed: tally("confirmed") + tally("rescheduled"),
        cancelled: tally("cancelled"), converted: tally("converted_prepaid"), tokenPaid: tally("token_paid"), held: tally("held"),
        addressFixed: live.filter(o => o.addressFixed).length,
        offersSent: live.filter(o => o.message).length, callQueued: tally("call_queued"), shipped: tally("shipped"),
      },
      log: log.slice(0, 25),
      rules,
    };
  }],
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (!url.pathname.startsWith("/api/")) return serveStatic(res, url.pathname);
  for (const [method, re, fn] of routes) {
    const m = url.pathname.match(re);
    if (m && req.method === method) {
      try { return send(res, 200, await fn(m, method === "GET" ? {} : await body(req), url)); }
      catch (e) { console.error(e); return send(res, e.code || 500, { error: e.message || "Something went wrong" }); }
    }
  }
  send(res, 404, { error: "Not found" });
});

loadState().finally(() => server.listen(PORT, () => console.log(`RTO Shield on :${PORT}`)));
