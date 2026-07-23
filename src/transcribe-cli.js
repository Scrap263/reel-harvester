#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const python = process.platform === "win32"
  ? path.resolve(".venv/Scripts/python.exe")
  : path.resolve(".venv/bin/python");

if (!fs.existsSync(python)) {
  console.error("Среда расшифровки не установлена. Выполните: npm.cmd run setup:transcribe");
  process.exit(1);
}

const result = spawnSync(python, [path.resolve("scripts/transcribe.py"), ...process.argv.slice(2)], {
  stdio: "inherit"
});
process.exit(result.status ?? 1);

