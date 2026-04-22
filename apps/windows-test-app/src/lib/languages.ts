export interface Language {
  code: string;
  name: string;
  nativeName: string;
  region: string;
  needsLargeModel?: boolean;
}

export const LANGUAGES: Language[] = [
  // European
  { code: "en", name: "English", nativeName: "English", region: "European" },
  { code: "es", name: "Spanish", nativeName: "Español", region: "European" },
  { code: "fr", name: "French", nativeName: "Français", region: "European" },
  { code: "de", name: "German", nativeName: "Deutsch", region: "European" },
  { code: "it", name: "Italian", nativeName: "Italiano", region: "European" },
  { code: "pt", name: "Portuguese", nativeName: "Português", region: "European" },
  { code: "ru", name: "Russian", nativeName: "Русский", region: "European" },
  { code: "nl", name: "Dutch", nativeName: "Nederlands", region: "European" },
  { code: "pl", name: "Polish", nativeName: "Polski", region: "European" },
  { code: "sv", name: "Swedish", nativeName: "Svenska", region: "European" },
  { code: "no", name: "Norwegian", nativeName: "Norsk", region: "European" },
  { code: "da", name: "Danish", nativeName: "Dansk", region: "European" },
  { code: "fi", name: "Finnish", nativeName: "Suomi", region: "European" },
  { code: "el", name: "Greek", nativeName: "Ελληνικά", region: "European" },
  { code: "cs", name: "Czech", nativeName: "Čeština", region: "European" },
  { code: "ro", name: "Romanian", nativeName: "Română", region: "European" },
  { code: "uk", name: "Ukrainian", nativeName: "Українська", region: "European" },
  { code: "hu", name: "Hungarian", nativeName: "Magyar", region: "European" },
  { code: "sk", name: "Slovak", nativeName: "Slovenčina", region: "European" },
  { code: "hr", name: "Croatian", nativeName: "Hrvatski", region: "European" },
  { code: "bg", name: "Bulgarian", nativeName: "Български", region: "European" },
  { code: "ca", name: "Catalan", nativeName: "Català", region: "European" },

  // South Asian
  { code: "hi", name: "Hindi", nativeName: "हिन्दी", region: "South Asian" },
  { code: "hinglish", name: "Hinglish", nativeName: "Hinglish", region: "South Asian" },
  { code: "ur", name: "Urdu", nativeName: "اردو", region: "South Asian", needsLargeModel: true },
  { code: "bn", name: "Bengali", nativeName: "বাংলা", region: "South Asian" },
  { code: "ta", name: "Tamil", nativeName: "தமிழ்", region: "South Asian" },
  { code: "te", name: "Telugu", nativeName: "తెలుగు", region: "South Asian" },
  { code: "mr", name: "Marathi", nativeName: "मराठी", region: "South Asian" },
  { code: "gu", name: "Gujarati", nativeName: "ગુજરાતી", region: "South Asian" },
  { code: "pa", name: "Punjabi", nativeName: "ਪੰਜਾਬੀ", region: "South Asian" },
  { code: "kn", name: "Kannada", nativeName: "ಕನ್ನಡ", region: "South Asian" },
  { code: "ml", name: "Malayalam", nativeName: "മലയാളം", region: "South Asian" },
  { code: "si", name: "Sinhala", nativeName: "සිංහල", region: "South Asian" },

  // East Asian
  { code: "zh", name: "Chinese (Mandarin)", nativeName: "中文", region: "East Asian", needsLargeModel: true },
  { code: "ja", name: "Japanese", nativeName: "日本語", region: "East Asian", needsLargeModel: true },
  { code: "ko", name: "Korean", nativeName: "한국어", region: "East Asian" },
  { code: "yue", name: "Cantonese", nativeName: "粵語", region: "East Asian", needsLargeModel: true },

  // Southeast Asian
  { code: "id", name: "Indonesian", nativeName: "Bahasa Indonesia", region: "Southeast Asian" },
  { code: "ms", name: "Malay", nativeName: "Bahasa Melayu", region: "Southeast Asian" },
  { code: "vi", name: "Vietnamese", nativeName: "Tiếng Việt", region: "Southeast Asian" },
  { code: "th", name: "Thai", nativeName: "ภาษาไทย", region: "Southeast Asian", needsLargeModel: true },
  { code: "tl", name: "Filipino", nativeName: "Filipino", region: "Southeast Asian" },

  // Middle Eastern
  { code: "ar", name: "Arabic", nativeName: "العربية", region: "Middle Eastern", needsLargeModel: true },
  { code: "fa", name: "Persian/Farsi", nativeName: "فارسی", region: "Middle Eastern" },
  { code: "tr", name: "Turkish", nativeName: "Türkçe", region: "Middle Eastern" },
  { code: "he", name: "Hebrew", nativeName: "עברית", region: "Middle Eastern", needsLargeModel: true },

  // African
  { code: "sw", name: "Swahili", nativeName: "Kiswahili", region: "African" },
  { code: "am", name: "Amharic", nativeName: "አማርኛ", region: "African", needsLargeModel: true },
  { code: "ha", name: "Hausa", nativeName: "Hausa", region: "African" },
  { code: "yo", name: "Yoruba", nativeName: "Yorùbá", region: "African" },
];

export const REGIONS = [...new Set(LANGUAGES.map((l) => l.region))];

export function getLanguage(code: string): Language | undefined {
  return LANGUAGES.find((l) => l.code === code);
}

export function needsLargeModel(codes: string[]): boolean {
  return codes.some((c) => LANGUAGES.find((l) => l.code === c)?.needsLargeModel);
}

export function isEnglishOnly(codes: string[]): boolean {
  const filtered = codes.filter((c) => c !== "auto" && c !== "multilingual");
  return filtered.length === 1 && filtered[0] === "en";
}

/** Map selected language codes to what whisper.cpp actually takes as -l flag */
export function toWhisperLang(codes: string[]): string {
  const real = codes.filter((c) => c !== "auto" && c !== "multilingual" && c !== "hinglish");
  if (real.length === 1) return real[0]!;
  return "auto";
}
