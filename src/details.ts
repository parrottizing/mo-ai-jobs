import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import type { JobListing } from "./listings";
import type { EnrichedFeedJob, FeedJob } from "./rss-models";

const execFileAsync = promisify(execFile);

export type JobDetails = {
  id: string;
  url: string;
  title: string;
  company: string | null;
  location: string | null;
  tags: string[];
  description: string;
};

export type JobDetailsOptions = {
  executablePath?: string;
  timeoutMs?: number;
  userAgent?: string;
};

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type EnrichFeedJobOptions = JobDetailsOptions & {
  fetcher?: Fetcher;
  allowHeadlessFallback?: boolean;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_USER_AGENT = "vibe-coder-job-agent/0.1";
const APPLY_NOW_STRICT_PATTERN = /\bapply\s+now\b/i;
const APPLY_NOW_LOOSE_PATTERN = /\bapply\b/i;

export async function enrichFeedJob(
  job: FeedJob,
  options: EnrichFeedJobOptions = {},
): Promise<EnrichedFeedJob> {
  const errors: string[] = [];

  try {
    const html = await loadHtmlWithHttp(job.detailUrl, options);
    const applyUrl = extractApplyUrl(html, job.detailUrl);
    if (applyUrl) {
      return {
        ...job,
        applyUrl,
        detailFetchStatus: "succeeded",
        enrichmentError: null,
      };
    }
  } catch (error) {
    errors.push(`HTTP detail fetch failed: ${toErrorMessage(error)}`);
  }

  if (options.allowHeadlessFallback) {
    try {
      const html = await loadHtmlWithBrowser(job.detailUrl, options);
      const applyUrl = extractApplyUrl(html, job.detailUrl);
      if (applyUrl) {
        return {
          ...job,
          applyUrl,
          detailFetchStatus: "succeeded",
          enrichmentError: null,
        };
      }
      errors.push("Headless fallback did not produce an apply URL.");
    } catch (error) {
      errors.push(`Headless fallback failed: ${toErrorMessage(error)}`);
    }
  }

  if (errors.length === 0) {
    errors.push("Apply URL was not found in Apply button anchor or JobPosting JSON-LD.");
  }

  return {
    ...job,
    applyUrl: job.detailUrl,
    detailFetchStatus: "failed",
    enrichmentError: errors.join(" "),
  };
}

export async function fetchJobDetails(
  job: JobListing,
  options: JobDetailsOptions = {},
): Promise<JobDetails> {
  const html = await loadHtmlWithBrowser(job.url, options);
  const extracted = extractFromHtml(html);

  return {
    id: job.id,
    url: job.url,
    title: extracted.title ?? job.title,
    company: extracted.company,
    location: extracted.location,
    tags: extracted.tags,
    description: extracted.description,
  };
}

async function loadHtmlWithHttp(url: string, options: EnrichFeedJobOptions): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetcher = options.fetcher ?? fetch;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetcher(url, {
      headers: {
        "User-Agent": options.userAgent ?? DEFAULT_USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(
        `Failed to fetch detail page ${url}: ${response.status} ${response.statusText}`,
      );
    }

    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function extractApplyUrl(html: string, detailUrl: string): string | null {
  return extractApplyAnchorUrl(html, detailUrl) ?? extractApplyUrlFromJsonLd(html, detailUrl);
}

function extractApplyAnchorUrl(html: string, detailUrl: string): string | null {
  const anchorRegex = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  const looseCandidates: string[] = [];

  let match: RegExpExecArray | null;
  while ((match = anchorRegex.exec(html))) {
    const attributes = match[1] ?? "";
    const innerHtml = match[2] ?? "";

    const href = readAttributeValue(attributes, "href");
    if (!href) {
      continue;
    }

    const resolvedUrl = normalizeUrlCandidate(href, detailUrl);
    if (!resolvedUrl || isSamePageUrl(resolvedUrl, detailUrl)) {
      continue;
    }

    const anchorLabel = normalizeWhitespace(
      [
        stripTags(innerHtml),
        readAttributeValue(attributes, "aria-label"),
        readAttributeValue(attributes, "title"),
      ]
        .filter((value): value is string => Boolean(value))
        .join(" "),
    );

    if (!anchorLabel) {
      continue;
    }

    if (APPLY_NOW_STRICT_PATTERN.test(anchorLabel)) {
      return resolvedUrl;
    }

    if (APPLY_NOW_LOOSE_PATTERN.test(anchorLabel)) {
      looseCandidates.push(resolvedUrl);
    }
  }

  return looseCandidates[0] ?? null;
}

function extractApplyUrlFromJsonLd(html: string, detailUrl: string): string | null {
  const jsonLdRegex =
    /<script\b[^>]*type\s*=\s*("|')application\/ld\+json\1[^>]*>([\s\S]*?)<\/script>/gi;
  const candidates: string[] = [];

  let match: RegExpExecArray | null;
  while ((match = jsonLdRegex.exec(html))) {
    const raw = (match[2] ?? "").trim();
    if (!raw) {
      continue;
    }

    const parsed = parseJsonLdPayload(raw);
    if (!parsed) {
      continue;
    }

    const jobPostings = findJobPostingNodes(parsed);
    for (const jobPosting of jobPostings) {
      const urlCandidates = [
        readNestedString(jobPosting, ["applyUrl"]),
        readNestedString(jobPosting, ["applicationUrl"]),
        readNestedString(jobPosting, ["hiringOrganization", "url"]),
        readNestedString(jobPosting, ["hiringOrganization", "sameAs"]),
        readNestedString(jobPosting, ["url"]),
      ];

      for (const urlCandidate of urlCandidates) {
        if (!urlCandidate) {
          continue;
        }
        const normalized = normalizeUrlCandidate(urlCandidate, detailUrl);
        if (normalized && !isSamePageUrl(normalized, detailUrl)) {
          candidates.push(normalized);
        }
      }
    }
  }

  return candidates[0] ?? null;
}

function parseJsonLdPayload(raw: string): unknown | null {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    const decoded = decodeHtmlEntities(raw);
    try {
      return JSON.parse(decoded) as unknown;
    } catch {
      return null;
    }
  }
}

function findJobPostingNodes(value: unknown): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];

  const visit = (current: unknown) => {
    if (Array.isArray(current)) {
      for (const item of current) {
        visit(item);
      }
      return;
    }

    if (!isRecord(current)) {
      return;
    }

    if (hasSchemaType(current, "JobPosting")) {
      nodes.push(current);
    }

    for (const nested of Object.values(current)) {
      visit(nested);
    }
  };

  visit(value);
  return nodes;
}

function hasSchemaType(node: Record<string, unknown>, schemaType: string): boolean {
  const value = node["@type"];
  if (typeof value === "string") {
    return value.toLowerCase() === schemaType.toLowerCase();
  }

  if (Array.isArray(value)) {
    return value.some(
      (entry) =>
        typeof entry === "string" && entry.toLowerCase() === schemaType.toLowerCase(),
    );
  }

  return false;
}

function readNestedString(
  value: Record<string, unknown>,
  pathSegments: string[],
): string | null {
  let current: unknown = value;

  for (const segment of pathSegments) {
    if (!isRecord(current)) {
      return null;
    }
    current = current[segment];
  }

  if (typeof current !== "string") {
    return null;
  }

  const normalized = current.trim();
  return normalized || null;
}

function readAttributeValue(attributes: string, attributeName: string): string | null {
  const escapedAttributeName = escapeRegExp(attributeName);
  const regex = new RegExp(
    `${escapedAttributeName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\\x60]+))`,
    "i",
  );

  const match = regex.exec(attributes);
  const raw = match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
  if (!raw) {
    return null;
  }

  const normalized = normalizeWhitespace(raw);
  return normalized || null;
}

function normalizeUrlCandidate(candidate: string, baseUrl: string): string | null {
  const value = candidate.trim();
  if (!value) {
    return null;
  }

  const lower = value.toLowerCase();
  if (lower.startsWith("javascript:") || lower.startsWith("mailto:") || lower.startsWith("tel:")) {
    return null;
  }

  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return null;
  }
}

