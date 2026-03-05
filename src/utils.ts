// ---------------------------------------------------------------------------
// Utility / helper functions for the YouTube Scraper
// ---------------------------------------------------------------------------

import { Buffer } from 'node:buffer';
import type { DateFilter, VideoType } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default innertube API key placeholder.
 * The real key is extracted at runtime from every YouTube HTML page
 * (see scraper.ts SEARCH handler) or read from the INNERTUBE_API_KEY
 * environment variable.
 */
export const INNERTUBE_API_KEY: string =
    process.env.INNERTUBE_API_KEY ?? 'RUNTIME_EXTRACTED';

// ---------------------------------------------------------------------------
// JSON extraction from YouTube HTML
// ---------------------------------------------------------------------------

/**
 * Extract a JSON object assigned to a JavaScript variable in raw HTML.
 *
 * YouTube embeds large JSON payloads inside `<script>` tags like:
 *   `var ytInitialData = { ... };</script>`
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractJsonFromHtml(html: string, varName: string): any | null {
    const patterns = [
        `var ${varName} = `,
        `var ${varName}=`,
        `${varName} = `,
        `${varName}=`,
    ];

    for (const pattern of patterns) {
        const idx = html.indexOf(pattern);
        if (idx === -1) continue;

        const start = idx + pattern.length;
        const scriptEnd = html.indexOf('</script>', start);
        if (scriptEnd === -1) continue;

        let jsonStr = html.substring(start, scriptEnd).trim();
        // Strip trailing semicolons / whitespace
        while (jsonStr.endsWith(';')) {
            jsonStr = jsonStr.slice(0, -1).trimEnd();
        }

        try {
            return JSON.parse(jsonStr);
        } catch {
            continue;
        }
    }

    return null;
}

// ---------------------------------------------------------------------------
// YouTube search filter encoding (minimal protobuf builder)
// ---------------------------------------------------------------------------

/**
 * Build the `sp` query-string parameter for YouTube search filters.
 *
 * YouTube encodes search filters as a base-64-encoded protobuf message.
 */
export function buildSearchFilterParam(
    dateFilter: DateFilter,
    videoType: VideoType,
): string {
    const innerBytes: number[] = [];

    // Upload-date filter → protobuf field 1
    const dateMap: Record<string, number> = {
        hour: 1,
        day: 2,
        week: 3,
        month: 4,
        year: 5,
    };
    if (dateFilter !== 'all' && dateMap[dateFilter]) {
        innerBytes.push(0x08, dateMap[dateFilter]);
    }

    // Video-type filter
    if (videoType === 'videos') {
        innerBytes.push(0x10, 0x01); // field 2, varint 1
    } else if (videoType === 'shorts') {
        innerBytes.push(0x18, 0x01); // field 3, varint 1
    } else if (videoType === 'streams') {
        innerBytes.push(0x40, 0x01); // field 8, varint 1
    }

    if (innerBytes.length === 0) return '';

    // Wrap in outer field 2 (wire-type 2 = length-delimited)
    const outerBytes = [0x12, innerBytes.length, ...innerBytes];
    return Buffer.from(outerBytes).toString('base64');
}

/**
 * Build a full YouTube search URL with optional filters.
 */
export function buildSearchUrl(
    term: string,
    dateFilter: DateFilter,
    videoType: VideoType,
): string {
    const query = encodeURIComponent(term);
    let url = `https://www.youtube.com/results?search_query=${query}`;

    const sp = buildSearchFilterParam(dateFilter, videoType);
    if (sp) {
        url += `&sp=${encodeURIComponent(sp)}`;
    }

    return url;
}

// ---------------------------------------------------------------------------
// URL classification
// ---------------------------------------------------------------------------

/**
 * Classify a YouTube URL and return its request label + normalised URL.
 */
