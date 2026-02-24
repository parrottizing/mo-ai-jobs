import type { JobMatchResult } from "./classifier";
import type { EnrichedFeedJob } from "./rss-models";

export type TelegramOptions = {
  botToken: string;
  chatId: string;
  timeoutMs?: number;
  fetcher?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  notifiedIds?: string[];
};

export type TelegramAlertStats = {
  sent: number;
  failed: number;
  skipped: number;
  sentJobIds: string[];
};

export type TelegramAlertResult = JobMatchResult & {
  enrichedJob?: EnrichedFeedJob;
};

const DEFAULT_TIMEOUT_MS = 10_000;

export async function sendTelegramAlerts(
  results: TelegramAlertResult[],
  options: TelegramOptions,
): Promise<TelegramAlertStats> {
  const stats: TelegramAlertStats = { sent: 0, failed: 0, skipped: 0, sentJobIds: [] };
  const previouslyNotified = new Set(
    (options.notifiedIds ?? []).map((id) => id.trim()).filter((id) => id.length > 0),
  );
  const sentInRun = new Set<string>();

  for (const result of results) {
    if (!result.match) {
      stats.skipped += 1;
      continue;
    }

    const jobId = result.job.id.trim();
    if (!jobId || previouslyNotified.has(jobId) || sentInRun.has(jobId)) {
      stats.skipped += 1;
      continue;
    }

    const message = formatTelegramMessage(result);

    try {
      await sendTelegramMessage(message, options);
      stats.sent += 1;
      stats.sentJobIds.push(jobId);
      sentInRun.add(jobId);
    } catch (error) {
      stats.failed += 1;
      console.error("Telegram alert failed:", error);
    }
  }

  return stats;
}

function formatTelegramMessage(result: TelegramAlertResult): string {
  const company = escapeHtml(normalizeTextField(result.job.company));
  const location = escapeHtml(normalizeTextField(result.job.location));
  const title = escapeHtml(result.job.title);
  const detailsUrl = normalizeUrl(result.job.detailUrl) ?? "Unknown";
  const applyUrlCandidate = normalizeUrl(result.enrichedJob?.applyUrl);
  const applyUrl =
    applyUrlCandidate && applyUrlCandidate !== detailsUrl ? applyUrlCandidate : detailsUrl;

  return [
    `<b>Title:</b> <i>${title}</i>`,
    `<b>Company:</b> <i>${company}</i>`,
    `<b>Location:</b> <i>${location}</i>`,
    `<a href="${detailsUrl}">Details</a>`,
    `<a href="${applyUrl}">Apply</a>`,
  ].join("\n");
}

function normalizeTextField(value: string | null | undefined): string {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : "Unknown";
}

function normalizeUrl(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : null;
}

function shortenRationale(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "Matched AI-native role criteria.";
  }

  const maxLength = 160;
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
        parse_mode: "HTML",
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
