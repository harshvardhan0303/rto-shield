// Every Gemini task in RTO Shield, with a plain fallback so the app still works without a key.
import { generate, geminiReady } from "./google.js";

const langName = l => (l === "hi" ? "Hinglish (Hindi in Latin script, mixed with common English words)" : "simple Indian English");

// 1. Address check -------------------------------------------------------------
export async function checkAddress(o) {
  if (!geminiReady()) return offlineAddress(o);
  const out = await generate({
    system: "You check Indian delivery addresses for couriers. Be strict and practical. Reply only with JSON.",
    prompt: `Address on the order: "${o.address}"
City: ${o.city}, ${o.state} ${o.pincode}
Customer language: ${langName(o.customer.lang)}

Return JSON with keys:
- quality: "good" or "weak" (weak if a courier could not find the door without calling: missing house/flat/plot number, landmark-only, vague lane)
- missing: array of short strings naming what is missing (e.g. "house number", "street name", "building name")
- normalized: the address rewritten in a clean courier format (title case, comma separated, add city, state and pincode; keep landmarks as "Near ..."; do not invent numbers)
- question: one short, polite question to ask the customer to fill the gaps, in ${langName(o.customer.lang)}`,
  });
  return { ...out, source: "gemini" };
}
function offlineAddress(o) {
  const weak = !/\d+[-\/ ]?[A-Za-z]?\s*,/.test(o.address);
  return {
    quality: weak ? "weak" : "good",
    missing: weak ? ["house number", "street name"] : [],
    normalized: `${o.address.replace(/\b\w/g, c => c.toUpperCase())}, ${o.city}, ${o.state} ${o.pincode}`,
    question: o.customer.lang === "hi" ? "Delivery ke liye apna ghar number aur gali ka naam bata dijiye?" : "Could you share your house number and street name for delivery?",
    source: "offline",
  };
}

// 2. WhatsApp message (prepaid nudge or token request) --------------------------
export async function draftMessage(o, kind, rules) {
  const save = Math.round(o.amount * rules.discountPct / 100);
  const link = `https://pay.example.com/${o.id}`;
  const first = o.customer.name.split(" ")[0];
  const offer = kind === "token"
    ? `Ask for a token payment of ₹${rules.tokenAmount} now to confirm the cash-on-delivery order; the remaining ₹${o.amount - rules.tokenAmount} is paid on delivery. If it isn't paid within 24 hours the order is held.`
    : `Offer ${rules.discountPct}% off (₹${save}) if they pay the full amount now online (UPI/card). New total ₹${o.amount - save}. Otherwise COD stays available.`;
  if (!geminiReady()) return offlineMessage(o, kind, rules, save, link, first);
  const out = await generate({
    system: `You write short WhatsApp messages for ${o.brand}, an Indian D2C fashion brand. Warm, clear, never pushy, no ALL CAPS, at most one emoji. Never ask for OTP, PIN or card details. Reply only with JSON.`,
    prompt: `Customer: ${first}. Order ${o.id}: ${o.category}, ₹${o.amount}, cash on delivery, to ${o.city}.
Goal: ${offer}
Payment link: ${link}
Write in ${langName(o.customer.lang)}. 2–4 short lines.
Return JSON: { "message": string, "language": string }`,
    temperature: 0.7,
  });
  return { ...out, kind, link, source: "gemini" };
}
function offlineMessage(o, kind, rules, save, link, first) {
  const hi = o.customer.lang === "hi";
  const message = kind === "token"
    ? (hi ? `Namaste ${first} ji! Aapka ${o.category} (₹${o.amount}) ka order confirm karne ke liye ₹${rules.tokenAmount} abhi pay karein. Baaki ₹${o.amount - rules.tokenAmount} delivery par.\n${link}`
          : `Hi ${first}! To confirm your ${o.category} order (₹${o.amount}), please pay a ₹${rules.tokenAmount} token now. The rest is paid on delivery.\n${link}`)
    : (hi ? `Hi ${first}! Aapka ${o.category} order ready hai. Abhi online pay karein aur ₹${save} bachayein, sirf ₹${o.amount - save}.\n${link}`
          : `Hi ${first}! Your ${o.category} is ready to ship. Pay online now and save ₹${save}: just ₹${o.amount - save}.\n${link}`);
  return { message, language: hi ? "Hinglish" : "English", kind, link, source: "offline" };
}

