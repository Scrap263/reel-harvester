import { formatElapsed, formatPublishedDate } from "./date-utils.js";

const state = { offset: 0, limit: 24, total: 0, rows: [], query: "", status: "all", audio: "all", platform: "instagram", account: "", selected: new Set(), selectedOperation: "collect", dashboard: null, scrollSessions: [], scrollSessionId: null, scrollData: null, scrollFilter: "all" };
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const formatNumber = (value) => new Intl.NumberFormat("ru-RU", { notation: value > 9999 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value || 0);
const formatMetric = (value) => value == null ? "—" : formatNumber(value);
const formatDate = (value) => value ? new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(value)) : "—";
const formatPercent = (value) => value == null ? "—" : `${(Number(value) * 100).toFixed(1)}%`;
const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
const reelCountLabel = (value) => {
  const count = Number(value) || 0;
  const mod10 = count % 10;
  const mod100 = count % 100;
  const word = mod10 === 1 && mod100 !== 11 ? "рилс" : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? "рилса" : "рилсов";
  return `${formatNumber(count)} ${word}`;
};

function audioPresentation(row) {
  const map = {
    speech: ["Речь подтверждена", "speech", "🎙"],
    original_audio: ["Вероятна речь", "speech", "🎙"],
    viral_audio: ["Вирусный оригинальный звук", "viral", "⚡"],
    music: ["Музыкальный трек", "music", "♫"],
    no_speech: ["Речи не найдено", "skip", "—"],
    unknown: ["Нужно проверить", "review", "?"]
  };
  const [label, tone, icon] = map[row.audio_kind] || map.unknown;
  const showUsage = ["viral_audio", "music"].includes(row.audio_kind);
  const usage = showUsage && row.audio_usage_count ? ` · ${formatNumber(row.audio_usage_count)}${row.audio_usage_is_minimum ? "+" : ""} рилсов` : "";
  return { label, tone, icon, title: `${row.audio_title || "Звук не определён"}${usage}` };
}

function toast(message) { const element = $("#toast"); element.textContent = message; element.classList.add("show"); setTimeout(() => element.classList.remove("show"), 2800); }
async function api(url, options) { const response = await fetch(url, options); const body = response.status === 204 ? null : await response.json(); if (!response.ok) throw new Error(body?.error || "Ошибка запроса"); return body; }

function renderStats(stats) {
  const items = [
    ["Всего рилсов", stats.total, "в локальной базе", "#8a6cff"],
    ["С описанием", stats.with_caption, `${Math.round((stats.with_caption || 0) / Math.max(1, stats.total) * 100)}% коллекции`, "#ff5a45"],
    ["Расшифровано", stats.transcribed, `${stats.media || 0} медиафайлов`, "#48d597"],
    ["Сумма просмотров", formatNumber(stats.total_views), `${stats.errors || 0} ошибок в очереди`, "#ffd068"]
  ];
  $("#overview").innerHTML = items.map(([label, value, foot, color]) => `<article class="stat-card" style="--glow:${color}"><div class="stat-label">${label}</div><div class="stat-value">${value ?? 0}</div><div class="stat-foot">${foot}</div></article>`).join("");
}

function renderJob(job) {
  const stateChip = $("#runnerState");
  const summary = $("#jobSummary");
  const consoleElement = $("#console");
  const stop = $("#stopButton");
  if (!job) {
    stateChip.textContent = "Свободно"; stateChip.classList.remove("running"); stop.classList.add("hidden");
    summary.className = "job-summary empty"; summary.textContent = "Задачи ещё не запускались";
    consoleElement.innerHTML = '<div class="console-empty">Логи появятся здесь после запуска операции.</div>'; return;
  }
  const running = job.status === "running";
  stateChip.textContent = running ? "Выполняется" : "Свободно"; stateChip.classList.toggle("running", running); stop.classList.toggle("hidden", !running); stop.dataset.id = job.id;
  const selection = job.selectionCount ? ` · ${reelCountLabel(job.selectionCount)}` : "";
  summary.className = "job-summary"; summary.innerHTML = `<strong>${job.type}</strong> · ${job.status}${selection} · ${formatDate(job.startedAt)}`;
  consoleElement.innerHTML = (job.lines || []).map((line) => `<div class="log-line ${line.stream === "stderr" ? "error" : ""}">${escapeHtml(line.text)}</div>`).join("") || '<div class="console-empty">Задача запущена, ожидаю первый лог…</div>';
  consoleElement.scrollTop = consoleElement.scrollHeight;
  renderSelectionControls();
}

