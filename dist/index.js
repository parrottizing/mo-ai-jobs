"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runOnce = runOnce;
exports.runDaily = runDaily;
exports.bootstrap = bootstrap;
const config_1 = require("./config");
const details_1 = require("./details");
const classifier_1 = require("./classifier");
const listings_1 = require("./listings");
const state_1 = require("./state");
const telegram_1 = require("./telegram");
__exportStar(require("./details"), exports);
__exportStar(require("./listings"), exports);
__exportStar(require("./classifier"), exports);
__exportStar(require("./telegram"), exports);
const DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;
async function runOnce() {
    const config = (0, config_1.loadConfig)();
    const state = await (0, state_1.loadState)(config.stateFilePath);
    const startedAt = new Date();
    log(`Run started (${startedAt.toISOString()})`);
    const newJobs = await (0, listings_1.collectNewJobs)({
        listingsUrl: config.listingsUrl,
        lastSeenJobId: state.lastSeenJobId,
    });
    log(`New jobs found: ${newJobs.length}`);
    if (newJobs.length === 0) {
        log("Run completed. Matches: 0.");
        return;
    }
    const details = [];
    for (const job of newJobs) {
        details.push(await (0, details_1.fetchJobDetails)(job));
    }
    const matchResults = await (0, classifier_1.classifyJobs)(details, {
        apiKey: config.googleApiKey,
        rateLimit: {
            tokensPerMinute: config.geminiTokensPerMinute,
            safetyMargin: config.geminiTokenSafetyMargin,
            minDelayMs: config.geminiMinDelayMs,
        },
    });
    const matchCount = matchResults.filter((result) => result.match).length;
    const alertStats = await (0, telegram_1.sendTelegramAlerts)(matchResults, {
        botToken: config.telegramBotToken,
        chatId: config.telegramChatId,
    });
    await (0, state_1.saveState)(config.stateFilePath, {
        lastSeenJobId: newJobs[0]?.id ?? state.lastSeenJobId,
    });
    log(`Telegram alerts: sent ${alertStats.sent}, failed ${alertStats.failed}, skipped ${alertStats.skipped}.`);
    log(`Run completed. New jobs: ${newJobs.length}. Matches: ${matchCount}.`);
}
async function runDaily() {
    let running = false;
    const runGuarded = async () => {
        if (running) {
            log("Skipping scheduled run because the previous run is still in progress.");
            return;
        }
        running = true;
        try {
            await runOnce();
        }
        catch (error) {
            console.error(error);
            log("Run failed. State not updated.");
        }
        finally {
            running = false;
        }
    };
    await runGuarded();
    setInterval(() => {
        void runGuarded();
    }, DAILY_INTERVAL_MS);
}
async function bootstrap() {
    const args = parseArgs(process.argv.slice(2));
    if (args.schedule === "daily") {
        await runDaily();
        return;
    }
    if (args.schedule) {
        throw new Error(`Unsupported schedule: ${args.schedule}`);
    }
    await runOnce();
}
if (require.main === module) {
    bootstrap().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
function log(message) {
    console.log(`[${new Date().toISOString()}] ${message}`);
}
function parseArgs(argv) {
    let schedule;
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === "--schedule" && argv[i + 1]) {
            schedule = argv[i + 1];
            i += 1;
            continue;
        }
        if (arg.startsWith("--schedule=")) {
            schedule = arg.slice("--schedule=".length);
        }
    }
    return { schedule };
}