export function classifyYouTubeUrl(
    rawUrl: string,
): { label: string; normalizedUrl: string } {
    const urlObj = new globalThis.URL(rawUrl);

    // Video:  youtube.com/watch?v=…
    if (urlObj.pathname === '/watch' && urlObj.searchParams.has('v')) {
        return {
            label: 'VIDEO',
            normalizedUrl: `https://www.youtube.com/watch?v=${urlObj.searchParams.get('v')}`,
        };
    }

    // Shorts:  youtube.com/shorts/VIDEO_ID
    if (urlObj.pathname.startsWith('/shorts/')) {
        const videoId = urlObj.pathname.split('/shorts/')[1]?.split(/[/?#]/)[0];
        return {
            label: 'VIDEO',
            normalizedUrl: `https://www.youtube.com/watch?v=${videoId}`,
        };
    }

    // Playlist:  youtube.com/playlist?list=…
    if (urlObj.pathname === '/playlist' && urlObj.searchParams.has('list')) {
        return { label: 'PLAYLIST', normalizedUrl: rawUrl };
    }

    // Channel:  youtube.com/@handle | /channel/ID | /c/name
    if (
        urlObj.pathname.startsWith('/@') ||
        urlObj.pathname.startsWith('/channel/') ||
        urlObj.pathname.startsWith('/c/')
    ) {
        let channelPath = urlObj.pathname.replace(/\/+$/, '');
        if (!channelPath.endsWith('/videos')) {
            channelPath += '/videos';
        }
        return {
            label: 'CHANNEL',
            normalizedUrl: `https://www.youtube.com${channelPath}`,
        };
    }

    // Fallback – treat unknown YT URLs as video pages
    return { label: 'VIDEO', normalizedUrl: rawUrl };
}

// ---------------------------------------------------------------------------
// Number / text parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse human-readable count strings into numbers.
 *
 * Handles formats like:
 *   "1,234,567 views"  →  1234567
 *   "12K likes"        →  12000
 *   "3.4M subscribers" →  3400000
 */
export function parseCount(text: string | undefined | null): number | null {
    if (!text) return null;

    const cleaned = text.replace(/[,\s]/g, '').toLowerCase();

    // Abbreviated: 1.2K, 3.4M, 5.6B
    const abbrMatch = cleaned.match(/([\d.]+)\s*(k|m|b)/i);
    if (abbrMatch) {
        const num = parseFloat(abbrMatch[1]);
        const multipliers: Record<string, number> = {
            k: 1_000,
            m: 1_000_000,
            b: 1_000_000_000,
        };
        return Math.round(num * (multipliers[abbrMatch[2].toLowerCase()] ?? 1));
    }

    // Plain number
    const plainMatch = cleaned.match(/(\d+)/);
    if (plainMatch) {
        return parseInt(plainMatch[1], 10);
    }

    return null;
}

/**
 * Extract `#hashtags` from a text string.
 */
export function extractHashtags(text: string | undefined | null): string[] {
    if (!text) return [];
    return text.match(/#[\w\u0080-\uFFFF]+/g) ?? [];
}

// ---------------------------------------------------------------------------
// Duration formatting
// ---------------------------------------------------------------------------

/**
 * Convert a duration in **seconds** into a human-readable `H:MM:SS` or `M:SS`
 * string.
 */
export function formatDuration(totalSeconds: number): string | null {
    if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return null;

    const hours = Math.floor(totalSeconds / 3600);
    const mins = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;

    if (hours > 0) {
        return `${hours}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    return `${mins}:${String(secs).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Subtitle helpers
// ---------------------------------------------------------------------------

/**
 * Decode common HTML entities.
 */
export function decodeHtmlEntities(text: string): string {
    const entityMap: Record<string, string> = {
        '&amp;': '&',
        '&lt;': '<',
        '&gt;': '>',
        '&quot;': '"',
        '&#39;': "'",
        '&apos;': "'",
        '&#x27;': "'",
        '&#x2F;': '/',
        '&#10;': '\n',
        '&#13;': '\r',
    };

    let result = text;
    for (const [entity, char] of Object.entries(entityMap)) {
        result = result.replaceAll(entity, char);
    }

    // Numeric decimal entities  &#123;
    result = result.replace(/&#(\d+);/g, (_, n) =>
        String.fromCharCode(parseInt(n, 10)),
    );
    // Numeric hex entities  &#xAB;
    result = result.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
        String.fromCharCode(parseInt(hex, 16)),
    );

    return result;
}

/**
 * Parse YouTube subtitle XML into a plain-text transcript.
 *
 * The XML consists of `<text start="…" dur="…">caption line</text>` elements.
 */
export function parseSubtitleXml(xml: string): string {
    const segments = xml.match(/<text[^>]*>([\s\S]*?)<\/text>/g);
    if (!segments) return '';

    return segments
        .map((seg) => {
            const inner = seg.replace(/<[^>]+>/g, '');
            return decodeHtmlEntities(inner);
        })
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// ---------------------------------------------------------------------------
// YouTube innertube API context
// ---------------------------------------------------------------------------

/**
 * Build the `context` payload required by YouTube's innertube REST API
 * (used for search-result continuation / pagination).
 */
export function getInnertubeContext(): Record<string, unknown> {
    return {
        client: {
            hl: 'en',
            gl: 'US',
            clientName: 'WEB',
            clientVersion: '2.20250301.00.00',
            userAgent:
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        },
    };
}

/**
 * Fetch a URL and return its text body. Uses Node's built-in `globalThis.fetch`
 * (available in Node 18+) which is what the Apify Docker image provides.
 */
export async function fetchText(url: string): Promise<string | null> {
    try {
        const res = await globalThis.fetch(url);
        if (!res.ok) return null;
        return await res.text();
    } catch {
        return null;
    }
}
