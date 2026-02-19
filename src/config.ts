import dotenv from "dotenv";

export type AppConfig = {
  googleApiKey: string;
  telegramBotToken: string;
  telegramChatId: string;
  stateFilePath: string;
  listingsUrl: string;
  rssFeedUrl: string;
  maxFeedItemsPerRun: number;
  classifierDescriptionCharCap: number;
  geminiTokensPerMinute?: number;
  geminiTokenSafetyMargin?: number;
  geminiMinDelayMs?: number;
};

const REQUIRED_KEYS = ["GOOGLE_API_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"] as const;
const DEFAULT_LISTINGS_URL = "https://www.moaijobs.com/";
const DEFAULT_RSS_FEED_URL = "https://www.moaijobs.com/ai-jobs.rss";
const DEFAULT_MAX_FEED_ITEMS_PER_RUN = 100;
const DEFAULT_CLASSIFIER_DESCRIPTION_CHAR_CAP = 4_000;

export function loadConfig(stateFilePath = "state.json"): AppConfig {
  dotenv.config();

  const missing = REQUIRED_KEYS.filter((key) => !process.env[key] || process.env[key]?.trim() === "");
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }

  return {
    googleApiKey: process.env.GOOGLE_API_KEY as string,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN as string,
    telegramChatId: process.env.TELEGRAM_CHAT_ID as string,
    stateFilePath,
    listingsUrl: process.env.LISTINGS_URL?.trim() || DEFAULT_LISTINGS_URL,
    rssFeedUrl: process.env.RSS_FEED_URL?.trim() || DEFAULT_RSS_FEED_URL,
    maxFeedItemsPerRun: readPositiveInteger("RSS_MAX_ITEMS_PER_RUN", DEFAULT_MAX_FEED_ITEMS_PER_RUN),
    classifierDescriptionCharCap: readPositiveInteger(
      "CLASSIFIER_DESCRIPTION_CHAR_CAP",
      DEFAULT_CLASSIFIER_DESCRIPTION_CHAR_CAP,
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
