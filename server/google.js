// Thin REST clients for Gemini and Firestore. No SDKs, so the app has zero npm dependencies.

const KEY = process.env.GEMINI_API_KEY || "";
export const TEXT_MODEL = process.env.TEXT_MODEL || "gemini-flash-latest";
export const LIVE_MODEL = process.env.LIVE_MODEL || "gemini-3.8-live";
export const LIVE_API_VERSION = process.env.LIVE_API_VERSION || "v1beta";
export const geminiReady = () => Boolean(KEY);

const GL = "https://generativelanguage.googleapis.com";

export async function generate({ system, prompt, history, json = true, temperature = 0.4 }) {
  if (!KEY) throw new Error("GEMINI_API_KEY is not set");
  const contents = history?.length ? history : [{ role: "user", parts: [{ text: prompt }] }];
  const res = await fetch(`${GL}/v1beta/models/${TEXT_MODEL}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": KEY, "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      contents,
      generationConfig: { temperature, ...(json ? { responseMimeType: "application/json" } : {}) },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${data?.error?.message || "request failed"}`);
  const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("");
  if (!json) return text.trim();
  try { return JSON.parse(text); }
  catch { const m = text.match(/\{[\s\S]*\}/); if (m) return JSON.parse(m[0]); throw new Error("Gemini returned non-JSON output"); }
}

// Short-lived token so the browser can open a Gemini Live session without seeing the API key.
export async function liveToken() {
  if (!KEY) throw new Error("GEMINI_API_KEY is not set");
  const now = Date.now();
  const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  const res = await fetch(`${GL}/${LIVE_API_VERSION}/auth_tokens`, {
    method: "POST",
    headers: { "x-goog-api-key": KEY, "content-type": "application/json" },
    body: JSON.stringify({ uses: 1, expireTime: iso(now + 30 * 60e3), newSessionExpireTime: iso(now + 2 * 60e3) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.name) throw new Error(`Live token ${res.status}: ${data?.error?.message || "no token returned"}`);
  return {
    token: data.name,
    model: `models/${LIVE_MODEL}`,
    url: `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.${LIVE_API_VERSION}.GenerativeService.BidiGenerateContentConstrained?access_token=${encodeURIComponent(data.name)}`,
  };
}

// ---------------- Firestore (REST + Cloud Run metadata credentials) ----------------
const MD = "http://metadata.google.internal/computeMetadata/v1";
let tok = null, tokExp = 0, projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT || "";
let fsState = "unknown";
export const firestoreState = () => fsState;

async function md(path) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 1500);
  try {
    const r = await fetch(MD + path, { headers: { "Metadata-Flavor": "Google" }, signal: ctrl.signal });
    if (!r.ok) throw new Error(`metadata ${r.status}`);
    return r;
  } finally { clearTimeout(t); }
}
async function token() {
  if (tok && Date.now() < tokExp) return tok;
  const r = await md("/instance/service-accounts/default/token");
  const j = await r.json();
  tok = j.access_token; tokExp = Date.now() + (j.expires_in - 60) * 1000;
  return tok;
}
async function project() {
  if (!projectId) projectId = await (await md("/project/project-id")).text();
  return projectId;
}
const base = async () => `https://firestore.googleapis.com/v1/projects/${await project()}/databases/${encodeURIComponent(process.env.FIRESTORE_DATABASE || "(default)")}/documents`;

// Documents are stored as { json: <stringified object>, updatedAt } to keep the REST mapping simple.
export async function fsSet(collection, id, obj) {
  try {
    const res = await fetch(`${await base()}/${collection}/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${await token()}`, "content-type": "application/json" },
      body: JSON.stringify({ fields: { json: { stringValue: JSON.stringify(obj) }, updatedAt: { timestampValue: new Date().toISOString() } } }),
    });
    if (!res.ok) throw new Error(`Firestore ${res.status}: ${(await res.text()).slice(0, 200)}`);
    fsState = "connected";
    return true;
  } catch (e) { fsState = `unavailable (${e.message})`; return false; }
}

export async function fsList(collection) {
  try {
    const out = [];
    let pageToken = "";
    do {
      const res = await fetch(`${await base()}/${collection}?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ""}`, {
        headers: { authorization: `Bearer ${await token()}` },
      });
      if (!res.ok) throw new Error(`Firestore ${res.status}`);
      const j = await res.json();
      for (const d of j.documents || []) {
        try { out.push({ id: decodeURIComponent(d.name.split("/").pop()), ...JSON.parse(d.fields.json.stringValue) }); } catch { /* skip bad doc */ }
      }
      pageToken = j.nextPageToken || "";
    } while (pageToken);
    fsState = "connected";
    return out;
  } catch (e) { fsState = `unavailable (${e.message})`; return null; }
}

export async function fsDelete(collection, id) {
  try {
    const res = await fetch(`${await base()}/${collection}/${encodeURIComponent(id)}`, { method: "DELETE", headers: { authorization: `Bearer ${await token()}` } });
    return res.ok;
  } catch { return false; }
}
