// Synthetic data for RTO Shield. Everything here is made up and generated from fixed seeds,
// so the demo looks the same on every start. No real customer or company data is used.

export function rng(seed) {
  // mulberry32
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const BRAND = "Saanjh Fashion"; // fictional D2C brand used in the demo

// city, state, pincode, tier, historical pincode RTO rate (synthetic), language
export const CITIES = [
  ["Mumbai", "MH", "400070", "Metro", 0.14, "en"],
  ["New Delhi", "DL", "110017", "Metro", 0.12, "hi"],
  ["Bengaluru", "KA", "560034", "Metro", 0.13, "en"],
  ["Hyderabad", "TG", "500032", "Metro", 0.15, "en"],
  ["Chennai", "TN", "600040", "Metro", 0.13, "en"],
  ["Pune", "MH", "411014", "Metro", 0.14, "en"],
  ["Kolkata", "WB", "700091", "Metro", 0.17, "en"],
  ["Jaipur", "RJ", "302017", "Tier 2", 0.22, "hi"],
  ["Lucknow", "UP", "226010", "Tier 2", 0.26, "hi"],
  ["Indore", "MP", "452010", "Tier 2", 0.21, "hi"],
  ["Patna", "BR", "800020", "Tier 2", 0.33, "hi"],
  ["Bhopal", "MP", "462016", "Tier 2", 0.24, "hi"],
  ["Nagpur", "MH", "440010", "Tier 2", 0.20, "hi"],
  ["Surat", "GJ", "395007", "Tier 2", 0.19, "hi"],
  ["Kanpur", "UP", "208012", "Tier 2", 0.30, "hi"],
  ["Ranchi", "JH", "834001", "Tier 2", 0.31, "hi"],
  ["Motihari", "BR", "845401", "Tier 3", 0.44, "hi"],
  ["Gaya", "BR", "823001", "Tier 3", 0.41, "hi"],
  ["Sitapur", "UP", "261001", "Tier 3", 0.39, "hi"],
  ["Bahraich", "UP", "271801", "Tier 3", 0.43, "hi"],
  ["Jhunjhunu", "RJ", "333001", "Tier 3", 0.34, "hi"],
  ["Darbhanga", "BR", "846004", "Tier 3", 0.42, "hi"],
  ["Ballia", "UP", "277001", "Tier 3", 0.45, "hi"],
  ["Hardoi", "UP", "241001", "Tier 3", 0.40, "hi"],
].map(([city, state, pincode, tier, pinRate, lang]) => ({ city, state, pincode, tier, pinRate, lang }));

const FIRST = ["Priya", "Rahul", "Anjali", "Vikas", "Sneha", "Amit", "Pooja", "Rohit", "Neha", "Sanjay", "Kavita", "Arjun",
  "Ritu", "Manoj", "Deepika", "Suresh", "Meena", "Karan", "Shalini", "Ajay", "Nisha", "Ravi", "Sunita", "Imran", "Farah", "Gurpreet", "Lakshmi", "Arun"];
const LAST = ["Sharma", "Verma", "Singh", "Kumar", "Gupta", "Yadav", "Mishra", "Patel", "Reddy", "Iyer", "Das", "Khan", "Jain", "Pandey", "Nair", "Chauhan"];
const CATS = [["Cotton kurta set", 1299], ["Printed saree", 1899], ["Denim jacket", 2499], ["Ethnic dupatta", 749], ["Men's linen shirt", 1199],
  ["Anarkali dress", 2199], ["Kids festive wear", 899], ["Palazzo pants", 649], ["Silk stole", 999], ["Embroidered lehenga", 3499]];
const STREETS = ["MG Road", "Station Road", "Civil Lines", "Gandhi Nagar", "Shastri Nagar", "Model Town", "Rajendra Nagar", "Ashok Vihar", "Laxmi Nagar", "Indira Colony"];
const WEAK = [
  "near Sharma ji dairy, gali no 3",
  "behind bus stand, opp. Hanuman mandir",
  "main road ke paas, blue gate wala ghar",
  "near the park, sector 4",
  "village post office ke saamne, near school",
  "Ram chowk, chai ki dukaan ke peeche",
  "opposite petrol pump, 2nd lane",
];

function pick(r, arr) { return arr[Math.floor(r() * arr.length)]; }
function pickCity(r) {
  const x = r();
  const tier = x < 0.4 ? "Metro" : x < 0.75 ? "Tier 2" : "Tier 3";
  return pick(r, CITIES.filter(c => c.tier === tier));
}

export function makeOrder(r, id, createdAt) {
  const c = pickCity(r);
  const [category, basePrice] = pick(r, CATS);
  const codShare = c.tier === "Tier 3" ? 0.85 : c.tier === "Tier 2" ? 0.7 : 0.5;
  const payment = r() < codShare ? "COD" : "Prepaid";
  const prevOrders = r() < 0.38 ? 0 : Math.floor(r() * 12) + 1;
  const prevRto = prevOrders === 0 ? 0 : (r() < 0.78 ? 0 : r() < 0.7 ? 1 : 2 + Math.floor(r() * 2));
  const weakChance = c.tier === "Tier 3" ? 0.45 : c.tier === "Tier 2" ? 0.25 : 0.12;
  const weak = r() < weakChance;
  const address = weak
    ? pick(r, WEAK)
    : `${Math.floor(r() * 300) + 1}${pick(r, ["", "-A", "/2", " B"])}, ${pick(r, STREETS)}, ${c.city}`;
  const items = r() < 0.8 ? 1 : 2 + Math.floor(r() * 3);
  const amount = Math.round(basePrice * items * (0.9 + r() * 0.25) / 10) * 10 - 1;
  const hour = r() < 0.1 ? Math.floor(r() * 5) : 8 + Math.floor(r() * 15);
  const name = `${pick(r, FIRST)} ${pick(r, LAST)}`;
  const phone = `+91 9${Math.floor(r() * 9)}XXX XX${String(Math.floor(r() * 900) + 100)}`;
  return {
    id, createdAt, brand: BRAND,
    customer: { name, phone, lang: c.lang, prevOrders, prevRto },
    city: c.city, state: c.state, pincode: c.pincode, tier: c.tier, pinRate: c.pinRate,
    payment, amount, items, category, hour, address,
  };
}

// Five hand-made showcase orders (same as the overview page), then generated ones.
function showcase(now) {
  const C = p => CITIES.find(c => c.pincode === p);
  const mk = (id, pin, o) => {
    const c = C(pin);
    return { id, createdAt: now - 3600e3, brand: BRAND, city: c.city, state: c.state, pincode: c.pincode, tier: c.tier, pinRate: c.pinRate, items: 1, hour: 14, ...o };
  };
  return [
    mk("ORD-1042", "845401", { customer: { name: "Sunita Yadav", phone: "+91 98XXX XX412", lang: "hi", prevOrders: 0, prevRto: 0 }, payment: "COD", amount: 1899, category: "Printed saree", address: "near Sharma ji dairy, gali no 3", hour: 23 }),
    mk("ORD-1043", "302017", { customer: { name: "Priya Sharma", phone: "+91 97XXX XX208", lang: "hi", prevOrders: 4, prevRto: 0 }, payment: "COD", amount: 749, category: "Ethnic dupatta", address: "B-14, Malviya Nagar, Sector 7, Jaipur" }),
    mk("ORD-1044", "800020", { customer: { name: "Rahul Verma", phone: "+91 99XXX XX761", lang: "hi", prevOrders: 5, prevRto: 2 }, payment: "COD", amount: 2499, category: "Denim jacket", address: "Flat 3B, Kankarbagh Colony, Patna" }),
    mk("ORD-1045", "560034", { customer: { name: "Lakshmi Iyer", phone: "+91 96XXX XX330", lang: "en", prevOrders: 0, prevRto: 0 }, payment: "Prepaid", amount: 1299, category: "Cotton kurta set", address: "Koramangala 4th block, near the park" }),
    mk("ORD-1046", "110017", { customer: { name: "Arjun Mehta", phone: "+91 98XXX XX905", lang: "en", prevOrders: 9, prevRto: 0 }, payment: "Prepaid", amount: 899, category: "Kids festive wear", address: "C-22, Malviya Nagar, 2nd floor, New Delhi" }),
  ];
}

export function todaysQueue(now = Date.now()) {
  const r = rng(20261018);
  const out = showcase(now);
  for (let i = 0; i < 31; i++) out.push(makeOrder(r, `ORD-${1047 + i}`, now - Math.floor(r() * 10) * 3600e3));
  return out;
}

// 30 days of past orders, used only for the impact simulation.
export function history(n = 4000) {
  const r = rng(424242);
  const out = [];
  for (let i = 0; i < n; i++) out.push(makeOrder(r, `H-${100000 + i}`, 0));
  return out;
}
