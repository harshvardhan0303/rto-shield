// RTO Shield front end. Plain JS, no build step.
const $ = (s, el = document) => el.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const inr = (n) => "₹" + Math.round(n).toLocaleString("en-IN");
const pct = (x, d = 0) => (x * 100).toFixed(d) + "%";
const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? "now" : m < 60 ? `${m}m` : `${Math.round(m / 60)}h`; };

const S = { orders: [], rules: null, health: {}, sel: null, filter: "action", busy: new Set() };

const REASON_TEXT = {
  HIGH_RISK_PINCODE: "Many past orders to this pincode came back",
  COD: "Cash on delivery: about 10× the RTO rate of prepaid",
  NEW_CUSTOMER: "First order from this customer",
  PAST_RTO: "Customer has refused or missed earlier deliveries",
  WEAK_ADDRESS: "Address is vague: no house number or landmark-only",
  ORDER_ANOMALY: "Odd hour, unusually large or many items",
};
const ACTION_TEXT = {
  call: ["Gemini voice call", "Call the customer in their language to confirm the order, fix the address and agree a delivery day."],
  token: ["Token amount upfront", "This customer has returned COD orders before. Ask for a small part-payment before dispatch; hold the order if it isn't paid."],
  prepaid_nudge: ["Prepaid nudge", "Offer a small discount to pay in full now. Prepaid orders rarely come back."],
  address_fix: ["Address fix", "Let Gemini check the address and ask the customer for what's missing."],
  ship: ["Ship as normal", "Low risk. No action needed."],
  control: ["Control group", "Left untouched on purpose, so the dashboard can measure what our actions change."],
};
const STATUS_TEXT = { open: "Open", confirmed: "Confirmed", rescheduled: "Rescheduled", cancelled: "Stopped", converted_prepaid: "Paid online", token_paid: "Token paid", held: "Held", shipped: "Shipped" };
const SPARK = `<svg class="spark" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1l1.6 4.4L14 7l-4.4 1.6L8 13l-1.6-4.4L2 7l4.4-1.6z" fill="var(--accent)"/></svg>`;

async function api(path, opts = {}) {
  const res = await fetch(path, { method: opts.method || (opts.body ? "POST" : "GET"), headers: { "content-type": "application/json" }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
function toast(msg, ms = 3200) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), ms); }
const tone = (p) => p == null ? "good" : p < (S.rules?.callBelow ?? 40) ? "crit" : p < (S.rules?.nudgeBelow ?? 65) ? "warn" : "good";

// ---------------- Boot + routing ----------------
async function boot() {
  try {
    const [h, o] = await Promise.all([api("/api/health"), api("/api/orders")]);
    S.health = h; S.orders = o.orders; S.rules = o.rules;
    renderHealth();
    S.sel = S.orders[0]?.id;
  } catch (e) { toast(e.message); }
  window.addEventListener("hashchange", route);
  route();
}
function route() {
  const tab = (location.hash || "#orders").slice(1).split("/")[0];
  const t = ["orders", "rules", "impact", "about"].includes(tab) ? tab : "orders";
  document.querySelectorAll(".tab").forEach(s => (s.hidden = s.id !== `tab-${t}`));
  document.querySelectorAll(".tabs a").forEach(a => a.setAttribute("aria-selected", a.dataset.tab === t ? "true" : "false"));
  ({ orders: renderOrders, rules: renderRules, impact: renderImpact, about: renderAbout })[t]();
}
function renderHealth() {
  const h = S.health;
  const fsOn = String(h.firestore).startsWith("connected");
  $("#health").innerHTML =
    `<span class="pill ${h.gemini ? "on" : "off"}" title="Text model: ${esc(h.textModel)} · Live model: ${esc(h.liveModel)}"><i></i>Gemini ${h.gemini ? "ready" : "offline"}</span>` +
    `<span class="pill ${fsOn ? "on" : "off"}" title="${esc(h.firestore)}"><i></i>Firestore ${fsOn ? "connected" : "local"}</span>`;
}

