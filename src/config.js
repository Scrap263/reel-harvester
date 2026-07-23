import fs from "node:fs";
import path from "node:path";

export const defaults = {
  profileDir: ".instagram-profile",
  database: "data/reels.sqlite",
  outputDir: "data/media",
  headless: false,
  enrich: false,
  downloadMedia: false,
  recordAudioFallback: false,
  maxReels: 100,
  maxScrolls: 50,
  scrollDelayMs: 1200,
  reelDelayMs: 1800,
  jitterMs: 800,
  navigationTimeoutMs: 45000,
  sources: []
};

export function loadConfig(file = "config.json", overrides = {}) {
  const fromFile = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : {};
  const config = { ...defaults, ...fromFile, ...overrides };

  config.profileDir = path.resolve(config.profileDir);
  config.database = path.resolve(config.database);
  config.outputDir = path.resolve(config.outputDir);
  config.sources = Array.isArray(config.sources) ? config.sources : [];
  return config;
}
