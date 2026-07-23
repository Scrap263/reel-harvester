const relativeFormatter = new Intl.RelativeTimeFormat("ru-RU", { numeric: "auto" });

export function formatPublishedDate(value) {
  if (!value) return "Дата публикации неизвестна";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Дата публикации неизвестна";
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

export function formatElapsed(value, now = Date.now()) {
  if (!value) return "давность неизвестна";
  const publishedAt = new Date(value).getTime();
  if (!Number.isFinite(publishedAt)) return "давность неизвестна";

  const deltaSeconds = Math.trunc((publishedAt - now) / 1000);
  const absoluteSeconds = Math.abs(deltaSeconds);
  const units = [
    ["year", 31_557_600],
    ["month", 2_629_800],
    ["week", 604_800],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60]
  ];

  for (const [unit, size] of units) {
    if (absoluteSeconds >= size) {
      return relativeFormatter.format(Math.trunc(deltaSeconds / size), unit);
    }
  }
  return "только что";
}