// ---------------- Orders ----------------
const FILTERS = [
  ["action", "Needs action", o => o.status === "open" && !["ship", "control"].includes(o.action)],
  ["all", "All", () => true],
  ["call", "Voice call", o => o.action === "call"],
  ["prepaid_nudge", "Prepaid nudge", o => o.action === "prepaid_nudge"],
  ["token", "Token", o => o.action === "token"],
  ["address_fix", "Address fix", o => o.action === "address_fix"],
  ["control", "Control", o => o.action === "control"],
  ["done", "Handled", o => o.status !== "open"],
];
function renderOrders() {
  const O = S.orders;
  const risky = O.filter(o => !["ship"].includes(o.action));
  const handled = O.filter(o => o.status !== "open");
  const cod = O.filter(o => o.payment === "COD").length;
  const avg = O.reduce((s, o) => s + o.p, 0) / (O.length || 1);
  $("#strip").innerHTML = `
    <div><b>${O.length}</b><span>orders waiting to ship today</span></div>
    <div><b class="c-crit">${risky.length}</b><span>flagged as at risk of RTO</span></div>
    <div><b>${Math.round(avg)}%</b><span>average delivery probability</span></div>
    <div><b>${cod}</b><span>cash-on-delivery orders</span></div>
    <div><b class="c-good">${handled.length}</b><span>handled by RTO Shield so far</span></div>`;
  $("#filters").innerHTML = FILTERS.map(([k, label, fn]) =>
    `<button class="fbtn" data-f="${k}" aria-pressed="${S.filter === k}">${label}<em>${O.filter(fn).length}</em></button>`).join("");
  $("#filters").onclick = (e) => { const b = e.target.closest("[data-f]"); if (b) { S.filter = b.dataset.f; renderOrders(); } };
  renderRows(); renderDetail();
}
function renderRows() {
  const fn = FILTERS.find(f => f[0] === S.filter)[2];
  const rows = S.orders.filter(fn).sort((a, b) => a.p - b.p);
  if (rows.length && !rows.some(r => r.id === S.sel)) S.sel = rows[0].id;
  $("#order-rows").innerHTML = rows.length ? rows.map(o => `
    <tr data-id="${o.id}" tabindex="0" aria-selected="${o.id === S.sel}">
      <td><span class="oid">${o.id}</span><div class="sub">${esc(o.category)}</div></td>
      <td>${esc(o.customer.name)}<div class="sub">${esc(o.city)} · ${o.pincode} · ${o.tier}</div></td>
      <td><span class="mono">${o.payment}</span></td>
      <td class="num">${inr(o.amount)}</td>
      <td><div class="prob"><b class="c-${tone(o.p)}">${o.p}%</b><div class="bar"><i class="bg-${tone(o.p)}" style="width:${o.p}%"></i></div></div></td>
      <td><div class="chips">${o.reasons.length ? o.reasons.map(r => `<span class="chip" title="${esc(REASON_TEXT[r])}">${r}</span>`).join("") : `<span class="chip ok">NONE</span>`}</div></td>
      <td><span class="act a-${o.action}"><i></i>${ACTION_TEXT[o.action][0]}</span></td>
      <td><span class="status st-${o.status}">${STATUS_TEXT[o.status] || o.status}</span></td>
    </tr>`).join("") : `<tr><td colspan="8" class="empty">No orders in this view.</td></tr>`;
  const tb = $("#order-rows");
  tb.onclick = (e) => { const tr = e.target.closest("tr[data-id]"); if (tr) select(tr.dataset.id); };
  tb.onkeydown = (e) => { const tr = e.target.closest("tr[data-id]"); if (tr && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); select(tr.dataset.id); } };
}
function select(id) {
  S.sel = id; renderRows(); renderDetail();
  if (window.innerWidth < 1100) $("#detail").scrollIntoView({ behavior: "smooth", block: "start" });
}
function upsert(order) { const i = S.orders.findIndex(o => o.id === order.id); if (i >= 0) S.orders[i] = order; }

