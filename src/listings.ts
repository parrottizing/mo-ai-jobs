import type { FeedJob } from "./rss-models";

export type RssRetryEvent = {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  error: string;
};

export type CollectFeedJobsResult = {
  feedItemsTotal: number;
  newFeedJobs: FeedJob[];
};

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type CollectOptions = {
  rssFeedUrl: string;
  latestSeenPubDate?: string | null;
  seenIds?: string[];
  maxItemsPerRun?: number;
  rssMaxPagesPerRun?: number;
  rssFetchMaxAttempts?: number;
  rssFetchInitialBackoffMs?: number;
  rssFetchMaxBackoffMs?: number;
  onRssRetry?: (event: RssRetryEvent) => void;
  fetcher?: Fetcher;
};

const DEFAULT_MAX_ITEMS_PER_RUN = 100;
const DEFAULT_RSS_MAX_PAGES_PER_RUN = 10;
const DEFAULT_RSS_FETCH_MAX_ATTEMPTS = 3;
const DEFAULT_RSS_FETCH_INITIAL_BACKOFF_MS = 1_000;
const DEFAULT_RSS_FETCH_MAX_BACKOFF_MS = 15_000;

export async function collectFeedJobs(options: CollectOptions): Promise<CollectFeedJobsResult> {
  const {
    rssFeedUrl,
    latestSeenPubDate = null,
    seenIds = [],
    maxItemsPerRun = DEFAULT_MAX_ITEMS_PER_RUN,
    rssMaxPagesPerRun = DEFAULT_RSS_MAX_PAGES_PER_RUN,
    rssFetchMaxAttempts = DEFAULT_RSS_FETCH_MAX_ATTEMPTS,
    rssFetchInitialBackoffMs = DEFAULT_RSS_FETCH_INITIAL_BACKOFF_MS,
    rssFetchMaxBackoffMs = DEFAULT_RSS_FETCH_MAX_BACKOFF_MS,
    onRssRetry,
    fetcher = fetch,
  } = options;

  const fetchRetryOptions = {
    maxAttempts: normalizePositiveInteger(rssFetchMaxAttempts, DEFAULT_RSS_FETCH_MAX_ATTEMPTS),
    initialBackoffMs: normalizePositiveInteger(
      rssFetchInitialBackoffMs,
      DEFAULT_RSS_FETCH_INITIAL_BACKOFF_MS,
    ),
    maxBackoffMs: normalizePositiveInteger(rssFetchMaxBackoffMs, DEFAULT_RSS_FETCH_MAX_BACKOFF_MS),
    onRetry: onRssRetry,
  };
  const maxPages = normalizePositiveInteger(rssMaxPagesPerRun, DEFAULT_RSS_MAX_PAGES_PER_RUN);
  const collectedFeedItems: FeedJob[] = [];

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    const pageUrl = buildPagedFeedUrl(rssFeedUrl, pageNumber);
    const response = await fetchRssWithRetry(pageUrl, fetcher, {
      ...fetchRetryOptions,
      allowNotFound: pageNumber > 1,
    });

    if (!response) {
      break;
    }

    const xml = await response.text();
    const pageItems = parseFeedItems(xml, rssFeedUrl);
    if (pageItems.length === 0) {
      break;
    }

    collectedFeedItems.push(...pageItems);

    if (allItemsOlderThanCursor(pageItems, latestSeenPubDate)) {
      break;
    }
  }

  const feedItems = sortNewestFirst(collectedFeedItems);
  const newFeedJobs = selectNewFeedItems(feedItems, {
    latestSeenPubDate,
    seenIds,
    maxItemsPerRun,
  });

  return {
    feedItemsTotal: feedItems.length,
    newFeedJobs,
  };
}

type FetchRetryOptions = {
  maxAttempts: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
  onRetry?: (event: RssRetryEvent) => void;
  allowNotFound?: boolean;
};

