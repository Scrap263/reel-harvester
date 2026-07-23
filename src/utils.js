import crypto from "node:crypto";
import { humanDelay } from "./playwright-browser.js";

/**
 * Человеческая пауза с нормальным распределением.
 * Для рилсов — быстрые тайминги.
 * baseMs: средняя задержка, jitterMs: используется как spread.
 */
export async function politePause(baseMs, jitterMs = 0) {
  // Если jitterMs = 0, используем spread = baseMs * 0.25
  const spread = jitterMs > 0 ? jitterMs : Math.round(baseMs * 0.25);
  const clampMin = Math.max(20, Math.round(baseMs * 0.3));
  const clampMax = baseMs * 3;
  await humanDelay(baseMs, spread, clampMin, clampMax);
}

export function normalizeReelUrl(value) {
  try {
    const url = new URL(value, "https://www.instagram.com");
    if (!/(^|\.)instagram\.com$/i.test(url.hostname)) return null;
    const match = url.pathname.match(/\/(reel|reels|p)\/([^/?#]+)/i);
    if (!match) return null;
    return `https://www.instagram.com/${match[1].toLowerCase()}/${match[2]}/`;
  } catch {
    return null;
  }
}

export function shortcodeFromUrl(url) {
  return normalizeReelUrl(url)?.match(/\/(?:reel|reels|p)\/([^/]+)\//)?.[1] ?? null;
}

export function parseCompactNumber(value) {
  if (!value) return null;
  const normalized = String(value).trim().replace(/[\u00a0\u202f]/g, " ");
  const match = normalized.match(/(\d(?:[\d.,]|\s(?=\d))*)\s*(МЛРД|МЛН|ТЫС\.?|BILLION|MILLION|THOUSAND|K|M|B|К|М)?/i);
  if (!match) return null;
  const suffix = (match[2] ?? "").toUpperCase();
  const rawNumber = match[1].trim();
  let numeric;
  if (suffix) {
    const compact = rawNumber.replace(/\s/g, "");
    const lastComma = compact.lastIndexOf(",");
    const lastDot = compact.lastIndexOf(".");
    const decimalIndex = Math.max(lastComma, lastDot);
    numeric = decimalIndex >= 0
      ? `${compact.slice(0, decimalIndex).replace(/[.,]/g, "")}.${compact.slice(decimalIndex + 1)}`
      : compact;
  } else {
    numeric = rawNumber.replace(/[\s.,]/g, "");
  }
  const multipliers = {
    K: 1e3,
    "К": 1e3,
    "ТЫС": 1e3,
    "ТЫС.": 1e3,
    THOUSAND: 1e3,
    M: 1e6,
    "М": 1e6,
    "МЛН": 1e6,
    MILLION: 1e6,
    B: 1e9,
    "МЛРД": 1e9,
    BILLION: 1e9
  };
  const number = Number(numeric);
  return Number.isFinite(number) ? Math.round(number * (multipliers[suffix] ?? 1)) : null;
}

export function csvEscape(value) {
  if (value == null) return "";
  const string = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string;
}
