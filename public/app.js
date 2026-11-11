// Creative Performance dashboard (vanilla JS, no build step).

const $ = (sel) => document.querySelector(sel);
const state = {
  config: null,
  accounts: [],
  selectedAccounts: new Set(load("selectedAccounts", [])),
  ads: [], // raw ads from the server
  checked: new Set(), // creative keys ticked for analysis
  view: "grid",
  tableSort: null,
  analysisAbort: null,
  reportMarkdown: "",
};

// ---------- helpers ----------
function load(key, fallback) {
  try {
    const v = localStorage.getItem(`cpd.${key}`);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(`cpd.${key}`, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = {
  money: (v) => (v == null ? "–" : v >= 1000 ? Math.round(v).toLocaleString() : v.toFixed(2)),
  int: (v) => (v == null ? "–" : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e4 ? `${(v / 1e3).toFixed(0)}k` : Math.round(v).toLocaleString()),
  pct: (v) => (v == null ? "–" : `${(v * 100).toFixed(2)}%`),
  x: (v) => (v == null ? "–" : `${v.toFixed(2)}x`),
};
const adKey = (a) => `${a.platform}:${a.accountId}:${a.adId}`;

function ratios(a) {
  const div = (x, y) => (y > 0 ? x / y : null);
  return {
    ...a,
    ctr: div(a.clicks, a.impressions),
    cpm: a.impressions > 0 ? (a.spend / a.impressions) * 1000 : null,
    cpc: div(a.spend, a.clicks),
    cpa: div(a.spend, a.conversions),
    roas: a.conversionValue > 0 ? div(a.conversionValue, a.spend) : null,
    hookRate: a.format === "video" ? div(a.hookViews, a.impressions) : null,
    holdRate: a.format === "video" ? div(a.holdViews, a.hookViews) : null,
  };
}

function setStatus(text, isError = false) {
  const el = $("#status");
  el.hidden = !text;
  el.textContent = text || "";
  el.classList.toggle("error", isError);
}

// ---------- creatives (optionally grouping duplicate ads) ----------
// The same creative is often run as several ads (different ad sets or
// copies). Group on platform + account + ad name + image path.
function creativeGroupKey(a) {
  let img = "";
  try {
    img = a.thumbnailUrl && !a.thumbnailUrl.startsWith("data:") ? new URL(a.thumbnailUrl).pathname : "";
  } catch {
    /* ignore */
  }
  return `${a.platform}|${a.accountId}|${(a.adName || "").trim().toLowerCase()}|${img}`;
}

function buildCreatives() {
  if (!$("#groupToggle").checked) return state.ads.map((a) => ({ ...a, key: adKey(a), adKeys: [adKey(a)], adCount: 1 }));
  const groups = new Map();
  for (const a of state.ads) {
    const k = creativeGroupKey(a);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(a);
  }
  const sumKeys = ["spend", "impressions", "clicks", "linkClicks", "conversions", "conversionValue", "hookViews", "holdViews", "completedViews"];
  return [...groups.values()].map((ads) => {
    const lead = ads.reduce((best, a) => (a.spend > best.spend ? a : best));
    const c = { ...lead, key: adKey(lead), adKeys: ads.map(adKey), adCount: ads.length, campaigns: [...new Set(ads.map((a) => a.campaignName))] };
    for (const k of sumKeys) c[k] = ads.reduce((s, a) => s + (a[k] || 0), 0);
    return ratios(c);
  });
}

const LOW_IS_GOOD = new Set(["cpm", "cpa", "cpc"]);

function filtered() {
  const q = $("#search").value.trim().toLowerCase();
  const platform = $("#platformFilter").value;
  const format = $("#formatFilter").value;
  const account = $("#accountFilter").value;
  const sortBy = $("#sortBy").value;
  let list = buildCreatives().filter(
    (c) =>
      (!platform || c.platform === platform) &&
      (!format || c.format === format) &&
      (!account || `${c.platform}:${c.accountId}` === account) &&
      (!q || `${c.adName} ${c.campaignName} ${c.body} ${c.headline}`.toLowerCase().includes(q))
  );
  const dir = LOW_IS_GOOD.has(sortBy) ? 1 : -1;
  list.sort((a, b) => {
    const av = a[sortBy], bv = b[sortBy];
    if (av == null && bv == null) return b.spend - a.spend;
    if (av == null) return 1;
    if (bv == null) return -1;
    return dir * (av - bv);
  });
  return list;
}

// Medians of the filtered set (spend-bearing creatives only) used to flag
// metrics as good/bad relative to the account's own performance.
function medians(list) {
  const out = {};
  for (const k of ["ctr", "cpm", "cpa", "roas", "hookRate", "holdRate"]) {
    const v = list.filter((c) => c.spend > 0 && c[k] != null).map((c) => c[k]).sort((a, b) => a - b);
    out[k] = v.length >= 4 ? v[Math.floor(v.length / 2)] : null;
  }
  return out;
}
function tone(k, v, med) {
  if (v == null || med[k] == null || med[k] === 0) return "";
  const r = v / med[k];
  const better = LOW_IS_GOOD.has(k) ? r < 0.8 : r > 1.25;
  const worse = LOW_IS_GOOD.has(k) ? r > 1.25 : r < 0.8;
  return better ? "good" : worse ? "bad" : "";
}

// ---------- rendering ----------
function render() {
  const list = filtered();
  $("#empty").hidden = state.ads.length > 0;
  if (state.ads.length && !list.length) {
    $("#empty").hidden = false;
    $("#empty").textContent = "No creatives match these filters.";
  }
  renderKpis(list);
  const med = medians(list);
  $("#grid").hidden = state.view !== "grid";
  $("#table").hidden = state.view !== "table";
  if (state.view === "grid") renderGrid(list, med);
  else renderTable(list, med);
  $("#analyzeBtn").disabled = !list.length;
}

function renderKpis(list) {
  if (!state.ads.length) return ($("#kpis").innerHTML = "");
  const sum = (k) => list.reduce((s, c) => s + (c[k] || 0), 0);
  const t = ratios({ spend: sum("spend"), impressions: sum("impressions"), clicks: sum("clicks"), conversions: sum("conversions"), conversionValue: sum("conversionValue") });
  const vids = list.filter((c) => c.format === "video");
  const hook = vids.length ? vids.reduce((s, c) => s + c.hookViews, 0) / Math.max(1, vids.reduce((s, c) => s + c.impressions, 0)) : null;
  const items = [
    ["Creatives", list.length.toLocaleString()],
    ["Spend", fmt.money(t.spend)],
    ["Impressions", fmt.int(t.impressions)],
    ["CTR", fmt.pct(t.ctr)],
    ["CPM", fmt.money(t.cpm)],
    ["Conversions", fmt.int(t.conversions)],
    ["CPA", fmt.money(t.cpa)],
    ["ROAS", fmt.x(t.roas)],
    ["Video hook rate", fmt.pct(hook)],
  ];
  $("#kpis").innerHTML = items.map(([l, v]) => `<div class="kpi"><div class="label">${l}</div><div class="value">${v}</div></div>`).join("");
}

function platformBadge(c) {
  return `<span class="badge badge-${c.platform === "ttads" ? "tiktok" : "meta"}">${esc(c.platformLabel)}</span>`;
}

function thumbHtml(c) {
  if (!c.thumbnailUrl) return `<div class="noimg">No preview</div>`;
  return `<img loading="lazy" referrerpolicy="no-referrer" src="${esc(c.thumbnailUrl)}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'noimg',textContent:'Preview expired. Reload with Bypass cache.'}))" />`;
}

function metric(label, value, cls = "") {
  return `<div class="metric"><div class="l">${label}</div><div class="v ${cls}">${value}</div></div>`;
}

function cardMetrics(c, med) {
  const m = [metric("Spend", fmt.money(c.spend)), metric("Impr.", fmt.int(c.impressions)), metric("CTR", fmt.pct(c.ctr), tone("ctr", c.ctr, med))];
  if (c.conversions > 0) {
    m.push(metric("Conv.", fmt.int(c.conversions)), metric("CPA", fmt.money(c.cpa), tone("cpa", c.cpa, med)));
    m.push(c.roas != null ? metric("ROAS", fmt.x(c.roas), tone("roas", c.roas, med)) : metric("CPM", fmt.money(c.cpm), tone("cpm", c.cpm, med)));
  } else if (c.format === "video") {
    m.push(metric("CPM", fmt.money(c.cpm), tone("cpm", c.cpm, med)), metric("Hook", fmt.pct(c.hookRate), tone("hookRate", c.hookRate, med)), metric("Hold", fmt.pct(c.holdRate), tone("holdRate", c.holdRate, med)));
  } else {
    m.push(metric("CPM", fmt.money(c.cpm), tone("cpm", c.cpm, med)), metric("CPC", fmt.money(c.cpc)), metric("Clicks", fmt.int(c.clicks)));
  }
  return m.join("");
}

function renderGrid(list, med) {
  $("#grid").innerHTML = list
    .slice(0, 400)
    .map(
      (c) => `
    <article class="card" data-key="${esc(c.key)}">
      <div class="thumb" data-open="${esc(c.key)}">
        ${thumbHtml(c)}
        <div class="tags">${platformBadge(c)}<span class="badge">${esc(c.format)}</span>${c.adCount > 1 ? `<span class="badge">${c.adCount} ads</span>` : ""}</div>
        <input class="pick" type="checkbox" title="Include in Claude analysis" data-pick="${esc(c.key)}" ${state.checked.has(c.key) ? "checked" : ""} />
      </div>
      <div class="info">
        <div class="name" title="${esc(c.adName)}">${esc(c.adName)}</div>
        <div class="sub" title="${esc(c.campaignName)}">${esc(c.accountName)} · ${esc(c.campaignName)}</div>
        <div class="metrics">${cardMetrics(c, med)}</div>
      </div>
    </article>`
    )
    .join("");
  if (list.length > 400) $("#grid").insertAdjacentHTML("beforeend", `<p class="muted">Showing the first 400 of ${list.length}. Narrow the filters to see more.</p>`);
}

const TABLE_COLS = [
  ["", null],
  ["Creative", "adName"],
  ["Platform", "platformLabel"],
  ["Spend", "spend", fmt.money],
  ["Impr.", "impressions", fmt.int],
  ["CPM", "cpm", fmt.money],
  ["CTR", "ctr", fmt.pct],
  ["CPC", "cpc", fmt.money],
  ["Conv.", "conversions", fmt.int],
  ["CPA", "cpa", fmt.money],
  ["ROAS", "roas", fmt.x],
  ["Hook", "hookRate", fmt.pct],
  ["Hold", "holdRate", fmt.pct],
];

function renderTable(list, med) {
  let rows = list;
  if (state.tableSort) {
    const { key, dir } = state.tableSort;
    rows = [...list].sort((a, b) => {
      const av = a[key], bv = b[key];
      if (typeof av === "string" || typeof bv === "string") return dir * String(av || "").localeCompare(String(bv || ""));
      return dir * ((av ?? -Infinity) - (bv ?? -Infinity));
    });
  }
  $("#table").innerHTML = `<table><thead><tr>${TABLE_COLS.map(([l, k]) => `<th data-sort="${k || ""}">${l}</th>`).join("")}</tr></thead><tbody>${rows
    .map(
      (c) => `<tr data-open="${esc(c.key)}">
        <td>${c.thumbnailUrl ? `<img loading="lazy" referrerpolicy="no-referrer" src="${esc(c.thumbnailUrl)}" alt="" />` : ""}</td>
        <td class="name-cell" title="${esc(c.adName)}">${esc(c.adName)}<div class="muted">${esc(c.accountName)}${c.adCount > 1 ? ` · ${c.adCount} ads` : ""}</div></td>
        <td>${esc(c.platformLabel)} · ${esc(c.format)}</td>
        ${TABLE_COLS.slice(3)
          .map(([, k, f]) => `<td class="v ${tone(k, c[k], med)}">${f(c[k])}</td>`)
          .join("")}
      </tr>`
    )
    .join("")}</tbody></table>`;
}

function openDetail(key) {
  const c = filtered().find((x) => x.key === key);
  if (!c) return;
  const med = medians(filtered());
  const isMp4 = c.videoUrl && /tiktokcdn|\.mp4/.test(c.videoUrl);
  const media = isMp4
    ? `<video src="${esc(c.videoUrl)}" poster="${esc(c.thumbnailUrl || "")}" controls playsinline referrerpolicy="no-referrer"></video>`
    : c.thumbnailUrl
      ? `<img src="${esc(c.thumbnailUrl)}" referrerpolicy="no-referrer" alt="" />`
      : `<div class="muted">No preview</div>`;
  const links = [
    c.previewUrl && !isMp4 ? `<a href="${esc(c.previewUrl)}" target="_blank" rel="noopener">Open ad preview</a>` : "",
    c.videoUrl && !isMp4 ? `<a href="${esc(c.videoUrl)}" target="_blank" rel="noopener">Open video</a>` : "",
    c.landingUrl ? `<a href="${esc(c.landingUrl)}" target="_blank" rel="noopener">Landing page</a>` : "",
  ].join("");
  $("#detail").innerHTML = `
    <div class="detail">
      <div class="media">${media}</div>
      <div class="content">
        <div style="display:flex;justify-content:space-between;gap:8px;align-items:start">
          <div>${platformBadge(c)} <span class="badge">${esc(c.format)}</span></div>
          <button class="btn btn-sm" data-close>Close</button>
        </div>
        <h2>${esc(c.adName)}</h2>
        <div class="muted">${esc(c.accountName)}<br/>${esc((c.campaigns || [c.campaignName]).join(", "))}${c.adGroupName ? ` · ${esc(c.adGroupName)}` : ""}</div>
        ${c.adCount > 1 ? `<div class="muted">Combined across ${c.adCount} ads with this creative.</div>` : ""}
        ${c.headline ? `<div><b>${esc(c.headline)}</b></div>` : ""}
        ${c.body ? `<div class="copy">${esc(c.body)}</div>` : ""}
        ${c.cta ? `<div class="muted">CTA: ${esc(c.cta)}</div>` : ""}
        <div class="metrics">
          ${metric("Spend", fmt.money(c.spend))}${metric("Impressions", fmt.int(c.impressions))}${metric("CPM", fmt.money(c.cpm), tone("cpm", c.cpm, med))}${metric("Clicks", fmt.int(c.clicks))}
          ${metric("CTR", fmt.pct(c.ctr), tone("ctr", c.ctr, med))}${metric("CPC", fmt.money(c.cpc))}${metric("Conversions", fmt.int(c.conversions))}${metric("CPA", fmt.money(c.cpa), tone("cpa", c.cpa, med))}
          ${metric("Conv. value", fmt.money(c.conversionValue))}${metric("ROAS", fmt.x(c.roas), tone("roas", c.roas, med))}
          ${c.format === "video" ? metric("Hook rate", fmt.pct(c.hookRate), tone("hookRate", c.hookRate, med)) + metric("Hold rate", fmt.pct(c.holdRate), tone("holdRate", c.holdRate, med)) : ""}
        </div>
        <div class="links">${links}</div>
        <p class="muted" style="font-size:12px">Green or red means at least 25% better or worse than the median of the creatives currently shown.</p>
      </div>
    </div>`;
  $("#detail").showModal();
}

// ---------- accounts ----------
function renderAccountMenu() {
  const q = $("#accountSearch").value.trim().toLowerCase();
  const byPlatform = {};
  for (const a of state.accounts) {
    if (q && !`${a.name} ${a.id}`.toLowerCase().includes(q)) continue;
    (byPlatform[a.connectorId] ||= []).push(a);
  }
  $("#accountList").innerHTML =
    Object.entries(byPlatform)
      .map(
        ([p, list]) =>
          `<h4>${esc(state.config.platforms[p] || p)}</h4>` +
          list
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((a) => {
              const k = `${a.connectorId}:${a.id}`;
              return `<label><input type="checkbox" data-account="${esc(k)}" ${state.selectedAccounts.has(k) ? "checked" : ""}/> <span>${esc(a.name)} <span class="muted">${esc(a.id)}</span></span></label>`;
            })
            .join("")
      )
      .join("") || `<p class="muted">No accounts found.</p>`;
  updateAccountBtn();
}
function updateAccountBtn() {
  const n = [...state.selectedAccounts].filter((k) => state.accounts.some((a) => `${a.connectorId}:${a.id}` === k)).length;
  $("#accountBtn").textContent = `Accounts: ${n || "none"}`;
  save("selectedAccounts", [...state.selectedAccounts]);
}

async function loadAccounts() {
  try {
    const res = await fetch("/api/accounts");
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || res.statusText);
    state.accounts = json.accounts;
    renderAccountMenu();
  } catch (err) {
    setStatus(`Could not load accounts from Two Minute Reports: ${err.message}`, true);
  }
}

// ---------- loading ads ----------
async function loadAds() {
  const accounts = [...state.selectedAccounts].filter((k) => state.accounts.some((a) => `${a.connectorId}:${a.id}` === k));
  if (!accounts.length) return setStatus("Pick at least one account first.", true);
  const params = new URLSearchParams({ accounts: accounts.join(","), start: $("#startDate").value, end: $("#endDate").value });
  if ($("#refreshToggle").checked) params.set("refresh", "1");
  save("range", { start: $("#startDate").value, end: $("#endDate").value });

  $("#loadBtn").disabled = true;
  state.ads = [];
  state.checked.clear();
  render();
  const errors = [];
  let loaded = 0;
  let oldest = Infinity;
  setStatus(`Loading ${accounts.length} account(s)... Two Minute Reports allows ~14 queries a minute, so large selections take a while the first time.`);
  try {
    const res = await fetch(`/api/ads?${params}`);
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.type === "progress") setStatus(`Fetching ${msg.account} (${loaded + 1}/${accounts.length})...`);
        if (msg.type === "ads") {
          loaded++;
          oldest = Math.min(oldest, msg.fetchedAt);
          state.ads.push(...msg.ads);
          refreshFilterOptions();
          render();
        }
        if (msg.type === "error") {
          loaded++;
          errors.push(`${msg.account}: ${msg.error}`);
        }
      }
    }
    const age = Number.isFinite(oldest) ? Math.round((Date.now() - oldest) / 60000) : 0;
    const freshness = age > 1 ? ` Data cached ${age < 120 ? `${age} min` : `${Math.round(age / 60)} h`} ago.` : "";
    setStatus(errors.length ? `Loaded with errors. ${errors.join(" | ")}` : `Loaded ${state.ads.length} ads from ${loaded} account(s).${freshness}`, errors.length > 0);
  } catch (err) {
    setStatus(`Failed to load ads: ${err.message}`, true);
  } finally {
    $("#loadBtn").disabled = false;
    render();
  }
}

