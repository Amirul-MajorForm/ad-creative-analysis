import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeRows, withRatios, fetchAccountAds, PLATFORMS } from "../server/platforms.js";
import { splitRange, TmrClient, TmrError } from "../server/tmr.js";

test("splitRange halves a range without overlap", () => {
  assert.deepEqual(splitRange("2026-01-01", "2026-12-31"), [
    { startDate: "2026-01-01", endDate: "2026-07-02" },
    { startDate: "2026-07-03", endDate: "2026-12-31" },
  ]);
});

test("mergeRows sums additive metrics by ad and strips connector prefixes", () => {
  const merged = mergeRows(
    [
      [{ ad_id: "1", ad_name: "A", spend: 10, impressions: 1000, clicks: 10 }],
      [{ fads_ad_id: "1", fads_ad_name: "A", fads_spend: 5, fads_impressions: 500, fads_clicks: 20 }, { ad_id: "2", spend: 1 }],
    ],
    "fads"
  );
  assert.equal(merged.length, 2);
  const a = merged.find((r) => r.ad_id === "1");
  assert.equal(a.spend, 15);
  assert.equal(a.impressions, 1500);
  assert.equal(a.clicks, 30);
});

test("withRatios computes ratios and leaves them null when undefined", () => {
  const r = withRatios({ format: "video", spend: 50, impressions: 10000, clicks: 100, conversions: 0, conversionValue: 0, hookViews: 3000, holdViews: 600 });
  assert.equal(r.ctr, 0.01);
  assert.equal(r.cpm, 5);
  assert.equal(r.cpa, null);
  assert.equal(r.roas, null);
  assert.equal(r.hookRate, 0.3);
  assert.equal(r.holdRate, 0.2);
});

test("Meta normaliser picks image, detects video", () => {
  const ad = PLATFORMS.fads.normalize({ ad_id: "9", ad_creative_object_type: "VIDEO", ad_creative_thumbnail_url: "https://x/t.jpg", spend: "3.5" });
  assert.equal(ad.format, "video");
  assert.equal(ad.thumbnailUrl, "https://x/t.jpg");
  assert.equal(ad.spend, 3.5);
});

function fakeTmr(handler) {
  const calls = [];
  const tmr = new TmrClient({ apiKey: "k", teamId: "t" });
  tmr.runQuery = async (body) => {
    calls.push(body);
    return handler(body, calls.length);
  };
  return { tmr, calls };
}

test("fetchAccountAds sends prefixed account IDs and normalises rows", async () => {
  const { tmr, calls } = fakeTmr(() => [{ ad_id: "1", ad_name: "Hero", video_cover_url: "https://c/1.jpg", spend: 20, impressions: 4000, clicks: 40, video_watched_2s: 1000, video_watched_6s: 300 }]);
  const ads = await fetchAccountAds(tmr, { connectorId: "ttads", account: { id: "123", name: " Brand " }, dateRange: { startDate: "2026-01-01", endDate: "2026-11-11" } });
  assert.deepEqual(calls[0].accounts, ["ttads_123"]);
  assert.deepEqual(calls[0].dateRange, { startDate: "2026-01-01", endDate: "2026-11-11" });
  assert.equal(ads[0].accountName, "Brand");
  assert.equal(ads[0].format, "video");
  assert.equal(ads[0].hookRate, 0.25);
  assert.equal(ads[0].holdRate, 0.3);
});

test("fetchAccountAds splits the date range on timeout and merges", async () => {
  const { tmr, calls } = fakeTmr((body, n) => {
    if (n === 1) throw new TmrError("timeout", { status: 504 });
    return [{ ad_id: "1", spend: 10, impressions: 100, clicks: 1 }];
  });
  const ads = await fetchAccountAds(tmr, { connectorId: "fads", account: { id: "act_1", name: "A" }, dateRange: { startDate: "2026-01-01", endDate: "2026-12-31" } });
  assert.equal(calls.length, 3);
  assert.equal(ads.length, 1);
  assert.equal(ads[0].spend, 20);
});

test("fetchAccountAds retries with prefixed field IDs on validation failure", async () => {
  const { tmr, calls } = fakeTmr((body, n) => {
    if (n === 1) throw new TmrError("bad field", { status: 400, code: "VALIDATION_FAILED" });
    return [{ fads_ad_id: "1", fads_spend: 4, fads_impressions: 100 }];
  });
  const ads = await fetchAccountAds(tmr, { connectorId: "fads", account: { id: "act_1", name: "A" }, dateRange: { startDate: "2026-01-01", endDate: "2026-02-01" } });
  assert.equal(calls[1].metrics[0], "fads_spend");
  assert.equal(ads[0].spend, 4);
});
