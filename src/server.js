#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { ReelStore } from "./db.js";
import { csvEscape } from "./utils.js";
import { normalizeSelectedShortcodes } from "./transcription-selection.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UI_ROOT = path.join(ROOT, "ui");
const config = loadConfig("config.json");
const store = new ReelStore(config.database);
const jobs = [];
let activeJob = null;
let nextJobId = 1;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 100_000) throw new Error("Request body is too large");
  }
  return body ? JSON.parse(body) : {};
}

function safeJson(value, fallback = []) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function publicReel(row) {
  return {
    ...row,
    hashtags: safeJson(row.hashtags),
    mentions: safeJson(row.mentions),
    keywords: safeJson(row.keywords),
    topics: safeJson(row.topics),
    collaborators: safeJson(row.collaborators),
    transcript_segments: safeJson(row.transcript_segments)
  };
}

function getStats() {
  return store.db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(caption IS NOT NULL) AS with_caption,
      SUM(thumbnail_url IS NOT NULL) AS with_preview,
      SUM(transcript IS NOT NULL AND transcript != '') AS transcribed,
      SUM(media_path IS NOT NULL) AS media,
      SUM(transcription_status = 'error' OR transcription_status = 'missing_media') AS errors,
      COALESCE(SUM(views), 0) AS total_views
      ,(SELECT COUNT(*) FROM scroll_sessions) AS scroll_sessions
    FROM reels
  `).get();
}

function getLibrarySources() {
  const rows = store.db.prepare(`
    SELECT COALESCE(source_platform, 'instagram') AS platform,
      source_account AS account,
      COUNT(*) AS count,
      SUM(transcript IS NOT NULL AND transcript != '') AS transcribed
    FROM reels
    GROUP BY COALESCE(source_platform, 'instagram'), source_account
    ORDER BY platform, count DESC, account
  `).all();
  const labels = { instagram: "Instagram" };
  const sources = new Map();
  for (const row of rows) {
    if (!sources.has(row.platform)) {
      sources.set(row.platform, { id: row.platform, label: labels[row.platform] ?? row.platform, count: 0, accounts: [] });
    }
    const source = sources.get(row.platform);
    source.count += row.count;
    source.accounts.push({
      id: row.account ?? "__unknown__",
      label: row.account ? `@${row.account}` : "Аккаунт не определён",
      count: row.count,
      transcribed: row.transcribed ?? 0
    });
  }
  return [...sources.values()];
}

function commandFor(type, options) {
  if (type === "scroll") {
    const count = Math.min(200, Math.max(1, Number(options.count) || 20));
    const watchMin = Math.min(60, Math.max(1, Number(options.watchMin) || 3));
    const watchMax = Math.min(90, Math.max(watchMin, Number(options.watchMax) || 7));
    const args = [
      "--disable-warning=ExperimentalWarning", "src/cli.js", "scroll",
      `--count=${count}`, `--watch-min=${watchMin}`, `--watch-max=${watchMax}`
    ];
    if (options.headless) args.push("--headless");
    return { executable: process.execPath, args };
  }
  if (type === "collect") {
    const source = String(options.source ?? "").trim();
    const parsed = new URL(source);
    if (!/(^|\.)instagram\.com$/i.test(parsed.hostname)) throw new Error("Нужна ссылка instagram.com");
    const args = ["--disable-warning=ExperimentalWarning", "src/cli.js", "collect", source, `--max=${Math.min(500, Math.max(1, Number(options.max) || 50))}`];
    if (options.enrich) args.push("--enrich");
    if (options.download) args.push("--download");
    if (options.recordAudio) args.push("--record-audio");
    if (options.headless) args.push("--headless");
    return { executable: process.execPath, args };
  }
  if (type === "analyze") return { executable: process.execPath, args: ["--disable-warning=ExperimentalWarning", "src/cli.js", "analyze"] };
  if (type === "login") return { executable: process.execPath, args: ["--disable-warning=ExperimentalWarning", "src/cli.js", "login"] };
  if (type === "transcribe") {
    const python = process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python";
    if (!fs.existsSync(path.join(ROOT, python))) throw new Error("Сначала установите faster-whisper");
    const model = ["tiny", "base", "small", "medium", "turbo"].includes(options.model) ? options.model : "small";
    const shortcodes = normalizeSelectedShortcodes(options.shortcodes);
    if (shortcodes) {
      const placeholders = shortcodes.map(() => "?").join(",");
      const found = store.db.prepare(`SELECT shortcode FROM reels WHERE shortcode IN (${placeholders})`).all(...shortcodes);
      const foundCodes = new Set(found.map((row) => row.shortcode));
      const missing = shortcodes.filter((shortcode) => !foundCodes.has(shortcode));
      if (missing.length) throw new Error(`Рилсы не найдены в библиотеке: ${missing.join(", ")}`);
    }
    const args = ["scripts/transcribe.py", `--model=${model}`];
    if (!shortcodes) args.push(`--limit=${Math.min(500, Math.max(1, Number(options.limit) || 20))}`);
    if (options.language) args.push(`--language=${String(options.language).slice(0, 8)}`);
    if (options.wordTimestamps) args.push("--word-timestamps");
    if (options.force) args.push("--force");
    return {
      executable: path.join(ROOT, python),
      args,
      env: shortcodes ? { REEL_SHORTCODES: JSON.stringify(shortcodes) } : {},
      selectionCount: shortcodes?.length ?? null
    };
  }
  throw new Error("Unknown job type");
}

function startJob(type, options) {
  if (activeJob) throw new Error("Другая задача уже выполняется");
  const command = commandFor(type, options);
  const job = {
    id: nextJobId++, type, status: "running", startedAt: new Date().toISOString(),
    finishedAt: null, exitCode: null, lines: [], selectionCount: command.selectionCount ?? null
  };
  jobs.unshift(job);
  jobs.splice(30);
  const child = spawn(command.executable, command.args, {
    cwd: ROOT,
    windowsHide: false,
    env: {
      ...process.env,
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
      ...command.env
    }
  });
  job.process = child;
  activeJob = job;
  const addLines = (chunk, stream) => {
    for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) {
      job.lines.push({ at: new Date().toISOString(), stream, text: line });
      if (job.lines.length > 500) job.lines.shift();
    }
  };
  child.stdout.on("data", (chunk) => addLines(chunk, "stdout"));
  child.stderr.on("data", (chunk) => addLines(chunk, "stderr"));
  child.on("error", (error) => addLines(error.message, "stderr"));
  child.on("exit", (code, signal) => {
    job.exitCode = code;
    job.status = signal ? "stopped" : code === 0 ? "complete" : "failed";
    job.finishedAt = new Date().toISOString();
    delete job.process;
    activeJob = null;
  });
  return job;
}

function serializeJob(job) {
  if (!job) return null;
  const { process: _process, ...safe } = job;
  return safe;
}

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/dashboard") {
    const sources = store.db.prepare("SELECT * FROM crawl_state ORDER BY updated_at DESC LIMIT 8").all();
    return json(response, 200, { stats: getStats(), activeJob: serializeJob(activeJob), jobs: jobs.map(serializeJob), sources, librarySources: getLibrarySources() });
  }
  if (request.method === "GET" && url.pathname === "/api/reels") {
    const query = String(url.searchParams.get("q") ?? "").trim();
    const status = String(url.searchParams.get("status") ?? "all");
    const audio = String(url.searchParams.get("audio") ?? "all");
    const platform = String(url.searchParams.get("platform") ?? "").trim().toLowerCase();
    const account = String(url.searchParams.get("account") ?? "").trim().toLowerCase();
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 30));
    const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
    const conditions = [];
    const parameters = [];
    if (platform) {
      conditions.push("COALESCE(source_platform, 'instagram') = ?");
      parameters.push(platform);
    }
    if (account === "__unknown__") {
      conditions.push("source_account IS NULL");
    } else if (account) {
      conditions.push("source_account = ?");
      parameters.push(account);
    }
    if (query) {
      conditions.push("(shortcode LIKE ? OR caption LIKE ? OR transcript LIKE ? OR author LIKE ?)");
      const like = `%${query}%`;
      parameters.push(like, like, like, like);
    }
    if (status === "transcribed") conditions.push("transcript IS NOT NULL AND transcript != ''");
    if (status === "pending") conditions.push("transcript IS NULL");
    if (status === "errors") conditions.push("transcription_status IN ('error', 'missing_media')");
    if (status === "media") conditions.push("media_path IS NOT NULL");
    if (audio === "recommended") conditions.push("transcription_recommendation = 'recommended' AND (transcript IS NULL OR transcript = '')");
    if (audio === "music") conditions.push("audio_kind = 'music'");
    if (audio === "viral") conditions.push("audio_kind = 'viral_audio'");
    if (audio === "review") conditions.push("transcription_recommendation = 'review'");
    if (audio === "skip") conditions.push("transcription_recommendation = 'skip'");
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const total = store.db.prepare(`SELECT COUNT(*) AS count FROM reels ${where}`).get(...parameters).count;
    const rows = store.db.prepare(`SELECT * FROM reels ${where} ORDER BY first_seen_at DESC LIMIT ? OFFSET ?`).all(...parameters, limit, offset);
    return json(response, 200, { total, rows: rows.map(publicReel) });
  }
  if (request.method === "GET" && url.pathname === "/api/scroll-sessions") {
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 20));
    return json(response, 200, { sessions: store.scrollSessions(limit) });
  }
  const scrollSessionMatch = url.pathname.match(/^\/api\/scroll-sessions\/(\d+)$/);
  if (request.method === "GET" && scrollSessionMatch) {
    const result = store.scrollSession(Number(scrollSessionMatch[1]));
    return result ? json(response, 200, result) : json(response, 404, { error: "Сессия скролла не найдена" });
  }
  if (request.method === "POST" && url.pathname === "/api/jobs") {
    try {
      const body = await readJson(request);
      return json(response, 202, serializeJob(startJob(body.type, body.options ?? {})));
    } catch (error) {
      return json(response, 400, { error: error.message });
    }
  }
  const stopMatch = url.pathname.match(/^\/api\/jobs\/(\d+)\/stop$/);
  if (request.method === "POST" && stopMatch) {
    if (!activeJob || activeJob.id !== Number(stopMatch[1])) return json(response, 404, { error: "Активная задача не найдена" });
    activeJob.process.kill();
    return json(response, 202, { ok: true });
  }
  if (request.method === "GET" && url.pathname === "/api/export.csv") {
    const rows = store.all();
    if (!rows.length) { response.writeHead(204); return response.end(); }
    const columns = Object.keys(rows[0]).filter((key) => key !== "raw_json");
    const csv = [columns.join(","), ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(","))].join("\n");
    response.writeHead(200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="reels-${new Date().toISOString().slice(0, 10)}.csv"`
    });
    return response.end(`\uFEFF${csv}`);
  }
  return json(response, 404, { error: "Not found" });
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) return await handleApi(request, response, url);
    const relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const filename = path.resolve(UI_ROOT, relative);
    if (!filename.startsWith(UI_ROOT + path.sep) || !fs.existsSync(filename) || fs.statSync(filename).isDirectory()) {
      response.writeHead(404); return response.end("Not found");
    }
    response.writeHead(200, { "Content-Type": mimeTypes[path.extname(filename)] ?? "application/octet-stream" });
    fs.createReadStream(filename).pipe(response);
  } catch (error) {
    json(response, 500, { error: error.message });
  }
});

const port = Number(process.env.PORT) || 4173;
server.listen(port, "127.0.0.1", () => {
  console.log(`Reel Harvester UI: http://127.0.0.1:${port}`);
});

function shutdown() {
  activeJob?.process?.kill();
  store.close();
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
