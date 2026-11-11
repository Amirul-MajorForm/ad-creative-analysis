// Per-platform field definitions for Two Minute Reports, plus normalisation
// into one ad shape the dashboard understands.
//
// Field IDs were checked against the TMR query schema for Facebook Ads (fads)
// and TikTok Ads (ttads). Only additive metrics are requested; ratios such as
// CTR, CPM and ROAS are computed here so they stay correct when rows are
// merged (e.g. after a date range is split on timeout).

export const PLATFORMS = {
  fads: {
    label: "Meta",
    dimensions: [
      "ad_id",
      "ad_name",
      "campaign_name",
      "adset_name",
      "ad_creative_thumbnail_url",
      "ad_creative_image_url",
      "ad_creative_body",
      "ad_creative_title",
      "ad_creative_object_type",
      "ad_creative_call_to_action_type",
      "ad_creative_link_url",
      "ad_creative_video_permalink_url",
      "ad_preview_shareable_link",
    ],
    metrics: [
      "spend",
      "impressions",
      "clicks",
      "inline_link_clicks",
      "conversions",
      "conversion_values",
      "video_views", // 3-second views
      "video_thruplay_watched_actions",
      "video_p100_watched_actions",
    ],
    normalize(r) {
      const objectType = (r.ad_creative_object_type || "").toUpperCase();
      const isVideo = objectType === "VIDEO" || !!r.ad_creative_video_permalink_url;
      return {
        adId: r.ad_id,
        adName: r.ad_name,
        campaignName: r.campaign_name,
        adGroupName: r.adset_name,
        format: isVideo ? "video" : objectType === "SHARE" ? "image/link" : objectType.toLowerCase() || "unknown",
        // image_url is full size for image ads; thumbnail_url covers video ads
        thumbnailUrl: r.ad_creative_image_url || r.ad_creative_thumbnail_url || null,
        videoUrl: r.ad_creative_video_permalink_url || null,
        previewUrl: r.ad_preview_shareable_link || null,
        headline: r.ad_creative_title || "",
        body: r.ad_creative_body || "",
        cta: r.ad_creative_call_to_action_type || "",
        landingUrl: r.ad_creative_link_url || "",
        spend: num(r.spend),
        impressions: num(r.impressions),
        clicks: num(r.clicks),
        linkClicks: num(r.inline_link_clicks),
        conversions: num(r.conversions),
        conversionValue: num(r.conversion_values),
        hookViews: num(r.video_views),
        holdViews: num(r.video_thruplay_watched_actions),
        completedViews: num(r.video_p100_watched_actions),
      };
    },
  },
  ttads: {
    label: "TikTok",
    dimensions: [
      "ad_id",
      "ad_name",
      "campaign_name",
      "adgroup_name",
      "video_cover_url",
      "video_preview_url",
      "video_duration",
      "ad_text",
      "ad_landing_page_url",
    ],
    metrics: [
      "spend",
      "impressions",
      "clicks",
      "conversion",
      "total_purchase_value",
      "video_watched_2s",
      "video_watched_6s",
      "video_views_p100",
    ],
    normalize(r) {
      return {
        adId: r.ad_id,
        adName: r.ad_name,
        campaignName: r.campaign_name,
        adGroupName: r.adgroup_name,
        format: r.video_cover_url || r.video_preview_url ? "video" : "image",
        thumbnailUrl: r.video_cover_url || null,
        videoUrl: r.video_preview_url || null,
        previewUrl: r.video_preview_url || null,
        videoDuration: num(r.video_duration) || null,
        headline: "",
        body: r.ad_text || "",
        cta: "",
        landingUrl: r.ad_landing_page_url || "",
        spend: num(r.spend),
        impressions: num(r.impressions),
        clicks: num(r.clicks),
        linkClicks: num(r.clicks),
        conversions: num(r.conversion),
        conversionValue: num(r.total_purchase_value),
        hookViews: num(r.video_watched_2s),
        holdViews: num(r.video_watched_6s),
        completedViews: num(r.video_views_p100),
      };
    },
  },
};