async function fetchRssWithRetry(
  feedUrl: string,
  fetcher: Fetcher,
  options: FetchRetryOptions,
): Promise<Response | null> {
  const maxAttempts = Math.max(1, options.maxAttempts);
  const initialBackoffMs = Math.max(1, options.initialBackoffMs);
  const maxBackoffMs = Math.max(initialBackoffMs, options.maxBackoffMs);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetcher(feedUrl, {
        headers: {
          "User-Agent": "vibe-coder-job-agent/0.1",
          Accept: "application/rss+xml, application/xml, text/xml, */*",
        },
      });

      if (response.ok) {
        return response;
      }

      if (options.allowNotFound && response.status === 404) {
        return null;
      }

      throw new Error(`Failed to fetch RSS feed ${feedUrl}: ${response.status} ${response.statusText}`);
    } catch (error) {
      if (attempt >= maxAttempts) {
        throw new Error(
          `Failed to fetch RSS feed ${feedUrl} after ${maxAttempts} attempt(s): ${formatError(error)}`,
        );
      }

      const delayMs = calculateBackoffDelayMs(attempt, initialBackoffMs, maxBackoffMs);
      options.onRetry?.({
        attempt,
        maxAttempts,
        delayMs,
        error: formatError(error),
      });
      await sleep(delayMs);
    }
  }

  throw new Error(`Failed to fetch RSS feed ${feedUrl}: exhausted retry attempts.`);
}

function buildPagedFeedUrl(baseUrl: string, pageNumber: number): string {
  if (pageNumber <= 1) {
    return baseUrl;
  }

  try {
    const url = new URL(baseUrl);
    url.searchParams.set("paged", String(pageNumber));
    return url.toString();
  } catch {
    const separator = baseUrl.includes("?") ? "&" : "?";
    return `${baseUrl}${separator}paged=${pageNumber}`;
  }
}

function allItemsOlderThanCursor(feedItems: FeedJob[], latestSeenPubDate: string | null): boolean {
  const cursorTimestamp = toTimestamp(latestSeenPubDate);
  if (cursorTimestamp === null) {
    return false;
  }

  let hasDatedItems = false;
  for (const item of feedItems) {
    const itemTimestamp = toTimestamp(item.pubDate);
    if (itemTimestamp === null) {
      continue;
    }
    hasDatedItems = true;
    if (itemTimestamp >= cursorTimestamp) {
      return false;
    }
  }

  return hasDatedItems;
}

export function parseFeedItems(xml: string, feedUrl: string): FeedJob[] {
  const itemBlocks = extractItemBlocks(xml);
  const parsedItems: FeedJob[] = [];

  for (const block of itemBlocks) {
    const item = parseFeedItem(block, feedUrl);
    if (item) {
      parsedItems.push(item);
    }
  }

  return sortNewestFirst(parsedItems);
}

type SelectionOptions = {
  latestSeenPubDate: string | null;
  seenIds: string[];
  maxItemsPerRun: number;
};

function selectNewFeedItems(feedItems: FeedJob[], options: SelectionOptions): FeedJob[] {
  const cursorTimestamp = toTimestamp(options.latestSeenPubDate);
  const historicalSeen = new Set(options.seenIds.map((id) => id.trim()).filter((id) => id.length > 0));
  const seenThisRun = new Set<string>();
  const selected: FeedJob[] = [];

  for (const item of feedItems) {
    if (selected.length >= options.maxItemsPerRun) {
      break;
    }

    if (seenThisRun.has(item.id)) {
      continue;
    }
    seenThisRun.add(item.id);

    const itemTimestamp = toTimestamp(item.pubDate);
    if (cursorTimestamp !== null && itemTimestamp !== null && itemTimestamp < cursorTimestamp) {
      break;
    }

    if (historicalSeen.has(item.id)) {
      continue;
    }

    selected.push(item);
  }

  return selected;
}

function extractItemBlocks(xml: string): string[] {
  const itemRegex = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  const blocks: string[] = [];

  let match: RegExpExecArray | null;
  while ((match = itemRegex.exec(xml))) {
    if (match[1]) {
      blocks.push(match[1]);
    }
  }

  return blocks;
}

