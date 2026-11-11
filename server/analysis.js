// Claude creative strategy analysis.
//
// Sends the selected creatives (thumbnail image + copy + performance) to
// Claude and streams back a markdown creative strategy report.
import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.ANALYSIS_MODEL || "claude-opus-5-5";
const EFFORT = process.env.ANALYSIS_EFFORT || "high";
const MAX_IMAGES = Number(process.env.ANALYSIS_MAX_IMAGES) || 24;
const MAX_IMAGE_BYTES = 4.5 * 1024 * 1024; // API limit is 5MB per image
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

let client;
function getClient() {
  // Resolves ANTHROPIC_API_KEY (or another configured credential) from env.
  client ??= new Anthropic();
  return client;
}

export function claudeConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

const SYSTEM_PROMPT = `You are a senior paid social creative strategist at a performance marketing agency. You review a brand's ad creatives from the past year alongside their delivery data and turn that into a creative strategy the team can brief from next week.

How to work:
- Ground every claim in the data and the creatives provided. Cite creatives by their number, e.g. [#3], whenever you make a point about them.
- Judge performance relative to this account set's own benchmarks (provided), not generic industry numbers. Weigh results by spend: a creative with tiny spend is a weak signal, so say so instead of over-reading it.
- Match the metric to the objective. Awareness/reach campaigns should be judged on CPM, hook rate and hold rate; traffic on CTR and CPC; conversion campaigns on CPA and ROAS. Infer the objective from the campaign name when it is not stated.
- For video ads you only see the cover/thumbnail frame plus the copy and retention metrics (hook rate = 2-3s views / impressions, hold rate = thruplays or 6s views / hook views). Be explicit when a conclusion about a video rests on the thumbnail alone.
- Look for patterns across creatives, not one-off commentary: visual style, people vs product, UGC vs polished, text overlay, offer framing, hook angle, copy length, CTA, format.
- Be direct and specific. Recommendations should be concrete enough to brief a designer or creator.

Write the report in GitHub-flavoured markdown with these sections:
## Summary
Three to five bullets: what is working, what is not, and the single biggest opportunity.
## What's winning
The patterns behind the top performers, with evidence.
## What's underperforming
Patterns behind the weakest spend-weighted performers, and the likely reason.
## Format, hook and copy insights
Video vs static, hook strength, retention, copy and CTA patterns.
## Recommendations
A prioritised list (highest impact first). For each: the change, why (cite creatives and numbers), and how to measure it.
## Next creatives to brief
Five concrete creative concepts, each with format, hook (first 3 seconds or headline), visual direction, copy angle, CTA and the hypothesis it tests.
Keep the whole report tight; use tables where they make comparisons clearer.`;

const fmt = {
  money: (v) => (v == null ? "-" : v.toFixed(2)),
  pct: (v) => (v == null ? "-" : `${(v * 100).toFixed(2)}%`),
  int: (v) => (v == null ? "-" : Math.round(v).toLocaleString("en-US")),
  x: (v) => (v == null ? "-" : `${v.toFixed(2)}x`),
};

