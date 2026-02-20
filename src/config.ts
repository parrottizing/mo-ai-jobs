import dotenv from "dotenv";

export type AppConfig = {
  googleApiKey: string;
  telegramBotToken: string;
  telegramChatId: string;
  stateFilePath: string;
  rssFeedUrl: string;
  maxFeedItemsPerRun: number;
  rssFetchMaxAttempts: number;
  rssFetchInitialBackoffMs: number;
  rssFetchMaxBackoffMs: number;
  classifierDescriptionCharCap: number;
  detailEnrichmentHeadlessFallbackEnabled: boolean;
  geminiTokensPerMinute?: number;
  geminiTokenSafetyMargin?: number;
  geminiMinDelayMs?: number;
};

const REQUIRED_KEYS = ["GOOGLE_API_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"] as const;
const DEFAULT_RSS_FEED_URL = "https://www.moaijobs.com/ai-jobs.rss";
const DEFAULT_MAX_FEED_ITEMS_PER_RUN = 100;
const DEFAULT_RSS_FETCH_MAX_ATTEMPTS = 3;
const DEFAULT_RSS_FETCH_INITIAL_BACKOFF_MS = 1_000;
const DEFAULT_RSS_FETCH_MAX_BACKOFF_MS = 15_000;
const DEFAULT_CLASSIFIER_DESCRIPTION_CHAR_CAP = 4_000;
const DEFAULT_DETAIL_ENRICHMENT_HEADLESS_FALLBACK_ENABLED = false;

export function loadConfig(stateFilePath = "state.json"): AppConfig {
  dotenv.config();

  const missing = REQUIRED_KEYS.filter((key) => !process.env[key] || process.env[key]?.trim() === "");
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }

  const rssFetchInitialBackoffMs = readPositiveInteger(
    "RSS_FETCH_INITIAL_BACKOFF_MS",
    DEFAULT_RSS_FETCH_INITIAL_BACKOFF_MS,
  );
  const rssFetchMaxBackoffMs = Math.max(
    rssFetchInitialBackoffMs,
    readPositiveInteger("RSS_FETCH_MAX_BACKOFF_MS", DEFAULT_RSS_FETCH_MAX_BACKOFF_MS),
  );

  return {
    googleApiKey: process.env.GOOGLE_API_KEY as string,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN as string,
    telegramChatId: process.env.TELEGRAM_CHAT_ID as string,
    stateFilePath,
    rssFeedUrl: process.env.RSS_FEED_URL?.trim() || DEFAULT_RSS_FEED_URL,
    maxFeedItemsPerRun: readPositiveInteger("RSS_MAX_ITEMS_PER_RUN", DEFAULT_MAX_FEED_ITEMS_PER_RUN),
    rssFetchMaxAttempts: readPositiveInteger("RSS_FETCH_MAX_ATTEMPTS", DEFAULT_RSS_FETCH_MAX_ATTEMPTS),
    rssFetchInitialBackoffMs,
    rssFetchMaxBackoffMs,
    classifierDescriptionCharCap: readPositiveInteger(
      "CLASSIFIER_DESCRIPTION_CHAR_CAP",
      DEFAULT_CLASSIFIER_DESCRIPTION_CHAR_CAP,
    ),
    detailEnrichmentHeadlessFallbackEnabled: readBoolean(
      "DETAIL_ENRICHMENT_HEADLESS_FALLBACK_ENABLED",
      DEFAULT_DETAIL_ENRICHMENT_HEADLESS_FALLBACK_ENABLED,
    ),
    geminiTokensPerMinute: readNumber("GEMINI_TOKENS_PER_MINUTE"),
    geminiTokenSafetyMargin: readNumber("GEMINI_TOKEN_SAFETY_MARGIN"),
    geminiMinDelayMs: readNumber("GEMINI_MIN_DELAY_MS"),
  };
}

function readNumber(key: string): number | undefined {
  const value = process.env[key];
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric env var ${key}: ${value}`);
  }
  return parsed;
}

function readPositiveInteger(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (!value) {
    return defaultValue;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive integer env var ${key}: ${value}`);
  }

  return parsed;
}

function readBoolean(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (value === undefined) {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  throw new Error(`Invalid boolean env var ${key}: ${value}`);
}