function renderLibraryFilters(sources = []) {
  const sourceSelect = $("#sourceFilter");
  const previousPlatform = state.platform;
  sourceSelect.innerHTML = sources.map((source) => `<option value="${escapeHtml(source.id)}">${escapeHtml(source.label)} · ${source.count}</option>`).join("");
  state.platform = sources.some((source) => source.id === previousPlatform) ? previousPlatform : sources[0]?.id ?? "";
  sourceSelect.value = state.platform;

  const source = sources.find((item) => item.id === state.platform);
  const previousAccount = state.account;
  $("#accountFilter").innerHTML = [`<option value="">Все аккаунты · ${source?.count ?? 0}</option>`, ...(source?.accounts ?? []).map((account) => `<option value="${escapeHtml(account.id)}">${escapeHtml(account.label)} · ${account.count}</option>`)].join("");
  state.account = source?.accounts.some((account) => account.id === previousAccount) ? previousAccount : "";
  $("#accountFilter").value = state.account;
}

function renderLibraryContext() {
  const sourceLabel = $("#sourceFilter").selectedOptions[0]?.textContent?.split(" · ")[0] ?? "Все источники";
  const accountLabel = state.account ? $("#accountFilter").selectedOptions[0]?.textContent?.split(" · ")[0] : "Все аккаунты";
  $("#libraryContext").innerHTML = `<span class="context-platform">${escapeHtml(sourceLabel)}</span><span>›</span><strong>${escapeHtml(accountLabel)}</strong><span class="context-count">${reelCountLabel(state.total)}</span>`;
}

async function refreshDashboard() {
  try {
    state.dashboard = await api("/api/dashboard"); renderStats(state.dashboard.stats);
    renderLibraryFilters(state.dashboard.librarySources);
    renderJob(state.dashboard.activeJob || state.dashboard.jobs[0]);
  } catch (error) { toast(error.message); }
}

function card(row) {
  const label = row.transcript ? "Текст готов" : row.transcription_status === "error" ? "Ошибка" : "В очереди";
  const account = row.source_account ? `@${row.source_account}` : "Аккаунт не определён";
  const selected = state.selected.has(row.shortcode);
  return `<article class="reel-card${selected ? " selected" : ""}" data-code="${escapeHtml(row.shortcode)}" tabindex="0"><label class="reel-select" title="Выбрать для расшифровки"><input type="checkbox" data-select-code="${escapeHtml(row.shortcode)}" aria-label="Выбрать рилс ${escapeHtml(row.shortcode)}"${selected ? " checked" : ""}><span>✓</span></label><div class="reel-cover">${row.thumbnail_url ? `<img src="${escapeHtml(row.thumbnail_url)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ""}<div class="reel-badges"><span class="mini-badge">▶ ${formatMetric(row.views)}</span><span class="mini-badge">${label}</span></div></div><div class="reel-body"><div class="reel-account">${escapeHtml(account)}</div><div class="reel-code">${escapeHtml(row.shortcode)}</div><p class="reel-caption">${escapeHtml(row.caption || row.transcript || "Описание пока не получено")}</p><div class="reel-stats"><span title="Лайки">♥ ${formatMetric(row.likes)}</span><span title="Комментарии">● ${formatMetric(row.comments)}</span><span title="Репосты">↻ ${formatMetric(row.reposts)}</span><span title="Отправки">↗ ${formatMetric(row.shares)}</span></div><div class="reel-published" title="Дата и время публикации"><span>${escapeHtml(formatPublishedDate(row.published_at))}</span><b>${escapeHtml(formatElapsed(row.published_at))}</b></div><div class="reel-meta"><span>${row.language || row.transcript_language || "—"}</span><span>Опубликовано</span></div></div></article>`;
}