function renderDetail() {
  const o = S.orders.find(x => x.id === S.sel);
  const el = $("#detail");
  if (!o) { el.innerHTML = `<div class="empty">Select an order to see its risk and actions.</div>`; return; }
  const [aTitle, aText] = ACTION_TEXT[o.action];
  const busy = (k) => S.busy.has(`${o.id}:${k}`) ? "disabled" : "";
  const ac = o.addressCheck, msg = o.message, cr = o.callResult;
  const isCod = o.payment === "COD";
  el.innerHTML = `
  <div class="d-sec">
    <div class="d-head"><div><span class="k">Order</span><h2>${o.id}</h2><div class="sub">${esc(o.category)} · ${o.items} item${o.items > 1 ? "s" : ""} · placed ${String(o.hour).padStart(2, "0")}:00</div></div>
      <span class="status st-${o.status}">${STATUS_TEXT[o.status] || o.status}</span></div>
    <div><span class="k">Delivery probability</span>
      <div class="gauge"><span class="big c-${tone(o.p)}">${o.p}%</span>
      ${o.pAfter != null ? `<span class="arrow">→</span><span class="after c-${tone(o.pAfter)}">${o.pAfter}%</span><span class="sub">after action</span>` : o.status === "cancelled" ? `<span class="arrow">→</span><span class="sub">stopped before dispatch, both shipping legs saved</span>` : ""}</div></div>
    <div class="chips">${o.reasons.map(r => `<span class="chip" title="${esc(REASON_TEXT[r])}">${r}</span>`).join("") || `<span class="chip ok">NO RISK FLAGS</span>`}</div>
    ${o.reasons.length ? `<ul class="sub" style="margin:0;padding-left:18px">${o.reasons.map(r => `<li>${esc(REASON_TEXT[r])}</li>`).join("")}</ul>` : ""}
  </div>
  <div class="d-sec">
    <div class="facts">
      <div><span class="k">Customer</span><span>${esc(o.customer.name)}</span></div>
      <div><span class="k">Phone</span><span class="mono">${esc(o.customer.phone)}</span></div>
      <div><span class="k">History</span><span>${o.customer.prevOrders ? `${o.customer.prevOrders} orders, ${o.customer.prevRto} RTO` : "First order"}</span></div>
      <div><span class="k">Payment</span><span>${o.payment} · ${inr(o.amount)}</span></div>
      <div><span class="k">Pincode</span><span>${o.pincode} · ${o.tier} · ${pct(o.pinRate)} past RTO</span></div>
      <div><span class="k">Language</span><span>${o.customer.lang === "hi" ? "Hindi / Hinglish" : "English"}</span></div>
    </div>
    <div><span class="k">Ship to ${o.addressFixed ? "· updated" : ""}</span><div class="label-box">${esc(o.address)}<br>${esc(o.city)}, ${o.state} ${o.pincode}</div></div>
  </div>
  <div class="d-sec">
    <div class="reco reco-${o.action}"><span class="k">Recommended</span><span class="t">${aTitle}</span><p>${aText}</p></div>
    <div class="btns">
      ${o.action !== "ship" ? `<button class="btn ${["call", "token"].includes(o.action) ? "primary" : ""}" data-do="call">📞 Call with Gemini</button>` : ""}
      ${isCod ? `<button class="btn ${o.action === "prepaid_nudge" ? "primary" : ""}" data-do="msg-prepaid" ${busy("msg")}>Prepaid offer</button>
                 <button class="btn ${o.action === "token" ? "primary" : ""}" data-do="msg-token" ${busy("msg")}>Token request</button>` : ""}
      <button class="btn ${o.action === "address_fix" ? "primary" : ""}" data-do="addr" ${busy("addr")}>${SPARK} Check address</button>
      ${o.status === "open" ? `<button class="btn ghost sm" data-do="ship">Mark shipped</button>` : ""}
    </div>
    ${o.action === "control" ? `<p class="fine">This order is in the control group. You can still act on it, but it will then stop counting as a control.</p>` : ""}
  </div>
  ${ac ? `<div class="d-sec"><div class="ai">
      <span class="k src">${SPARK} Gemini address check · ${ac.source === "gemini" ? "live" : "offline"}</span>
      <div><b class="${ac.quality === "weak" ? "c-warn" : "c-good"}">${ac.quality === "weak" ? "Incomplete address" : "Address looks complete"}</b>${ac.missing?.length ? ` · missing ${esc(ac.missing.join(", "))}` : ""}</div>
      <div><span class="k">Clean format</span><div class="label-box">${esc(ac.normalized)}</div></div>
      ${ac.question ? `<div><span class="k">Ask the customer</span><p>“${esc(ac.question)}”</p></div>` : ""}
      ${!o.addressFixed ? `<div class="btns"><button class="btn sm" data-do="addr-apply">Use clean format</button></div>` : ""}
  </div></div>` : ""}
  ${msg ? `<div class="d-sec"><div class="ai">
      <span class="k src">${SPARK} WhatsApp draft by Gemini · ${esc(msg.language || "")}</span>
      <div class="wa">${esc(msg.message)}<div class="wa-meta">${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} ✓✓</div></div>
      <p class="fine">Preview only: in production this goes out through the WhatsApp Business API. Record the customer's response:</p>
      <div class="btns">
        ${msg.kind === "token" ? `<button class="btn sm" data-do="pay-token">Token paid</button>` : `<button class="btn sm" data-do="pay-full">Paid in full</button>`}
        <button class="btn sm ghost" data-do="pay-declined">${msg.kind === "token" ? "Not paid, hold order" : "Kept COD"}</button>
        <button class="btn sm ghost" data-do="copy-msg">Copy text</button>
      </div>
  </div></div>` : ""}
  ${cr ? `<div class="d-sec">${callResultHTML(cr)}</div>` : ""}
  ${o.actions.length ? `<div class="d-sec"><span class="k">Activity</span><div class="log">${o.actions.slice().reverse().map(a => `<div><time>${ago(a.at)}</time><span>${esc(a.detail)}</span></div>`).join("")}</div></div>` : ""}`;
  el.onclick = (e) => { const b = e.target.closest("[data-do]"); if (b) doAction(o, b.dataset.do, b); };
}
function callResultHTML(r) {
  const tone2 = { confirmed: "c-good", rescheduled: "c-warn", cancelled: "c-crit", unclear: "" }[r.outcome] || "";
  return `<div class="ai"><span class="k src">${SPARK} Call result · Gemini analysis · ${esc(r.mode || "voice")}</span>
    <div class="result-grid">
      <div><span class="k">Outcome</span><b class="${tone2}" style="text-transform:capitalize">${esc(r.outcome)}</b></div>
      <div><span class="k">Sentiment</span><span style="text-transform:capitalize">${esc(r.sentiment)}</span></div>
      <div><span class="k">Intent score</span><span class="mono">${esc(r.intent_score)}/100</span></div>
      <div><span class="k">Payment</span><span>${esc(String(r.payment_choice || "").replace("_", " "))}</span></div>
      ${r.reschedule_date ? `<div><span class="k">New date</span><span>${esc(r.reschedule_date)}</span></div>` : ""}
      ${r.language ? `<div><span class="k">Language</span><span>${esc(r.language)}</span></div>` : ""}
    </div>
    ${r.new_address ? `<div><span class="k">Corrected address</span><div class="label-box">${esc(r.new_address)}</div></div>` : ""}
    <p>${esc(r.summary)}</p></div>`;
}