function isSamePageUrl(candidateUrl: string, detailUrl: string): boolean {
  try {
    const candidate = new URL(candidateUrl);
    const detail = new URL(detailUrl);

    const normalizePath = (pathname: string) => pathname.replace(/\/+$/, "");
    return (
      candidate.origin === detail.origin &&
      normalizePath(candidate.pathname) === normalizePath(detail.pathname)
    );
  } catch {
    return candidateUrl === detailUrl;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

async function loadHtmlWithBrowser(url: string, options: JobDetailsOptions): Promise<string> {
  const executablePath = resolveExecutablePath(options.executablePath);
  if (!executablePath) {
    throw new Error("No Chrome/Chromium executable found for headless scrape.");
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const commonArgs = [
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--dump-dom",
    `--user-agent=${options.userAgent ?? DEFAULT_USER_AGENT}`,
    url,
  ];

  try {
    const { stdout } = await execFileAsync(executablePath, ["--headless=new", ...commonArgs], {
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const { stdout } = await execFileAsync(executablePath, ["--headless", ...commonArgs], {
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    if (stdout) {
      return stdout;
    }
    throw error;
  }
}

function resolveExecutablePath(explicitPath?: string): string | undefined {
  if (explicitPath) {
    return explicitPath;
  }

  const envPath =
    process.env.PUPPETEER_EXECUTABLE_PATH ||
    process.env.CHROME_PATH ||
    process.env.CHROMIUM_PATH ||
    process.env.GOOGLE_CHROME_PATH;

  if (envPath) {
    return envPath;
  }

  const platform = process.platform;
  const candidates: string[] = [];

  if (platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    );
  } else if (platform === "win32") {
    const programFiles = process.env["PROGRAMFILES"] ?? "C:\\Program Files";
    const programFilesX86 = process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)";
    candidates.push(
      path.join(programFiles, "Google/Chrome/Application/chrome.exe"),
      path.join(programFilesX86, "Google/Chrome/Application/chrome.exe"),
    );
  } else {
    candidates.push("/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser");
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

type HtmlExtraction = {
  title: string | null;
  company: string | null;
  location: string | null;
  tags: string[];
  description: string;
};

function extractFromHtml(html: string): HtmlExtraction {
  const title =
    extractTagText(html, "h1") ??
    extractMetaContent(html, "og:title") ??
    extractTagText(html, "title");

  const company =
    extractByLabel(html, ["company", "employer", "organization"]) ??
    extractClassText(html, ["company", "job-company"]);

  const location =
    extractByLabel(html, ["location", "remote", "region"]) ??
    extractClassText(html, ["location", "job-location"]);

  const tags = extractTags(html);

  const description = applyCutoff(
    extractSection(html, ["job-description", "description"]) ??
    extractTagBlock(html, "article") ??
    extractTagBlock(html, "main") ??
    normalizeWhitespace(stripTags(html)),
  );

  return {
    title,
    company,
    location,
    tags,
    description: description ?? "",
  };
}

function applyCutoff(text: string | null): string | null {
  if (!text) {
    return null;
  }

  const cutoffs = [
    "Similar Jobs",
    "Browse all AI jobs",
    "Looking for something different?",
    "Post a Job",
    "Share this job opportunity",
  ];

  let lowestIndex = text.length;
  for (const marker of cutoffs) {
    const index = text.indexOf(marker);
    if (index !== -1 && index < lowestIndex) {
      lowestIndex = index;
    }
  }

  return text.slice(0, lowestIndex).trim();
}

function extractTagText(html: string, tag: string): string | null {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const match = regex.exec(html);
  if (!match?.[1]) {
    return null;
  }
  return normalizeWhitespace(stripTags(match[1]));
}

function extractTagBlock(html: string, tag: string): string | null {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const match = regex.exec(html);
  if (!match?.[1]) {
    return null;
  }
  return normalizeWhitespace(stripTags(match[1]));
}

function extractMetaContent(html: string, property: string): string | null {
  const regex = new RegExp(
    `<meta\\s+[^>]*property\\s*=\\s*("|')${property}\\1[^>]*content\\s*=\\s*("|')(.*?)\\2`,
    "i",
  );
  const match = regex.exec(html);
  if (!match?.[3]) {
    return null;
  }
  return normalizeWhitespace(match[3]);
}

function extractByLabel(html: string, labels: string[]): string | null {
  for (const label of labels) {
    const regex = new RegExp(
      `<(?:dt|th|div|span|p)[^>]*>\\s*${label}\\s*<\\/(?:dt|th|div|span|p)>\\s*` +
      `<(?:dd|td|div|span|p)[^>]*>([\\s\\S]*?)<\\/(?:dd|td|div|span|p)>`,
      "i",
    );
    const match = regex.exec(html);
    if (match?.[1]) {
      const value = normalizeWhitespace(stripTags(match[1]));
      if (value) {
        return value;
      }
    }
  }

  return null;
}

function extractClassText(html: string, classNames: string[]): string | null {
  for (const className of classNames) {
    const regex = new RegExp(
      `<[^>]*class\\s*=\\s*("|')[^"']*${className}[^"']*\\1[^>]*>([\\s\\S]*?)<\\/[^>]+>`,
      "i",
    );
    const match = regex.exec(html);
    if (match?.[2]) {
      const value = normalizeWhitespace(stripTags(match[2]));
      if (value) {
        return value;
      }
    }
  }

  return null;
}

function extractSection(html: string, classNames: string[]): string | null {
  for (const className of classNames) {
    const regex = new RegExp(
      `<[^>]*class\\s*=\\s*("|')[^"']*${className}[^"']*\\1[^>]*>([\\s\\S]*?)<\\/[^>]+>`,
      "i",
    );
    const match = regex.exec(html);
    if (match?.[2]) {
      const value = normalizeWhitespace(stripTags(match[2]));
      if (value) {
        return value;
      }
    }
  }

  return null;
}

function extractTags(html: string): string[] {
  const tagSet = new Set<string>();
  const classRegex = /<[^>]*class\s*=\s*("|')[^"']*(tag|badge)[^"']*\1[^>]*>([\s\S]*?)<\/[^>]+>/gi;
  const dataRegex = /data-tags\s*=\s*("|')([\s\S]*?)\1/gi;

  let match: RegExpExecArray | null;
  while ((match = classRegex.exec(html))) {
    const text = normalizeWhitespace(stripTags(match[3] ?? ""));
    if (text) {
      tagSet.add(text);
    }
  }

  while ((match = dataRegex.exec(html))) {
    const raw = match[2] ?? "";
    for (const part of raw.split(/[,;]/)) {
      const value = normalizeWhitespace(part);
      if (value) {
        tagSet.add(value);
      }
    }
  }

  return Array.from(tagSet);
}

function stripTags(text: string): string {
  return text.replace(/<[^>]*>/g, " ");
}

function normalizeWhitespace(text: string | null | undefined): string | null {
  if (!text) {
    return null;
  }
  const normalized = decodeHtmlEntities(text).replace(/\s+/g, " ").trim();
  return normalized || null;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