function renderSelectionControls() {
  const count = state.selected.size;
  const allVisibleSelected = state.rows.length > 0 && state.rows.every((row) => state.selected.has(row.shortcode));
  $("#selectionCount").textContent = `Выбрано: ${reelCountLabel(count)}`;
  $("#selectionHint").textContent = count ? "Whisper обработает только отмеченные карточки." : "Отметьте конкретные карточки — Whisper обработает только их.";
  $("#selectVisible").textContent = allVisibleSelected ? "Снять с загруженных" : "Выбрать загруженные";
  $("#selectVisible").disabled = state.rows.length === 0;
  $("#clearSelection").disabled = count === 0;
  $("#transcribeSelected").disabled = count === 0 || Boolean(state.dashboard?.activeJob);
}

function renderAudioTriage() {
  for (const row of state.rows) {
    const cardElement = [...document.querySelectorAll(".reel-card")]
      .find((element) => element.dataset.code === row.shortcode);
    const caption = cardElement?.querySelector(".reel-caption");
    if (!caption) continue;
    const audio = audioPresentation(row);
    caption.insertAdjacentHTML("afterend", `<div class="audio-triage ${audio.tone}"><span class="audio-triage-icon">${audio.icon}</span><div><b>${audio.label}</b>${row.audio_url ? `<a href="${escapeHtml(row.audio_url)}" target="_blank" rel="noreferrer" title="Открыть все рилсы с этим звуком">${escapeHtml(audio.title)} ↗</a>` : `<small>${escapeHtml(audio.title)}</small>`}</div></div>`);
  }
}

function renderReels() {
  $("#reelsGrid").innerHTML = state.rows.length ? state.rows.map(card).join("") : '<div class="empty-library">В этом канале ничего не найдено. Измените фильтр или запустите сбор.</div>';
  renderAudioTriage();
  $("#loadMore").classList.toggle("hidden", state.offset >= state.total);
  renderSelectionControls();
}

const popularityLabels = { mega: "1M+ · мегахит", viral: "500K+ · вирусный", hot: "100K+ · горячий", normal: "до 100K", unknown: "просмотры неизвестны" };
const engagementLabels = { elite: "10%+ · отличный", high: "5%+ · высокий", medium: "2%+ · средний", low: "ниже 2%", unknown: "engagement неизвестен" };
const recencyLabels = { today: "за сутки", fresh: "до 7 дней", recent: "до 30 дней", older: "старше месяца", unknown: "дата неизвестна" };

function scrollObservationVisible(row) {
  if (state.scrollFilter === "500k") return Number(row.views) >= 500_000;
  if (state.scrollFilter === "100k") return Number(row.views) >= 100_000;
  if (state.scrollFilter === "engagement") return ["elite", "high"].includes(row.engagement_grade);
  if (state.scrollFilter === "recent-popular") {
    return Number(row.views) >= 100_000 && ["today", "fresh", "recent"].includes(row.recency_grade);
  }
  return true;
}