async function run(o, key, fn) {
  const k = `${o.id}:${key}`; if (S.busy.has(k)) return;
  S.busy.add(k); renderDetail();
  try { await fn(); } catch (e) { toast(e.message); }
  finally { S.busy.delete(k); renderOrders(); }
}
async function doAction(o, what) {
  if (what === "call") return openCall(o);
  if (what === "addr") return run(o, "addr", async () => { const r = await api(`/api/orders/${o.id}/address-check`, { body: {} }); upsert(r.order); toast("Gemini checked the address"); });
  if (what === "addr-apply") return run(o, "addr", async () => { upsert(await api(`/api/orders/${o.id}/address-apply`, { body: {} })); toast("Address updated on the order"); });
  if (what === "msg-prepaid" || what === "msg-token") return run(o, "msg", async () => { const r = await api(`/api/orders/${o.id}/message`, { body: { kind: what === "msg-token" ? "token" : "prepaid" } }); upsert(r.order); toast("WhatsApp message drafted"); });
  if (what.startsWith("pay-")) {
    const outcome = { "pay-full": "paid_full", "pay-token": "paid_token", "pay-declined": "declined" }[what];
    return run(o, "pay", async () => { upsert(await api(`/api/orders/${o.id}/payment`, { body: { outcome } })); toast("Order updated"); });
  }
  if (what === "copy-msg") { try { await navigator.clipboard.writeText(o.message.message); toast("Copied"); } catch { toast("Copy isn't available here"); } return; }
  if (what === "ship") return run(o, "ship", async () => { upsert(await api(`/api/orders/${o.id}/status`, { body: { status: "shipped" } })); });
}

