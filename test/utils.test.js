import test from "node:test";
import assert from "node:assert/strict";
import { csvEscape, normalizeReelUrl, parseCompactNumber, shortcodeFromUrl } from "../src/utils.js";
import { analyzeCaption, similarity } from "../src/text-analysis.js";
import { sourceAccountFrom, sourcePlatformFrom } from "../src/db.js";
import { normalizeSelectedShortcodes } from "../src/transcription-selection.js";
import { InstagramCollector } from "../src/instagram.js";
import { audioIdFromUrl, classifyAudio, normalizeAudioTitle, parseAudioUsageCount } from "../src/audio-triage.js";
import { formatElapsed, formatPublishedDate } from "../ui/date-utils.js";
import { engagementStats, popularityGrade, recencyGrade } from "../src/scroll-grades.js";

test("normalizes Instagram reel URLs", () => {
  assert.equal(
    normalizeReelUrl("https://www.instagram.com/reel/ABC123/?igsh=x"),
    "https://www.instagram.com/reel/ABC123/"
  );
  assert.equal(normalizeReelUrl("https://example.com/reel/ABC123/"), null);
  assert.equal(shortcodeFromUrl("/reel/XYZ/"), "XYZ");
  assert.equal(
    normalizeReelUrl("https://www.instagram.com/natgeo/reel/NEW123/?x=1"),
    "https://www.instagram.com/reel/NEW123/"
  );
  assert.equal(normalizeReelUrl("https://www.instagram.com/natgeo/reels/"), null);
});

test("parses compact counters", () => {
  assert.equal(parseCompactNumber("1.2K"), 1200);
  assert.equal(parseCompactNumber("2,5 млн"), 2500000);
  assert.equal(parseCompactNumber("217 тыс."), 217000);
  assert.equal(parseCompactNumber("3,584 likes"), 3584);
  assert.equal(parseCompactNumber("3 659"), 3659);
  assert.equal(parseCompactNumber("987"), 987);
});

test("escapes CSV values", () => {
  assert.equal(csvEscape('hello, "world"'), '"hello, ""world"""');
});

test("analyzes captions locally", () => {
  const result = analyzeCaption("Wildlife research 🦈 by @natgeo #Ocean https://example.com #ad");
  assert.deepEqual(result.hashtags, ["#Ocean", "#ad"]);
  assert.deepEqual(result.mentions, ["@natgeo"]);
  assert.equal(result.language, "en");
  assert.equal(result.adDetected, true);
  assert.ok(result.topics.includes("animals"));
  assert.ok(result.topics.includes("science"));
  assert.ok(similarity("A shark swims in the blue ocean", "A shark swims through blue ocean") > 0.5);
});

test("derives the Instagram channel from author or collection URL", () => {
  assert.equal(sourceAccountFrom({ author: "@NatGeo" }), "natgeo");
  assert.equal(sourceAccountFrom({ sourceUrl: "https://www.instagram.com/NatGeo/reels/" }), "natgeo");
  assert.equal(sourceAccountFrom({ author: "@Owner", sourceUrl: "https://www.instagram.com/Channel/reels/" }), "channel");
  assert.equal(sourceAccountFrom({ sourceUrl: "https://www.instagram.com/reel/ABC123/" }), null);
  assert.equal(sourceAccountFrom({ author: "@Author", sourceUrl: "https://www.instagram.com/reel/ABC123/" }), null);
  assert.equal(sourcePlatformFrom({ url: "https://www.instagram.com/reel/ABC123/" }), "instagram");
});

test("normalizes an exact transcription selection", () => {
  assert.equal(normalizeSelectedShortcodes(null), null);
  assert.deepEqual(normalizeSelectedShortcodes(["ABC_123", "ABC_123", " XYZ-789 "]), ["ABC_123", "XYZ-789"]);
  assert.throws(() => normalizeSelectedShortcodes([]), /выберите хотя бы один/i);
  assert.throws(() => normalizeSelectedShortcodes(["bad value"]), /некорректный shortcode/i);
});

test("keeps reel metadata when a direct media download is unavailable", async () => {
  const warnings = [];
  const collector = new InstagramCollector(null, null, {}, { warn: (message) => warnings.push(message) });
  collector.download = async () => { throw new Error("У рилса нет прямого видеоисточника"); };
  assert.equal(await collector.downloadIfAvailable({ shortcode: "ABC123" }, null), null);
  assert.match(warnings[0], /будет сохранён без локального файла/i);
  assert.match(warnings[0], /yt-dlp/i);
});

test("classifies audio before full transcription", () => {
  assert.equal(audioIdFromUrl("https://www.instagram.com/reels/audio/123456789/"), "123456789");
  assert.equal(normalizeAudioTitle("Artist · Song Artist · Song"), "Artist · Song");
  assert.equal(parseAudioUsageCount("5,3 тыс. видео Reels"), 5300);
  assert.equal(parseAudioUsageCount("12.4K Reels"), 12400);
  assert.deepEqual(
    classifyAudio({ audioTitle: "Original audio", audioUrl: "https://www.instagram.com/reels/audio/1/" }).audioKind,
    "original_audio"
  );
  assert.deepEqual(
    classifyAudio({ audioTitle: "Artist · Popular song", audioUrl: "https://www.instagram.com/reels/audio/2/" }).audioKind,
    "music"
  );
  assert.equal(classifyAudio({ transcriptionStatus: "no_speech" }).transcriptionRecommendation, "skip");
  assert.equal(classifyAudio({ transcriptionStatus: "complete", transcript: "Человек действительно говорит" }).audioKind, "speech");
  assert.equal(classifyAudio({ audioTitle: "Artist · Song", audioUrl: "https://www.instagram.com/reels/audio/3/", transcriptionStatus: "complete", transcript: "song lyrics here" }).audioKind, "music");
  assert.equal(classifyAudio({ audioTitle: "Author · Original audio", audioUrl: "https://www.instagram.com/reels/audio/4/", audioUsageCount: 11 }).audioKind, "viral_audio");
});

test("formats the reel publication date and elapsed time", () => {
  const publishedAt = "2026-01-04T12:45:28.000Z";
  const now = new Date("2026-01-25T12:45:28.000Z").getTime();
  assert.match(formatPublishedDate(publishedAt), /2026/);
  assert.equal(formatElapsed(publishedAt, now), "3 недели назад");
  assert.equal(formatElapsed(null, now), "давность неизвестна");
});

test("grades feed-scroll popularity, engagement and recency", () => {
  assert.equal(popularityGrade(99_999), "normal");
  assert.equal(popularityGrade(null), "unknown");
  assert.equal(popularityGrade(100_000), "hot");
  assert.equal(popularityGrade(500_000), "viral");
  assert.equal(popularityGrade(1_000_000), "mega");
  assert.deepEqual(engagementStats(60_000, 1_000_000), { rate: 0.06, grade: "high" });
  assert.equal(recencyGrade("2026-07-20T00:00:00Z", new Date("2026-07-22T00:00:00Z").getTime()), "fresh");
});
