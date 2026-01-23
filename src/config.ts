import dotenv from "dotenv";

export type AppConfig = {
  googleApiKey: string;
  telegramBotToken: string;
  telegramChatId: string;
  stateFilePath: string;
  listingsUrl: string;
};

const REQUIRED_KEYS = ["GOOGLE_API_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"] as const;
const DEFAULT_LISTINGS_URL = "https://www.moaijobs.com/";

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
  };
}