function renderScrollInsights() {
  const data = state.scrollData;
  if (!data) {
    $("#scrollSummary").innerHTML = '<div class="empty-library">Запустите первую скролл-сессию.</div>';
    $("#scrollAccounts").innerHTML = "";
    $("#scrollReels").innerHTML = "";
    return;
  }
  const session = data.session;
  const observations = data.observations.filter(scrollObservationVisible);
  $("#scrollSummary").innerHTML = [
    ["Увидено", reelCountLabel(session.observed_count), `цель: ${session.target_count}`],
    ["Аккаунтов", formatNumber(data.accounts.length), "в этой сессии"],
    ["100K+", formatNumber(data.observations.filter((row) => Number(row.views) >= 100_000).length), "популярные"],
    ["Свежие · 100K+", formatNumber(data.observations.filter((row) => Number(row.views) >= 100_000 && ["today", "fresh", "recent"].includes(row.recency_grade)).length), "до 30 дней"]
  ].map(([label, value, foot]) => `<article><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b><small>${escapeHtml(foot)}</small></article>`).join("");
  $("#scrollAccounts").innerHTML = data.accounts.length
    ? data.accounts.map((account) => `<span><b>@${escapeHtml(account.account)}</b> · ${reelCountLabel(account.reels)} · max ${formatMetric(account.max_views)} · ER ${formatPercent(account.avg_engagement)}</span>`).join("")
    : '<span>Аккаунты пока не определены</span>';
  $("#scrollReels").innerHTML = observations.length ? observations.map((row) => `
    <article class="scroll-reel-card">
      <a class="scroll-thumb" href="${escapeHtml(row.reel_url)}" target="_blank" rel="noreferrer">${row.thumbnail_url ? `<img src="${escapeHtml(row.thumbnail_url)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ""}<span>▶ ${formatMetric(row.views)}</span></a>
      <div class="scroll-reel-body">
        <div class="scroll-reel-top"><b>@${escapeHtml(row.account || row.author || "unknown")}</b><small>#${row.position} · смотрели ${Number(row.watched_seconds || 0).toFixed(0)} сек.</small></div>
        <p>${escapeHtml(row.caption || row.shortcode)}</p>
        <div class="grade-row"><span class="grade popularity-${escapeHtml(row.popularity_grade || "unknown")}">${escapeHtml(popularityLabels[row.popularity_grade] || popularityLabels.unknown)}</span><span class="grade engagement-${escapeHtml(row.engagement_grade || "unknown")}">ER ${formatPercent(row.engagement_rate)} · ${escapeHtml(engagementLabels[row.engagement_grade] || engagementLabels.unknown)}</span></div>
        <div class="scroll-card-meta"><span>♥ ${formatMetric(row.likes)}</span><span>${escapeHtml(formatPublishedDate(row.published_at))}</span><b>${escapeHtml(recencyLabels[row.recency_grade] || recencyLabels.unknown)}</b></div>
      </div>
    </article>`).join("") : '<div class="empty-library">Под выбранный фильтр ничего не попало.</div>';
}

async function loadScrollSessions() {
  try {
    const result = await api("/api/scroll-sessions?limit=30");
    state.scrollSessions = result.sessions;
    const select = $("#scrollSessionSelect");
    if (!result.sessions.length) {
      state.scrollSessionId = null; state.scrollData = null;
      select.innerHTML = '<option value="">Сессий пока нет</option>';
      renderScrollInsights(); return;
    }
    if (!result.sessions.some((session) => session.id === Number(state.scrollSessionId))) state.scrollSessionId = result.sessions[0].id;
    select.innerHTML = result.sessions.map((session) => `<option value="${session.id}">#${session.id} · ${escapeHtml(formatDate(session.started_at))} · ${reelCountLabel(session.observed_count)}</option>`).join("");
    select.value = String(state.scrollSessionId);
    state.scrollData = await api(`/api/scroll-sessions/${state.scrollSessionId}`);
    renderScrollInsights();
  } catch (error) { toast(error.message); }
}

async function loadReels(reset = false) {
  if (reset) { state.offset = 0; state.rows = []; }
  const params = new URLSearchParams({ q: state.query, status: state.status, audio: state.audio, platform: state.platform, account: state.account, limit: state.limit, offset: state.offset });
  try {
    const result = await api(`/api/reels?${params}`); state.total = result.total; state.rows.push(...result.rows); state.offset += result.rows.length;
    renderReels();
    renderLibraryContext();
  } catch (error) { toast(error.message); }
}

