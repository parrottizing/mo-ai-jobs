"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadConfig = loadConfig;
const dotenv_1 = __importDefault(require("dotenv"));
const REQUIRED_KEYS = ["GOOGLE_API_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"];
const DEFAULT_LISTINGS_URL = "https://www.moaijobs.com/";
function loadConfig(stateFilePath = "state.json") {
    dotenv_1.default.config();
    const missing = REQUIRED_KEYS.filter((key) => !process.env[key] || process.env[key]?.trim() === "");
    if (missing.length > 0) {
        throw new Error(`Missing required env vars: ${missing.join(", ")}`);
    }
    return {
        googleApiKey: process.env.GOOGLE_API_KEY,
        telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
        telegramChatId: process.env.TELEGRAM_CHAT_ID,
        stateFilePath,
        listingsUrl: process.env.LISTINGS_URL?.trim() || DEFAULT_LISTINGS_URL,
        geminiTokensPerMinute: readNumber("GEMINI_TOKENS_PER_MINUTE"),
        geminiTokenSafetyMargin: readNumber("GEMINI_TOKEN_SAFETY_MARGIN"),
        geminiMinDelayMs: readNumber("GEMINI_MIN_DELAY_MS"),
    };
}
function readNumber(key) {
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
