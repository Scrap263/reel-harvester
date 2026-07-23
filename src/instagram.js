import fs from "node:fs";
import path from "node:path";
import { normalizeReelUrl, parseCompactNumber, politePause, shortcodeFromUrl } from "./utils.js";
import { analyzeCaption } from "./text-analysis.js";
import { audioIdFromUrl, classifyAudio, parseAudioUsageCount } from "./audio-triage.js";
import { dismissInstagramDialogs, gotoPage, moveMouseNaturally, scrollPage } from "./playwright-browser.js";

const BLOCK_MARKERS = [
  "challenge_required",
  "checkpoint_required",
  "Please wait a few minutes",
  "Подождите несколько минут",
  "Confirm it's you",
  "Подтвердите, что это вы"
];

export class InstagramCollector {
  constructor(context, store, config, logger = console) {
    this.context = context;
    this.store = store;
    this.config = config;
    this.logger = logger;
    this.audioUsageCache = new Map();
  }

  decorateReel(reel) {
    if (reel.caption) Object.assign(reel, analyzeCaption(reel.caption));
    const existing = this.store?.get?.(reel.shortcode) ?? null;
    reel.audioId = reel.audioId ?? audioIdFromUrl(reel.audioUrl);
    Object.assign(reel, classifyAudio({
      ...reel,
      transcript: reel.transcript ?? existing?.transcript,
      transcriptionStatus: reel.transcriptionStatus ?? existing?.transcription_status
    }));
    const similar = this.store.findSimilarDescription(reel.shortcode, reel.caption);
    if (similar) {
      reel.duplicateOf = similar.shortcode;
      reel.similarityScore = Number(similar.score.toFixed(4));
    }
    return reel;
  }

  async assertHealthy(page) {
    const state = {
      text: await page.locator("body").innerText({ timeout: 3000 }).catch(() => ""),
      url: page.url()
    };
    const text = state.text;
    const marker = BLOCK_MARKERS.find((candidate) => text.includes(candidate));
    if (marker) {
      throw new Error(`Instagram checkpoint/rate limit detected: ${marker}`);
    }
    if (/\/accounts\/login/i.test(state.url)) {
      throw new Error("Instagram открыл страницу входа. Повторите npm.cmd run login.");
    }
  }

