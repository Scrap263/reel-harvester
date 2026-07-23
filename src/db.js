import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { similarity } from "./text-analysis.js";
import { audioIdFromUrl, classifyAudio, normalizeAudioTitle } from "./audio-triage.js";

const INSTAGRAM_RESERVED_PATHS = new Set(["accounts", "direct", "explore", "p", "reel", "reels", "stories"]);

export function sourceAccountFrom(reel = {}) {
  const sourceUrl = reel.source_url ?? reel.sourceUrl;
  try {
    const parsed = new URL(sourceUrl);
    if (/(^|\.)instagram\.com$/i.test(parsed.hostname)) {
      const segment = parsed.pathname.split("/").filter(Boolean)[0]?.replace(/^@/, "");
      if (segment && !INSTAGRAM_RESERVED_PATHS.has(segment.toLowerCase()) && /^[a-z0-9._]{1,30}$/i.test(segment)) {
        return segment.toLowerCase();
      }
      if (segment && INSTAGRAM_RESERVED_PATHS.has(segment.toLowerCase())) return null;
    }
  } catch {}

  const author = String(reel.author ?? "").trim().replace(/^@/, "");
  return /^[a-z0-9._]{1,30}$/i.test(author) ? author.toLowerCase() : null;
}

export function sourcePlatformFrom(reel = {}) {
  const sourceUrl = reel.source_url ?? reel.sourceUrl ?? reel.url;
  try {
    return /(^|\.)instagram\.com$/i.test(new URL(sourceUrl).hostname) ? "instagram" : null;
  } catch {
    return null;
  }
}

