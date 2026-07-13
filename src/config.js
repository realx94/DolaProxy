import fs from "node:fs";
import path from "node:path";

export function loadEnv(file = path.resolve(".env")) {
  if (!fs.existsSync(file)) return;

  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function getConfig() {
  loadEnv();
  return {
    host: process.env.HOST || "127.0.0.1",
    port: numberFromEnv("PORT", 3000),
    apiKey: process.env.DOLA_PROXY_API_KEY || "",
    debugUrl: (process.env.DOLA_DEBUG_URL || "http://127.0.0.1:9229").replace(/\/$/, ""),
    requestTimeoutMs: numberFromEnv("DOLA_REQUEST_TIMEOUT_MS", 360_000),
    maxRequestBytes: numberFromEnv("DOLA_MAX_REQUEST_BYTES", 32 * 1024 * 1024),
    maxFileBytes: numberFromEnv("DOLA_MAX_FILE_BYTES", 20 * 1024 * 1024),
  };
}

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
