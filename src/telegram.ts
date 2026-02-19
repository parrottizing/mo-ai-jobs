import type { JobMatchResult } from "./classifier";

export type TelegramOptions = {
  botToken: string;
  chatId: string;
  timeoutMs?: number;
  fetcher?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};

export type TelegramAlertStats = {
  sent: number;
  failed: number;
  skipped: number;
};

const DEFAULT_TIMEOUT_MS = 10_000;

export async function sendTelegramAlerts(
  results: JobMatchResult[],
  options: TelegramOptions,
): Promise<TelegramAlertStats> {
  const stats: TelegramAlertStats = { sent: 0, failed: 0, skipped: 0 };

  for (const result of results) {
    if (!result.match) {
      stats.skipped += 1;
      continue;
    }

    const message = formatTelegramMessage(result);

    try {
      await sendTelegramMessage(message, options);
      stats.sent += 1;
    } catch (error) {
      stats.failed += 1;
      console.error("Telegram alert failed:", error);
    }
  }

  return stats;
}

function formatTelegramMessage(result: JobMatchResult): string {
  const company = result.job.company ?? "Unknown";
  return [
    "Vibe-coder match found:",
    `Title: ${result.job.title}`,
    `Company: ${company}`,
    `Link: ${result.job.detailUrl}`,
  ].join("\n");
}

async function sendTelegramMessage(text: string, options: TelegramOptions): Promise<void> {
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const url = `https://api.telegram.org/bot${options.botToken}/sendMessage`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetcher(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: options.chatId,
        text,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await safeReadBody(response);
      throw new Error(`Telegram API error: ${response.status} ${response.statusText} ${errorBody}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function safeReadBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