function refreshFilterOptions() {
  const fill = (sel, values, label) => {
    const el = $(sel);
    const current = el.value;
    el.innerHTML = `<option value="">${label}</option>` + values.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join("");
    if (values.some(([v]) => v === current)) el.value = current;
  };
  const uniq = (arr) => [...new Map(arr.map((x) => [x[0], x])).values()];
  fill("#platformFilter", uniq(state.ads.map((a) => [a.platform, a.platformLabel])), "All platforms");
  fill("#formatFilter", uniq(state.ads.map((a) => [a.format, a.format])), "All formats");
  fill("#accountFilter", uniq(state.ads.map((a) => [`${a.platform}:${a.accountId}`, `${a.platformLabel}: ${a.accountName}`])), "All loaded accounts");
}

// ---------- Claude analysis ----------
function analysisSet() {
  const list = filtered();
  const mode = $("#analysisSelection").value;
  const bySpend = [...list].sort((a, b) => b.spend - a.spend);
  if (mode === "checked") return bySpend.filter((c) => state.checked.has(c.key));
  if (mode === "top15") return bySpend.slice(0, 15);
  if (mode === "topbottom") {
    const top = bySpend.slice(0, 15);
    // Bottom performers among creatives with meaningful spend, ranked on the
    // best available efficiency metric.
    const pool = bySpend.slice(15).filter((c) => c.spend >= (bySpend[Math.floor(bySpend.length / 2)]?.spend || 0));
    const score = (c) => c.roas ?? (c.cpa != null ? -c.cpa : c.ctr ?? 0);
    const bottom = pool.sort((a, b) => score(a) - score(b)).slice(0, 10);
    return [...top, ...bottom];
  }
  return bySpend.slice(0, 30);
}