export class ReelStore {
  constructor(filename) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS reels (
        shortcode TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        author TEXT,
        caption TEXT,
        published_at TEXT,
        likes INTEGER,
        comments INTEGER,
        views INTEGER,
        reposts INTEGER,
        shares INTEGER,
        video_url TEXT,
        thumbnail_url TEXT,
        media_path TEXT,
        source_url TEXT,
        source_platform TEXT,
        source_account TEXT,
        raw_json TEXT,
        first_seen_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS crawl_state (
        source_url TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS scroll_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL,
        feed_url TEXT NOT NULL,
        target_count INTEGER NOT NULL,
        observed_count INTEGER NOT NULL DEFAULT 0,
        saved_count INTEGER NOT NULL DEFAULT 0,
        total_watch_seconds REAL NOT NULL DEFAULT 0,
        settings_json TEXT,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS scroll_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES scroll_sessions(id) ON DELETE CASCADE,
        shortcode TEXT NOT NULL,
        position INTEGER NOT NULL,
        account TEXT,
        reel_url TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        watched_seconds REAL NOT NULL DEFAULT 0,
        views INTEGER,
        likes INTEGER,
        comments INTEGER,
        reposts INTEGER,
        shares INTEGER,
        published_at TEXT,
        popularity_grade TEXT,
        engagement_rate REAL,
        engagement_grade TEXT,
        recency_grade TEXT,
        UNIQUE(session_id, shortcode)
      );
      CREATE INDEX IF NOT EXISTS idx_scroll_observations_session ON scroll_observations(session_id, position);
      CREATE INDEX IF NOT EXISTS idx_scroll_observations_grades ON scroll_observations(popularity_grade, engagement_grade, recency_grade);
    `);
    const extraColumns = {
      hashtags: "TEXT",
      mentions: "TEXT",
      external_links: "TEXT",
      word_count: "INTEGER",
      char_count: "INTEGER",
      language: "TEXT",
      emojis: "TEXT",
      keywords: "TEXT",
      ad_detected: "INTEGER",
      topics: "TEXT",
      caption_hash: "TEXT",
      duplicate_of: "TEXT",
      similarity_score: "REAL",
      duration_seconds: "INTEGER",
      audio_title: "TEXT",
      audio_artist: "TEXT",
      audio_url: "TEXT",
      audio_id: "TEXT",
      audio_usage_count: "INTEGER",
      audio_usage_is_minimum: "INTEGER",
      audio_kind: "TEXT",
      transcription_recommendation: "TEXT",
      transcription_reason: "TEXT",
      collaborators: "TEXT",
      is_remix: "INTEGER",
      media_type: "TEXT",
      is_pinned: "INTEGER",
      grid_position: "INTEGER",
      thumbnail_width: "INTEGER",
      thumbnail_height: "INTEGER",
      thumbnail_variants: "TEXT",
      transcript: "TEXT",
      transcript_language: "TEXT",
      language_probability: "REAL",
      transcript_segments: "TEXT",
      transcript_model: "TEXT",
      transcription_status: "TEXT",
      transcription_error: "TEXT",
      transcribed_at: "TEXT",
      media_hash: "TEXT",
      source_platform: "TEXT",
      source_account: "TEXT",
      reposts: "INTEGER",
      shares: "INTEGER"
    };
    const existingColumns = new Set(
      this.db.prepare("PRAGMA table_info(reels)").all().map((column) => column.name)
    );
    for (const [name, type] of Object.entries(extraColumns)) {
      if (!existingColumns.has(name)) this.db.exec(`ALTER TABLE reels ADD COLUMN ${name} ${type}`);
    }
    const updateSource = this.db.prepare(`
      UPDATE reels
      SET source_platform = COALESCE(?, source_platform),
          source_account = COALESCE(?, source_account)
      WHERE shortcode = ?
    `);
    for (const row of this.db.prepare("SELECT shortcode, author, source_url, url, source_platform, source_account FROM reels").all()) {
      const platform = sourcePlatformFrom(row);
      const account = sourceAccountFrom(row);
      if ((!platform || platform === row.source_platform) && (!account || account === row.source_account)) continue;
      updateSource.run(platform, account, row.shortcode);
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_reels_source_channel ON reels(source_platform, source_account)");
    this.db.exec(`
      UPDATE reels SET audio_title = NULL
      WHERE audio_title IN (
        'Изображение аудидорожки', 'Изображение аудиодорожки',
        'изображение аудидорожки', 'изображение аудиодорожки',
        'Audio track image', 'audio track image'
      )
    `);
    const updateAudioTriage = this.db.prepare(`
      UPDATE reels SET
        audio_title = ?,
        audio_id = COALESCE(audio_id, ?),
        audio_usage_count = COALESCE(audio_usage_count, ?),
        audio_usage_is_minimum = COALESCE(audio_usage_is_minimum, ?),
        audio_kind = ?,
        transcription_recommendation = ?,
        transcription_reason = ?
      WHERE shortcode = ?
    `);
    for (const row of this.db.prepare("SELECT shortcode, audio_title, audio_url, audio_id, audio_usage_count, audio_usage_is_minimum, transcript, transcription_status FROM reels").all()) {
      const triage = classifyAudio(row);
      updateAudioTriage.run(
        normalizeAudioTitle(row.audio_title),
        row.audio_id ?? audioIdFromUrl(row.audio_url),
        row.audio_usage_count,
        row.audio_usage_is_minimum,
        triage.audioKind,
        triage.transcriptionRecommendation,
        triage.transcriptionReason,
        row.shortcode
      );
    }
    this.db.exec(`
      UPDATE reels
      SET duplicate_of = NULL, similarity_score = NULL
      WHERE duplicate_of IN (
        SELECT shortcode FROM reels
        WHERE caption IN ('Значок числа просмотров', 'Views icon', 'View count icon')
      );
      UPDATE reels
      SET caption = NULL,
          hashtags = NULL,
          mentions = NULL,
          external_links = NULL,
          word_count = NULL,
          char_count = NULL,
          language = NULL,
          emojis = NULL,
          keywords = NULL,
          ad_detected = NULL,
          topics = NULL,
          caption_hash = NULL,
          duplicate_of = NULL,
          similarity_score = NULL
      WHERE caption IN ('Значок числа просмотров', 'Views icon', 'View count icon');
    `);
    this.upsertStatement = this.db.prepare(`
      INSERT INTO reels (
        shortcode, url, author, caption, published_at, likes, comments, views, reposts, shares,
        video_url, thumbnail_url, media_path, source_url, source_platform, source_account, raw_json,
        first_seen_at, updated_at
      ) VALUES (
        @shortcode, @url, @author, @caption, @published_at, @likes, @comments, @views, @reposts, @shares,
        @video_url, @thumbnail_url, @media_path, @source_url, @source_platform, @source_account, @raw_json,
        @first_seen_at, @updated_at
      )
      ON CONFLICT(shortcode) DO UPDATE SET
        author = COALESCE(excluded.author, author),
        caption = COALESCE(excluded.caption, caption),
        published_at = COALESCE(excluded.published_at, published_at),
        likes = COALESCE(excluded.likes, likes),
        comments = COALESCE(excluded.comments, comments),
        views = COALESCE(excluded.views, views),
        reposts = COALESCE(excluded.reposts, reposts),
        shares = COALESCE(excluded.shares, shares),
        video_url = COALESCE(excluded.video_url, video_url),
        thumbnail_url = COALESCE(excluded.thumbnail_url, thumbnail_url),
        media_path = COALESCE(excluded.media_path, media_path),
        source_url = COALESCE(excluded.source_url, source_url),
        source_platform = COALESCE(excluded.source_platform, source_platform),
        source_account = COALESCE(excluded.source_account, source_account),
        raw_json = excluded.raw_json,
        updated_at = excluded.updated_at
    `);
  }

  upsert(reel) {
    const now = new Date().toISOString();
    this.upsertStatement.run({
      shortcode: reel.shortcode,
      url: reel.url,
      author: reel.author ?? null,
      caption: reel.caption ?? null,
      published_at: reel.publishedAt ?? null,
      likes: reel.likes ?? null,
      comments: reel.comments ?? null,
      views: reel.views ?? null,
      reposts: reel.reposts ?? null,
      shares: reel.shares ?? null,
      video_url: reel.videoUrl ?? null,
      thumbnail_url: reel.thumbnailUrl ?? null,
      media_path: reel.mediaPath ?? null,
      source_url: reel.sourceUrl ?? null,
      source_platform: sourcePlatformFrom(reel),
      source_account: sourceAccountFrom(reel),
      raw_json: JSON.stringify(reel),
      first_seen_at: now,
      updated_at: now
    });
  }

  has(shortcode) {
    return Boolean(this.db.prepare("SELECT 1 FROM reels WHERE shortcode = ?").get(shortcode));
  }

  get(shortcode) {
    return this.db.prepare("SELECT * FROM reels WHERE shortcode = ?").get(shortcode) ?? null;
  }

  fillMissing(reel) {
    this.db.prepare(`
      UPDATE reels SET
        author = COALESCE(author, @author),
        caption = COALESCE(caption, @caption),
        views = COALESCE(views, @views),
        reposts = COALESCE(reposts, @reposts),
        shares = COALESCE(shares, @shares),
        thumbnail_url = COALESCE(thumbnail_url, @thumbnail_url),
        source_url = COALESCE(source_url, @source_url),
        source_platform = COALESCE(source_platform, @source_platform),
        source_account = COALESCE(source_account, @source_account),
        raw_json = CASE WHEN raw_json IS NULL THEN @raw_json ELSE raw_json END,
        updated_at = @updated_at
      WHERE shortcode = @shortcode
    `).run({
      shortcode: reel.shortcode,
      author: reel.author ?? null,
      caption: reel.caption ?? null,
      views: reel.views ?? null,
      reposts: reel.reposts ?? null,
      shares: reel.shares ?? null,
      thumbnail_url: reel.thumbnailUrl ?? null,
      source_url: reel.sourceUrl ?? null,
      source_platform: sourcePlatformFrom(reel),
      source_account: sourceAccountFrom(reel),
      raw_json: JSON.stringify(reel),
      updated_at: new Date().toISOString()
    });
  }

  findSimilarDescription(shortcode, caption) {
    if (!caption) return null;
    let best = null;
    const rows = this.db.prepare(
      "SELECT shortcode, caption FROM reels WHERE shortcode != ? AND caption IS NOT NULL"
    ).all(shortcode);
    for (const row of rows) {
      const score = similarity(caption, row.caption);
      if (!best || score > best.score) best = { shortcode: row.shortcode, score };
    }
    return best && best.score >= 0.78 ? best : null;
  }

  updateMetadata(reel) {
    this.db.prepare(`
      UPDATE reels SET
        hashtags = COALESCE(@hashtags, hashtags),
        mentions = COALESCE(@mentions, mentions),
        external_links = COALESCE(@external_links, external_links),
        word_count = COALESCE(@word_count, word_count),
        char_count = COALESCE(@char_count, char_count),
        language = COALESCE(@language, language),
        emojis = COALESCE(@emojis, emojis),
        keywords = COALESCE(@keywords, keywords),
        ad_detected = COALESCE(@ad_detected, ad_detected),
        topics = COALESCE(@topics, topics),
        caption_hash = COALESCE(@caption_hash, caption_hash),
        duplicate_of = COALESCE(@duplicate_of, duplicate_of),
        similarity_score = COALESCE(@similarity_score, similarity_score),
        likes = COALESCE(likes, @likes),
        comments = COALESCE(comments, @comments),
        views = COALESCE(views, @views),
        reposts = COALESCE(reposts, @reposts),
        shares = COALESCE(shares, @shares),
        duration_seconds = COALESCE(duration_seconds, @duration_seconds),
        audio_title = COALESCE(@audio_title, audio_title),
        audio_artist = COALESCE(@audio_artist, audio_artist),
        audio_url = COALESCE(@audio_url, audio_url),
        audio_id = COALESCE(@audio_id, audio_id),
        audio_usage_count = COALESCE(@audio_usage_count, audio_usage_count),
        audio_usage_is_minimum = COALESCE(@audio_usage_is_minimum, audio_usage_is_minimum),
        audio_kind = COALESCE(@audio_kind, audio_kind),
        transcription_recommendation = COALESCE(@transcription_recommendation, transcription_recommendation),
        transcription_reason = COALESCE(@transcription_reason, transcription_reason),
        collaborators = COALESCE(collaborators, @collaborators),
        is_remix = COALESCE(is_remix, @is_remix),
        media_type = COALESCE(media_type, @media_type),
        is_pinned = COALESCE(is_pinned, @is_pinned),
        grid_position = COALESCE(grid_position, @grid_position),
        thumbnail_width = COALESCE(thumbnail_width, @thumbnail_width),
        thumbnail_height = COALESCE(thumbnail_height, @thumbnail_height),
        thumbnail_variants = COALESCE(thumbnail_variants, @thumbnail_variants),
        updated_at = @updated_at
      WHERE shortcode = @shortcode
    `).run({
      shortcode: reel.shortcode,
      hashtags: reel.hashtags ? JSON.stringify(reel.hashtags) : null,
      mentions: reel.mentions ? JSON.stringify(reel.mentions) : null,
      external_links: reel.externalLinks ? JSON.stringify(reel.externalLinks) : null,
      word_count: reel.wordCount ?? null,
      char_count: reel.charCount ?? null,
      language: reel.language ?? null,
      emojis: reel.emojis ? JSON.stringify(reel.emojis) : null,
      keywords: reel.keywords ? JSON.stringify(reel.keywords) : null,
      ad_detected: reel.adDetected == null ? null : Number(reel.adDetected),
      topics: reel.topics ? JSON.stringify(reel.topics) : null,
      caption_hash: reel.captionHash ?? null,
      duplicate_of: reel.duplicateOf ?? null,
      similarity_score: reel.similarityScore ?? null,
      likes: reel.likes ?? null,
      comments: reel.comments ?? null,
      views: reel.views ?? null,
      reposts: reel.reposts ?? null,
      shares: reel.shares ?? null,
      duration_seconds: reel.durationSeconds ?? null,
      audio_title: normalizeAudioTitle(reel.audioTitle),
      audio_artist: reel.audioArtist ?? null,
      audio_url: reel.audioUrl ?? null,
      audio_id: reel.audioId ?? audioIdFromUrl(reel.audioUrl),
      audio_usage_count: reel.audioUsageCount ?? null,
      audio_usage_is_minimum: reel.audioUsageIsMinimum == null ? null : Number(reel.audioUsageIsMinimum),
      audio_kind: reel.audioKind ?? null,
      transcription_recommendation: reel.transcriptionRecommendation ?? null,
      transcription_reason: reel.transcriptionReason ?? null,
      collaborators: reel.collaborators ? JSON.stringify(reel.collaborators) : null,
      is_remix: reel.isRemix == null ? null : Number(reel.isRemix),
      media_type: reel.mediaType ?? null,
      is_pinned: reel.isPinned == null ? null : Number(reel.isPinned),
      grid_position: reel.gridPosition ?? null,
      thumbnail_width: reel.thumbnailWidth ?? null,
      thumbnail_height: reel.thumbnailHeight ?? null,
      thumbnail_variants: reel.thumbnailVariants ? JSON.stringify(reel.thumbnailVariants) : null,
      updated_at: new Date().toISOString()
    });
  }

  setSourceState(sourceUrl, status, error = null) {
    this.db.prepare(`
      INSERT INTO crawl_state(source_url, status, last_error, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(source_url) DO UPDATE SET
        status = excluded.status,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `).run(sourceUrl, status, error, new Date().toISOString());
  }

  startScrollSession({ feedUrl, targetCount, settings = {} }) {
    const result = this.db.prepare(`
      INSERT INTO scroll_sessions(started_at, status, feed_url, target_count, settings_json)
      VALUES (?, 'running', ?, ?, ?)
    `).run(new Date().toISOString(), feedUrl, targetCount, JSON.stringify(settings));
    return Number(result.lastInsertRowid);
  }

  recordScrollObservation(sessionId, observation) {
    this.db.prepare(`
      INSERT INTO scroll_observations(
        session_id, shortcode, position, account, reel_url, observed_at, watched_seconds,
        views, likes, comments, reposts, shares, published_at,
        popularity_grade, engagement_rate, engagement_grade, recency_grade
      ) VALUES (
        @session_id, @shortcode, @position, @account, @reel_url, @observed_at, @watched_seconds,
        @views, @likes, @comments, @reposts, @shares, @published_at,
        @popularity_grade, @engagement_rate, @engagement_grade, @recency_grade
      )
      ON CONFLICT(session_id, shortcode) DO UPDATE SET
        position = excluded.position,
        account = COALESCE(excluded.account, account),
        reel_url = excluded.reel_url,
        watched_seconds = MAX(watched_seconds, excluded.watched_seconds),
        views = COALESCE(excluded.views, views),
        likes = COALESCE(excluded.likes, likes),
        comments = COALESCE(excluded.comments, comments),
        reposts = COALESCE(excluded.reposts, reposts),
        shares = COALESCE(excluded.shares, shares),
        published_at = COALESCE(excluded.published_at, published_at),
        popularity_grade = COALESCE(excluded.popularity_grade, popularity_grade),
        engagement_rate = COALESCE(excluded.engagement_rate, engagement_rate),
        engagement_grade = COALESCE(excluded.engagement_grade, engagement_grade),
        recency_grade = COALESCE(excluded.recency_grade, recency_grade)
    `).run({
      session_id: sessionId,
      shortcode: observation.shortcode,
      position: observation.position,
      account: observation.account ?? null,
      reel_url: observation.reelUrl,
      observed_at: observation.observedAt ?? new Date().toISOString(),
      watched_seconds: observation.watchedSeconds ?? 0,
      views: observation.views ?? null,
      likes: observation.likes ?? null,
      comments: observation.comments ?? null,
      reposts: observation.reposts ?? null,
      shares: observation.shares ?? null,
      published_at: observation.publishedAt ?? null,
      popularity_grade: observation.popularityGrade ?? null,
      engagement_rate: observation.engagementRate ?? null,
      engagement_grade: observation.engagementGrade ?? null,
      recency_grade: observation.recencyGrade ?? null
    });
  }

  finishScrollSession(sessionId, status = "complete", error = null) {
    const summary = this.db.prepare(`
      SELECT COUNT(*) AS observed_count,
        SUM(CASE WHEN views IS NOT NULL OR likes IS NOT NULL THEN 1 ELSE 0 END) AS saved_count,
        COALESCE(SUM(watched_seconds), 0) AS total_watch_seconds
      FROM scroll_observations WHERE session_id = ?
    `).get(sessionId);
    this.db.prepare(`
      UPDATE scroll_sessions SET finished_at = ?, status = ?, error = ?,
        observed_count = ?, saved_count = ?, total_watch_seconds = ?
      WHERE id = ?
    `).run(
      new Date().toISOString(), status, error,
      summary.observed_count ?? 0, summary.saved_count ?? 0, summary.total_watch_seconds ?? 0,
      sessionId
    );
  }

  scrollSessions(limit = 20) {
    return this.db.prepare(`
      SELECT s.*,
        COUNT(DISTINCT o.account) AS account_count,
        SUM(CASE WHEN o.views >= 100000 THEN 1 ELSE 0 END) AS over_100k,
        SUM(CASE WHEN o.views >= 500000 THEN 1 ELSE 0 END) AS over_500k,
        SUM(CASE WHEN o.recency_grade IN ('today', 'fresh', 'recent') AND o.views >= 100000 THEN 1 ELSE 0 END) AS recent_popular
      FROM scroll_sessions s
      LEFT JOIN scroll_observations o ON o.session_id = s.id
      GROUP BY s.id
      ORDER BY s.id DESC LIMIT ?
    `).all(limit);
  }

  scrollSession(id) {
    const session = this.db.prepare("SELECT * FROM scroll_sessions WHERE id = ?").get(id);
    if (!session) return null;
    const observations = this.db.prepare(`
      SELECT o.*, r.caption, r.thumbnail_url, r.author, r.url
      FROM scroll_observations o
      LEFT JOIN reels r ON r.shortcode = o.shortcode
      WHERE o.session_id = ?
      ORDER BY o.position
    `).all(id);
    const accounts = this.db.prepare(`
      SELECT account, COUNT(*) AS reels,
        MAX(views) AS max_views,
        AVG(engagement_rate) AS avg_engagement
      FROM scroll_observations
      WHERE session_id = ? AND account IS NOT NULL
      GROUP BY account ORDER BY reels DESC, max_views DESC
    `).all(id);
    return { session, observations, accounts };
  }

  all() {
    return this.db.prepare("SELECT * FROM reels ORDER BY first_seen_at DESC").all();
  }

  stats() {
    return this.db.prepare(`
      SELECT COUNT(*) AS reels,
             COUNT(DISTINCT author) AS authors,
             SUM(CASE WHEN media_path IS NOT NULL THEN 1 ELSE 0 END) AS downloaded
      FROM reels
    `).get();
  }

  close() {
    this.db.close();
  }
}
