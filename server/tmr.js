// Two Minute Reports REST API client.
// Docs: https://twominutereports.com/help/api
//
// run-query is limited to 15 requests/minute and 500/hour per team, and a
// single request times out after ~60s (HTTP 504). This client:
//   - serialises run-query calls and spaces them out to stay under the limit
//   - retries 429 / 503 with backoff
//   - on 504, splits the date range in half and merges the results

const BASE_URL = process.env.TMR_BASE_URL || "https://api.twominutereports.com/v1";
const MIN_QUERY_SPACING_MS = 4200; // ~14 req/min, just under the 15/min limit
const MAX_SPLIT_DEPTH = 3; // a year can be split down to ~6-week chunks

export class TmrError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = "TmrError";
    this.status = status;
    this.code = code;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class TmrClient {
  constructor({ apiKey, teamId }) {
    if (!apiKey) throw new Error("TMR_API_KEY is not set");
    if (!teamId) throw new Error("TMR_TEAM_ID is not set");
    this.apiKey = apiKey;
    this.teamId = teamId;
    this.queue = Promise.resolve();
    this.lastQueryAt = 0;
  }

  async request(method, path, body) {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    // 504s and edge-network 429s can come back as HTML, so check status first.
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON body */
    }
    if (!res.ok || json?.success === false) {
      const code = json?.error?.code || `HTTP_${res.status}`;
      const message = json?.error?.message || text.slice(0, 200) || res.statusText;
      throw new TmrError(`${code}: ${message}`, { status: res.status, code });
    }
    return json;
  }

  async listAccounts(connectorId) {
    const json = await this.request(
      "GET",
      `/teams/${this.teamId}/connectors/${connectorId}/accounts?status=enabled`
    );
    return json.data || [];
  }

  // Serialise run-query calls and keep them under the rate limit.
  runQuery(body) {
    const job = this.queue.then(async () => {
      const wait = this.lastQueryAt + MIN_QUERY_SPACING_MS - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastQueryAt = Date.now();
      return this.runQueryWithRetry(body);
    });
    // Keep the queue alive even if this job fails.
    this.queue = job.catch(() => {});
    return job;
  }

  async runQueryWithRetry(body, attempt = 0) {
    try {
      const json = await this.request("POST", `/teams/${this.teamId}/data/run-query`, body);
      return json.data || [];
    } catch (err) {
      const retryable = err.status === 429 || err.status === 503;
      if (retryable && attempt < 4) {
        await sleep(2000 * 2 ** attempt + Math.random() * 1000);
        this.lastQueryAt = Date.now();
        return this.runQueryWithRetry(body, attempt + 1);
      }
      throw err;
    }
  }

  // Runs a query over a custom date range. If it times out, splits the range
  // in two and runs each half (results are returned as separate row sets so
  // the caller can merge additive metrics by key).
  async runQuerySplitting(body, { startDate, endDate }, depth = 0) {
    try {
      const rows = await this.runQuery({ ...body, dateRange: { startDate, endDate } });
      return [rows];
    } catch (err) {
      const timedOut = err.status === 504 || err.code === "UPSTREAM_JOB_TIMEOUT";
      if (!timedOut || depth >= MAX_SPLIT_DEPTH || startDate === endDate) throw err;
      const [a, b] = splitRange(startDate, endDate);
      const left = await this.runQuerySplitting(body, a, depth + 1);
      const right = await this.runQuerySplitting(body, b, depth + 1);
      return [...left, ...right];
    }
  }
}

export function splitRange(startDate, endDate) {
  const s = Date.parse(`${startDate}T00:00:00Z`);
  const e = Date.parse(`${endDate}T00:00:00Z`);
  const mid = s + Math.floor((e - s) / 86400000 / 2) * 86400000;
  const fmt = (t) => new Date(t).toISOString().slice(0, 10);
  return [
    { startDate: fmt(s), endDate: fmt(mid) },
    { startDate: fmt(mid + 86400000), endDate: fmt(e) },
  ];
}
