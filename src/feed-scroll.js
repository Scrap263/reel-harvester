import crypto from "node:crypto";
import { analyzeCaption } from "./text-analysis.js";
import { normalizeReelUrl, parseCompactNumber, politePause, shortcodeFromUrl } from "./utils.js";
import { gotoPage, moveMouseNaturally, scrollPage } from "./playwright-browser.js";
import { scrollGrades } from "./scroll-grades.js";
import { InstagramCollector } from "./instagram.js";

const FEED_URL = "https://www.instagram.com/reels/";

async function activeFeedReel(page) {
  return page.evaluate(() => {
    const visibleVideos = [...document.querySelectorAll("video")]
      .map((video) => ({ video, rect: video.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width > 80 && rect.height > 80 && rect.bottom > 0 && rect.top < innerHeight)
      .sort((left, right) =>
        Math.abs((left.rect.top + left.rect.bottom) / 2 - innerHeight / 2) -
        Math.abs((right.rect.top + right.rect.bottom) / 2 - innerHeight / 2)
      );
    const selected = visibleVideos[0];
    if (!selected) return null;

    let container = selected.video;
    let reelLinks = [];
    for (let depth = 0; container && depth < 12; depth += 1) {
      reelLinks = [...container.querySelectorAll('a[href]')]
        .filter((anchor) => /\/(?:reel|reels)\/[A-Za-z0-9_-]+/i.test(anchor.href));
      if (reelLinks.length) break;
      container = container.parentElement;
    }
    container ??= selected.video.parentElement ?? document.body;
    const locationReel = /\/(?:reel|reels)\/[A-Za-z0-9_-]+/i.test(location.pathname)
      ? location.href
      : null;
    const reelUrl = reelLinks[0]?.href ?? locationReel;
    if (!reelUrl) return null;

    const reserved = new Set(["accounts", "direct", "explore", "p", "reel", "reels", "stories"]);
    const account = [...container.querySelectorAll('a[href^="/"]')]
      .map((anchor) => anchor.getAttribute("href")?.split("/").filter(Boolean)[0] ?? null)
      .find((value) => value && !reserved.has(value.toLowerCase()) && /^[a-z0-9._]{1,30}$/i.test(value)) ?? null;
    return {
      reelUrl,
      account,
      caption: (container.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 1200) || null,
      thumbnailUrl: selected.video.poster || null,
      center: {
        x: selected.rect.left + selected.rect.width / 2,
        y: selected.rect.top + selected.rect.height / 2
      }
    };
  });
}

function withoutAudio(reel) {
  const clean = { ...reel };
  for (const key of [
    "audioUrl", "audioTitle", "audioArtist", "audioKindHint", "audioId",
    "audioUsageCount", "audioUsageIsMinimum", "audioKind",
    "transcriptionRecommendation", "transcriptionReason"
  ]) delete clean[key];
  return clean;
}

export class FeedScroller {
  constructor(context, store, config, logger = console) {
    this.context = context;
    this.store = store;
    this.config = config;
    this.logger = logger;
    this.collector = new InstagramCollector(context, store, config, logger);
  }

  async profileViews(account, shortcode) {
    if (!account || !shortcode) return null;
    const page = await this.context.newPage();
    try {
      await gotoPage(page, `https://www.instagram.com/${account}/reels/`, this.config.navigationTimeoutMs);
      const card = page.locator(
        `a[href*="/reel/${shortcode}/"], a[href*="/reels/${shortcode}/"], a[href*="/p/${shortcode}/"]`
      ).first();
      for (let attempt = 0; attempt < 10; attempt += 1) {
        if (await card.count()) {
          const text = await card.evaluate((anchor) => {
            const container = anchor.parentElement ?? anchor;
            const visible = (anchor.innerText ?? "").replace(/\s+/g, " ").trim();
            if (visible) return visible;
            const labels = [anchor, container, ...container.querySelectorAll("[aria-label], [title]")]
              .flatMap((element) => [element.getAttribute("aria-label"), element.getAttribute("title")])
              .filter(Boolean);
            return labels.find((value) => /view|play|просмотр/i.test(value)) ?? "";
          });
          return parseCompactNumber(text);
        }
        await scrollPage(page, 950);
        await politePause(700, 160);
      }
      return null;
    } catch {
      return null;
    } finally {
      await page.close();
    }
  }

  async run({ feedUrl = FEED_URL, count = 20, watchMin = 3, watchMax = 7 }) {
    const safeCount = Math.min(200, Math.max(1, Number(count) || 20));
    const safeMin = Math.min(60, Math.max(1, Number(watchMin) || 3));
    const safeMax = Math.min(90, Math.max(safeMin, Number(watchMax) || 7));
    const sessionId = this.store.startScrollSession({
      feedUrl,
      targetCount: safeCount,
      settings: { watchMin: safeMin, watchMax: safeMax, saveAudio: false }
    });
    const page = await this.context.newPage();
    const candidates = [];
    const seen = new Set();
    this.logger.info(
      `Скролл-сессия #${sessionId}: цель=${safeCount}, просмотр=${safeMin}–${safeMax} сек., звук не сохраняется.`
    );

    try {
      await gotoPage(page, feedUrl, this.config.navigationTimeoutMs);
      await page.locator("video").first().waitFor({ state: "visible", timeout: 15_000 });
      await this.collector.assertHealthy(page);

      let attempts = 0;
      while (candidates.length < safeCount && attempts < safeCount * 5) {
        attempts += 1;
        const visible = await activeFeedReel(page).catch(() => null);
        const reelUrl = normalizeReelUrl(visible?.reelUrl);
        const shortcode = shortcodeFromUrl(reelUrl);
        if (!visible || !reelUrl || !shortcode || seen.has(shortcode)) {
          await scrollPage(page, crypto.randomInt(650, 951));
          await politePause(650, 180);
          continue;
        }

        seen.add(shortcode);
        const watchedSeconds = crypto.randomInt(safeMin, safeMax + 1);
        const position = candidates.length + 1;
        const observedAt = new Date().toISOString();
        await page.mouse.move(visible.center.x, visible.center.y, { steps: 7 }).catch(() => {});
        await page.mouse.click(visible.center.x, visible.center.y).catch(() => {});
        this.logger.info(
          `[${position}/${safeCount}] @${visible.account ?? "unknown"} · ${shortcode}: смотрю ${watchedSeconds} сек.`
        );
        this.store.recordScrollObservation(sessionId, {
          shortcode, position, account: visible.account, reelUrl, observedAt, watchedSeconds
        });
        candidates.push({
          shortcode, position, account: visible.account, reelUrl, observedAt, watchedSeconds,
          caption: visible.caption, thumbnailUrl: visible.thumbnailUrl
        });
        await page.waitForTimeout(watchedSeconds * 1000);
        await moveMouseNaturally(page);
        await scrollPage(page, crypto.randomInt(700, 1001));
        await politePause(750, 180);
        await this.collector.assertHealthy(page);
      }
      await page.close();

      let saved = 0;
      for (const candidate of candidates) {
        try {
          this.logger.info(
            `Метаданные ${candidate.position}/${candidates.length}: ${candidate.shortcode} (без обработки звука).`
          );
          const detail = withoutAudio(await this.collector.extract(candidate.reelUrl, feedUrl));
          if (detail.views == null) {
            detail.views = await this.profileViews(detail.author ?? candidate.account, candidate.shortcode);
            if (detail.views != null) this.logger.info(`${candidate.shortcode}: просмотры из сетки @${detail.author ?? candidate.account}: ${detail.views}.`);
          }
          const reel = withoutAudio({
            ...detail,
            shortcode: detail.shortcode ?? candidate.shortcode,
            url: detail.url ?? candidate.reelUrl,
            author: detail.author ?? candidate.account,
            caption: detail.caption ?? candidate.caption,
            thumbnailUrl: detail.thumbnailUrl ?? candidate.thumbnailUrl,
            sourceUrl: feedUrl
          });
          if (reel.caption) Object.assign(reel, analyzeCaption(reel.caption));
          this.store.upsert(reel);
          this.store.updateMetadata(reel);
          const grades = scrollGrades(reel);
          this.store.recordScrollObservation(sessionId, {
            ...candidate,
            account: reel.author ?? candidate.account,
            reelUrl: reel.url,
            views: reel.views,
            likes: reel.likes,
            comments: reel.comments,
            reposts: reel.reposts,
            shares: reel.shares,
            publishedAt: reel.publishedAt,
            ...grades
          });
          saved += 1;
        } catch (error) {
          this.logger.warn(`${candidate.shortcode}: метаданные сохранены частично (${error.message}).`);
        }
      }

      this.store.finishScrollSession(sessionId, "complete");
      this.logger.info(
        `Скролл-сессия #${sessionId} завершена: увидено=${candidates.length}, полные данные=${saved}, аккаунтов=${new Set(candidates.map((item) => item.account).filter(Boolean)).size}.`
      );
      return sessionId;
    } catch (error) {
      await page.close().catch(() => {});
      this.store.finishScrollSession(sessionId, "failed", error.message);
      throw error;
    }
  }
}
