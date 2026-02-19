"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.collectNewJobs = collectNewJobs;
exports.parseListingsPage = parseListingsPage;
const JOB_PATH_HINTS = [/\/jobs?\//i, /\/role\//i, /\/position\//i, /\/listing\//i];
async function collectNewJobs(options) {
    const { listingsUrl, lastSeenJobId = null, maxPages = 20, fetcher = fetch, } = options;
    const jobs = [];
    const seenIds = new Set();
    const visited = new Set();
    let nextUrl = listingsUrl;
    let pages = 0;
    let foundLastSeen = false;
    while (nextUrl && pages < maxPages && !foundLastSeen) {
        if (visited.has(nextUrl)) {
            break;
        }
        visited.add(nextUrl);
        pages += 1;
        const response = await fetcher(nextUrl, {
            headers: {
                "User-Agent": "vibe-coder-job-agent/0.1",
            },
        });
        if (!response.ok) {
            throw new Error(`Failed to fetch listings page ${nextUrl}: ${response.status} ${response.statusText}`);
        }
        const html = await response.text();
        const page = parseListingsPage(html, nextUrl);
        for (const job of page.jobs) {
            if (lastSeenJobId && job.id === lastSeenJobId) {
                foundLastSeen = true;
                break;
            }
            if (!seenIds.has(job.id)) {
                jobs.push(job);
                seenIds.add(job.id);
            }
        }
        if (!foundLastSeen) {
            nextUrl = page.nextPageUrl;
        }
    }
    return jobs;
}
function parseListingsPage(html, baseUrl) {
    const jobs = parseJobListings(html, baseUrl);
    const nextPageUrl = findNextPageUrl(html, baseUrl);
    return { jobs, nextPageUrl };
}
function parseJobListings(html, baseUrl) {
    const jobListings = [];
    const seen = new Set();
    const anchorRegex = /<a\s+([^>]*?)href\s*=\s*(["'])(.*?)\2([^>]*?)>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = anchorRegex.exec(html))) {
        const beforeAttrs = match[1] ?? "";
        const href = match[3]?.trim();
        const afterAttrs = match[4] ?? "";
        const inner = match[5] ?? "";
        if (!href || !hrefIsJobListing(href)) {
            continue;
        }
        const url = resolveUrl(baseUrl, href);
        const title = normalizeWhitespace(stripTags(inner));
        const attrs = `${beforeAttrs} ${afterAttrs}`;
        const dataId = extractDataId(attrs);
        const id = dataId ?? extractIdFromUrl(url);
        if (!id || !title || seen.has(id)) {
            continue;
        }
        seen.add(id);
        jobListings.push({ id, title, url });
    }
    return jobListings;
}
function hrefIsJobListing(href) {
    return JOB_PATH_HINTS.some((pattern) => pattern.test(href));
}
function findNextPageUrl(html, baseUrl) {
    const linkRelMatch = /<link\s+[^>]*rel\s*=\s*(["'])next\1[^>]*href\s*=\s*(["'])(.*?)\2[^>]*>/i.exec(html);
    if (linkRelMatch?.[3]) {
        return resolveUrl(baseUrl, linkRelMatch[3]);
    }
    const anchorRelMatch = /<a\s+[^>]*rel\s*=\s*(["'])next\1[^>]*href\s*=\s*(["'])(.*?)\2[^>]*>([\s\S]*?)<\/a>/i.exec(html);
    if (anchorRelMatch?.[3]) {
        return resolveUrl(baseUrl, anchorRelMatch[3]);
    }
    // Try to find next page by URL pattern /page/N
    const currentPageMatch = /\/page\/(\d+)/.exec(baseUrl);
    const currentPage = currentPageMatch ? parseInt(currentPageMatch[1], 10) : 1;
    const nextPage = currentPage + 1;
    const nextPagePattern = new RegExp(`href\\s*=\\s*(["'])[^"']*\\/page\\/${nextPage}[^"']*\\1`, "i");
    const nextPageUrlMatch = nextPagePattern.exec(html);
    if (nextPageUrlMatch) {
        const fullMatch = /<a\s+[^>]*href\s*=\s*(["'])([^"']*\/page\/\d+[^"']*)\1[^>]*>/i.exec(html);
        if (fullMatch?.[2]?.includes(`/page/${nextPage}`)) {
            return resolveUrl(baseUrl, fullMatch[2]);
        }
    }
    const anchorRegex = /<a\s+[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = anchorRegex.exec(html))) {
        const href = match[2]?.trim();
        const text = normalizeWhitespace(stripTags(match[3] ?? ""));
        if (!href || !text) {
            continue;
        }
        const lowerText = text.toLowerCase();
        // Check for common "next" patterns including MoAIJobs-specific ones
        if (lowerText === "next" ||
            lowerText === "»" ||
            lowerText.includes("next page") ||
            lowerText.includes("older") ||
            lowerText.includes("view more")) {
            return resolveUrl(baseUrl, href);
        }
    }
    return null;
}
function resolveUrl(baseUrl, href) {
    return new URL(href, baseUrl).toString();
}
function stripTags(text) {
    return text.replace(/<[^>]*>/g, " ");
}
function normalizeWhitespace(text) {
    return decodeHtmlEntities(text).replace(/\s+/g, " ").trim();
}
function decodeHtmlEntities(text) {
    return text
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, "\"")
        .replace(/&#39;/g, "'")
        .replace(/&#x27;/g, "'");
}
function extractDataId(attrs) {
    const dataIdMatch = /data-(?:job-)?id\s*=\s*(["'])(.*?)\1/i.exec(attrs);
    if (dataIdMatch?.[2]) {
        return normalizeWhitespace(dataIdMatch[2]);
    }
    return null;
}
function extractIdFromUrl(url) {
    try {
        const parsed = new URL(url);
        const segments = parsed.pathname.split("/").filter(Boolean);
        const slug = segments[segments.length - 1];
        return slug ?? url;
    }
    catch {
        return url;
    }
}