// ---------------- Call overlay ----------------
const C = { order: null, live: null, mode: null, lines: [], t0: 0, timer: null, session: null };
function openCall(o) {
  Object.assign(C, { order: o, live: null, mode: null, lines: [], session: null });
  $("#call").hidden = false;
  $("#call-title").textContent = o.customer.name;
  $("#call-sub").textContent = `${o.customer.phone} · ${o.id} · ${o.payment} ${inr(o.amount)}`;
  $("#call-avatar").textContent = o.customer.name[0];
  $("#call-lines").innerHTML = `<div class="line sys">Gemini will speak as Riya from ${esc(o.brand)}. ${o.customer.lang === "hi" ? "It starts in Hinglish and follows your language." : "It starts in English and follows your language."}</div>`;
  $("#call-result").hidden = true; $("#call-form").hidden = true;
  $("#call-start").hidden = false; $("#call-end").hidden = true; $("#call-text").hidden = false;
  setCallState("Ready", ""); $("#call-timer").textContent = "00:00"; $("#call-mode").textContent = "";
  $("#call-start").disabled = false; $("#call-start").focus();
}
function setCallState(text, cls) { $("#call-state").textContent = text; $("#call-dot").className = "dot " + (cls || ""); }
function startTimer() { C.t0 = Date.now(); clearInterval(C.timer); C.timer = setInterval(() => { const s = Math.floor((Date.now() - C.t0) / 1000); $("#call-timer").textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; }, 500); }
function drawLines() {
  const body = $("#call-lines");
  body.innerHTML = C.lines.map(l => `<div class="line ${l.role}"><small>${l.role === "agent" ? "Riya · Gemini" : "Customer"}</small>${esc(l.text)}</div>`).join("") || body.innerHTML;
  body.scrollTop = body.scrollHeight;
}
async function getSession() { return C.session ||= await api(`/api/orders/${C.order.id}/call-session`, { body: {} }); }

$("#call-start").onclick = async () => {
  $("#call-start").disabled = true; setCallState("Connecting…", "busy");
  try {
    const s = await getSession();
    if (!s.live) throw new Error(s.liveError ? `Gemini Live unavailable: ${s.liveError}` : "Gemini Live unavailable");
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser can't use the microphone here.");
    C.mode = "voice"; $("#call-mode").textContent = "Voice · Gemini Live";
    C.live = new LiveCall({
      url: s.live.url, model: s.live.model, instructions: s.instructions, voice: s.voice,
      onState: (st, why) => {
        if (st === "live") { setCallState("On call", "live"); startTimer(); $("#call-start").hidden = true; $("#call-end").hidden = false; $("#call-text").hidden = true; }
        if (st === "ended") { clearInterval(C.timer); setCallState("Call ended", ""); if (why) toast(why, 5000); finishCall(); }
      },
      onLine: (lines) => { C.lines = lines.map(l => ({ ...l })); drawLines(); },
      onLevel: (v) => { $("#call-meter").style.width = `${Math.round(v * 100)}%`; },
      onError: (m) => toast(m, 5000),
    });
    await C.live.start();
  } catch (e) {
    setCallState("Couldn't start", ""); $("#call-start").disabled = false;
    toast(`${e.message} You can run the same call by text.`, 6000);
  }
};
$("#call-end").onclick = () => C.live?.stop();
$("#call-close").onclick = () => { if (C.live && !C.live.closed) C.live.stop(); else closeCall(); };
$("#call").addEventListener("keydown", (e) => { if (e.key === "Escape") $("#call-close").click(); });
function closeCall() { clearInterval(C.timer); $("#call").hidden = true; renderOrders(); }

// Text mode: you type as the customer, Gemini replies as the agent.
$("#call-text").onclick = async () => {
  C.mode = "text"; $("#call-mode").textContent = "Text · Gemini";
  $("#call-start").hidden = true; $("#call-text").hidden = true; $("#call-end").hidden = false;
  $("#call-end").onclick = () => finishCall();
  $("#call-form").hidden = false; setCallState("On call (text)", "live"); startTimer();
  await agentTurn(); $("#call-input").focus();
};
async function agentTurn() {
  const body = $("#call-lines");
  body.insertAdjacentHTML("beforeend", `<div class="line sys" id="typing">Riya is typing…</div>`); body.scrollTop = body.scrollHeight;
  try { const r = await api(`/api/orders/${C.order.id}/chat`, { body: { turns: C.lines } }); C.lines.push({ role: "agent", text: r.reply }); }
  catch (e) { toast(e.message); }
  $("#typing")?.remove(); drawLines();
}
$("#call-form").onsubmit = async (e) => {
  e.preventDefault(); const v = $("#call-input").value.trim(); if (!v) return;
  $("#call-input").value = ""; C.lines.push({ role: "customer", text: v }); drawLines(); await agentTurn();
};

