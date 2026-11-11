import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TmrClient } from "./tmr.js";
import { PLATFORMS, fetchAccountAds, withRatios } from "./platforms.js";
import { getCached, setCached } from "./cache.js";
import { analyzeCreatives, claudeConfigured } from "./analysis.js";
import { DEMO_ACCOUNTS, demoAds } from "./demo.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const DEMO = process.env.DEMO_MODE === "1" || !process.env.TMR_API_KEY;
const CONNECTORS = (process.env.TMR_CONNECTORS || "fads,ttads")
  .split(",")
  .map((s) => s.trim())
  .filter((c) => PLATFORMS[c]);

const tmr = DEMO ? null : new TmrClient({ apiKey: process.env.TMR_API_KEY, teamId: process.env.TMR_TEAM_ID });

// Every ad the server has loaded, keyed "platform:accountId:adId". The
// analysis endpoint only accepts keys from here, so it never fetches
// arbitrary URLs supplied by the browser.
const adIndex = new Map();
const adKey = (a) => `${a.platform}:${a.accountId}:${a.adId}`;

const app = express();
app.use(express.json({ limit: "1mb" }));

// Optional shared-password protection for when the dashboard is deployed.
if (process.env.DASHBOARD_PASSWORD) {
  app.use((req, res, next) => {
    const [scheme, encoded] = (req.headers.authorization || "").split(" ");
    const pass = scheme === "Basic" ? Buffer.from(encoded || "", "base64").toString().split(":").slice(1).join(":") : "";
    if (pass === process.env.DASHBOARD_PASSWORD) return next();
    res.set("WWW-Authenticate", 'Basic realm="Creative dashboard"').status(401).send("Authentication required");
  });
}

app.use(express.static(path.join(here, "..", "public")));
// Markdown rendering + sanitising for the analysis report, served locally.
app.get("/vendor/marked.min.js", (_req, res) => res.sendFile(path.join(here, "..", "node_modules/marked/marked.min.js")));
app.get("/vendor/purify.min.js", (_req, res) => res.sendFile(path.join(here, "..", "node_modules/dompurify/dist/purify.min.js")));

function yearToDate() {
  const today = new Date().toISOString().slice(0, 10);
  return { startDate: `${today.slice(0, 4)}-01-01`, endDate: today };
}

app.get("/api/config", (_req, res) => {
  res.json({
    demo: DEMO,
    claudeEnabled: claudeConfigured(),
    defaultRange: yearToDate(),
    platforms: Object.fromEntries(CONNECTORS.map((c) => [c, PLATFORMS[c].label])),
  });
});

app.get("/api/accounts", async (req, res) => {
  try {
    if (DEMO) return res.json({ accounts: DEMO_ACCOUNTS });
    const key = `accounts:${CONNECTORS.join(",")}`;
    const cached = req.query.refresh ? null : await getCached(key);
    if (cached) return res.json({ accounts: cached.value });
    const lists = await Promise.all(
      CONNECTORS.map(async (c) => (await tmr.listAccounts(c)).map((a) => ({ ...a, connectorId: c, name: (a.name || "").trim() })))
    );
    const accounts = lists.flat().filter((a) => a.status === "enabled");
    await setCached(key, accounts);
    res.json({ accounts });
  } catch (err) {
    console.error("accounts:", err.message);
    res.status(502).json({ error: err.message });
  }
});

