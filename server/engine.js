// Risk score, rules and impact simulation.
import { rng, history } from "./data.js";

// --- Address quality (fast heuristic; Gemini does the real check on demand) ---
const WEAK_HINTS = /(near|behind|opp\.?|opposite|ke paas|ke saamne|ke peeche|wala|chowk|gali|lane|park|mandir|dukaan|petrol pump)/i;
export function addressLooksWeak(address) {
  const hasNumber = /\d+[-\/ ]?[A-Za-z]?\s*,/.test(address) || /^(flat|house|h\.?\s?no|plot|[a-z]-?\d)/i.test(address.trim());
  return !hasNumber && WEAK_HINTS.test(address) || address.length < 22;
}

// --- Score: delivery probability 0..1 with reason codes ---
export const WEIGHTS = {
  base: 0.85,
  cod: 0.15,
  pincodePerPoint: 0.7,    // per point of pincode RTO rate above 10%
  newCustomer: 0.06,
  pastRtoEach: 0.14,
  weakAddress: 0.13,
  anomaly: 0.07,
  loyalBonus: 0.04,         // 5+ delivered, 0 RTO
};

export function score(o) {
  const reasons = [];
  let p = WEIGHTS.base;
  const pin = Math.max(0, o.pinRate - 0.10) * WEIGHTS.pincodePerPoint;
  p -= pin; if (o.pinRate >= 0.3) reasons.push("HIGH_RISK_PINCODE");
  if (o.payment === "COD") { p -= WEIGHTS.cod; reasons.push("COD"); }
  const c = o.customer;
  if (c.prevOrders === 0) { p -= WEIGHTS.newCustomer; reasons.push("NEW_CUSTOMER"); }
  if (c.prevRto > 0) { p -= Math.min(2, c.prevRto) * WEIGHTS.pastRtoEach; reasons.push("PAST_RTO"); }
  if (c.prevOrders >= 5 && c.prevRto === 0) p += WEIGHTS.loyalBonus;
  const weak = o.addressFixed ? false : addressLooksWeak(o.address);
  if (weak) { p -= WEIGHTS.weakAddress; reasons.push("WEAK_ADDRESS"); }
  const anomaly = o.hour < 5 || o.items >= 4 || o.amount >= 4000;
  if (anomaly) { p -= WEIGHTS.anomaly; reasons.push("ORDER_ANOMALY"); }
  p = Math.min(0.98, Math.max(0.03, p));
  return { p: Math.round(p * 100), reasons, weakAddress: weak };
}

// --- Rules ---
export const DEFAULT_RULES = {
  callBelow: 40,        // below this probability: Gemini voice call
  nudgeBelow: 65,       // below this: COD -> prepaid nudge; weak address -> address fix
  discountPct: 5,       // discount offered for paying in full now
  tokenAmount: 199,     // token (part-prepaid) amount for high-RTO COD customers
  tokenMinPastRto: 1,   // COD customers with at least this many past RTOs get a token request
  controlPct: 5,        // share of risky orders left untouched as a control group
};

export function inControl(id, pct) {
  let h = 2166136261;
  for (const ch of id) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100) < pct;
}

export const ACTION_LABEL = {
  call: "Gemini voice call",
  token: "Token amount upfront",
  prepaid_nudge: "Prepaid nudge",
  address_fix: "Address fix",
  ship: "Ship as normal",
  control: "Control group (no action)",
};

export function recommend(o, s, rules) {
  const risky = s.p < rules.nudgeBelow || s.weakAddress;
  if (risky && inControl(o.id, rules.controlPct)) return "control";
  if (s.p < rules.callBelow) {
    if (o.payment === "COD" && o.customer.prevRto >= rules.tokenMinPastRto) return "token";
    return "call";
  }
  if (s.p < rules.nudgeBelow) {
    if (o.payment === "COD") return "prepaid_nudge";
    if (s.weakAddress) return "address_fix";
    return "ship";
  }
  if (s.weakAddress) return "address_fix";
  return "ship";
}