function median(values) {
  const v = values.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

function benchmarks(ads) {
  const sum = (k) => ads.reduce((s, a) => s + (a[k] || 0), 0);
  const spend = sum("spend");
  const impressions = sum("impressions");
  const clicks = sum("clicks");
  const conversions = sum("conversions");
  const value = sum("conversionValue");
  const videos = ads.filter((a) => a.format === "video");
  return [
    `Creatives in this set: ${ads.length} (${videos.length} video)`,
    `Total spend: ${fmt.money(spend)}`,
    `Blended CTR: ${fmt.pct(impressions ? clicks / impressions : null)}`,
    `Blended CPM: ${fmt.money(impressions ? (spend / impressions) * 1000 : null)}`,
    `Blended CPA: ${fmt.money(conversions ? spend / conversions : null)}`,
    `Blended ROAS: ${fmt.x(value && spend ? value / spend : null)}`,
    `Median hook rate (video): ${fmt.pct(median(videos.map((a) => a.hookRate)))}`,
    `Median hold rate (video): ${fmt.pct(median(videos.map((a) => a.holdRate)))}`,
  ].join("\n");
}

function describeAd(ad, n) {
  const lines = [
    `[#${n}] ${ad.platformLabel} | ${ad.format} | account: ${ad.accountName}`,
    `Ad name: ${ad.adName}`,
    `Campaign: ${ad.campaignName}${ad.adGroupName ? ` | Ad set/group: ${ad.adGroupName}` : ""}`,
  ];
  if (ad.adCount > 1) lines.push(`Ran as ${ad.adCount} ads (metrics combined)`);
  if (ad.headline) lines.push(`Headline: ${ad.headline}`);
  if (ad.body) lines.push(`Copy: ${ad.body.replace(/\s+/g, " ").slice(0, 600)}`);
  if (ad.cta) lines.push(`CTA: ${ad.cta}`);
  if (ad.videoDuration) lines.push(`Video length: ${ad.videoDuration}s`);
  lines.push(
    `Spend ${fmt.money(ad.spend)} | Impr ${fmt.int(ad.impressions)} | CPM ${fmt.money(ad.cpm)} | CTR ${fmt.pct(ad.ctr)} | CPC ${fmt.money(ad.cpc)} | Conv ${fmt.int(ad.conversions)} | CPA ${fmt.money(ad.cpa)} | ROAS ${fmt.x(ad.roas)}` +
      (ad.format === "video" ? ` | Hook ${fmt.pct(ad.hookRate)} | Hold ${fmt.pct(ad.holdRate)}` : "")
  );
  return lines.join("\n");
}

async function fetchImage(url) {
  if (!url || !/^https?:\/\//.test(url)) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const type = (res.headers.get("content-type") || "").split(";")[0].trim();
    if (!IMAGE_TYPES.has(type)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_IMAGE_BYTES) return null;
    return { media_type: type, data: buf.toString("base64") };
  } catch {
    return null;
  }
}

// Build the user message: benchmarks, then each creative's image + details.
async function buildContent(ads, { notes }) {
  // Images for the highest-spend creatives only, to bound request size.
  const images = await Promise.all(ads.map((a, i) => (i < MAX_IMAGES ? fetchImage(a.thumbnailUrl) : null)));

  const content = [
    {
      type: "text",
      text:
        `Here are ${ads.length} ad creatives that ran this period, ordered by spend (highest first).\n\n` +
        `Account set benchmarks:\n${benchmarks(ads)}\n\n` +
        (notes ? `Context from the team:\n${notes}\n\n` : "") +
        `Each creative follows: its image (when available), then its details.`,
    },
  ];
  ads.forEach((ad, i) => {
    const img = images[i];
    if (img) content.push({ type: "image", source: { type: "base64", ...img } });
    content.push({
      type: "text",
      text: describeAd(ad, i + 1) + (img ? "" : "\n(No image available for this creative.)"),
    });
  });
  content.push({
    type: "text",
    text: "Write the creative strategy report now, following the structure in your instructions.",
  });
  return { content, imageCount: images.filter(Boolean).length };
}

// Streams the report as plain text chunks via onText. Returns metadata.
export async function analyzeCreatives(ads, { notes, onText, signal }) {
  const { content, imageCount } = await buildContent(ads, { notes });

  const stream = getClient().beta.messages.stream(
    {
      model: MODEL,
      max_tokens: 64000,
      // Opus 5.5 always thinks adaptively; effort controls depth.
      thinking: { type: "adaptive" },
      output_config: { effort: EFFORT },
      // If a safety classifier declines, retry on a fallback model server-side.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content }],
    },
    { signal }
  );

  stream.on("text", (delta) => onText(delta));
  const message = await stream.finalMessage();

  if (message.stop_reason === "refusal") {
    onText("\n\n> The analysis was declined by the model's safety system. Try removing the team notes or selecting different creatives.");
  } else if (message.stop_reason === "max_tokens") {
    onText("\n\n> The report hit the output limit and was cut short. Try analysing fewer creatives.");
  }
  return { model: message.model, imageCount, usage: message.usage };
}
