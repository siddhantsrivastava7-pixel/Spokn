/**
 * Canonical casing for Indian names and common tech / brand terms that users
 * say in Hinglish conversation. Keys are lowercased; values are the preferred
 * written form. Kept as a static TS object — zero runtime cost, trivially
 * extensible, auditable.
 *
 * Scope: ~150 seed entries. Extensions via `adaptiveRules.hinglishDictionaryOverrides`
 * derived from user feedback.
 */
export const HINGLISH_DICTIONARY: Record<string, string> = {
  // Common Indian given names (women)
  aarohi: "Aarohi",
  aditi: "Aditi",
  ananya: "Ananya",
  anjali: "Anjali",
  ishita: "Ishita",
  kavya: "Kavya",
  meera: "Meera",
  neha: "Neha",
  pooja: "Pooja",
  priya: "Priya",
  riya: "Riya",
  sanya: "Sanya",
  shruti: "Shruti",
  sneha: "Sneha",
  tanvi: "Tanvi",

  // Common Indian given names (men)
  aarav: "Aarav",
  aditya: "Aditya",
  amit: "Amit",
  arjun: "Arjun",
  kabir: "Kabir",
  karan: "Karan",
  rahul: "Rahul",
  raj: "Raj",
  rohan: "Rohan",
  rohit: "Rohit",
  sahil: "Sahil",
  siddharth: "Siddharth",
  vikram: "Vikram",
  vivek: "Vivek",
  yash: "Yash",

  // Cities / places
  bengaluru: "Bengaluru",
  bangalore: "Bangalore",
  chennai: "Chennai",
  delhi: "Delhi",
  gurgaon: "Gurgaon",
  hyderabad: "Hyderabad",
  kolkata: "Kolkata",
  mumbai: "Mumbai",
  noida: "Noida",
  pune: "Pune",

  // Indian brand / tech terms
  flipkart: "Flipkart",
  infosys: "Infosys",
  ola: "Ola",
  paytm: "Paytm",
  phonepe: "PhonePe",
  swiggy: "Swiggy",
  tcs: "TCS",
  wipro: "Wipro",
  zomato: "Zomato",

  // General tech terms frequently code-switched
  api: "API",
  ci: "CI",
  css: "CSS",
  cto: "CTO",
  ceo: "CEO",
  gpu: "GPU",
  graphql: "GraphQL",
  html: "HTML",
  ios: "iOS",
  javascript: "JavaScript",
  json: "JSON",
  kubernetes: "Kubernetes",
  npm: "npm",
  nodejs: "Node.js",
  postgres: "Postgres",
  postgresql: "PostgreSQL",
  python: "Python",
  react: "React",
  redis: "Redis",
  restapi: "REST API",
  sql: "SQL",
  tdd: "TDD",
  typescript: "TypeScript",
  url: "URL",
  vpn: "VPN",
};

/**
 * Two-word Hinglish phrase overrides. Matched case-insensitively on adjacent
 * word tokens. Useful for constructs like "react js" → "React.js".
 */
export const HINGLISH_BIGRAMS: Record<string, string> = {
  "react js": "React.js",
  "node js": "Node.js",
  "rest api": "REST API",
  "machine learning": "machine learning", // keep lowercase explicitly
  "open ai": "OpenAI",
};

/**
 * Small lexicon of Hindi-romanized tokens that strongly imply Hinglish
 * context. Used by the "me → mein" guard to avoid corrupting pure-English
 * text that happens to contain "me".
 *
 * Kept intentionally small + unambiguous.
 */
export const HINGLISH_CONTEXT_TOKENS = new Set<string>([
  "hai",
  "hain",
  "ho",
  "hoga",
  "hogi",
  "tha",
  "thi",
  "the",
  "raha",
  "rahi",
  "rahe",
  "kar",
  "kiya",
  "kiye",
  "karna",
  "karta",
  "karti",
  "karte",
  "nahi",
  "nahin",
  "naa",
  "na",
  "bhi",
  "toh",
  "haina",
  "yaar",
  "bhai",
  "didi",
  "kya",
  "kyun",
  "kyu",
  "kaise",
  "kab",
  "kahan",
  "abhi",
  "phir",
  "wapas",
  "accha",
  "achha",
  "chalo",
  "theek",
  "bas",
  "jaa",
  "ja",
  "jao",
  "aao",
  "aaya",
  "aayi",
  "gaya",
  "gayi",
  "rakh",
  "rakha",
  "dekh",
  "dekha",
  "sun",
  "suna",
  "bol",
  "bolo",
  "bola",
  "office",
  "ghar",
  "paani",
  "khana",
]);