// --- Impact simulation over 30 days of synthetic past orders ---
// Assumptions are shown on the dashboard. They are illustrative, not measured.
export const SIM_ASSUMPTIONS = {
  callReach: 0.7, callCancel: 0.15, callConfirmFactor: 0.55, addressFixFactor: 0.6,
  prepaidConvert: 0.28, prepaidRtoAfter: 0.03, nudgeIgnoredFactor: 0.95,
  tokenPay: 0.35, tokenPaidFactor: 0.25,
  rtoCost: 200,
};

let HIST = null;
export function simulate(rules) {
  HIST ||= history(4000);
  const A = SIM_ASSUMPTIONS;
  const r = rng(777);
  const g = { control: { n: 0, rto: 0 }, treated: { n: 0, rto: 0, stopped: 0 }, safe: { n: 0, rto: 0 } };
  const byAction = {};
  const byTier = {};
  let converted = 0, tokens = 0, tokenSum = 0, calls = 0, addrFixed = 0;
  for (const o of HIST) {
    const s = score(o);
    const action = recommend(o, s, rules);
    // ground truth chance of RTO if we do nothing (score is calibrated-ish, plus noise)
    let q = Math.min(0.95, Math.max(0.01, (1 - s.p / 100) * 0.62 * (0.85 + r() * 0.3)));
    let rto = false, stopped = false;
    const u = r(), v = r(), w = r();
    switch (action) {
      case "call": {
        calls++;
        if (u < A.callReach) {
          if (v < A.callCancel) stopped = true;
          else { q *= A.callConfirmFactor; if (s.weakAddress) { q *= A.addressFixFactor; addrFixed++; } }
        }
        break;
      }
      case "token": {
        if (u < A.tokenPay) { q *= A.tokenPaidFactor; tokens++; tokenSum += rules.tokenAmount; }
        else stopped = true; // held, never shipped
        break;
      }
      case "prepaid_nudge": {
        if (u < A.prepaidConvert) { q = A.prepaidRtoAfter; converted++; } else q *= A.nudgeIgnoredFactor;
        break;
      }
      case "address_fix": { if (u < 0.75) { q *= A.addressFixFactor; addrFixed++; } break; }
      default: break;
    }
    if (!stopped) rto = w < q;
    const bucket = action === "control" ? g.control : action === "ship" ? g.safe : g.treated;
    bucket.n++; if (rto) bucket.rto++; if (stopped) g.treated.stopped++;
    const ba = byAction[action] ||= { n: 0, rto: 0, stopped: 0 };
    ba.n++; if (rto) ba.rto++; if (stopped) ba.stopped++;
    if (action !== "ship") {
      const t = byTier[o.tier] ||= { treated: { n: 0, rto: 0 }, control: { n: 0, rto: 0 } };
      const k = action === "control" ? "control" : "treated";
      t[k].n++; if (rto) t[k].rto++;
    }
  }
  const rate = b => b.n ? b.rto / b.n : 0;
  const controlRate = rate(g.control);
  const treatedRate = rate(g.treated);
  const expectedWithout = controlRate * g.treated.n;
  const saved = Math.max(0, Math.round(expectedWithout - g.treated.rto));
  return {
    orders: HIST.length,
    risky: g.treated.n + g.control.n,
    control: { ...g.control, rate: controlRate },
    treated: { ...g.treated, rate: treatedRate },
    safe: { ...g.safe, rate: rate(g.safe) },
    savedOrders: saved,
    savedRupees: saved * A.rtoCost,
    converted, tokens, tokenSum, calls, addrFixed,
    byAction: Object.fromEntries(Object.entries(byAction).map(([k, b]) => [k, { ...b, rate: rate(b), label: ACTION_LABEL[k] }])),
    byTier: Object.fromEntries(Object.entries(byTier).map(([k, t]) => [k, { treated: rate(t.treated), control: rate(t.control), n: t.treated.n + t.control.n }])),
    assumptions: A,
  };
}