async function finishCall() {
  if (C.finishing) return; C.finishing = true;
  clearInterval(C.timer); $("#call-form").hidden = true; $("#call-end").hidden = true;
  $("#call-end").onclick = () => C.live?.stop();
  setCallState("Call ended", "");
  const res = $("#call-result"); res.hidden = false;
  if (!C.lines.some(l => l.role === "customer")) {
    res.innerHTML = `<p>No customer speech was captured, so there is nothing to analyse. Try again with headphones, or use text.</p><div class="btns"><button class="btn" id="cr-close">Close</button></div>`;
    $("#cr-close").onclick = closeCall; C.finishing = false; $("#call-start").hidden = false; $("#call-start").disabled = false; $("#call-text").hidden = false; return;
  }
  res.innerHTML = `<p>${SPARK} Gemini is reading the call…</p>`;
  try {
    const r = await api(`/api/orders/${C.order.id}/call-result`, { body: { transcript: C.lines, mode: C.mode } });
    upsert(r.order);
    res.innerHTML = callResultHTML({ ...r.result, mode: C.mode }) + `<p class="fine">Saved to the order${S.health.firestore?.startsWith?.("connected") ? " in Firestore" : ""}. Delivery probability is now ${r.order.pAfter == null ? "n/a (order stopped)" : r.order.pAfter + "%"}.</p><div class="btns"><button class="btn primary" id="cr-close">Back to orders</button></div>`;
  } catch (e) { res.innerHTML = `<p>${esc(e.message)}</p><div class="btns"><button class="btn" id="cr-close">Close</button></div>`; }
  $("#cr-close").onclick = closeCall; C.finishing = false;
}

// ---------------- Rules ----------------
function inControl(id, p) { let h = 2166136261; for (const ch of id) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return ((h >>> 0) % 100) < p; }
function recommendLocal(o, r) {
  const risky = o.p < r.nudgeBelow || o.weakAddress;
  if (risky && inControl(o.id, r.controlPct)) return "control";
  if (o.p < r.callBelow) return o.payment === "COD" && o.customer.prevRto >= r.tokenMinPastRto ? "token" : "call";
  if (o.p < r.nudgeBelow) return o.payment === "COD" ? "prepaid_nudge" : o.weakAddress ? "address_fix" : "ship";
  return o.weakAddress ? "address_fix" : "ship";
}
const RULE_FIELDS = [
  ["callBelow", "Call below", "%", 5, 95, "Orders under this delivery probability get a Gemini voice call (or a token request if they have returned COD orders before)."],
  ["nudgeBelow", "Nudge below", "%", 5, 99, "COD orders under this probability get a WhatsApp offer to pay in full now. Prepaid orders with a weak address get an address fix."],
  ["discountPct", "Prepaid discount", "%", 0, 30, "Discount offered for paying the full amount online."],
  ["tokenAmount", "Token amount", "₹", 0, 1000, "Part-payment asked from high-RTO COD customers before dispatch."],
  ["tokenMinPastRto", "Token after past RTOs", "", 1, 5, "COD customers with at least this many returned orders get the token request instead of a call."],
  ["controlPct", "Control group", "%", 0, 30, "Share of risky orders left untouched so impact can be measured."],
];
let draft = null, simT = null;
function renderRules() {
  draft = { ...S.rules };
  $("#rules-form").innerHTML = `
    <div class="rule"><span class="k">Bands on today's queue</span><div class="bandbar" id="bandbar"></div></div>
    ${RULE_FIELDS.map(([k, label, unit, lo, hi, hint]) => `
      <div class="rule"><label for="r-${k}">${label}</label>
        <div class="rule-row"><input type="range" id="r-${k}" data-k="${k}" min="${lo}" max="${hi}" value="${draft[k]}">
        <input type="number" id="n-${k}" data-k="${k}" min="${lo}" max="${hi}" value="${draft[k]}" aria-label="${label} value${unit ? " in " + unit : ""}"></div>
        <span class="hint">${hint}</span></div>`).join("")}
    <div class="btns"><button class="btn primary" type="submit">Save rules</button><button class="btn ghost" type="button" id="r-reset">Reset to defaults</button></div>`;
  const form = $("#rules-form");
  form.oninput = (e) => { const k = e.target.dataset.k; if (!k) return; draft[k] = Number(e.target.value); $(`#r-${k}`).value = draft[k]; $(`#n-${k}`).value = draft[k]; if (draft.nudgeBelow < draft.callBelow) { draft.nudgeBelow = draft.callBelow; $("#r-nudgeBelow").value = $("#n-nudgeBelow").value = draft.nudgeBelow; } previewRules(); };
  form.onsubmit = async (e) => { e.preventDefault(); try { const r = await api("/api/rules", { method: "PUT", body: draft }); S.rules = r.rules; const o = await api("/api/orders"); S.orders = o.orders; toast(r.saved ? "Rules saved to Firestore" : "Rules saved (Firestore unavailable, kept in memory)"); } catch (err) { toast(err.message); } };
  $("#r-reset").onclick = async () => { const d = await api("/api/rules"); draft = { ...d.defaults }; RULE_FIELDS.forEach(([k]) => { $(`#r-${k}`).value = $(`#n-${k}`).value = draft[k]; }); previewRules(); };
  previewRules();
}
function previewRules() {
  const counts = {}; S.orders.forEach(o => { const a = recommendLocal(o, draft); counts[a] = (counts[a] || 0) + 1; });
  const order = ["call", "token", "prepaid_nudge", "address_fix", "control", "ship"];
  $("#rules-queue").innerHTML = `<span class="k">Today's ${S.orders.length} orders with these rules</span><div class="qcount">${order.map(a => `<div class="qrow"><span class="act a-${a}"><i></i>${ACTION_TEXT[a][0]}</span><b>${counts[a] || 0}</b></div>`).join("")}</div>`;
  const c = draft.callBelow, n = draft.nudgeBelow;
  $("#bandbar").innerHTML = `<div style="flex-basis:${c}%;background:var(--crit)">${c >= 12 ? `&lt;${c}% call` : ""}</div><div style="flex-basis:${n - c}%;background:var(--warn)">${n - c >= 12 ? `${c}–${n}% nudge` : ""}</div><div style="flex-basis:${100 - n}%;background:var(--good)">${100 - n >= 12 ? `${n}%+ ship` : ""}</div>`;
  clearTimeout(simT);
  simT = setTimeout(async () => {
    try {
      const s = await api("/api/impact/preview", { body: draft });
      $("#rules-sim").innerHTML = `<span class="k">30-day simulation with these rules</span>
        <div class="cmp">
          <div class="cmp-row"><span>Control</span><div class="track"><i class="bg-crit" style="width:${Math.min(100, s.control.rate * 200)}%"></i></div><b>${pct(s.control.rate, 1)}</b></div>
          <div class="cmp-row"><span>Acted on</span><div class="track"><i style="width:${Math.min(100, s.treated.rate * 200)}%;background:var(--accent)"></i></div><b>${pct(s.treated.rate, 1)}</b></div>
        </div>
        <p>RTO rate among risky orders. Estimated <b>${s.savedOrders.toLocaleString("en-IN")}</b> orders and <b>${inr(s.savedRupees)}</b> saved over ${s.orders.toLocaleString("en-IN")} orders.</p>`;
    } catch { /* ignore preview errors */ }
  }, 220);
}