function updateAnalysisScope() {
  const set = analysisSet();
  const spend = set.reduce((s, c) => s + c.spend, 0);
  $("#analysisScope").textContent = set.length
    ? `${set.length} creatives selected (spend ${fmt.money(spend)}). Claude sees each creative's image (video cover frame for videos), copy and metrics.`
    : "No creatives selected. Tick creatives in the gallery or pick another option.";
  $("#runAnalysis").disabled = !set.length || !state.config.claudeEnabled;
  if (!state.config.claudeEnabled) $("#analysisScope").textContent += " Set ANTHROPIC_API_KEY on the server to enable this.";
}

function renderReport(md, done) {
  const html = window.marked ? marked.parse(md) : `<pre>${esc(md)}</pre>`;
  $("#analysisOutput").innerHTML = (window.DOMPurify ? DOMPurify.sanitize(html) : esc(md)) + (done ? "" : `<p class="thinking">Claude is working...</p>`);
}

async function runAnalysis() {
  const set = analysisSet();
  if (!set.length) return;
  state.reportMarkdown = "";
  state.analysisAbort = new AbortController();
  $("#runAnalysis").disabled = true;
  $("#stopAnalysis").hidden = false;
  $("#downloadReport").hidden = true;
  renderReport("", false);
  try {
    const res = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ creatives: set.map((c) => c.adKeys), notes: $("#analysisNotes").value }),
      signal: state.analysisAbort.signal,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      state.reportMarkdown += decoder.decode(value, { stream: true });
      renderReport(state.reportMarkdown, false);
    }
  } catch (err) {
    if (err.name !== "AbortError") state.reportMarkdown += `\n\n> ${err.message}`;
  } finally {
    renderReport(state.reportMarkdown, true);
    $("#runAnalysis").disabled = false;
    $("#stopAnalysis").hidden = true;
    $("#downloadReport").hidden = !state.reportMarkdown;
    save("lastReport", state.reportMarkdown);
  }
}