function parseFeedItem(block: string, feedUrl: string): FeedJob | null {
  const guid = normalizeTagText(readTagContent(block, ["guid"]));
  const link = normalizeTagText(readTagContent(block, ["link"]));
  const detailUrlRaw = link ?? guid;

  if (!detailUrlRaw) {
    return null;
  }

  const detailUrl = resolveUrl(feedUrl, detailUrlRaw);
  const id = guid ?? extractIdFromUrl(detailUrl);
  if (!id) {
    return null;
  }

  const title =
    normalizeTagText(readTagContent(block, ["title"])) ??
    extractTitleFromDescription(readTagContent(block, ["description"])) ??
    id;

  const pubDate = normalizePubDate(readTagContent(block, ["pubDate", "dc:date"]));
  const descriptionHtml = normalizeDescriptionHtml(readTagContent(block, ["description", "content:encoded"]));
  const descriptionText = htmlToPlainText(descriptionHtml);

  const company =
    normalizeTagText(readTagContent(block, ["job:company", "company"], true)) ??
    extractLabeledValue(descriptionText, "Company");

  const location =
    normalizeTagText(readTagContent(block, ["job:location", "location"], true)) ??
    extractLabeledValue(descriptionText, "Location");

  const tags = extractTags(descriptionHtml, descriptionText);

  return {
    id,
    title,
    detailUrl,
    pubDate,
    company,
    location,
    tags,
    descriptionHtml,
    descriptionText,
  };
}

function readTagContent(block: string, tagNames: string[], includeLocalNameFallback = false): string | null {
  for (const tagName of tagNames) {
    const directMatch = matchTagContent(block, tagName, false);
    if (directMatch) {
      return directMatch;
    }

    if (includeLocalNameFallback && !tagName.includes(":")) {
      const fallbackMatch = matchTagContent(block, tagName, true);
      if (fallbackMatch) {
        return fallbackMatch;
      }
    }
  }

  return null;
}

function matchTagContent(block: string, tagName: string, allowAnyPrefix: boolean): string | null {
  const prefixPattern = allowAnyPrefix ? "(?:[\\w.-]+:)?" : "";
  const escapedTagName = escapeRegExp(tagName);
  const pattern = `<${prefixPattern}${escapedTagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\/${prefixPattern}${escapedTagName}>`;
  const regex = new RegExp(pattern, "i");
  const match = regex.exec(block);
  return match?.[1] ?? null;
}

function normalizeDescriptionHtml(rawDescription: string | null): string {
  if (!rawDescription) {
    return "";
  }

  const withoutCdataMarkers = stripCdataMarkers(rawDescription);
  const decoded = decodeHtmlEntitiesDeep(withoutCdataMarkers, 3);
  const sanitized = decoded
    .replace(/<!\[CDATA\[/gi, "")
    .replace(/\]\]>/g, "")
    .replace(/\s*\]\]+\s*$/g, "");
  const trimmed = sanitized.trim().replace(/^>+\s*/, "").replace(/\s*<\/+description>\s*$/i, "");
  return trimmed;
}

function stripCdataMarkers(value: string): string {
  return value.replace(/<!\[CDATA\[/gi, "").replace(/\]\]>/g, "");
}

function htmlToPlainText(html: string): string {
  if (!html) {
    return "";
  }

  const withoutScripts = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");

  const withSpacing = withoutScripts
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(?:p|div|li|h[1-6]|tr|section|article|ul|ol)>/gi, "\n")
    .replace(/<(?:li)\b[^>]*>/gi, "- ");

  const withoutTags = withSpacing.replace(/<[^>]*>/g, " ");
  const decoded = decodeHtmlEntitiesDeep(withoutTags, 2);
  return normalizeWhitespace(decoded);
}

function extractTags(descriptionHtml: string, descriptionText: string): string[] {
  const parsedFromHtml = parseTagsFromText(htmlToPlainText(descriptionHtml));
  if (parsedFromHtml.length > 0) {
    return parsedFromHtml;
  }

  return parseTagsFromText(descriptionText);
}

