import fs from "node:fs";
import path from "node:path";
import { csvEscape } from "./utils.js";

export function exportRows(rows, filename) {
  fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
  if (filename.toLowerCase().endsWith(".jsonl")) {
    fs.writeFileSync(filename, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    return;
  }
  const columns = [
    "shortcode", "url", "author", "caption", "published_at", "likes", "comments",
    "views", "reposts", "shares", "video_url", "thumbnail_url", "media_path", "source_url",
    "hashtags", "mentions", "external_links", "word_count", "char_count", "language",
    "emojis", "keywords", "ad_detected", "topics", "caption_hash", "duplicate_of",
    "similarity_score", "duration_seconds", "audio_title", "audio_artist", "audio_url", "audio_id",
    "audio_usage_count", "audio_usage_is_minimum", "audio_kind", "transcription_recommendation", "transcription_reason", "collaborators",
    "is_remix", "media_type", "is_pinned", "grid_position", "thumbnail_width",
    "thumbnail_height", "thumbnail_variants", "transcript", "transcript_language",
    "language_probability", "transcript_segments", "transcript_model",
    "transcription_status", "transcription_error", "transcribed_at", "media_hash",
    "first_seen_at", "updated_at"
  ];
  const body = rows.map((row) => columns.map((column) => csvEscape(row[column])).join(","));
  fs.writeFileSync(filename, [columns.join(","), ...body].join("\n"), "utf8");
}
