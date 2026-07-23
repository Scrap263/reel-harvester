#!/usr/bin/env node
import { launchBrowser } from "./playwright-browser.js";
import { loadConfig } from "./config.js";
import { exportRows } from "./export.js";
import { InstagramCollector } from "./instagram.js";
import { createLogger } from "./logger.js";
import { analyzeCaption } from "./text-analysis.js";
import { FeedScroller } from "./feed-scroll.js";

function option(name, fallback = undefined) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

const command = process.argv[2] ?? "help";
const config = loadConfig(option("config", "config.json"), {
  ...(option("max") ? { maxReels: Number(option("max")) } : {}),
  ...(flag("headless") ? { headless: true } : {}),
  ...(flag("enrich") ? { enrich: true } : {}),
  ...(flag("download") ? { downloadMedia: true } : {})
  , ...(flag("record-audio") ? { recordAudioFallback: true } : {})
});
const logger = createLogger("data/collector.log");

async function withStore(action) {
  const { ReelStore } = await import("./db.js");
  const store = new ReelStore(config.database);
  try {
    return await action(store);
  } finally {
    store.close();
  }
}

if (command === "login") {
  logger.info("Режим входа: запускаю браузер.");
  const context = await launchBrowser({
    profileDir: config.profileDir,
    headless: false,
    logger
  });
  const page = await context.newPage("https://www.instagram.com/accounts/login/");
  logger.info("Страница входа открыта. После появления ленты нажмите Enter в терминале.");
  await new Promise((resolve) => process.stdin.once("data", resolve));
  logger.info("Enter получен. Закрываю браузер; авторизованная сессия сохранена.");
  await context.close();
  logger.info("Вход завершён. Теперь запустите команду collect.");
} else if (command === "scroll") {
  const feedUrl = option("feed", "https://www.instagram.com/reels/");
  const count = Math.min(200, Math.max(1, Number(option("count", 20)) || 20));
  const watchMin = Math.min(60, Math.max(1, Number(option("watch-min", 3)) || 3));
  const watchMax = Math.min(90, Math.max(watchMin, Number(option("watch-max", 7)) || 7));
  await withStore(async (store) => {
    logger.info(`Запуск скролла Reels: роликов=${count}, просмотр=${watchMin}–${watchMax} сек., звук=выключен.`);
    const context = await launchBrowser({ profileDir: config.profileDir, headless: config.headless, logger });
    try {
      const scroller = new FeedScroller(context, store, config, logger);
      const sessionId = await scroller.run({ feedUrl, count, watchMin, watchMax });
      logger.info(`Сессия скролла сохранена: #${sessionId}.`);
    } catch (error) {
      const trace = await context.saveTrace("scroll-error").catch(() => null);
      if (trace) logger.error(`Playwright trace сохранён: ${trace}`);
      throw error;
    } finally {
      logger.info("Закрываю Playwright browser context.");
      await context.close();
      logger.info("Playwright browser context закрыт; UI остаётся открытым.");
    }
  });
} else if (command === "collect") {
  const cliSources = process.argv.slice(3).filter((arg) => /^https?:\/\//i.test(arg));
  const sources = cliSources.length ? cliSources : config.sources;
  if (!sources.length) throw new Error("Добавьте sources в config.json или передайте URL после collect.");

  await withStore(async (store) => {
    logger.info(
      `Запуск сбора: источников=${sources.length}, лимит=${config.maxReels}, ` +
      `режим=${config.enrich || config.downloadMedia ? "полный" : "быстрый"}.`
    );
    logger.info(`Текущая база: ${store.stats().reels} рилсов. Лог: ${logger.filename}`);
    const context = await launchBrowser({
      profileDir: config.profileDir,
      headless: config.headless,
      logger
    });
    try {
      const collector = new InstagramCollector(context, store, config, logger);
      const count = await collector.collect(sources);
      const stats = store.stats();
      logger.info(`Готово. Новых записей=${count}, всего в базе=${stats.reels}.`);
    } catch (error) {
      const trace = await context.saveTrace("collect-error").catch(() => null);
      if (trace) logger.error(`Playwright trace сохранён: ${trace}`);
      throw error;
    } finally {
      logger.info("Закрываю Playwright browser context.");
      await context.close();
      logger.info("Playwright browser context закрыт; UI остаётся открытым.");
    }
  });
} else if (command === "export") {
  const filename = option("out", "data/reels.csv");
  await withStore((store) => exportRows(store.all(), filename));
  logger.info(`Экспорт завершён: ${filename}`);
} else if (command === "analyze") {
  await withStore((store) => {
    let analyzed = 0;
    for (const row of store.all()) {
      if (!row.caption) continue;
      const metadata = { shortcode: row.shortcode, ...analyzeCaption(row.caption) };
      const similar = store.findSimilarDescription(row.shortcode, row.caption);
      if (similar) {
        metadata.duplicateOf = similar.shortcode;
        metadata.similarityScore = Number(similar.score.toFixed(4));
      }
      store.updateMetadata(metadata);
      analyzed += 1;
    }
    logger.info(`Локальный анализ завершён: ${analyzed} описаний.`);
  });
} else if (command === "stats") {
  await withStore((store) => console.table(store.stats()));
} else {
  console.log(`Reel Harvester

Команды:
  npm run login
  npm run scroll -- [--count=20] [--watch-min=3] [--watch-max=7] [--headless]
  npm run collect -- <URL...> [--max=100] [--enrich] [--download] [--record-audio] [--headless]
  npm run analyze
  npm run export -- --out=data/reels.csv
  npm run stats
`);
}