function openReel(code) {
  const row = state.rows.find((item) => item.shortcode === code); if (!row) return;
  const tags = [...(row.hashtags || []), ...(row.topics || [])];
  $("#dialogContent").innerHTML = `<div class="dialog-layout">${row.thumbnail_url ? `<img class="dialog-image" src="${escapeHtml(row.thumbnail_url)}" alt="Превью рилса" referrerpolicy="no-referrer">` : '<div class="dialog-image"></div>'}<div class="dialog-info"><p class="eyebrow">REEL · ${escapeHtml(row.transcript_language || row.language || "—")}</p><h3>${escapeHtml(row.shortcode)}</h3><a class="dialog-link" href="${escapeHtml(row.url)}" target="_blank" rel="noreferrer">Открыть в Instagram ↗</a><div class="dialog-published"><span>Опубликовано</span><b>${escapeHtml(formatPublishedDate(row.published_at))}</b><small>${escapeHtml(formatElapsed(row.published_at))}</small></div><div class="dialog-metrics"><span><b>${formatMetric(row.views)}</b> просмотров</span><span><b>${formatMetric(row.likes)}</b> лайков</span><span><b>${formatMetric(row.comments)}</b> комментариев</span><span><b>${formatMetric(row.reposts)}</b> репостов</span><span><b>${formatMetric(row.shares)}</b> отправок</span></div><div class="dialog-section"><strong>Описание</strong><p>${escapeHtml(row.caption || "Описание отсутствует")}</p></div>${tags.length ? `<div class="tag-list">${tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</div>` : ""}<div class="dialog-section"><strong>Транскрипт</strong><p class="transcript">${escapeHtml(row.transcript || row.transcription_error || "Ещё не расшифрован")}</p></div></div></div>`;
  const audio = audioPresentation(row);
  const firstSection = $("#dialogContent .dialog-section");
  firstSection?.insertAdjacentHTML("beforebegin", `<div class="dialog-section audio-detail"><strong>${audio.icon} ${audio.label}</strong><p>${escapeHtml(row.transcription_reason || "Оценка звука ещё не выполнена")}</p>${row.audio_url ? `<a class="dialog-link" href="${escapeHtml(row.audio_url)}" target="_blank" rel="noreferrer">${escapeHtml(audio.title)} · все рилсы с этим звуком ↗</a>` : ""}</div>`);
  $("#reelDialog").showModal();
}

async function startJob(type, options) {
  try { const job = await api("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, options }) }); renderJob(job); toast("Задача запущена"); return job; }
  catch (error) { toast(error.message); return null; }
}

$$('.operation-tab').forEach((button) => button.addEventListener("click", () => {
  $$('.operation-tab').forEach((item) => item.classList.toggle("active", item === button));
  state.selectedOperation = button.dataset.operation;
  ["collect", "scroll", "transcribe", "analyze"].forEach((name) => $(`#${name}Form`).classList.toggle("hidden", name !== state.selectedOperation));
}));

$("#collectForm").addEventListener("submit", (event) => { event.preventDefault(); const data = new FormData(event.currentTarget); startJob("collect", { source: data.get("source"), max: data.get("max"), enrich: data.has("enrich"), download: data.has("download"), headless: data.has("headless") }); });
$("#scrollForm").addEventListener("submit", (event) => { event.preventDefault(); const data = new FormData(event.currentTarget); startJob("scroll", { count: data.get("count"), watchMin: data.get("watchMin"), watchMax: data.get("watchMax"), headless: data.has("headless") }); });
$("#transcribeForm").addEventListener("submit", (event) => { event.preventDefault(); const data = new FormData(event.currentTarget); startJob("transcribe", { model: data.get("model"), limit: data.get("limit"), language: data.get("language"), wordTimestamps: data.has("wordTimestamps") }); });
$("#analyzeForm").addEventListener("submit", (event) => { event.preventDefault(); startJob("analyze", {}); });
$("#stopButton").addEventListener("click", async (event) => { try { await api(`/api/jobs/${event.currentTarget.dataset.id}/stop`, { method: "POST" }); toast("Остановка отправлена"); } catch (error) { toast(error.message); } });
$("#refreshButton").addEventListener("click", () => { refreshDashboard(); loadReels(true); loadScrollSessions(); });
$("#scrollSessionSelect").addEventListener("change", (event) => { state.scrollSessionId = Number(event.target.value) || null; loadScrollSessions(); });
$("#scrollGradeFilter").addEventListener("change", (event) => { state.scrollFilter = event.target.value; renderScrollInsights(); });
$("#loadMore").addEventListener("click", () => loadReels());
let searchTimer; $("#searchInput").addEventListener("input", (event) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { state.query = event.target.value; loadReels(true); }, 300); });
$("#statusFilter").addEventListener("change", (event) => { state.status = event.target.value; loadReels(true); });
$("#audioFilter").addEventListener("change", (event) => { state.audio = event.target.value; loadReels(true); });
$("#sourceFilter").addEventListener("change", (event) => { state.platform = event.target.value; state.account = ""; renderLibraryFilters(state.dashboard?.librarySources); loadReels(true); });
$("#accountFilter").addEventListener("change", (event) => { state.account = event.target.value; loadReels(true); });
$("#selectVisible").addEventListener("click", () => { const allSelected = state.rows.length > 0 && state.rows.every((row) => state.selected.has(row.shortcode)); for (const row of state.rows) { if (allSelected) state.selected.delete(row.shortcode); else state.selected.add(row.shortcode); } renderReels(); });
$("#selectRecommended").addEventListener("click", () => { for (const row of state.rows.filter((item) => item.transcription_recommendation === "recommended" && !item.transcript)) state.selected.add(row.shortcode); renderReels(); });
$("#clearSelection").addEventListener("click", () => { state.selected.clear(); renderReels(); });
$("#transcribeSelected").addEventListener("click", async () => { const shortcodes = [...state.selected]; const job = await startJob("transcribe", { model: $("#selectedModel").value, shortcodes }); if (job) { state.selected.clear(); renderReels(); await refreshDashboard(); } });
$("#reelsGrid").addEventListener("change", (event) => { const checkbox = event.target.closest("[data-select-code]"); if (!checkbox) return; if (checkbox.checked) state.selected.add(checkbox.dataset.selectCode); else state.selected.delete(checkbox.dataset.selectCode); checkbox.closest(".reel-card")?.classList.toggle("selected", checkbox.checked); renderSelectionControls(); });
$("#reelsGrid").addEventListener("click", (event) => { if (event.target.closest(".reel-select, a")) return; const item = event.target.closest(".reel-card"); if (item) openReel(item.dataset.code); });
$("#reelsGrid").addEventListener("keydown", (event) => { if (event.target.matches("[data-select-code]")) return; if (event.key === "Enter") { const item = event.target.closest(".reel-card"); if (item) openReel(item.dataset.code); } });
$(".dialog-close").addEventListener("click", () => $("#reelDialog").close());
$("#reelDialog").addEventListener("click", (event) => { if (event.target === $("#reelDialog")) $("#reelDialog").close(); });

await Promise.all([refreshDashboard(), loadReels(true), loadScrollSessions()]);
let lastScrollRefresh = Date.now();
setInterval(async () => {
  await refreshDashboard();
  if (!state.dashboard?.activeJob) {
    await loadReels(true);
    if (Date.now() - lastScrollRefresh > 5000) { lastScrollRefresh = Date.now(); await loadScrollSessions(); }
  }
}, 1800);
