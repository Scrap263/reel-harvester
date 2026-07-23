import { parseCompactNumber } from "./utils.js";

const ORIGINAL_AUDIO = /(?:original\s+audio|original\s+sound|оригинальн(?:ый|ое)\s+(?:звук|аудио))/i;

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function normalizeAudioTitle(value) {
  const title = clean(value);
  const repeated = title.match(/^(.{3,}?)\s+\1$/i);
  return (repeated?.[1] ?? title) || null;
}

export function isOriginalAudioTitle(value) {
  return ORIGINAL_AUDIO.test(normalizeAudioTitle(value) ?? "");
}

export function parseAudioUsageCount(value) {
  const text = clean(value);
  const match = text.match(/(\d[\d\s.,]*(?:\s*(?:тыс\.?|млн|млрд|K|M|B))?)\s+(?:видео\s+)?(?:Reels?|рилс(?:ов|а|ы)?)/i);
  return match ? parseCompactNumber(match[1]) : null;
}

export function audioIdFromUrl(value) {
  try {
    const match = new URL(value).pathname.match(/\/reels\/audio\/(\d+)/i);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export function classifyAudio(reel = {}) {
  let title = normalizeAudioTitle(reel.audioTitle ?? reel.audio_title) ?? "";
  if (/^(?:изображение ауди?дорожки|audio track image)$/i.test(title)) title = "";
  const url = clean(reel.audioUrl ?? reel.audio_url) || null;
  const transcript = clean(reel.transcript);
  const status = clean(reel.transcriptionStatus ?? reel.transcription_status).toLowerCase();
  const kindHint = clean(reel.audioKindHint ?? reel.audio_kind_hint).toLowerCase();
  const usageCount = Number(reel.audioUsageCount ?? reel.audio_usage_count) || 0;
  const usageIsMinimum = Boolean(Number(reel.audioUsageIsMinimum ?? reel.audio_usage_is_minimum));
  const isOriginal = kindHint === "original_audio" || isOriginalAudioTitle(title);

  if (isOriginal && usageCount > 10) {
    return {
      audioKind: "viral_audio",
      transcriptionRecommendation: "review",
      transcriptionReason: `Оригинальный звук использован больше чем в 10 рилсах (${usageIsMinimum ? "найдено минимум" : "Instagram показывает"} ${usageCount}). Это может быть вирусная речь, цитата, мем или музыка.`
    };
  }

  if (kindHint === "music" || (title && url && !ORIGINAL_AUDIO.test(title))) {
    return {
      audioKind: "music",
      transcriptionRecommendation: "skip",
      transcriptionReason: "Instagram пометил звук как отдельный именованный трек; полная расшифровка обычно не нужна."
    };
  }
  if (status === "no_speech") {
    return {
      audioKind: "no_speech",
      transcriptionRecommendation: "skip",
      transcriptionReason: "Предыдущая проверка не обнаружила разборчивой речи."
    };
  }
  if (status === "complete" && transcript.split(/\s+/).filter(Boolean).length >= 2) {
    return {
      audioKind: "speech",
      transcriptionRecommendation: "recommended",
      transcriptionReason: "В аудио уже подтверждена разборчивая речь."
    };
  }
  if (isOriginal) {
    return {
      audioKind: "original_audio",
      transcriptionRecommendation: "recommended",
      transcriptionReason: "Оригинальный звук автора: вероятна живая речь, но это стоит подтвердить короткой проверкой."
    };
  }
  if (title && url) {
    return {
      audioKind: "music",
      transcriptionRecommendation: "skip",
      transcriptionReason: "Instagram пометил звук как отдельный именованный трек; полная расшифровка обычно не нужна."
    };
  }
  return {
    audioKind: "unknown",
    transcriptionRecommendation: "review",
    transcriptionReason: url
      ? "Страница звука найдена, но Instagram не показал его название — нужна быстрая ручная проверка."
      : "Данных о звуке пока недостаточно — запустите полный сбор для предоценки."
  };
}
