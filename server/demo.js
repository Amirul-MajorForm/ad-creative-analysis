// Synthetic data for DEMO_MODE, so the dashboard can be tried without a
// Two Minute Reports API key. Nothing here is real client data.
import { withRatios } from "./platforms.js";

export const DEMO_ACCOUNTS = [
  { id: "act_1000000001", name: "Demo Brand SG", connectorId: "fads" },
  { id: "act_1000000002", name: "Demo Brand MY", connectorId: "fads" },
  { id: "7000000000000000001", name: "Demo Brand TikTok", connectorId: "ttads" },
];

const CONCEPTS = [
  ["UGC_Review_Morning-Routine", "video", "Honestly didn't expect to like this. Two weeks in and it's part of my morning now.", "#e76f51"],
  ["Static_Offer_20OFF", "image/link", "20% off your first order. Ends Sunday.", "#264653"],
  ["Video_Founder-Story_45s", "video", "We started in a tiny kitchen with one recipe. Here's what happened next.", "#2a9d8f"],
  ["Static_Product-Hero_White", "image/link", "Clean ingredients. Nothing you can't pronounce.", "#8d99ae"],
  ["Video_Unboxing_15s", "video", "POV: your order just arrived", "#f4a261"],
  ["Carousel_Bestsellers", "carousel", "Our top 5 bestsellers, picked by 10,000 customers.", "#6d597a"],
  ["Video_Recipe-Hack_30s", "video", "3 ingredients, 5 minutes. Save this for later.", "#e9c46a"],
  ["Static_Testimonial-Quote", "image/link", "\"The only one my kids actually ask for.\" - Sarah, verified buyer", "#457b9d"],
  ["Video_Comparison_vs-Regular", "video", "We put it side by side with the regular stuff. See the difference.", "#bc4749"],
  ["Static_Lifestyle_Picnic", "image/link", "Made for slow weekends.", "#6a994e"],
];

function thumb(label, color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="360"><rect width="360" height="360" fill="${color}"/><text x="180" y="180" font-family="sans-serif" font-size="20" fill="#fff" text-anchor="middle" dominant-baseline="middle">${label.replace(/_/g, " ").slice(0, 26)}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

// Deterministic pseudo-random so the demo looks the same on every load.
function rng(seed) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

export function demoAds(account) {
  const rand = rng(account.id.length * 7919 + account.id.charCodeAt(account.id.length - 1));
  const isTikTok = account.connectorId === "ttads";
  return CONCEPTS.filter(([, f]) => !isTikTok || f === "video").map(([name, format, body, color], i) => {
    const impressions = Math.round(20000 + rand() * 900000);
    const ctr = 0.004 + rand() * 0.02;
    const clicks = Math.round(impressions * ctr);
    const conversions = Math.round(clicks * (0.01 + rand() * 0.06));
    const spend = Math.round(impressions * (2 + rand() * 6)) / 1000;
    const hookViews = format === "video" ? Math.round(impressions * (0.15 + rand() * 0.35)) : 0;
    return withRatios({
      platform: account.connectorId,
      platformLabel: isTikTok ? "TikTok" : "Meta",
      accountId: account.id,
      accountName: account.name,
      adId: `${account.id}-${i}`,
      adName: `${name}_2026`,
      campaignName: i % 3 === 0 ? "Demo_Conversions_Purchase_2026" : i % 3 === 1 ? "Demo_Traffic_LPV_2026" : "Demo_Awareness_Reach_2026",
      adGroupName: "Broad 25-44",
      format: isTikTok ? "video" : format,
      thumbnailUrl: thumb(name, color),
      videoUrl: null,
      previewUrl: null,
      headline: format === "video" ? "" : "Shop now",
      body,
      cta: "SHOP_NOW",
      landingUrl: "https://example.com",
      spend,
      impressions,
      clicks,
      linkClicks: Math.round(clicks * 0.7),
      conversions,
      conversionValue: Math.round(conversions * (25 + rand() * 40) * 100) / 100,
      hookViews,
      holdViews: Math.round(hookViews * (0.1 + rand() * 0.4)),
      completedViews: Math.round(hookViews * 0.08),
    });
  });
}