const ADDITIVE = new Set([
  "spend",
  "impressions",
  "clicks",
  "inline_link_clicks",
  "conversions",
  "conversion_values",
  "video_views",
  "video_thruplay_watched_actions",
  "video_p100_watched_actions",
  "conversion",
  "total_purchase_value",
  "video_watched_2s",
  "video_watched_6s",
  "video_views_p100",
]);

function num(v) {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

// Strip a "<connector>_" prefix from row keys, in case the API echoes
// prefixed field IDs.
function unprefixRow(row, connectorId) {
  const out = {};
  const p = `${connectorId}_`;
  for (const [k, v] of Object.entries(row)) out[k.startsWith(p) ? k.slice(p.length) : k] = v;
  return out;
}

// Merge raw rows (possibly from several date-range chunks) by ad_id, summing
// additive metrics and keeping the first non-empty value of each dimension.
export function mergeRows(rowSets, connectorId) {
  const byAd = new Map();
  for (const rows of rowSets) {
    for (const raw of rows) {
      const row = unprefixRow(raw, connectorId);
      const key = row.ad_id;
      if (!key) continue;
      const existing = byAd.get(key);
      if (!existing) {
        byAd.set(key, { ...row });
        continue;
      }
      for (const [k, v] of Object.entries(row)) {
        if (ADDITIVE.has(k)) existing[k] = num(existing[k]) + num(v);
        else if (!existing[k] && v) existing[k] = v;
      }
    }
  }
  return [...byAd.values()];
}

// Adds computed ratios. Kept separate so it can be re-run after the client
// groups ads into creatives.
export function withRatios(ad) {
  const div = (a, b) => (b > 0 ? a / b : null);
  return {
    ...ad,
    ctr: div(ad.clicks, ad.impressions),
    linkCtr: div(ad.linkClicks, ad.impressions),
    cpm: ad.impressions > 0 ? (ad.spend / ad.impressions) * 1000 : null,
    cpc: div(ad.spend, ad.clicks),
    cpa: div(ad.spend, ad.conversions),
    roas: ad.conversionValue > 0 ? div(ad.conversionValue, ad.spend) : null,
    hookRate: ad.format === "video" ? div(ad.hookViews, ad.impressions) : null,
    holdRate: ad.format === "video" ? div(ad.holdViews, ad.hookViews) : null,
  };
}

// Fetch every ad that spent in the date range for one account.
export async function fetchAccountAds(tmr, { connectorId, account, dateRange }) {
  const platform = PLATFORMS[connectorId];
  if (!platform) throw new Error(`Unsupported connector: ${connectorId}`);

  const body = {
    // The data endpoint expects connector-prefixed account IDs.
    accounts: [`${connectorId}_${account.id}`],
    dimensions: platform.dimensions,
    metrics: platform.metrics,
    filters: [{ fieldId: "impressions", operator: "greaterThan", value: "0" }],
    sort: [{ fieldId: "spend", direction: "desc" }],
  };
  // Convert all money to one currency so totals across accounts add up.
  if (process.env.TMR_CURRENCY) body.dataOptions = { currency: process.env.TMR_CURRENCY };

  let rowSets;
  try {
    rowSets = await tmr.runQuerySplitting(body, dateRange);
  } catch (err) {
    // Fallback: if the API wants connector-prefixed field IDs, retry once
    // with them. mergeRows strips the prefix again.
    if (err.code !== "VALIDATION_FAILED") throw err;
    const pre = (ids) => ids.map((id) => `${connectorId}_${id}`);
    rowSets = await tmr.runQuerySplitting(
      {
        ...body,
        dimensions: pre(body.dimensions),
        metrics: pre(body.metrics),
        filters: [{ ...body.filters[0], fieldId: `${connectorId}_impressions` }],
        sort: [{ ...body.sort[0], fieldId: `${connectorId}_spend` }],
      },
      dateRange
    );
  }

  return mergeRows(rowSets, connectorId).map((row) =>
    withRatios({
      platform: connectorId,
      platformLabel: platform.label,
      accountId: account.id,
      accountName: (account.name || "").trim(),
      ...platform.normalize(row),
    })
  );
}