// ---------------- Impact ----------------
async function renderImpact() {
  const el = $("#impact");
  el.innerHTML = `<div class="empty">Loading…</div>`;
  let d; try { d = await api("/api/impact"); } catch (e) { el.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  const s = d.sim, t = d.today, A = s.assumptions;
  const drop = s.control.rate ? 1 - s.treated.rate / s.control.rate : 0;
  const tiers = ["Metro", "Tier 2", "Tier 3"].filter(k => s.byTier[k]);
  const max = Math.max(...tiers.flatMap(k => [s.byTier[k].treated, s.byTier[k].control]), 0.01);
  const acts = ["call", "token", "prepaid_nudge", "address_fix", "control"].filter(k => s.byAction[k]);
  el.innerHTML = `
  <div class="kpis">
    <div class="kpi hero"><span class="k">RTO among risky orders</span><b>${pct(s.treated.rate, 1)}</b><span>vs ${pct(s.control.rate, 1)} in the control group, ${pct(drop)} lower</span></div>
    <div class="kpi"><span class="k">Orders saved</span><b>${s.savedOrders.toLocaleString("en-IN")}</b><span>RTOs avoided in 30 days, from ${s.risky.toLocaleString("en-IN")} risky orders</span></div>
    <div class="kpi"><span class="k">Money saved</span><b>${inr(s.savedRupees)}</b><span>at ${inr(A.rtoCost)} logistics cost per RTO</span></div>
    <div class="kpi"><span class="k">Money upfront</span><b>${s.converted.toLocaleString("en-IN")}</b><span>COD orders paid online, plus ${s.tokens.toLocaleString("en-IN")} token payments (${inr(s.tokenSum)})</span></div>
  </div>
  <div class="imp-grid">
    <div class="card">
      <div><span class="k">RTO rate by pincode tier</span><h3>Acted on vs control</h3></div>
      <div class="legend"><span><i style="background:var(--accent)"></i>Acted on</span><span><i class="bg-crit"></i>Control (no action)</span></div>
      <div class="cmp">${tiers.map(k => `
        <div class="cmp-row"><span>${k}</span><div class="track"><i style="width:${s.byTier[k].treated / max * 100}%;background:var(--accent)"></i></div><b>${pct(s.byTier[k].treated)}</b></div>
        <div class="cmp-row"><span class="sub">control</span><div class="track"><i class="bg-crit" style="width:${s.byTier[k].control / max * 100}%"></i></div><b class="sub">${pct(s.byTier[k].control)}</b></div>`).join("")}
      </div>
      <div class="tbl-wrap"><table><thead><tr><th>Action</th><th class="num">Orders</th><th class="num">Stopped before dispatch</th><th class="num">RTO rate</th></tr></thead>
        <tbody>${acts.map(k => `<tr><td><span class="act a-${k}"><i></i>${ACTION_TEXT[k][0]}</span></td><td class="num">${s.byAction[k].n}</td><td class="num">${s.byAction[k].stopped}</td><td class="num">${pct(s.byAction[k].rate, 1)}</td></tr>`).join("")}</tbody></table></div>
      <details class="assume"><summary>Simulation assumptions</summary>
        <p style="margin-top:6px">Outcomes are simulated on ${s.orders.toLocaleString("en-IN")} synthetic orders from the last 30 days using the current rules. Assumed response rates:</p>
        <ul><li>Voice call: ${pct(A.callReach)} reached; ${pct(A.callCancel)} of those cancel before dispatch; confirmed orders' RTO risk × ${A.callConfirmFactor}</li>
        <li>Address fixed: RTO risk × ${A.addressFixFactor}</li>
        <li>Prepaid nudge: ${pct(A.prepaidConvert)} pay online (then ${pct(A.prepaidRtoAfter)} RTO)</li>
        <li>Token request: ${pct(A.tokenPay)} pay (RTO risk × ${A.tokenPaidFactor}); unpaid orders are held</li></ul>
        <p>Real impact comes from live outcomes against the control group once the brand is connected.</p></details>
    </div>
    <div class="card">
      <div><span class="k">Today, live</span><h3>What RTO Shield did on today's queue</h3></div>
      <div class="today">
        <div><b>${t.calls}</b><span>Gemini calls</span></div>
        <div><b class="c-good">${t.confirmed}</b><span>confirmed or rescheduled</span></div>
        <div><b class="c-crit">${t.cancelled}</b><span>stopped before dispatch</span></div>
        <div><b>${t.addressFixed}</b><span>addresses fixed</span></div>
        <div><b class="c-good">${t.converted}</b><span>paid online</span></div>
        <div><b class="c-good">${t.tokenPaid}</b><span>tokens paid</span></div>
        <div><b>${t.held}</b><span>held</span></div>
        <div><b>${t.risky}</b><span>at-risk orders</span></div>
      </div>
      <span class="k">Recent activity</span>
      <div class="log">${d.log.length ? d.log.map(a => `<div><time>${ago(a.at)}</time><span><span class="mono">${a.orderId}</span> · ${esc(a.detail)}</span></div>`).join("") : `<p class="sub">No actions yet today. Open an order and start a call.</p>`}</div>
    </div>
  </div>`;
}

// ---------------- About ----------------
function renderAbout() {
  $("#about").innerHTML = `
    <div class="flow">
      <div class="card"><span class="n">1 · SCORE</span><h3>Every order</h3><p>Delivery probability from pincode history, payment mode, customer history, address quality and order pattern, COD or prepaid.</p></div>
      <div class="card"><span class="n">2 · EXPLAIN</span><h3>Reasons</h3><p>Each order carries reason codes like WEAK_ADDRESS or PAST_RTO, so the right action can be picked.</p></div>
      <div class="card"><span class="n">3 · ACT</span><h3>Gemini acts</h3><p>Voice call in the buyer's language, prepaid or token payment request, address clean-up. Results are written back to the order.</p></div>
      <div class="card"><span class="n">4 · MEASURE</span><h3>Against a control</h3><p>A share of risky orders gets no action. The dashboard compares RTO rates to show real impact.</p></div>
    </div>
    <div class="stack">
      <div class="card"><b>Gemini Live API</b><p>Real-time voice call in the browser; transcripts of both sides.</p></div>
      <div class="card"><b>Gemini Flash</b><p>Address check, WhatsApp drafts, and turning the call into outcome, sentiment and intent.</p></div>
      <div class="card"><b>Cloud Run</b><p>Hosts this app: one Node.js container with no dependencies.</p></div>
      <div class="card"><b>Firestore</b><p>Orders, actions, call results and rules.</p></div>
    </div>
    <p class="fine">All data in this prototype is synthetic. Brand, customers and orders are made up.</p>`;
}

boot();
