import dotenv from "dotenv";

dotenv.config();

const toNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toBoolean = (value, fallback) => {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
};

export const config = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: toNumber(process.env.PORT, 3030),
  host: process.env.HOST || "0.0.0.0",
  apiPassword: process.env.API_PASSWORD || "",
  requestTimeoutMs: toNumber(process.env.REQUEST_TIMEOUT_MS, 60000),
  queueEnabled: toBoolean(process.env.QUEUE_ENABLED, true),
  queueConcurrency: Math.max(1, toNumber(process.env.QUEUE_CONCURRENCY, 2)),
  queueMaxSize: Math.max(0, toNumber(process.env.QUEUE_MAX_SIZE, 100)),
  defaultResults: toNumber(process.env.DEFAULT_RESULTS, 10),
  maxResults: toNumber(process.env.MAX_RESULTS, 50),
  maxScrolls: toNumber(process.env.MAX_SCROLLS, 8),
  scrollDelayMs: toNumber(process.env.SCROLL_DELAY_MS, 1300),
  navigationTimeoutMs: toNumber(process.env.NAVIGATION_TIMEOUT_MS, 30000),
  headless: toBoolean(process.env.CLOAK_HEADLESS, true),
  humanize: toBoolean(process.env.CLOAK_HUMANIZE, true),
  humanPreset: process.env.CLOAK_HUMAN_PRESET || "default",
  proxy: process.env.CLOAK_PROXY || "",
  locale: process.env.CLOAK_LOCALE || "",
  timezone: process.env.CLOAK_TIMEZONE || "",
  geoip: toBoolean(process.env.CLOAK_GEOIP, false),
  extraArgs: (process.env.CLOAK_ARGS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
  logRequests: toBoolean(process.env.LOG_REQUESTS, true)
};

export const clampResults = (value) => {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return config.defaultResults;
  }

  return Math.min(Math.floor(parsed), config.maxResults);
};