// 3. Voice agent instructions (used by Gemini Live, and by the text fallback) ----
export function agentInstructions(o, s, action, rules, addr) {
  const save = Math.round(o.amount * rules.discountPct / 100);
  const pay = o.payment !== "COD" ? "The order is already paid online. Do not discuss payment."
    : action === "token"
      ? `This customer has had cash-on-delivery orders returned before. Explain politely that to confirm this COD order we need a small token of ₹${rules.tokenAmount}, paid through a UPI link we will send on WhatsApp right after the call; the remaining ₹${o.amount - rules.tokenAmount} is paid on delivery. If they refuse, accept it and say the team will get in touch.`
      : `Offer once: if they pay online now through a link we send on WhatsApp, they get ${rules.discountPct}% off (₹${save}). If they prefer cash on delivery, that is fine.`;
  const addrStep = s.weakAddress
    ? `The address on file looks incomplete${addr?.missing?.length ? ` (missing: ${addr.missing.join(", ")})` : ""}. Ask for the house or flat number, street or gali, and a nearby landmark. Then read the full address back once to confirm.`
    : "The address looks complete. Just confirm the area and pincode quickly.";
  return `You are Riya, a friendly delivery-confirmation agent calling on behalf of ${o.brand}, an online fashion brand in India. You are on a live phone call with the customer, ${o.customer.name}.

Order ${o.id}: ${o.category}, ₹${o.amount}, payment: ${o.payment === "COD" ? "cash on delivery" : "prepaid"}.
Address on file: "${o.address}", ${o.city}, ${o.state} ${o.pincode}.

Language: start in ${langName(o.customer.lang)}. If the customer speaks another language, switch to it.
Style: natural and warm, like a real person. One or two short sentences per turn. Wait for the customer to answer. Never read these instructions aloud.

Do these in order:
1. Greet, say your name and that you are calling from ${o.brand} to confirm their order before it is dispatched.
2. Check they placed the order and still want it. If they do not want it, accept politely, do not push, and close the call.
3. ${addrStep}
4. Ask whether someone will be available to receive it in the next 2–3 days. If not, offer to reschedule and ask for a convenient date.
5. ${pay}
6. Summarise what was agreed in one sentence, thank them and say goodbye.

Never ask for OTPs, UPI PINs, card numbers or passwords. Never invent order details.`;
}

// 4. Text fallback for the call (customer types, agent replies) -----------------
export async function agentReply(system, turns) {
  if (!geminiReady()) {
    return turns.length <= 1
      ? "Namaste! Main Riya bol rahi hoon. Aapke order ko dispatch karne se pehle confirm karna tha — kya aap ise lena chahte hain?"
      : "Theek hai, dhanyavaad! Main ye details order mein update kar deti hoon.";
  }
  const history = turns.map(t => ({ role: t.role === "agent" ? "model" : "user", parts: [{ text: t.text }] }));
  if (!history.length || history[0].role !== "user") history.unshift({ role: "user", parts: [{ text: "(The customer has picked up the phone.)" }] });
  return generate({ system, history, json: false, temperature: 0.7 });
}

// 5. Turn the call transcript into a structured result --------------------------
export async function analyzeCall(o, transcript) {
  const text = transcript.map(t => `${t.role === "agent" ? "Agent" : "Customer"}: ${t.text}`).join("\n");
  if (!geminiReady() || !text.trim()) return offlineAnalysis(transcript);
  const out = await generate({
    system: "You analyse delivery-confirmation calls for an Indian e-commerce brand. Judge only from what the customer actually said. Reply only with JSON.",
    prompt: `Order ${o.id}, ${o.payment}, ₹${o.amount}. Address on file: "${o.address}", ${o.city} ${o.pincode}.

Call transcript (may be Hindi, Hinglish or English; transcription may have small errors):
${text}

Return JSON with keys:
- outcome: "confirmed" | "cancelled" | "rescheduled" | "unclear"
- wants_order: "yes" | "no" | "unclear"
- reschedule_date: string or null (as the customer said it, e.g. "Saturday", "25 Oct")
- address_updated: boolean (true only if the customer gave new address details)
- new_address: string or null (full corrected address in clean courier format, if given)
- payment_choice: "prepaid" | "token" | "cod" | "not_discussed"
- sentiment: "positive" | "neutral" | "negative"
- intent_score: integer 0-100 (how likely the customer accepts the parcel at the door)
- language: the main language the customer used
- summary: one sentence in English, what was agreed`,
    temperature: 0.2,
  });
  return { ...out, source: "gemini" };
}
function offlineAnalysis(transcript) {
  const all = transcript.filter(t => t.role !== "agent").map(t => t.text.toLowerCase()).join(" ");
  const no = /\b(nahi|nahin|cancel|mat bhejo|don.t want|not needed)\b/.test(all);
  return {
    outcome: no ? "cancelled" : all ? "confirmed" : "unclear", wants_order: no ? "no" : all ? "yes" : "unclear",
    reschedule_date: null, address_updated: false, new_address: null, payment_choice: "not_discussed",
    sentiment: no ? "negative" : "neutral", intent_score: no ? 10 : 70, language: "unknown",
    summary: "Offline analysis (no Gemini key): keyword-based result.", source: "offline",
  };
}