// Streams NDJSON: one line per account as it loads, so the UI can show
// progress while queries are paced to the TMR rate limit.
app.get("/api/ads", async (req, res) => {
  const range = {
    startDate: String(req.query.start || yearToDate().startDate),
    endDate: String(req.query.end || yearToDate().endDate),
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(range.startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(range.endDate)) {
    return res.status(400).json({ error: "start and end must be YYYY-MM-DD" });
  }
  const wanted = String(req.query.accounts || "")
    .split(",")
    .filter(Boolean)
    .map((s) => {
      const i = s.indexOf(":");
      return { connectorId: s.slice(0, i), id: s.slice(i + 1) };
    })
    .filter((a) => PLATFORMS[a.connectorId] && a.id);
  if (!wanted.length) return res.status(400).json({ error: "Pick at least one account" });

  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-store");
  const send = (obj) => res.write(JSON.stringify(obj) + "\n");
  let aborted = false;
  res.on("close", () => (aborted = true));

  const allAccounts = DEMO ? DEMO_ACCOUNTS : (await getCached(`accounts:${CONNECTORS.join(",")}`))?.value || [];
  for (const w of wanted) {
    if (aborted) break;
    const account = allAccounts.find((a) => a.connectorId === w.connectorId && a.id === w.id) || { ...w, name: w.id };
    const cacheKey = `ads:${w.connectorId}:${w.id}:${range.startDate}:${range.endDate}`;
    try {
      let entry = req.query.refresh ? null : await getCached(cacheKey);
      if (!entry) {
        send({ type: "progress", account: account.name, platform: w.connectorId });
        const ads = DEMO ? demoAds(account) : await fetchAccountAds(tmr, { connectorId: w.connectorId, account, dateRange: range });
        entry = await setCached(cacheKey, ads);
      }
      for (const ad of entry.value) adIndex.set(adKey(ad), ad);
      send({ type: "ads", account: account.name, platform: w.connectorId, fetchedAt: entry.savedAt, ads: entry.value });
    } catch (err) {
      console.error(`ads ${w.connectorId}:${w.id}:`, err.message);
      send({ type: "error", account: account.name, platform: w.connectorId, error: err.message });
    }
  }
  send({ type: "done" });
  res.end();
});

// Combine several ads that share one creative into a single entry.
function combine(ads) {
  if (ads.length === 1) return { ...ads[0], adCount: 1 };
  const sumKeys = ["spend", "impressions", "clicks", "linkClicks", "conversions", "conversionValue", "hookViews", "holdViews", "completedViews"];
  const base = { ...ads.reduce((best, a) => (a.spend > best.spend ? a : best)), adCount: ads.length };
  for (const k of sumKeys) base[k] = ads.reduce((s, a) => s + (a[k] || 0), 0);
  return withRatios(base);
}

// Body: { creatives: [[adKey, ...], ...], notes?: string }
// Streams the markdown report as plain text.
app.post("/api/analyze", async (req, res) => {
  if (!claudeConfigured()) return res.status(400).json({ error: "Set ANTHROPIC_API_KEY to enable Claude analysis" });
  const groups = Array.isArray(req.body?.creatives) ? req.body.creatives.slice(0, 60) : [];
  const creatives = groups
    .map((keys) => (Array.isArray(keys) ? keys.map((k) => adIndex.get(k)).filter(Boolean) : []))
    .filter((g) => g.length)
    .map(combine)
    .sort((a, b) => b.spend - a.spend);
  if (!creatives.length) return res.status(400).json({ error: "No loaded creatives selected. Reload the ads and try again." });
  const notes = typeof req.body.notes === "string" ? req.body.notes.slice(0, 4000) : "";

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  const controller = new AbortController();
  res.on("close", () => controller.abort());
  try {
    const meta = await analyzeCreatives(creatives, {
      notes,
      signal: controller.signal,
      onText: (t) => res.write(t),
    });
    console.log(`analysis: ${creatives.length} creatives, ${meta.imageCount} images, model ${meta.model}`);
  } catch (err) {
    if (!controller.signal.aborted) {
      console.error("analysis:", err.message);
      res.write(`\n\n> Analysis failed: ${err.message}`);
    }
  }
  res.end();
});

app.listen(PORT, () => {
  console.log(`Creative dashboard on http://localhost:${PORT}${DEMO ? " (demo data: set TMR_API_KEY for live data)" : ""}`);
  if (!claudeConfigured()) console.log("Claude analysis disabled: set ANTHROPIC_API_KEY to enable it");
});