  async discover(sourceUrl) {
    const direct = normalizeReelUrl(sourceUrl);
    if (direct) {
      this.logger.info(`Прямая ссылка на рилс: ${direct}`);
      return [{ url: direct, direct: true }];
    }

    const page = await this.context.newPage();
    const found = new Map();
    try {
      this.logger.info(`Открываю источник: ${sourceUrl}`);
      await gotoPage(page, sourceUrl, this.config.navigationTimeoutMs);
      const reelLinks = page.locator('a[href*="/reel/"], a[href*="/reels/"], a[href*="/p/"]');
      await reelLinks.first().waitFor({ state: "attached", timeout: 7000 }).catch(() => {});
      this.logger.info("Документ загружен. Playwright дождался доступной React-сетки.");
      this.logger.info("Начинаю прокрутку и поиск ссылок.");
      await this.assertHealthy(page);

      let unchanged = 0;
      for (let index = 0; index < this.config.maxScrolls; index += 1) {
        const before = found.size;
        const cards = await reelLinks.evaluateAll((anchors) =>
          anchors.map((anchor) => {
              const container = anchor.parentElement ?? anchor;
              const images = [...container.querySelectorAll("img")];
              const image = images
                .sort((left, right) =>
                  (right.naturalWidth * right.naturalHeight) -
                  (left.naturalWidth * left.naturalHeight)
                )[0] ?? null;
              const video = anchor.querySelector("video") ?? container.querySelector("video");
              const backgroundElement = [anchor, ...anchor.querySelectorAll("*"), container]
                .find((element) => getComputedStyle(element).backgroundImage !== "none");
              const background = backgroundElement
                ? getComputedStyle(backgroundElement).backgroundImage.match(/url\(["']?(.*?)["']?\)/)?.[1]
                : null;
              const labels = [anchor, ...container.querySelectorAll("[aria-label], [title]")]
                .flatMap((element) => [
                  element.getAttribute("aria-label"),
                  element.getAttribute("title")
                ])
                .filter(Boolean);
              const interactionText = `${container.innerText || ""}\n${labels.join("\n")}`.trim();
              const variants = (image?.getAttribute("srcset") ?? "")
                .split(",")
                .map((part) => part.trim().split(/\s+/)[0])
                .filter(Boolean);
              const audioLabel = labels.find((label) =>
                /(?:original\s+audio|audio|music|аудио|музык)/i.test(label)
              );
              const collaboratorLabel = labels.find((label) =>
                /(?:collab|совместн|соавтор)/i.test(label)
              );
              const caption = [
                ...images.map((item) => item.alt),
                anchor.getAttribute("aria-label"),
                ...labels
              ]
                .filter((value) =>
                  value &&
                  value.length >= 30 &&
                  !/(?:^|\s)(?:icon|значок|view count|числа просмотров)(?:\s|$)/i.test(value)
                )
                .sort((left, right) => right.length - left.length)[0] ?? null;
              return {
                href: anchor.href,
                thumbnailUrl:
                  image?.currentSrc ||
                  image?.src ||
                  image?.getAttribute("src") ||
                  video?.poster ||
                  background ||
                  null,
                visibleText: (anchor.innerText || "").trim(),
                interactionText,
                caption,
                durationText: interactionText.match(/\b\d{1,2}:[0-5]\d\b/)?.[0] ?? null,
                audioTitle: audioLabel ?? null,
                collaboratorText: collaboratorLabel ?? null,
                isPinned: /(?:pinned|закреплено)/i.test(interactionText),
                isRemix: /(?:remix|ремикс)/i.test(interactionText),
                mediaType: /(?:carousel|карусел)/i.test(interactionText) ? "carousel" : "reel",
                thumbnailWidth: image?.naturalWidth || null,
                thumbnailHeight: image?.naturalHeight || null,
                thumbnailVariants: variants
              };
            })
        );
        for (const card of cards) {
          const normalized = normalizeReelUrl(card.href);
          if (normalized && !found.has(normalized)) {
            const metric = (names) => {
              const suffix = new RegExp(`([\\d.,KMBКМ\\s]+)\\s*(?:${names})`, "iu");
              const prefix = new RegExp(`(?:${names})\\s*[:–-]?\\s*([\\d.,KMBКМ\\s]+)`, "iu");
              return parseCompactNumber(
                card.interactionText.match(suffix)?.[1] ??
                card.interactionText.match(prefix)?.[1]
              );
            };
            const durationParts = card.durationText?.split(":").map(Number);
            const collaborators = card.collaboratorText?.match(/@[\p{L}\p{N}._]+/gu) ?? [];
            found.set(normalized, {
              url: normalized,
              shortcode: shortcodeFromUrl(normalized),
              thumbnailUrl: card.thumbnailUrl,
              caption: card.caption,
              likes: metric("likes?|отмет(?:ок|ки).*нравится"),
              comments: metric("comments?|комментар(?:иев|ия|ии)"),
              views: metric("views?|plays?|просмотр(?:ов|а|ы)") ??
                parseCompactNumber(card.visibleText),
              reposts: metric("reposts?|репост(?:ов|а|ы)"),
              shares: metric("shares?|отправ(?:ок|ки)|подел(?:ились|иться)"),
              durationSeconds: durationParts
                ? durationParts[0] * 60 + durationParts[1]
                : null,
              audioTitle: card.audioTitle,
              collaborators,
              isRemix: card.isRemix,
              mediaType: card.mediaType,
              isPinned: card.isPinned,
              gridPosition: found.size + 1,
              thumbnailWidth: card.thumbnailWidth,
              thumbnailHeight: card.thumbnailHeight,
              thumbnailVariants: card.thumbnailVariants,
              sourceUrl
            });
          }
          if (found.size >= this.config.maxReels) break;
        }
        this.logger.info(
          `Поиск: прокрутка ${index + 1}/${this.config.maxScrolls}, найдено ${found.size}/${this.config.maxReels}.`
        );
        if (found.size >= this.config.maxReels) break;

        unchanged = found.size === before ? unchanged + 1 : 0;
        if (unchanged >= 4) {
          this.logger.info("Новых ссылок нет четыре прокрутки подряд — поиск завершён.");
          break;
        }
        await moveMouseNaturally(page);
        await scrollPage(page);
        await politePause(this.config.scrollDelayMs, this.config.jitterMs);
        await this.assertHealthy(page);
      }
      if (found.size === 0) {
        const diagnostics = await page.evaluate(() => {
          const hrefs = [...document.querySelectorAll("a[href]")]
            .map((anchor) => anchor.getAttribute("href"))
            .filter(Boolean);
          return {
            url: location.href,
            title: document.title,
            anchors: hrefs.length,
            samples: [...new Set(hrefs.filter((href) => href.includes("instagram.com") || href.startsWith("/")))]
              .slice(0, 20),
            body: (document.body?.innerText ?? "").replace(/\s+/g, " ").slice(0, 500)
          };
        });
        const screenshot = path.resolve("data/debug-zero.png");
        await page.screenshot({ path: screenshot, fullPage: false }).catch((error) =>
          this.logger.warn(`Не удалось сохранить диагностический снимок: ${error.message}`)
        );
        this.logger.error(
          `Найдено 0 ссылок. URL=${diagnostics.url}; title=${JSON.stringify(diagnostics.title)}; ` +
          `всего ссылок=${diagnostics.anchors}; примеры=${JSON.stringify(diagnostics.samples)}`
        );
        this.logger.error(`Текст страницы: ${JSON.stringify(diagnostics.body)}`);
        this.logger.error(`Диагностический снимок: ${screenshot}`);
        throw new Error(
          "Instagram не отдал ссылки на рилсы. Проверьте data/debug-zero.png и последние строки лога."
        );
      }
      const candidates = [...found.values()].slice(0, this.config.maxReels);
      const previews = candidates.filter((item) => item.thumbnailUrl).length;
      const captions = candidates.filter((item) => item.caption).length;
      this.logger.info(
        `Данные сетки: превью=${previews}/${candidates.length}, ` +
        `описания=${captions}/${candidates.length}.`
      );
      return candidates;
    } finally {
      await page.close();
    }
  }

  async extract(reelUrl, sourceUrl) {
    const page = await this.context.newPage();
    const mediaUrls = new Set();
    let stopWatchingMedia = () => {};
    try {
      const watchMedia = (request) => {
        if (request.resourceType() === "media" && /^https?:\/\//i.test(request.url())) {
          mediaUrls.add(request.url());
        }
      };
      page.on("request", watchMedia);
      stopWatchingMedia = () => page.off("request", watchMedia);
      await gotoPage(page, reelUrl, this.config.navigationTimeoutMs);
      await this.assertHealthy(page);
      await page.locator('article, video, meta[property="og:title"], meta[property="og:description"]')
        .first().waitFor({ state: "attached", timeout: 5000 }).catch(() => {});
      await page.locator("time[datetime]").first()
        .waitFor({ state: "attached", timeout: 3000 }).catch(() => {});
      const player = page.locator("article video, video").first();
      await player.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
      await player.scrollIntoViewIfNeeded().catch(() => {});
      const box = await player.boundingBox().catch(() => null);
      if (box) {
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;
        await page.mouse.move(x, y, { steps: 6 }).catch(() => {});
        await page.mouse.click(x, y).catch(() => {});
      }
      if (this.config.downloadMedia) {
        await page.evaluate(async () => {
          const video = document.querySelector("article video") ?? document.querySelector("video");
          if (!video) return false;
          video.muted = true;
          try {
            await video.play();
            return true;
          } catch {
            return false;
          }
        }).catch(() => false);
        await politePause(3500, 0);
      }

      const data = await page.evaluate(() => {
        const meta = (property) =>
          document.querySelector(`meta[property="${property}"]`)?.content ??
          document.querySelector(`meta[name="${property}"]`)?.content ??
          null;
        const article = document.querySelector("article") ?? document.body;
        const authorLink = article.querySelector('header a[href^="/"]') ??
          article.querySelector('a[href^="/"][role="link"]');
        const video = article.querySelector("video") ?? document.querySelector("video");
        const description = meta("og:description");
        const metaUrl = meta("og:url");
        const metaPath = (() => {
          try { return new URL(metaUrl).pathname.split("/").filter(Boolean); } catch { return []; }
        })();
        const metaAuthor = metaPath[0] && !["p", "reel", "reels"].includes(metaPath[0].toLowerCase())
          ? metaPath[0]
          : null;
        const visibleText = article.innerText ?? "";
        const metricPatterns = {
          likes: /^(?:like|unlike|нравится|больше не нравится)$/i,
          comments: /^(?:comment|комментировать)$/i,
          reposts: /^(?:repost|сделать репост)$/i,
          shares: /^(?:share|поделиться)$/i
        };
        let reelContainer = video;
        while (reelContainer) {
          const labels = [...reelContainer.querySelectorAll("[aria-label]")]
            .map((element) => element.getAttribute("aria-label") ?? "");
          const found = Object.values(metricPatterns).filter((pattern) =>
            labels.some((label) => pattern.test(label))
          ).length;
          if (found >= 3 && reelContainer.querySelectorAll("video").length <= 1) break;
          reelContainer = reelContainer.parentElement;
        }
        const timeCandidates = [
          ...(reelContainer?.querySelectorAll("time[datetime]") ?? []),
          ...article.querySelectorAll("time[datetime]")
        ];
        const time = timeCandidates.find((candidate) => {
          const href = candidate.closest("a")?.getAttribute("href") ?? "";
          return !/\/c\/\d+\/?(?:[?#].*)?$/i.test(href);
        }) ?? reelContainer?.querySelector("time") ?? article.querySelector("time");
        const embeddedPublishedAt = (() => {
          const targetCode = [metaUrl, location.href]
            .map((value) => value?.match(/\/(?:p|reel|reels)\/([^/?#]+)/i)?.[1] ?? null)
            .find(Boolean);
          if (!targetCode) return null;

          const stack = [];
          for (const script of document.scripts) {
            const text = script.textContent ?? "";
            if (!text.includes(targetCode) || !text.includes("taken_at")) continue;
            try { stack.push(JSON.parse(text)); } catch {}
          }
          let inspected = 0;
          while (stack.length && inspected < 250000) {
            const value = stack.pop();
            inspected += 1;
            if (!value || typeof value !== "object") continue;
            if (value.code === targetCode || value.shortcode === targetCode) {
              const timestamp = Number(value.taken_at ?? value.taken_at_timestamp);
              if (Number.isFinite(timestamp) && timestamp > 0) {
                return new Date(timestamp > 1e12 ? timestamp : timestamp * 1000).toISOString();
              }
            }
            for (const nested of Array.isArray(value) ? value : Object.values(value)) {
              if (nested && typeof nested === "object") stack.push(nested);
            }
          }
          return null;
        })();
        const embeddedMetrics = (() => {
          const targetCode = [metaUrl, location.href]
            .map((value) => value?.match(/\/(?:p|reel|reels)\/([^/?#]+)/i)?.[1] ?? null)
            .find(Boolean);
          if (!targetCode) return {};
          const stack = [];
          for (const script of document.scripts) {
            const text = script.textContent ?? "";
            if (!text.includes(targetCode)) continue;
            try { stack.push(JSON.parse(text)); } catch {}
          }
          let inspected = 0;
          const best = {};
          while (stack.length && inspected < 250000) {
            const value = stack.pop();
            inspected += 1;
            if (!value || typeof value !== "object") continue;
            if (value.code === targetCode || value.shortcode === targetCode) {
              const number = (keys, positiveOnly = false) => {
                for (const key of keys) {
                  const candidate = Number(value[key]);
                  if (Number.isFinite(candidate) && (positiveOnly ? candidate > 0 : candidate >= 0)) return candidate;
                }
                return null;
              };
              const metrics = {
                views: number(["play_count", "view_count", "video_view_count"], true),
                likes: number(["like_count"]),
                comments: number(["comment_count"]),
                reposts: number(["reshare_count", "repost_count"]),
                shares: number(["share_count"])
              };
              for (const [name, metric] of Object.entries(metrics)) {
                if (metric != null && (best[name] == null || metric > best[name])) best[name] = metric;
              }
              if (best.views != null && best.likes != null) return best;
            }
            for (const nested of Array.isArray(value) ? value : Object.values(value)) {
              if (nested && typeof nested === "object") stack.push(nested);
            }
          }
          return best;
        })();
        const metricNear = (pattern) => {
          if (!reelContainer) return null;
          const icon = [...reelContainer.querySelectorAll("[aria-label]")]
            .find((element) => pattern.test(element.getAttribute("aria-label") ?? ""));
          let node = icon?.parentElement ?? null;
          for (let depth = 0; node && reelContainer.contains(node) && depth < 7; depth += 1) {
            const metricIconCount = [...node.querySelectorAll("[aria-label]")]
              .filter((element) => Object.values(metricPatterns).some((candidate) =>
                candidate.test(element.getAttribute("aria-label") ?? "")
              )).length;
            if (metricIconCount > 1) return null;
            const text = (node.innerText ?? "").replace(/\s+/g, " ").trim();
            const value = text.match(/\d[\d\s.,]*(?:\s*(?:тыс\.?|млн|млрд|K|M|B))?/i)?.[0];
            if (value) return value;
            node = node.parentElement;
          }
          return null;
        };
        const audioAnchors = [...document.querySelectorAll('a[href]')]
          .filter((anchor) => /\/reels\/audio\/\d+/i.test(anchor.getAttribute("href") ?? anchor.href ?? ""));
        const audioAnchor = [...(reelContainer ?? article).querySelectorAll('a[href]')]
          .find((anchor) => /\/reels\/audio\/\d+/i.test(anchor.getAttribute("href") ?? anchor.href ?? "")) ??
          audioAnchors[0] ?? null;
        const audioId = audioAnchor?.href?.match(/\/reels\/audio\/(\d+)/i)?.[1] ?? null;
        const embeddedAudio = (() => {
          if (!audioId) return null;
          const stack = [];
          for (const script of document.scripts) {
            const text = script.textContent ?? "";
            if (!text.includes(audioId)) continue;
            try { stack.push(JSON.parse(text)); } catch {}
          }
          let inspected = 0;
          while (stack.length && inspected < 250000) {
            const value = stack.pop();
            inspected += 1;
            if (!value || typeof value !== "object") continue;
            const original = value.original_sound_info;
            if (String(original?.audio_asset_id ?? "") === audioId) {
              return {
                kind: "original_audio",
                title: original.original_audio_title ?? "Original audio",
                artist: original.ig_artist?.username ?? null
              };
            }
            const music = value.music_info?.music_asset_info ?? value.music_asset_info;
            if (music && String(music.audio_asset_id ?? music.id ?? "") === audioId) {
              return {
                kind: "music",
                title: music.title ?? music.audio_title ?? null,
                artist: music.display_artist ?? music.artist_name ?? null
              };
            }
            for (const nested of Array.isArray(value) ? value : Object.values(value)) {
              if (nested && typeof nested === "object") stack.push(nested);
            }
          }
          return null;
        })();
        const audioTitle = (() => {
          if (embeddedAudio?.title) {
            return [embeddedAudio.artist, embeddedAudio.title].filter(Boolean).join(" · ");
          }
          if (!audioAnchor) return null;
          const matchingAnchors = audioAnchors.filter((anchor) => anchor.href === audioAnchor.href);
          const values = [
            ...matchingAnchors.map((anchor) => anchor.innerText),
            ...matchingAnchors.flatMap((anchor) => [
              anchor.getAttribute("aria-label"),
              anchor.getAttribute("title"),
              ...[...anchor.querySelectorAll("[aria-label], [title]")]
                .flatMap((element) => [element.getAttribute("aria-label"), element.getAttribute("title")])
            ])
          ];
          return values.map((value) => (value ?? "").replace(/\s+/g, " ").trim())
            .find((value) => value && value.length <= 160 && !/^(?:audio|аудио|изображение ауди?дорожки|audio track image)$/i.test(value)) ?? null;
        })();
        const resourceVideoUrl = performance.getEntriesByType("resource")
          .filter((entry) => entry.initiatorType === "video" && /^https?:\/\//i.test(entry.name))
          .map((entry) => entry.name)
          .at(-1) ?? null;
        const remoteUrl = (...values) => values.find((value) => /^https?:\/\//i.test(value ?? "")) ?? null;
        return {
          canonical: metaUrl ?? document.querySelector('link[rel="canonical"]')?.href ?? location.href,
          author: metaAuthor ?? authorLink?.getAttribute("href")?.split("/").filter(Boolean)[0] ?? null,
          caption: meta("og:title") ?? description,
          publishedAt: time?.dateTime ?? time?.getAttribute("datetime") ?? embeddedPublishedAt,
          videoUrl: remoteUrl(
            video?.getAttribute("src"),
            video?.querySelector("source")?.getAttribute("src"),
            meta("og:video"),
            resourceVideoUrl,
            video?.src,
            video?.currentSrc
          ),
          thumbnailUrl: meta("og:image"),
          description,
          visibleText,
          metrics: Object.fromEntries(
            Object.entries(metricPatterns).map(([name, pattern]) => [name, metricNear(pattern)])
          ),
          embeddedMetrics,
          audioUrl: audioAnchor?.href ?? null,
          audioTitle,
          audioArtist: embeddedAudio?.artist ?? null,
          audioKindHint: embeddedAudio?.kind ?? null
        };
      });

      const numberNear = (labelPattern, ...texts) => {
        for (const text of texts) {
          const match = text?.match(labelPattern);
          if (match) return parseCompactNumber(match[1]);
        }
        return null;
      };
      const url = normalizeReelUrl(data.canonical) ?? reelUrl;
      const reel = {
        shortcode: shortcodeFromUrl(url),
        url,
        author: data.author,
        caption: data.caption,
        publishedAt: data.publishedAt,
        likes: data.embeddedMetrics.likes ?? parseCompactNumber(data.metrics.likes) ??
          numberNear(/([\d.,KMBКМ\s]+)\s+(?:likes?|отметок ["«]?Нравится)/i, data.description, data.visibleText),
        comments: data.embeddedMetrics.comments ?? parseCompactNumber(data.metrics.comments) ??
          numberNear(/([\d.,KMBКМ\s]+)\s+(?:comments?|комментар)/i, data.description, data.visibleText),
        views: data.embeddedMetrics.views ?? numberNear(/([\d.,KMBКМ\s]+)\s+(?:views?|plays?|просмотр)/i, data.description, data.visibleText),
        reposts: data.embeddedMetrics.reposts ?? parseCompactNumber(data.metrics.reposts) ??
          numberNear(/([\d.,KMBКМ\s]+)\s+(?:reposts?|репост)/i, data.description, data.visibleText),
        shares: data.embeddedMetrics.shares ?? parseCompactNumber(data.metrics.shares) ??
          numberNear(/([\d.,KMBКМ\s]+)\s+(?:shares?|отправ|подел)/i, data.description, data.visibleText),
        videoUrl: data.videoUrl ?? [...mediaUrls].at(-1) ?? null,
        thumbnailUrl: data.thumbnailUrl,
        audioUrl: data.audioUrl,
        audioTitle: data.audioTitle,
        audioArtist: data.audioArtist,
        audioKindHint: data.audioKindHint,
        audioId: audioIdFromUrl(data.audioUrl),
        sourceUrl
      };

      if (this.config.downloadMedia) {
        reel.mediaPath = await this.downloadIfAvailable(reel, page);
      }
      return reel;
    } finally {
      stopWatchingMedia();
      await page.close();
    }
  }

  async downloadIfAvailable(reel, page) {
    try {
      return await this.download(reel, page);
    } catch (error) {
      if (/checkpoint|rate limit/i.test(error.message) || ["EACCES", "ENOSPC"].includes(error.code)) throw error;
      this.logger.warn(
        `${reel.shortcode}: медиа сейчас не скачано (${error.message}). ` +
        "Рилс будет сохранён без локального файла; транскрайбер позже получит медиа через yt-dlp."
      );
      return null;
    }
  }

  async download(reel, page) {
    fs.mkdirSync(this.config.outputDir, { recursive: true });
    const destination = path.join(this.config.outputDir, `${reel.shortcode}.mp4`);
    if (fs.existsSync(destination)) return destination;

    if (reel.videoUrl) {
      try {
        fs.writeFileSync(destination, await this.context.download(reel.videoUrl, reel.url));
        return destination;
      } catch (error) {
        this.logger.warn(`Не удалось скачать MP4 напрямую: ${error.message}. Пробую захват аудио плеера.`);
      }
    }
    if (page && this.config.recordAudioFallback) {
      const audioDestination = path.join(this.config.outputDir, `${reel.shortcode}.webm`);
      return this.context.captureCurrentAudio(page, audioDestination);
    }
    throw new Error("Instagram не отдал прямой видеоисточник в этой сессии Chrome");
  }

  async countAudioUsage(audioUrl) {
    if (this.audioUsageCache.has(audioUrl)) return this.audioUsageCache.get(audioUrl);
    const page = await this.context.newPage();
    const found = new Set();
    try {
      await gotoPage(page, audioUrl, this.config.navigationTimeoutMs);
      await politePause(1800, 0);
      await this.assertHealthy(page);
      let declaredCount = null;
      for (let attempt = 0; attempt < 8 && declaredCount == null; attempt += 1) {
        const declaredText = await page.evaluate(() => document.querySelector("main")?.innerText ?? document.body?.innerText ?? "");
        declaredCount = parseAudioUsageCount(declaredText);
        if (declaredCount == null) await politePause(500, 0);
      }
      if (declaredCount != null) {
        const result = { count: declaredCount, isMinimum: false };
        this.audioUsageCache.set(audioUrl, result);
        return result;
      }
      let unchanged = 0;
      for (let index = 0; index < 6; index += 1) {
        const hrefs = await page.evaluate(() => [...document.querySelectorAll('main a[href]')]
          .map((anchor) => anchor.href)
          .filter((href) => /\/(?:reel|reels)\/[A-Za-z0-9_-]+\/?(?:[?#].*)?$/i.test(href)));
        const before = found.size;
        for (const href of hrefs) {
          const normalized = normalizeReelUrl(href);
          if (normalized) found.add(normalized);
        }
        if (found.size > 10) break;
        unchanged = found.size === before ? unchanged + 1 : 0;
        if (unchanged >= 2) break;
        await moveMouseNaturally(page);
        await scrollPage(page);
        await politePause(900, 0);
      }
      const result = { count: found.size, isMinimum: true };
      this.audioUsageCache.set(audioUrl, result);
      return result;
    } finally {
      await page.close();
    }
  }

  async collect(sources) {
    let collected = 0;
    let skipped = 0;
    let failed = 0;
    let enriched = 0;
    for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex += 1) {
      const sourceUrl = sources[sourceIndex];
      this.logger.info(`Источник ${sourceIndex + 1}/${sources.length}: ${sourceUrl}`);
      this.store.setSourceState(sourceUrl, "running");
      try {
        const candidates = await this.discover(sourceUrl);
        this.logger.info(`Обнаружено рилсов: ${candidates.length}. Начинаю обработку.`);
        for (let reelIndex = 0; reelIndex < candidates.length; reelIndex += 1) {
          const candidate = candidates[reelIndex];
          const url = candidate.url;
          if (collected >= this.config.maxReels) break;
          const shortcode = candidate.shortcode ?? shortcodeFromUrl(url);
          const alreadyExists = Boolean(shortcode && this.store.has(shortcode));
          this.logger.info(
            `Прогресс ${reelIndex + 1}/${candidates.length}: ${shortcode ?? url} ` +
            `(новых=${collected}, дополнено=${enriched}, пропущено=${skipped}, ошибок=${failed}).`
          );
          if (alreadyExists && !this.config.enrich && !this.config.downloadMedia) {
            if (!this.config.enrich && !this.config.downloadMedia) {
              const existing = this.store.get(shortcode);
              const existingUpdate = this.decorateReel({
                shortcode,
                url,
                caption: candidate.caption ?? existing?.caption ?? null,
                thumbnailUrl: candidate.thumbnailUrl,
                likes: candidate.likes,
                comments: candidate.comments,
                views: candidate.views,
                durationSeconds: candidate.durationSeconds,
                audioTitle: candidate.audioTitle,
                audioUrl: candidate.audioUrl,
                audioId: candidate.audioId,
                collaborators: candidate.collaborators,
                isRemix: candidate.isRemix,
                mediaType: candidate.mediaType,
                isPinned: candidate.isPinned,
                gridPosition: candidate.gridPosition,
                thumbnailWidth: candidate.thumbnailWidth,
                thumbnailHeight: candidate.thumbnailHeight,
                thumbnailVariants: candidate.thumbnailVariants,
                sourceUrl
              });
              this.store.fillMissing(existingUpdate);
              this.store.updateMetadata(existingUpdate);
              this.logger.info(`Обновил быстрые и аналитические поля: ${shortcode}.`);
            }
            skipped += 1;
            this.logger.info(`Уже есть в базе, пропускаю: ${shortcode}.`);
            continue;
          }
          try {
            const needsDetailPage = candidate.direct || this.config.enrich || this.config.downloadMedia;
            let reelData;
            if (needsDetailPage) {
              const detail = await this.extract(url, sourceUrl);
              reelData = {
                ...candidate,
                ...detail,
                shortcode: detail.shortcode ?? shortcode,
                url: detail.url ?? url,
                caption: detail.caption ?? candidate.caption,
                thumbnailUrl: detail.thumbnailUrl ?? candidate.thumbnailUrl,
                likes: detail.likes ?? candidate.likes,
                comments: detail.comments ?? candidate.comments,
                views: detail.views ?? candidate.views,
                reposts: detail.reposts ?? candidate.reposts,
                shares: detail.shares ?? candidate.shares,
                sourceUrl
              };
            } else {
              reelData = {
                  shortcode,
                  url,
                  caption: candidate.caption,
                  thumbnailUrl: candidate.thumbnailUrl,
                  likes: candidate.likes,
                  comments: candidate.comments,
                  views: candidate.views,
                  reposts: candidate.reposts,
                  shares: candidate.shares,
                  durationSeconds: candidate.durationSeconds,
                  audioTitle: candidate.audioTitle,
                  audioUrl: candidate.audioUrl,
                  audioId: candidate.audioId,
                  collaborators: candidate.collaborators,
                  isRemix: candidate.isRemix,
                  mediaType: candidate.mediaType,
                  isPinned: candidate.isPinned,
                  gridPosition: candidate.gridPosition,
                  thumbnailWidth: candidate.thumbnailWidth,
                  thumbnailHeight: candidate.thumbnailHeight,
                  thumbnailVariants: candidate.thumbnailVariants,
                  sourceUrl
                };
            }
            if (this.config.enrich && reelData.audioUrl) {
              try {
                const usage = await this.countAudioUsage(reelData.audioUrl);
                reelData.audioUsageCount = usage.count;
                reelData.audioUsageIsMinimum = usage.isMinimum;
                this.logger.info(`${shortcode}: Instagram показывает ${usage.isMinimum ? "минимум " : ""}${usage.count} рилсов с этим звуком.`);
              } catch (error) {
                reelData.audioUsageCount = this.store.get(shortcode)?.audio_usage_count ?? null;
                reelData.audioUsageIsMinimum = this.store.get(shortcode)?.audio_usage_is_minimum ?? null;
                this.logger.warn(`${shortcode}: не удалось проверить популярность звука (${error.message}).`);
              }
            }
            const reel = this.decorateReel(reelData);
            if (reel.shortcode) {
              this.store.upsert(reel);
              this.store.updateMetadata(reel);
              if (alreadyExists) enriched += 1;
              else collected += 1;
              this.logger.info(
                `Сохранён ${reel.shortcode}${needsDetailPage ? " с полными данными" : " из сетки"}. ` +
                `Новых=${collected}, дополнено=${enriched}.`
              );
            }
          } catch (error) {
            failed += 1;
            this.logger.error(`Ошибка рилса ${url}: ${error.message}`);
            if (/checkpoint|rate limit/i.test(error.message)) throw error;
          }
          const needsPause = candidate.direct || this.config.enrich || this.config.downloadMedia;
          if (needsPause && reelIndex < candidates.length - 1 && collected < this.config.maxReels) {
            this.logger.info(
              `Пауза перед следующим рилсом: ${this.config.reelDelayMs}–` +
              `${this.config.reelDelayMs + this.config.jitterMs} мс.`
            );
            await politePause(this.config.reelDelayMs, this.config.jitterMs);
          }
        }
        this.store.setSourceState(sourceUrl, "complete");
        this.logger.info(`Источник завершён: ${sourceUrl}`);
      } catch (error) {
        this.store.setSourceState(sourceUrl, "paused", error.message);
        this.logger.error(`Источник приостановлен: ${error.message}`);
        throw error;
      }
    }
    this.logger.info(
      `Итог запуска: новых=${collected}, дополнено=${enriched}, ` +
      `пропущено=${skipped}, ошибок=${failed}.`
    );
    return collected;
  }
}
