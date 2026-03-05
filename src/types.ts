// ---------------------------------------------------------------------------
// TypeScript interfaces & enums for the YouTube Scraper Apify Actor
// ---------------------------------------------------------------------------

/** Accepted video-type filter values. */
export type VideoType = 'videos' | 'shorts' | 'streams' | 'all';

/** Accepted upload-date filter values. */
export type DateFilter = 'hour' | 'day' | 'week' | 'month' | 'year' | 'all';

// ---------------------------------------------------------------------------
// Actor input
// ---------------------------------------------------------------------------

/** Shape of the Actor input (mirrors INPUT_SCHEMA.json). */
export interface InputSchema {
    searchTerms?: string[];
    youtubeUrls?: string[];
    maxResults?: number;
    scrapeSubtitles?: boolean;
    videoType?: VideoType;
    dateFilter?: DateFilter;
}

// ---------------------------------------------------------------------------
// Data models
// ---------------------------------------------------------------------------

/** Full video record pushed to the Apify Dataset. */
export interface VideoData {
    title: string;
    videoId: string;
    url: string;
    thumbnailUrl: string;
    viewCount: number | null;
    likeCount: number | null;
    commentsCount: number | null;
    duration: string | null;
    uploadDate: string | null;
    channelName: string;
    channelUrl: string;
    subscriberCount: string | null;
    description: string | null;
    hashtags: string[];
    subtitles: string | null;
    scrapedAt: string;
}

/** Lightweight video info extracted from search / channel / playlist pages. */
export interface BasicVideoInfo {
    videoId: string;
    title: string;
    channelName: string;
    channelUrl: string;
    viewCount: number | null;
    duration: string | null;
    thumbnailUrl: string;
    uploadDate: string | null;
}

// ---------------------------------------------------------------------------
// Router helpers
// ---------------------------------------------------------------------------

/** Options forwarded to the Crawlee router factory. */
export interface RouterOptions {
    maxResults: number;
    scrapeSubtitles: boolean;
}

/** Labels used by the Crawlee request router. */
export const Labels = {
    SEARCH: 'SEARCH',
    SEARCH_CONTINUATION: 'SEARCH_CONTINUATION',
    VIDEO: 'VIDEO',
    CHANNEL: 'CHANNEL',
    PLAYLIST: 'PLAYLIST',
} as const;

export type LabelValue = (typeof Labels)[keyof typeof Labels];
