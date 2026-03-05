// ---------------------------------------------------------------------------
// Core scraping logic – Crawlee router with per-label request handlers
// ---------------------------------------------------------------------------

import { Actor, log } from 'apify';
import { createCheerioRouter } from 'crawlee';

import type { BasicVideoInfo, RouterOptions, VideoData } from './types.js';
import { Labels } from './types.js';
import {
    extractJsonFromHtml,
    extractHashtags,
    fetchText,
    formatDuration,
    getInnertubeContext,
    INNERTUBE_API_KEY,
    parseCount,
    parseSubtitleXml,
} from './utils.js';

// ---------------------------------------------------------------------------
// Shared mutable counters (safe – Node.js is single-threaded between awaits)
// ---------------------------------------------------------------------------

let videosEnqueued = 0;
let videosScraped = 0;

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

/**
 * Create and return the Crawlee Cheerio router with all YouTube request
 * handlers wired up.
 */
export function createRouter(options: RouterOptions) {
    const { maxResults, scrapeSubtitles } = options;

    // Reset counters (allows re-use in tests)
    videosEnqueued = 0;
    videosScraped = 0;

    const router = createCheerioRouter();

    // =======================================================================
    // SEARCH – YouTube search results page (HTML)
    // =======================================================================
    router.addHandler(Labels.SEARCH, async (ctx) => {
        const { body, request, crawler } = ctx;
        const html = body.toString();
        const searchTerm = (request.userData?.searchTerm as string) ?? '';

        log.info(`Parsing search results for "${searchTerm}"`);

        const ytInitialData = extractJsonFromHtml(html, 'ytInitialData');
        if (!ytInitialData) {
            log.warning('Could not extract ytInitialData from search page.');
            return;
        }

        // Grab the innertube API key from the page
        const apiKeyMatch = html.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/);
        const apiKey = apiKeyMatch?.[1] ?? INNERTUBE_API_KEY;

        const videos = extractSearchResults(ytInitialData);
        log.info(`Found ${videos.length} videos on search page for "${searchTerm}"`);

        // Enqueue individual video pages
        const videoRequests: Array<Record<string, any>> = [];
        for (const video of videos) {
            if (videosEnqueued >= maxResults) break;
            videoRequests.push({
                url: `https://www.youtube.com/watch?v=${video.videoId}`,
                label: Labels.VIDEO,
                userData: { basicInfo: video },
                uniqueKey: `video-${video.videoId}`,
            });
            videosEnqueued++;
        }
        if (videoRequests.length > 0) {
            await crawler.addRequests(videoRequests);
        }

        // Pagination via continuation token
        if (videosEnqueued < maxResults) {
            const continuationToken = extractContinuationToken(ytInitialData);
            if (continuationToken) {
                log.info('Fetching next page of search results…');
                await crawler.addRequests([{
                    url: `https://www.youtube.com/youtubei/v1/search?key=${apiKey}`,
                    label: Labels.SEARCH_CONTINUATION,
                    method: 'POST' as const,
                    headers: {
                        'Content-Type': 'application/json',
                        Origin: 'https://www.youtube.com',
                        Referer: 'https://www.youtube.com/',
                    },
                    payload: JSON.stringify({
                        context: getInnertubeContext(),
                        continuation: continuationToken,
                    }),
                    userData: { searchTerm, apiKey },
                    uniqueKey: `search-cont-${continuationToken.slice(0, 40)}`,
                }]);
            }
        }
    });

    // =======================================================================
    // SEARCH_CONTINUATION – paginated search results (JSON from innertube)
    // =======================================================================
    router.addHandler(Labels.SEARCH_CONTINUATION, async (ctx) => {
        const { body, request, crawler } = ctx;
        const searchTerm = (request.userData?.searchTerm as string) ?? '';
        const apiKey = (request.userData?.apiKey as string) ?? INNERTUBE_API_KEY;

        let data: any;
        try {
            data = JSON.parse(body.toString());
        } catch {
            log.warning('Could not parse continuation response as JSON.');
            return;
        }

        log.info(`Parsing continuation results for "${searchTerm}"`);

        const videos = extractContinuationResults(data);
        log.info(`Found ${videos.length} additional videos from continuation`);

        const videoRequests: Array<Record<string, any>> = [];
        for (const video of videos) {
            if (videosEnqueued >= maxResults) break;
            videoRequests.push({
                url: `https://www.youtube.com/watch?v=${video.videoId}`,
                label: Labels.VIDEO,
                userData: { basicInfo: video },
                uniqueKey: `video-${video.videoId}`,
            });
            videosEnqueued++;
        }
        if (videoRequests.length > 0) {
            await crawler.addRequests(videoRequests);
        }

        // Continue pagination if needed
        if (videosEnqueued < maxResults) {
            const nextToken = extractContinuationFromApiResponse(data);
            if (nextToken) {
                log.info('Fetching next continuation page…');
                await crawler.addRequests([{
                    url: `https://www.youtube.com/youtubei/v1/search?key=${apiKey}`,
                    label: Labels.SEARCH_CONTINUATION,
                    method: 'POST' as const,
                    headers: {
                        'Content-Type': 'application/json',
                        Origin: 'https://www.youtube.com',
                        Referer: 'https://www.youtube.com/',
                    },
                    payload: JSON.stringify({
                        context: getInnertubeContext(),
                        continuation: nextToken,
                    }),
                    userData: { searchTerm, apiKey },
                    uniqueKey: `search-cont-${nextToken.slice(0, 40)}`,
                }]);
            }
        }
    });

    // =======================================================================
    // VIDEO – individual video page (HTML)
    // =======================================================================
    router.addHandler(Labels.VIDEO, async (ctx) => {
        const { body, request } = ctx;

        if (videosScraped >= maxResults) {
            log.info('maxResults reached – skipping remaining video requests.');
            return;
        }

        const html = body.toString();
        const basicInfo = request.userData?.basicInfo as BasicVideoInfo | undefined;
        const videoId =
            request.url.match(/[?&]v=([^&#]+)/)?.[1] ??
            basicInfo?.videoId ??
            '';

        log.info(`Scraping video ${videoId}`);

        // Detect unavailable videos early
        if (
            html.includes('"playabilityStatus":{"status":"ERROR"') ||
            html.includes('"playabilityStatus":{"status":"UNPLAYABLE"')
        ) {
            log.warning(`Video ${videoId} is unavailable – skipping.`);
            return;
        }

        const ytInitialData = extractJsonFromHtml(html, 'ytInitialData');
        const ytPlayerResponse = extractJsonFromHtml(html, 'ytInitialPlayerResponse');

        if (!ytPlayerResponse && !ytInitialData) {
            log.warning(`No embedded data found for video ${videoId}`);
            return;
        }

        // --- Extract from ytInitialPlayerResponse ---------------------------
        const videoDetails = ytPlayerResponse?.videoDetails ?? {};
        const microformat =
            ytPlayerResponse?.microformat?.playerMicroformatRenderer ?? {};

        // --- Extract from ytInitialData -------------------------------------
        const likeCount = extractLikeCount(ytInitialData);
        const commentsCount = extractCommentsCount(ytInitialData);
        const subscriberCount = extractSubscriberCount(ytInitialData);

        // --- Description & hashtags -----------------------------------------
        const description: string | null =
            videoDetails.shortDescription ??
            microformat.description?.simpleText ??
            null;

        // --- Subtitles (optional) -------------------------------------------
        let subtitles: string | null = null;
        if (scrapeSubtitles && ytPlayerResponse) {
            subtitles = await scrapeSubtitlesForVideo(ytPlayerResponse);
        }

        // --- Thumbnail ------------------------------------------------------
        const thumbnails: Array<{ url: string }> =
            videoDetails.thumbnail?.thumbnails ?? [];
        const thumbnailUrl =
            thumbnails[thumbnails.length - 1]?.url ??
            basicInfo?.thumbnailUrl ??
            '';

        // --- Build final record ---------------------------------------------
        const videoData: VideoData = {
            title: videoDetails.title ?? basicInfo?.title ?? '',
            videoId: videoDetails.videoId ?? videoId,
            url: `https://www.youtube.com/watch?v=${videoDetails.videoId ?? videoId}`,
            thumbnailUrl,
            viewCount:
                parseCount(videoDetails.viewCount) ??
                basicInfo?.viewCount ??
                null,
            likeCount,
            commentsCount,
            duration:
                formatDuration(parseInt(videoDetails.lengthSeconds, 10)) ??
                basicInfo?.duration ??
                null,
            uploadDate:
                microformat.uploadDate ??
                microformat.publishDate ??
                basicInfo?.uploadDate ??
                null,
            channelName: videoDetails.author ?? basicInfo?.channelName ?? '',
            channelUrl: videoDetails.channelId
                ? `https://www.youtube.com/channel/${videoDetails.channelId}`
                : basicInfo?.channelUrl ?? '',
            subscriberCount,
            description,
            hashtags: extractHashtags(description),
            subtitles,
            scrapedAt: new Date().toISOString(),
        };

        await Actor.pushData(videoData);
        videosScraped++;
        log.info(
            `✓ [${videosScraped}/${maxResults}] "${videoData.title}" — ` +
            `${videoData.viewCount?.toLocaleString() ?? '?'} views`,
        );
    });

    // =======================================================================
    // CHANNEL – channel /videos page (HTML)
    // =======================================================================
    router.addHandler(Labels.CHANNEL, async (ctx) => {
        const { body, request, crawler } = ctx;
        const html = body.toString();
        log.info(`Parsing channel page: ${request.url}`);

        const ytInitialData = extractJsonFromHtml(html, 'ytInitialData');
        if (!ytInitialData) {
            log.warning('Could not extract ytInitialData from channel page.');
            return;
        }

        const videos = extractChannelVideos(ytInitialData);
        log.info(`Found ${videos.length} videos on channel page`);

        const videoRequests: Array<Record<string, any>> = [];
        for (const video of videos) {
            if (videosEnqueued >= maxResults) break;
            videoRequests.push({
                url: `https://www.youtube.com/watch?v=${video.videoId}`,
                label: Labels.VIDEO,
                userData: { basicInfo: video },
                uniqueKey: `video-${video.videoId}`,
            });
            videosEnqueued++;
        }
        if (videoRequests.length > 0) {
            await crawler.addRequests(videoRequests);
        }
    });

    // =======================================================================
    // PLAYLIST – playlist page (HTML)
    // =======================================================================
    router.addHandler(Labels.PLAYLIST, async (ctx) => {
        const { body, request, crawler } = ctx;
        const html = body.toString();
        log.info(`Parsing playlist page: ${request.url}`);

        const ytInitialData = extractJsonFromHtml(html, 'ytInitialData');
        if (!ytInitialData) {
            log.warning('Could not extract ytInitialData from playlist page.');
            return;
        }

        const videos = extractPlaylistVideos(ytInitialData);
        log.info(`Found ${videos.length} videos in playlist`);

        const videoRequests: Array<Record<string, any>> = [];
        for (const video of videos) {
            if (videosEnqueued >= maxResults) break;
            videoRequests.push({
                url: `https://www.youtube.com/watch?v=${video.videoId}`,
                label: Labels.VIDEO,
                userData: { basicInfo: video },
                uniqueKey: `video-${video.videoId}`,
            });
            videosEnqueued++;
        }
        if (videoRequests.length > 0) {
            await crawler.addRequests(videoRequests);
        }
    });

    // =======================================================================
    // Default handler – catch-all for unmatched labels
    // =======================================================================
    router.addDefaultHandler(async (ctx) => {
        log.warning(`Unhandled request label "${ctx.request.label}" for ${ctx.request.url}`);
    });

    return router;
}

// ===========================================================================
//  PRIVATE HELPER FUNCTIONS
// ===========================================================================

// ---------------------------------------------------------------------------
// Search-result extraction
// ---------------------------------------------------------------------------

function extractSearchResults(ytInitialData: any): BasicVideoInfo[] {
    const results: BasicVideoInfo[] = [];

    try {
        const sections: any[] =
            ytInitialData
                ?.contents
                ?.twoColumnSearchResultsRenderer
                ?.primaryContents
                ?.sectionListRenderer
                ?.contents ?? [];

        for (const section of sections) {
            const items: any[] = section?.itemSectionRenderer?.contents ?? [];

            for (const item of items) {
                const vr = item.videoRenderer;
                if (!vr?.videoId) continue;

                const thumbs: any[] = vr.thumbnail?.thumbnails ?? [];
                const ownerRuns: any[] = vr.ownerText?.runs ?? [];

                results.push({
                    videoId: vr.videoId,
                    title: vr.title?.runs?.[0]?.text ?? '',
                    channelName: ownerRuns[0]?.text ?? '',
                    channelUrl: ownerRuns[0]?.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl
                        ? `https://www.youtube.com${ownerRuns[0].navigationEndpoint.browseEndpoint.canonicalBaseUrl}`
                        : '',
                    viewCount: parseCount(
                        vr.viewCountText?.simpleText ??
                        vr.viewCountText?.runs?.[0]?.text,
                    ),
                    duration: vr.lengthText?.simpleText ?? null,
                    thumbnailUrl: thumbs[thumbs.length - 1]?.url ?? '',
                    uploadDate: vr.publishedTimeText?.simpleText ?? null,
                });
            }
        }
    } catch (err) {
        log.warning(`Error parsing search results: ${err}`);
    }

    return results;
}

// ---------------------------------------------------------------------------
// Continuation-response parsing
// ---------------------------------------------------------------------------

function extractContinuationResults(data: any): BasicVideoInfo[] {
    const results: BasicVideoInfo[] = [];

    try {
        const commands: any[] = data?.onResponseReceivedCommands ?? [];

        for (const cmd of commands) {
            const items: any[] =
                cmd?.appendContinuationItemsAction?.continuationItems ?? [];

            for (const item of items) {
                const sectionContents: any[] =
                    item?.itemSectionRenderer?.contents ?? [];

                for (const content of sectionContents) {
                    const vr = content.videoRenderer;
                    if (!vr?.videoId) continue;

                    const thumbs: any[] = vr.thumbnail?.thumbnails ?? [];
                    const ownerRuns: any[] = vr.ownerText?.runs ?? [];

                    results.push({
                        videoId: vr.videoId,
                        title: vr.title?.runs?.[0]?.text ?? '',
                        channelName: ownerRuns[0]?.text ?? '',
                        channelUrl: ownerRuns[0]?.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl
                            ? `https://www.youtube.com${ownerRuns[0].navigationEndpoint.browseEndpoint.canonicalBaseUrl}`
                            : '',
                        viewCount: parseCount(
                            vr.viewCountText?.simpleText ??
                            vr.viewCountText?.runs?.[0]?.text,
                        ),
                        duration: vr.lengthText?.simpleText ?? null,
                        thumbnailUrl: thumbs[thumbs.length - 1]?.url ?? '',
                        uploadDate: vr.publishedTimeText?.simpleText ?? null,
                    });
                }
            }
        }
    } catch (err) {
        log.warning(`Error parsing continuation results: ${err}`);
    }

    return results;
}

// ---------------------------------------------------------------------------
// Continuation-token extraction
// ---------------------------------------------------------------------------

/** Extract the continuation token from an initial search-page ytInitialData. */
function extractContinuationToken(ytInitialData: any): string | null {
    try {
        const sections: any[] =
            ytInitialData
                ?.contents
                ?.twoColumnSearchResultsRenderer
                ?.primaryContents
                ?.sectionListRenderer
                ?.contents ?? [];

        for (const section of sections) {
            const token =
                section?.continuationItemRenderer
                    ?.continuationEndpoint
                    ?.continuationCommand
                    ?.token;
            if (token) return token;
        }
    } catch { /* swallow */ }

    return null;
}

/** Extract continuation token from an innertube API JSON response. */
function extractContinuationFromApiResponse(data: any): string | null {
    try {
        const commands: any[] = data?.onResponseReceivedCommands ?? [];
        for (const cmd of commands) {
            const items: any[] =
                cmd?.appendContinuationItemsAction?.continuationItems ?? [];
            for (const item of items) {
                const token =
                    item?.continuationItemRenderer
                        ?.continuationEndpoint
                        ?.continuationCommand
                        ?.token;
                if (token) return token;
            }
        }
    } catch { /* swallow */ }

    return null;
}

// ---------------------------------------------------------------------------
// Video-page data extraction helpers
// ---------------------------------------------------------------------------

/** Try multiple known JSON paths to locate the like count. */
function extractLikeCount(ytInitialData: any): number | null {
    try {
        const contents: any[] =
            ytInitialData
                ?.contents
                ?.twoColumnWatchNextResults
                ?.results
                ?.results
                ?.contents ?? [];

        for (const content of contents) {
            const renderer = content.videoPrimaryInfoRenderer;
            if (!renderer) continue;

            const topButtons: any[] =
                renderer?.videoActions?.menuRenderer?.topLevelButtons ?? [];

            for (const btn of topButtons) {
                // Path A – segmentedLikeDislikeButtonViewModel (2024+ layout)
                const vmTitle =
                    btn?.segmentedLikeDislikeButtonViewModel
                        ?.likeButtonViewModel?.likeButtonViewModel
                        ?.toggleButtonViewModel?.toggleButtonViewModel
                        ?.defaultButtonViewModel?.buttonViewModel?.title;
                if (vmTitle) return parseCount(vmTitle);

                // Path B – segmentedLikeDislikeButtonRenderer (older layout)
                const toggleRenderer =
                    btn?.segmentedLikeDislikeButtonRenderer
                        ?.likeButton?.toggleButtonRenderer;
                if (toggleRenderer) {
                    const label =
                        toggleRenderer?.defaultText?.accessibility
                            ?.accessibilityData?.label;
                    if (label) return parseCount(label);

                    const simple = toggleRenderer?.defaultText?.simpleText;
                    if (simple) return parseCount(simple);
                }

                // Path C – top-level buttonViewModel
                const bvmTitle = btn?.buttonViewModel?.title;
                if (bvmTitle) {
                    const n = parseCount(bvmTitle);
                    if (n !== null) return n;
                }
            }
        }
    } catch { /* swallow */ }

    return null;
}

/** Try to extract the comments count from the video page data. */
function extractCommentsCount(ytInitialData: any): number | null {
    try {
        const contents: any[] =
            ytInitialData
                ?.contents
                ?.twoColumnWatchNextResults
                ?.results
                ?.results
                ?.contents ?? [];

        for (const content of contents) {
            const items: any[] =
                content?.itemSectionRenderer?.contents ?? [];
            for (const item of items) {
                // commentsEntryPointHeaderRenderer
                const hdr = item?.commentsEntryPointHeaderRenderer;
                if (hdr?.commentCount?.simpleText) {
                    return parseCount(hdr.commentCount.simpleText);
                }
                const entry =
                    hdr?.headerEntry?.commentsEntryPointHeaderEntryRenderer;
                if (entry?.commentCount?.simpleText) {
                    return parseCount(entry.commentCount.simpleText);
                }
            }
        }

        // Fallback – engagement panels
        const panels: any[] = ytInitialData?.engagementPanels ?? [];
        for (const panel of panels) {
            const hdr =
                panel?.engagementPanelSectionListRenderer
                    ?.header?.engagementPanelTitleHeaderRenderer;
            const text = hdr?.contextualInfo?.runs?.[0]?.text;
            if (text && /comment/i.test(text)) {
                return parseCount(text);
            }
        }
    } catch { /* swallow */ }

    return null;
}

/** Extract the channel subscriber count shown on the watch page. */
function extractSubscriberCount(ytInitialData: any): string | null {
    try {
        const contents: any[] =
            ytInitialData
                ?.contents
                ?.twoColumnWatchNextResults
                ?.results
                ?.results
                ?.contents ?? [];

        for (const content of contents) {
            const owner =
                content?.videoSecondaryInfoRenderer?.owner?.videoOwnerRenderer;
            if (owner?.subscriberCountText?.simpleText) {
                return owner.subscriberCountText.simpleText;
            }
            if (owner?.subscriberCountText?.accessibility?.accessibilityData?.label) {
                return owner.subscriberCountText.accessibility.accessibilityData.label;
            }
        }
    } catch { /* swallow */ }

    return null;
}

// ---------------------------------------------------------------------------
// Channel videos extraction
// ---------------------------------------------------------------------------

function extractChannelVideos(ytInitialData: any): BasicVideoInfo[] {
    const results: BasicVideoInfo[] = [];

    try {
        const tabs: any[] =
            ytInitialData?.contents?.twoColumnBrowseResultsRenderer?.tabs ?? [];

        for (const tab of tabs) {
            const tabRenderer = tab?.tabRenderer;
            if (!tabRenderer?.selected) continue;

            const gridContents: any[] =
                tabRenderer?.content?.richGridRenderer?.contents ??
                tabRenderer?.content?.sectionListRenderer?.contents ??
                [];

            for (const item of gridContents) {
                // Rich grid items (modern layout)
                const vr = item?.richItemRenderer?.content?.videoRenderer;
                if (vr?.videoId) {
                    results.push(videoRendererToBasicInfo(vr));
                    continue;
                }

                // Grid video renderer (legacy layout)
                const gvr = item?.gridVideoRenderer;
                if (gvr?.videoId) {
                    const thumbs: any[] = gvr.thumbnail?.thumbnails ?? [];
                    results.push({
                        videoId: gvr.videoId,
                        title:
                            gvr.title?.runs?.[0]?.text ??
                            gvr.title?.simpleText ??
                            '',
                        channelName: '',
                        channelUrl: '',
                        viewCount: parseCount(
                            gvr.viewCountText?.simpleText ??
                            gvr.viewCountText?.runs?.[0]?.text,
                        ),
                        duration:
                            gvr.thumbnailOverlays?.[0]
                                ?.thumbnailOverlayTimeStatusRenderer?.text
                                ?.simpleText ?? null,
                        thumbnailUrl: thumbs[thumbs.length - 1]?.url ?? '',
                        uploadDate: gvr.publishedTimeText?.simpleText ?? null,
                    });
                }
            }
        }
    } catch (err) {
        log.warning(`Error parsing channel videos: ${err}`);
    }

    return results;
}

// ---------------------------------------------------------------------------
// Playlist videos extraction
// ---------------------------------------------------------------------------

function extractPlaylistVideos(ytInitialData: any): BasicVideoInfo[] {
    const results: BasicVideoInfo[] = [];

    try {
        const items: any[] =
            ytInitialData
                ?.contents
                ?.twoColumnBrowseResultsRenderer
                ?.tabs?.[0]
                ?.tabRenderer
                ?.content
                ?.sectionListRenderer
                ?.contents?.[0]
                ?.itemSectionRenderer
                ?.contents?.[0]
                ?.playlistVideoListRenderer
                ?.contents ?? [];

        for (const item of items) {
            const pvr = item?.playlistVideoRenderer;
            if (!pvr?.videoId) continue;

            const thumbs: any[] = pvr.thumbnail?.thumbnails ?? [];
            const byline: any[] = pvr.shortBylineText?.runs ?? [];

            results.push({
                videoId: pvr.videoId,
                title: pvr.title?.runs?.[0]?.text ?? '',
                channelName: byline[0]?.text ?? '',
                channelUrl: byline[0]?.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl
                    ? `https://www.youtube.com${byline[0].navigationEndpoint.browseEndpoint.canonicalBaseUrl}`
                    : '',
                viewCount: null,
                duration: pvr.lengthText?.simpleText ?? null,
                thumbnailUrl: thumbs[thumbs.length - 1]?.url ?? '',
                uploadDate: null,
            });
        }
    } catch (err) {
        log.warning(`Error parsing playlist videos: ${err}`);
    }

    return results;
}

// ---------------------------------------------------------------------------
// Subtitles
// ---------------------------------------------------------------------------

/**
 * Fetch and parse subtitles for a video. Prefers English captions, falls back
 * to the first available track.
 */
async function scrapeSubtitlesForVideo(ytPlayerResponse: any): Promise<string | null> {
    try {
        const tracks: any[] | undefined =
            ytPlayerResponse
                ?.captions
                ?.playerCaptionsTracklistRenderer
                ?.captionTracks;

        if (!Array.isArray(tracks) || tracks.length === 0) {
            log.info('No subtitle tracks available for this video.');
            return null;
        }

        // Prefer English, fall back to first available
        const englishTrack = tracks.find(
            (t: any) => t.languageCode === 'en' || t.languageCode?.startsWith('en'),
        );
        const track = englishTrack ?? tracks[0];

        if (!track?.baseUrl) return null;

        log.info(`Fetching subtitles (lang: ${track.languageCode ?? 'unknown'})`);

        const xml = await fetchText(track.baseUrl);
        if (!xml) {
            log.warning('Subtitle fetch failed.');
            return null;
        }

        return parseSubtitleXml(xml);
    } catch (err) {
        log.warning(`Error fetching subtitles: ${err}`);
        return null;
    }
}

// ---------------------------------------------------------------------------
// Shared micro-helpers
// ---------------------------------------------------------------------------

/** Convert a generic videoRenderer JSON node into BasicVideoInfo. */
function videoRendererToBasicInfo(vr: any): BasicVideoInfo {
    const thumbs: any[] = vr.thumbnail?.thumbnails ?? [];
    const ownerRuns: any[] = vr.ownerText?.runs ?? [];

    return {
        videoId: vr.videoId,
        title: vr.title?.runs?.[0]?.text ?? vr.title?.simpleText ?? '',
        channelName: ownerRuns[0]?.text ?? '',
        channelUrl: ownerRuns[0]?.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl
            ? `https://www.youtube.com${ownerRuns[0].navigationEndpoint.browseEndpoint.canonicalBaseUrl}`
            : '',
        viewCount: parseCount(
            vr.viewCountText?.simpleText ?? vr.viewCountText?.runs?.[0]?.text,
        ),
        duration: vr.lengthText?.simpleText ?? null,
        thumbnailUrl: thumbs[thumbs.length - 1]?.url ?? '',
        uploadDate: vr.publishedTimeText?.simpleText ?? null,
    };
}
