import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import type { JobListing } from "./listings";

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

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_USER_AGENT = "vibe-coder-job-agent/0.1";

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

  const description =
    extractSection(html, ["job-description", "description"]) ??
    extractTagBlock(html, "article") ??
    extractTagBlock(html, "main") ??
    normalizeWhitespace(stripTags(html));

  return {
    title,
    company,
    location,
    tags,
    description: description ?? "",
  };
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