function parseTagsFromText(text: string): string[] {
  if (!text) {
    return [];
  }

  const jsonLikeMatch = /Tags\s*:\s*(\[[^\]]*\])/i.exec(text);
  if (jsonLikeMatch?.[1]) {
    const tags = parseStructuredTags(jsonLikeMatch[1]);
    if (tags.length > 0) {
      return tags;
    }
  }

  const plainMatch = /Tags\s*:\s*([^\n\r]+)/i.exec(text);
  if (!plainMatch?.[1]) {
    return [];
  }

  return plainMatch[1]
    .split(",")
    .map((tag) => tag.replace(/["'[\]]/g, "").trim())
    .filter((tag) => tag.length > 0);
}

function parseStructuredTags(value: string): string[] {
  const normalizedJson = value.replace(/'/g, '"');

  try {
    const parsed = JSON.parse(normalizedJson) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    const unique = new Set<string>();
    const tags: string[] = [];

    for (const entry of parsed) {
      if (typeof entry !== "string") {
        continue;
      }
      const normalized = entry.trim();
      if (!normalized || unique.has(normalized)) {
        continue;
      }
      unique.add(normalized);
      tags.push(normalized);
    }

    return tags;
  } catch {
    return [];
  }
}

function extractTitleFromDescription(rawDescription: string | null): string | null {
  if (!rawDescription) {
    return null;
  }

  const descriptionHtml = normalizeDescriptionHtml(rawDescription);
  const titleMatch = /<h2\b[^>]*>([\s\S]*?)<\/h2>/i.exec(descriptionHtml);
  if (!titleMatch?.[1]) {
    return null;
  }

  return normalizeWhitespace(decodeHtmlEntitiesDeep(stripTags(titleMatch[1]), 2));
}

function extractLabeledValue(descriptionText: string, label: string): string | null {
  if (!descriptionText) {
    return null;
  }

  const escapedLabel = escapeRegExp(label);
  const regex = new RegExp(
    `${escapedLabel}\\s*:\\s*(.+?)(?=\\s(?:Company|Location|Tags|Job Description)\\s*:|$)`,
    "i",
  );
  const match = regex.exec(descriptionText);
  if (!match?.[1]) {
    return null;
  }

  const value = normalizeWhitespace(match[1]);
  return value || null;
}

function normalizeTagText(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const decoded = decodeHtmlEntitiesDeep(stripCdataMarkers(value), 2);
  const normalized = normalizeWhitespace(stripTags(decoded));
  return normalized || null;
}

function normalizePubDate(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const normalizedValue = normalizeWhitespace(decodeHtmlEntitiesDeep(stripCdataMarkers(value), 2));
  const timestamp = Date.parse(normalizedValue);
  if (!Number.isFinite(timestamp)) {
    return null;
  }

  return new Date(timestamp).toISOString();
}

function sortNewestFirst(items: FeedJob[]): FeedJob[] {
  return items
    .map((item, index) => ({
      item,
      index,
      timestamp: toTimestamp(item.pubDate),
    }))
    .sort((a, b) => {
      if (a.timestamp !== null && b.timestamp !== null && a.timestamp !== b.timestamp) {
        return b.timestamp - a.timestamp;
      }

      if (a.timestamp !== null && b.timestamp === null) {
        return -1;
      }

      if (a.timestamp === null && b.timestamp !== null) {
        return 1;
      }

      return a.index - b.index;
    })
    .map((entry) => entry.item);
}

function resolveUrl(baseUrl: string, href: string): string {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return href;
  }
}

function extractIdFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const slug = segments[segments.length - 1];
    return slug ?? url;
  } catch {
    return url;
  }
}

function toTimestamp(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return null;
  }

  return timestamp;
}

function stripTags(text: string): string {
  return text.replace(/<[^>]*>/g, " ");
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function decodeHtmlEntitiesDeep(value: string, maxPasses: number): string {
  let decoded = value;
  for (let i = 0; i < maxPasses; i += 1) {
    const next = decodeHtmlEntities(decoded);
    if (next === decoded) {
      break;
    }
    decoded = next;
  }
  return decoded;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, decimal: string) => {
      const codePoint = Number.parseInt(decimal, 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : _;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hexadecimal: string) => {
      const codePoint = Number.parseInt(hexadecimal, 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : _;
    })
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'");
}

function calculateBackoffDelayMs(attempt: number, initialBackoffMs: number, maxBackoffMs: number): number {
  const exponent = Math.max(0, attempt - 1);
  const retryDelay = initialBackoffMs * 2 ** exponent;
  return Math.min(maxBackoffMs, retryDelay);
}

function normalizePositiveInteger(value: number, fallbackValue: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    return fallbackValue;
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
