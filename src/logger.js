import fs from "node:fs";
import path from "node:path";

export function createLogger(filename = "data/collector.log") {
  const absolute = path.resolve(filename);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });

  const write = (level, message) => {
    const line = `${new Date().toISOString()} [${level}] ${message}`;
    fs.appendFileSync(absolute, `${line}\n`, "utf8");
    const output = level === "ERROR" ? console.error : console.log;
    output(line);
  };

  return {
    filename: absolute,
    info: (message) => write("INFO", message),
    warn: (message) => write("WARN", message),
    error: (message) => write("ERROR", message),
    log: (message) => write("INFO", message)
  };
}
