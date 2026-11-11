# Creative Performance Dashboard

A dashboard that pulls every Meta and TikTok ad that ran in a date range (the current year by default) from the [Two Minute Reports API](https://twominutereports.com/help/api). It shows each creative's preview next to its performance, and can have Claude review the creatives and write a creative strategy report.

## What it does

- **Creative gallery and table.** Thumbnail or cover frame, ad copy, platform and format for each ad, with spend, impressions, CPM, CTR, CPC, conversions, CPA, ROAS, and for video, hook and hold rate.
- **Click any creative** to see the full copy, a larger preview (TikTok videos play inline), and links to the Meta ad preview, the video and the landing page.
- **Groups duplicate creatives.** The same creative running in several ad sets is combined into one card, with metrics summed and ratios recalculated. You can turn this off.
- **Filters, search and sorting** by platform, format, account, spend, ROAS, CPA, CTR, hook rate and more. Metrics are shown green or red when they are at least 25% better or worse than the median of the creatives on screen.
- **Claude creative analysis.** Sends the selected creatives (image, copy and metrics) to Claude. You get back a report with a summary, what's winning, what's underperforming, format/hook/copy insights, prioritised recommendations, and five concrete creative briefs. The report streams in and can be downloaded as Markdown.

## Setup

Requires Node 20+.

```bash
npm install
```

```bash
cp .env.example .env
```

Fill in `.env`:

| Variable | Required | What it is |
|---|---|---|
| `TMR_API_KEY` | yes (for live data) | Create one at hub.twominutereports.com > Settings > API keys, with intended use **API**. It needs `data:read` and `connectors:read`, and your role must allow "Query data over MCP and the API". |
| `TMR_TEAM_ID` | yes (for live data) | Your team's UUID. |
| `TMR_CONNECTORS` | no | Defaults to `fads,ttads` (Meta Ads, TikTok Ads). |
| `TMR_CURRENCY` | no | For example `SGD`. Converts all money to one currency so totals across accounts in different currencies add up. |
| `ANTHROPIC_API_KEY` | for analysis | From platform.claude.com. Without it the dashboard works and the analysis button is disabled. |
| `ANALYSIS_MODEL` / `ANALYSIS_EFFORT` | no | Default `claude-opus-5-5` at `high` effort. |
| `DASHBOARD_PASSWORD` | no | Adds a password prompt (any username) if you host the dashboard. |

```bash
npm start
```

Open http://localhost:3000, pick accounts, and press **Load ads**.

### Try it without keys

```bash
npm run demo
```

This runs with synthetic demo data. It is also used automatically when `TMR_API_KEY` is empty.

## How it works

```
browser (public/)  ──>  Express server (server/)  ──>  Two Minute Reports API
                                                  └─>  Claude API (analysis)
```

- `server/tmr.js`: the TMR REST client. The run-query endpoint allows **15 requests a minute and 500 an hour**, so queries are queued and spaced about 4 seconds apart. 429 and 503 errors are retried with backoff. If a query times out (504), the date range is split in half and retried, and the halves are merged.
- `server/platforms.js`: the fields requested per platform, and how rows are turned into one ad shape. Only additive metrics are fetched; CTR, CPM, CPA, ROAS, hook rate and hold rate are calculated afterwards, so they stay correct when ads or date ranges are combined.
- `server/cache.js`: fetched data is cached on disk in `data/cache` for 12 hours (`CACHE_TTL_HOURS`). Tick **Bypass cache** to force a fresh pull.
- `server/analysis.js`: builds the Claude request (account benchmarks, then each creative's image, copy and metrics) and streams the report back. Images are downloaded by the server and sent inline. Only ads the server itself loaded can be analysed, so the browser can't make the server fetch arbitrary URLs.

One query is made per account, so loading 30 accounts takes about 2 minutes the first time. After that it comes from the cache.

### Field mapping

| | Meta (`fads`) | TikTok (`ttads`) |
|---|---|---|
| Preview | `ad_creative_image_url`, falling back to `ad_creative_thumbnail_url`; `ad_preview_shareable_link` | `video_cover_url`, `video_preview_url` (mp4) |
| Copy | `ad_creative_title`, `ad_creative_body`, `ad_creative_call_to_action_type` | `ad_text` |
| Conversions / value | `conversions`, `conversion_values` | `conversion`, `total_purchase_value` |
| Hook rate | `video_views` (3s) / impressions | `video_watched_2s` / impressions |
| Hold rate | `video_thruplay_watched_actions` / 3s views | `video_watched_6s` / 2s views |

"Conversions" uses each ad account's own conversion setup in TMR. If you care about a specific event (purchases, leads), change the metrics in `server/platforms.js`.

## Things to know

- **Preview links expire.** Meta and TikTok CDN image URLs are signed and expire after a few days. If thumbnails break, reload with **Bypass cache**.
- **Videos are judged from the cover frame.** Claude sees the thumbnail, copy and retention metrics for video ads, not the video itself. The report says when a conclusion rests on the thumbnail only.
- **Cost of an analysis.** One analysis of 30 creatives with images is up to roughly 60k input tokens, depending on image sizes. The default is the top 30 by spend under the current filters, and you can choose a smaller set in the panel.
- **Mixed currencies.** Without `TMR_CURRENCY`, accounts in different currencies are summed as-is in the KPI row.

## Tests

```bash
npm test
```
