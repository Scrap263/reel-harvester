const SHORTCODE_PATTERN = /^[a-zA-Z0-9_-]{3,64}$/;

export function normalizeSelectedShortcodes(value, maximum = 500) {
  if (value == null) return null;
  if (!Array.isArray(value)) throw new Error("Список выбранных рилсов имеет неверный формат");

  const shortcodes = [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
  if (!shortcodes.length) throw new Error("Сначала выберите хотя бы один рилс");
  if (shortcodes.length > maximum) throw new Error(`За один запуск можно выбрать не более ${maximum} рилсов`);
  if (shortcodes.some((shortcode) => !SHORTCODE_PATTERN.test(shortcode))) {
    throw new Error("В списке выбранных рилсов найден некорректный shortcode");
  }
  return shortcodes;
}
