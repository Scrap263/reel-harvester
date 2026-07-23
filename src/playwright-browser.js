import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

export function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    path.join(process.env.PROGRAMFILES ?? "", "Google/Chrome/Application/chrome.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] ?? "", "Google/Chrome/Application/chrome.exe"),
    path.join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe"),
    path.join(process.env.PROGRAMFILES ?? "", "Microsoft/Edge/Application/msedge.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] ?? "", "Microsoft/Edge/Application/msedge.exe")
  ].filter(Boolean);
  const executable = candidates.find(fs.existsSync);
  if (!executable) throw new Error("Chrome/Edge не найден. Укажите путь в переменной CHROME_PATH.");
  return executable;
}

export function normalDelay(mean, spread, clampMin = 0, clampMax = Infinity) {
  const u = Math.max(crypto.randomInt(1, 1_000_000) / 1_000_000, 0.000001);
  const v = Math.max(crypto.randomInt(1, 1_000_000) / 1_000_000, 0.000001);
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.min(Math.max(Math.round(mean + z * spread), clampMin), clampMax);
}

export function humanDelay(meanMs, spreadMs, clampMin = 0, clampMax = Infinity) {
  return delay(normalDelay(meanMs, spreadMs, clampMin, clampMax));
}

export function randomViewport() {
  const resolutions = [
    { width: 390, height: 844 },
    { width: 412, height: 915 },
    { width: 375, height: 812 },
    { width: 414, height: 896 },
    { width: 1366, height: 768 },
    { width: 1440, height: 900 },
    { width: 1536, height: 864 }
  ];
  const pick = resolutions[crypto.randomInt(0, resolutions.length)];
  return {
    width: pick.width + crypto.randomInt(-10, 11),
    height: pick.height + crypto.randomInt(-8, 9)
  };
}

export async function moveMouseNaturally(page) {
  const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
  const x = crypto.randomInt(40, Math.max(41, viewport.width - 40));
  const y = crypto.randomInt(80, Math.max(81, viewport.height - 60));
  await page.mouse.move(x, y, { steps: crypto.randomInt(3, 9) }).catch(() => {});
}

export async function scrollPage(page, distance = undefined) {
  const total = distance ?? crypto.randomInt(450, 850);
  const steps = crypto.randomInt(2, 5);
  for (let index = 0; index < steps; index += 1) {
    const portion = Math.round(total / steps);
    await page.mouse.wheel(0, portion + crypto.randomInt(-60, 61));
    await humanDelay(90, 45, 35, 250);
  }
}

export async function dismissInstagramDialogs(page) {
  const buttons = page.getByRole("button", {
    name: /^(?:Закрыть|Close|Не сейчас|Not Now|Отмена|Cancel)$/i
  });
  const count = Math.min(await buttons.count(), 3);
  for (let index = 0; index < count; index += 1) {
    const button = buttons.nth(index);
    if (await button.isVisible().catch(() => false)) {
      await button.click({ timeout: 1500 }).catch(() => {});
      await humanDelay(120, 40, 50, 250);
    }
  }
}

export async function gotoPage(page, url, timeoutMs = 45_000) {
  await humanDelay(300, 130, 100, 800);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs });
  await dismissInstagramDialogs(page);
  await moveMouseNaturally(page);
  await scrollPage(page, crypto.randomInt(80, 240));
}

async function captureCurrentAudio(page, filename) {
  const base64 = await page.evaluate(async () => {
    const video = document.querySelector("article video") ?? document.querySelector("video");
    if (!video?.captureStream) throw new Error("Video audio capture is not supported by this page");
    video.loop = false;
    video.currentTime = 0;
    video.muted = false;
    await video.play();
    await new Promise((resolve) => setTimeout(resolve, 300));
    video.pause();
    video.currentTime = 0;
    let stream = video.captureStream();
    let audioTracks = stream.getAudioTracks();
    if (!audioTracks.length) {
      try {
        const context = new AudioContext();
        const source = context.createMediaElementSource(video);
        const destination = context.createMediaStreamDestination();
        source.connect(destination);
        await context.resume();
        stream = destination.stream;
        audioTracks = stream.getAudioTracks();
      } catch {}
    }
    if (!audioTracks.length) throw new Error("Video has no capturable audio track");
    const recorder = new MediaRecorder(new MediaStream(audioTracks), { mimeType: "audio/webm;codecs=opus" });
    const chunks = [];
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size) chunks.push(event.data);
    });
    const finished = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (recorder.state !== "inactive") recorder.stop();
        reject(new Error("Audio capture timeout"));
      }, Math.max(30_000, ((Number.isFinite(video.duration) ? video.duration : 90) + 15) * 1000));
      recorder.addEventListener("stop", () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      video.addEventListener("ended", () => {
        if (recorder.state !== "inactive") recorder.stop();
      }, { once: true });
    });
    recorder.start(1000);
    await video.play();
    await finished;
    const bytes = new Uint8Array(await new Blob(chunks, { type: "audio/webm" }).arrayBuffer());
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  });
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, Buffer.from(base64, "base64"));
  return filename;
}

class PlaywrightSession {
  constructor(context, logger = null) {
    this.context = context;
    this.logger = logger;
    this.ownsProcess = true;
    this.traceActive = false;
  }

  async startTrace() {
    try {
      await this.context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      this.traceActive = true;
    } catch (error) {
      this.logger?.warn(`Не удалось включить Playwright trace: ${error.message}`);
    }
  }

  async newPage(url = "about:blank") {
    const page = await this.context.newPage();
    if (url !== "about:blank") await gotoPage(page, url);
    return page;
  }

  async download(url, referer) {
    const cookies = await this.context.cookies(url);
    const cookie = cookies.map((item) => `${item.name}=${item.value}`).join("; ");
    const response = await fetch(url, {
      headers: { Referer: referer, Cookie: cookie, "User-Agent": "Mozilla/5.0" }
    });
    if (!response.ok) throw new Error(`Media download failed: HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }

  captureCurrentAudio(page, filename) {
    return captureCurrentAudio(page, filename);
  }

  async saveTrace(label = "failure") {
    if (!this.traceActive) return null;
    const directory = path.resolve("data/traces");
    fs.mkdirSync(directory, { recursive: true });
    const safeLabel = label.replace(/[^a-z0-9_-]+/gi, "-").slice(0, 50) || "failure";
    const filename = path.join(directory, `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeLabel}.zip`);
    await this.context.tracing.stop({ path: filename });
    this.traceActive = false;
    return filename;
  }

  async close() {
    if (this.traceActive) {
      await this.context.tracing.stop().catch(() => {});
      this.traceActive = false;
    }
    await this.context.close();
  }
}

export async function launchBrowser({ profileDir, headless = false, logger = null }) {
  fs.mkdirSync(profileDir, { recursive: true });
  const executablePath = findBrowser();
  const viewport = randomViewport();
  logger?.info(
    `Playwright запускает ${path.basename(executablePath)} (${headless ? "headless" : "с окном"}), ` +
    `persistent profile, viewport=${viewport.width}x${viewport.height}.`
  );
  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath,
    headless,
    viewport,
    locale: "ru-RU",
    timezoneId: "Europe/Moscow",
    acceptDownloads: true,
    serviceWorkers: "allow",
    timeout: 30_000,
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--autoplay-policy=no-user-gesture-required"
    ]
  });
  context.setDefaultTimeout(12_000);
  context.setDefaultNavigationTimeout(45_000);
  const session = new PlaywrightSession(context, logger);
  await session.startTrace();
  logger?.info("Playwright context готов.");
  return session;
}
