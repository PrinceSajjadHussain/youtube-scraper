# YouTube Scraper — Apify Actor

A high‑performance Apify Actor built with **Apify SDK v3**, **Crawlee**, and
**TypeScript** that scrapes YouTube search results, video pages, channels, and
playlists.

---

## Features

| Capability | Details |
|---|---|
| **Search scraping** | Enter keywords → get structured video data |
| **Direct URL scraping** | Pass video, channel, or playlist URLs |
| **Pagination** | Automatically follows YouTube continuation tokens |
| **Search filters** | Filter by upload date and video type (videos / shorts / streams) |
| **Subtitle extraction** | Optionally download and parse video captions |
| **Anti‑blocking** | Uses Apify datacenter proxy with session rotation |
| **Typed output** | Every record matches the `VideoData` TypeScript interface |

---

## Input

The Actor accepts JSON input conforming to [`INPUT_SCHEMA.json`](INPUT_SCHEMA.json).

| Field | Type | Default | Description |
|---|---|---|---|
| `searchTerms` | `string[]` | `[]` | YouTube search keywords |
| `youtubeUrls` | `string[]` | `[]` | Direct video / channel / playlist URLs |
| `maxResults` | `number` | `50` | Maximum videos to scrape |
| `scrapeSubtitles` | `boolean` | `false` | Extract subtitles / captions |
| `videoType` | `enum` | `"all"` | `"videos"` · `"shorts"` · `"streams"` · `"all"` |
| `dateFilter` | `enum` | `"all"` | `"hour"` · `"day"` · `"week"` · `"month"` · `"year"` · `"all"` |

### Example input

```json
{
    "searchTerms": ["web scraping tutorial", "node.js"],
    "youtubeUrls": [
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "https://www.youtube.com/@Google/videos"
    ],
    "maxResults": 100,
    "scrapeSubtitles": true,
    "videoType": "videos",
    "dateFilter": "month"
}
```

---

## Output

Each video is pushed to the default **Apify Dataset** as a JSON record:

```json
{
    "title": "Learn Web Scraping in 20 Minutes",
    "videoId": "abc123xyz",
    "url": "https://www.youtube.com/watch?v=abc123xyz",
    "thumbnailUrl": "https://i.ytimg.com/vi/abc123xyz/maxresdefault.jpg",
    "viewCount": 152340,
    "likeCount": 4200,
    "commentsCount": 312,
    "duration": "20:15",
    "uploadDate": "2025-12-01",
    "channelName": "Code Academy",
    "channelUrl": "https://www.youtube.com/channel/UC1234567890",
    "subscriberCount": "1.2M subscribers",
    "description": "In this tutorial we cover ...",
    "hashtags": ["#webscraping", "#nodejs"],
    "subtitles": "Hi everyone, welcome to this tutorial ...",
    "scrapedAt": "2026-03-06T12:00:00.000Z"
}
```

---

## Tech Stack

- **[Apify SDK v3](https://docs.apify.com/sdk/js/)** — Actor lifecycle, dataset, proxy
- **[Crawlee](https://crawlee.dev/)** — `CheerioCrawler` with labeled routing
- **TypeScript 5** — strict mode, ESM
- **Node.js 20**

---

## Project Structure

```
├── .actor/
│   └── actor.json          # Actor metadata
├── src/
│   ├── main.ts             # Entry point — input parsing, crawler setup
│   ├── scraper.ts           # Crawlee router & request handlers
│   ├── types.ts             # TypeScript interfaces & enums
│   └── utils.ts             # JSON extraction, URL helpers, parsers
├── Dockerfile               # Docker image definition
├── INPUT_SCHEMA.json        # Apify input schema
├── package.json             # Dependencies & scripts
├── tsconfig.json            # TypeScript config
└── README.md                # This file
```

---

## Local Development

```bash
# Install dependencies
npm install

# Create an input file
mkdir -p storage/key_value_stores/default
echo '{ "searchTerms": ["apify tutorial"], "maxResults": 5 }' \
  > storage/key_value_stores/default/INPUT.json

# Run in development mode (tsx — no build step)
npm run dev

# Or build & run
npm start
```

> **Note:** Proxy is only available when running on the Apify platform. Local
> runs execute without proxy and may be rate‑limited by YouTube.

---

## Deploying to Apify

```bash
# Install the Apify CLI
npm install -g apify-cli

# Log in
apify login

# Push the Actor to Apify
apify push
```

---

## How It Works

1. **Search URLs** are built from `searchTerms` with optional `sp` protobuf
   filters for date and video type.
2. **CheerioCrawler** fetches each page and the embedded `ytInitialData` /
   `ytInitialPlayerResponse` JSON blobs are extracted from `<script>` tags —
   no browser needed.
3. Search results are parsed and individual **video page requests** are
   enqueued (up to `maxResults`).
4. **Pagination** uses YouTube's innertube continuation API via POST requests
   with the continuation token.
5. Each video page handler extracts detailed metadata (likes, comments,
   subscribers, subtitles) and pushes a `VideoData` record to the Apify
   Dataset.

---

## License

ISC
