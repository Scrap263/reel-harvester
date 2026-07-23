#!/usr/bin/env node
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { findBrowser } from "./playwright-browser.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UI_URL = "http://127.0.0.1:4173/";
const env = {
  ...process.env,
  PYTHONUTF8: "1",
  PYTHONIOENCODING: "utf-8"
};

async function fetchJson(url, options = {}) {
  try {
    const response = await fetch(url, options);
    return response.ok ? response.json() : null;
  } catch {
    return null;
  }
}

async function waitFor(url, child, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child?.exitCode != null) throw new Error(`UI-сервер завершился с кодом ${child.exitCode}`);
    if (await fetchJson(url)) return;
    await delay(150);
  }
  throw new Error(`Не удалось дождаться ${url}`);
}

async function openUiInChrome() {
  const executable = findBrowser();
  const browser = spawn(executable, [UI_URL], {
    cwd: ROOT,
    stdio: "ignore",
    windowsHide: false,
    env,
    detached: true
  });
  browser.unref();
  console.log(`UI открыт в Chrome: ${UI_URL}`);
  return browser;
}

async function main() {
  process.chdir(ROOT);
  let server = null;

  if (await fetchJson(`${UI_URL}api/dashboard`)) {
    console.log("UI-сервер уже работает — повторно не запускаю.");
  } else {
    server = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "src/server.js"], {
      cwd: ROOT,
      stdio: "inherit",
      windowsHide: false,
      env
    });
    await waitFor(`${UI_URL}api/dashboard`, server);
    console.log(`UI-сервер готов: ${UI_URL}`);
  }

  await openUiInChrome();
  console.log("Reel Harvester запущен. Это окно можно свернуть.");

  if (!server) return;
  const stop = () => {
    if (server.exitCode == null) server.kill();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await new Promise((resolve) => server.once("exit", resolve));
}

main().catch((error) => {
  console.error(`Ошибка запуска: ${error.message}`);
  process.exitCode = 1;
});
