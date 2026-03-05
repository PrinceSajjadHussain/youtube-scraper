// ---------------------------------------------------------------------------
// Actor entry point – YouTube Scraper
// ---------------------------------------------------------------------------

import { Actor, log } from 'apify';
import { CheerioCrawler } from 'crawlee';

import { createRouter } from './scraper.js';
import type { InputSchema } from './types.js';
import { Labels } from './types.js';
import { buildSearchUrl, classifyYouTubeUrl } from './utils.js';

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

Actor.main(async () => {
    // ------------------------------------------------------------------
    // 1. Read & validate input
    // ------------------------------------------------------------------
    const input = (await Actor.getInput<InputSchema>()) ?? {};

    const {
        searchTerms = [],
        youtubeUrls = [],
        maxResults = 50,
        scrapeSubtitles = false,
        videoType = 'all',
        dateFilter = 'all',
    } = input;

    log.info('YouTube Scraper starting', {
        searchTermsCount: searchTerms.length,
        youtubeUrlsCount: youtubeUrls.length,
        maxResults,
        scrapeSubtitles,
        videoType,
        dateFilter,
    });

    if (searchTerms.length === 0 && youtubeUrls.length === 0) {
        throw new Error(
            'Input error: provide at least one value in "searchTerms" or "youtubeUrls".',
        );
    }

    // ------------------------------------------------------------------
    // 2. Proxy configuration (datacenter by default on Apify platform)
    // ------------------------------------------------------------------
    let proxyConfiguration;
    try {
        proxyConfiguration = await Actor.createProxyConfiguration({
            groups: ['SHADER'],
        });
        log.info('Using Apify datacenter proxy (SHADER group).');
    } catch {
        try {
            proxyConfiguration = await Actor.createProxyConfiguration();
            log.info('Using default Apify proxy configuration.');
        } catch {
            log.warning(
                'Proxy not available — running without proxy. ' +
                'YouTube may block requests without proxy rotation.',
            );
        }
    }

    // ------------------------------------------------------------------
    // 3. Build the Crawlee router
    // ------------------------------------------------------------------
    const router = createRouter({ maxResults, scrapeSubtitles });

    // ------------------------------------------------------------------
    // 4. Create the CheerioCrawler
    // ------------------------------------------------------------------
    const crawler = new CheerioCrawler({
        proxyConfiguration,
        requestHandler: router,

        // Concurrency & retries
        maxConcurrency: 5,
        maxRequestRetries: 3,
        requestHandlerTimeoutSecs: 120,

        // Accept JSON responses (used for search-continuation API calls)
        additionalMimeTypes: ['application/json'],

        // Set YouTube-friendly headers on every outgoing request
        preNavigationHooks: [
            async (_ctx: any, gotOptions: any) => {
                const headers = (gotOptions.headers ?? {}) as Record<string, string>;
                headers['Accept-Language'] = 'en-US,en;q=0.9';
                headers['Cookie'] = 'CONSENT=YES+1';
                gotOptions.headers = headers;
            },
        ],
    });

    // ------------------------------------------------------------------
    // 5. Build initial request list
    // ------------------------------------------------------------------
    const initialRequests: Array<{
        url: string;
        label: string;
        userData?: Record<string, unknown>;
        uniqueKey: string;
    }> = [];

    // Search terms → search-page URLs
    for (const term of searchTerms) {
        const url = buildSearchUrl(term, dateFilter, videoType);
        initialRequests.push({
            url,
            label: Labels.SEARCH,
            userData: { searchTerm: term },
            uniqueKey: `search-${term}`,
        });
    }

    // Direct YouTube URLs → classified requests
    for (const rawUrl of youtubeUrls) {
        try {
            const { label, normalizedUrl } = classifyYouTubeUrl(rawUrl);
            initialRequests.push({
                url: normalizedUrl,
                label,
                uniqueKey: `direct-${normalizedUrl}`,
            });
        } catch (err) {
            log.warning(`Skipping invalid URL "${rawUrl}": ${err}`);
        }
    }

    log.info(
        `Queued ${initialRequests.length} initial request(s). Starting crawl…`,
    );

    // ------------------------------------------------------------------
    // 6. Run the crawler
    // ------------------------------------------------------------------
    await crawler.run(initialRequests);

    // ------------------------------------------------------------------
    // 7. Done
    // ------------------------------------------------------------------
    const { requestsFinished, requestsFailed } = crawler.stats.state;
    log.info(
        `YouTube Scraper finished — ` +
        `${requestsFinished} succeeded, ${requestsFailed} failed.`,
    );
});