function downloadReport() {
  const blob = new Blob([state.reportMarkdown], { type: "text/markdown" });
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(blob),
    download: `creative-analysis-${new Date().toISOString().slice(0, 10)}.md`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- wiring ----------
async function init() {
  state.config = await (await fetch("/api/config")).json();
  $("#demoBadge").hidden = !state.config.demo;
  const range = load("range", null);
  $("#startDate").value = range?.start || state.config.defaultRange.startDate;
  $("#endDate").value = range?.end || state.config.defaultRange.endDate;
  $("#analysisNotes").value = load("notes", "");
  await loadAccounts();

  $("#accountBtn").onclick = () => ($("#accountMenu").hidden = !$("#accountMenu").hidden);
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".account-picker")) $("#accountMenu").hidden = true;
  });
  $("#accountSearch").oninput = renderAccountMenu;
  $("#accountList").onchange = (e) => {
    const k = e.target.dataset.account;
    if (!k) return;
    e.target.checked ? state.selectedAccounts.add(k) : state.selectedAccounts.delete(k);
    updateAccountBtn();
  };
  $("#selectAllAccounts").onclick = () => {
    $("#accountList").querySelectorAll("[data-account]").forEach((el) => state.selectedAccounts.add(el.dataset.account));
    renderAccountMenu();
  };
  $("#clearAccounts").onclick = () => {
    state.selectedAccounts.clear();
    renderAccountMenu();
  };
  $("#loadBtn").onclick = loadAds;

  for (const id of ["#search", "#platformFilter", "#formatFilter", "#accountFilter", "#sortBy", "#groupToggle"]) {
    $(id).addEventListener("input", () => {
      if (id === "#groupToggle") state.checked.clear();
      render();
    });
  }
  document.querySelectorAll("[data-view]").forEach((b) =>
    b.addEventListener("click", () => {
      state.view = b.dataset.view;
      document.querySelectorAll("[data-view]").forEach((x) => x.classList.toggle("active", x === b));
      render();
    })
  );

  $("#grid").addEventListener("click", (e) => {
    const pick = e.target.closest("[data-pick]");
    if (pick) {
      pick.checked ? state.checked.add(pick.dataset.pick) : state.checked.delete(pick.dataset.pick);
      if (!$("#analysisPanel").hidden) updateAnalysisScope();
      return;
    }
    const open = e.target.closest("[data-open]");
    if (open) openDetail(open.dataset.open);
  });
  $("#table").addEventListener("click", (e) => {
    const th = e.target.closest("th[data-sort]");
    if (th && th.dataset.sort) {
      const key = th.dataset.sort;
      state.tableSort = { key, dir: state.tableSort?.key === key ? -state.tableSort.dir : LOW_IS_GOOD.has(key) ? 1 : -1 };
      return render();
    }
    const row = e.target.closest("[data-open]");
    if (row) openDetail(row.dataset.open);
  });
  $("#detail").addEventListener("click", (e) => {
    if (e.target === $("#detail") || e.target.closest("[data-close]")) $("#detail").close();
  });

  $("#analyzeBtn").onclick = () => {
    $("#analysisPanel").hidden = false;
    if (state.checked.size) $("#analysisSelection").value = "checked";
    updateAnalysisScope();
    if (!state.reportMarkdown) {
      state.reportMarkdown = load("lastReport", "");
      if (state.reportMarkdown) {
        renderReport(state.reportMarkdown, true);
        $("#downloadReport").hidden = false;
      }
    }
  };
  $("#closePanel").onclick = () => ($("#analysisPanel").hidden = true);
  $("#analysisSelection").onchange = updateAnalysisScope;
  $("#analysisNotes").oninput = () => save("notes", $("#analysisNotes").value);
  $("#runAnalysis").onclick = runAnalysis;
  $("#stopAnalysis").onclick = () => state.analysisAbort?.abort();
  $("#downloadReport").onclick = downloadReport;

  render();
}

init().catch((err) => setStatus(`Failed to start: ${err.message}`, true));
