import crypto from "node:crypto";

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "in",
  "is", "it", "of", "on", "or", "that", "the", "this", "to", "was", "were", "will",
  "with", "you", "your", "и", "в", "во", "на", "с", "со", "что", "это", "как",
  "к", "по", "из", "за", "для", "от", "до", "у", "о", "об", "а", "но", "не",
  "мы", "вы", "они", "он", "она", "его", "ее", "их"
]);

const TOPICS = {
  animals: ["animal", "wildlife", "shark", "whale", "bird", "dog", "cat", "живот", "акул", "птиц"],
  environment: ["climate", "ocean", "nature", "conservation", "planet", "эколог", "климат", "природ"],
  science: ["science", "research", "scientist", "space", "history", "исследован", "наук", "космос", "истори"],
  travel: ["travel", "trip", "journey", "country", "city", "island", "путеше", "поездк", "город", "остров"],
  food: ["food", "recipe", "cook", "restaurant", "еда", "рецепт", "готов"],
  fitness: ["fitness", "workout", "training", "sport", "фитнес", "трениров", "спорт"],
  beauty: ["beauty", "makeup", "skincare", "красот", "макияж", "космет"],
  fashion: ["fashion", "style", "outfit", "мод", "стил", "образ"],
  technology: ["technology", "tech", "software", "device", "ai", "технолог", "программ", "устройств"],
  business: ["business", "marketing", "sales", "money", "бизнес", "маркетинг", "продаж", "деньг"],
  entertainment: ["movie", "music", "show", "game", "film", "музык", "кино", "игр", "шоу"]
};

export function normalizeCaption(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/https?:\/\/\S+/gu, " ")
    .replace(/[^\p{L}\p{N}#@]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function captionTokens(value) {
  return normalizeCaption(value)
    .split(" ")
    .map((token) => token.replace(/^[@#]/, ""))
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token) && !/^\d+$/.test(token));
}

export function similarity(left, right) {
  const a = new Set(captionTokens(left));
  const b = new Set(captionTokens(right));
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function detectLanguage(text) {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (!letters.length) return null;
  const cyrillic = text.match(/\p{Script=Cyrillic}/gu)?.length ?? 0;
  const latin = text.match(/\p{Script=Latin}/gu)?.length ?? 0;
  if (cyrillic / letters.length > 0.35) return "ru";
  if (latin / letters.length > 0.55) return "en";
  return "other";
}

export function analyzeCaption(caption) {
  const text = String(caption ?? "");
  const tokens = captionTokens(text);
  const frequency = new Map();
  for (const token of tokens) frequency.set(token, (frequency.get(token) ?? 0) + 1);
  const keywords = [...frequency.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, 12)
    .map(([token]) => token);
  const normalized = normalizeCaption(text);
  const topics = Object.entries(TOPICS)
    .filter(([, markers]) => markers.some((marker) => normalized.includes(marker)))
    .map(([topic]) => topic);

  return {
    hashtags: [...new Set(text.match(/#[\p{L}\p{N}_]+/gu) ?? [])],
    mentions: [...new Set(text.match(/@[\p{L}\p{N}._]+/gu) ?? [])],
    externalLinks: [...new Set(text.match(/https?:\/\/[^\s<>"']+/giu) ?? [])],
    wordCount: text.trim() ? text.trim().split(/\s+/u).length : 0,
    charCount: [...text].length,
    language: detectLanguage(text),
    emojis: [...new Set(text.match(/\p{Extended_Pictographic}/gu) ?? [])],
    keywords,
    adDetected: /(^|\s)#(?:ad|ads|advertisement|sponsored|реклама)\b|партн[её]рск|paid partnership/iu.test(text),
    topics,
    captionHash: normalized
      ? crypto.createHash("sha256").update(normalized).digest("hex")
      : null
  };
}

