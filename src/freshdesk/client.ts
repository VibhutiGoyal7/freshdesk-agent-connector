/**
 * Freshdesk HTTP client.
 *
 * Responsibilities: auth, rate limiting, retries, idempotency, redaction, and
 * turning every outcome into something structured. Tool handlers above this layer
 * never see a Response object and never see a raw network error.
 */

import { ConnectorConfig, FetchLike } from "../config.js";
import { FreshdeskError, classifyHttp } from "../errors.js";
import { ConcurrencyGate, TokenBucket, backoffMs, sleep } from "./limiter.js";
import { log } from "../log.js";

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT";
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Supplied on writes so a retry cannot create a duplicate note. */
  idempotencyKey?: string;
  /** Tool name, for logging only. */
  tool: string;
}

export interface FreshdeskResponse<T> {
  data: T;
  /** Freshdesk's own view of remaining quota, when it tells us. */
  rateLimitRemaining?: number;
  /** Present on list endpoints that paginate via Link headers. */
  nextPage?: number;
}

const MAX_ATTEMPTS = 4;

export class FreshdeskClient {
  private readonly bucket: TokenBucket;
  private readonly gate: ConcurrencyGate;
  private readonly fetchImpl: FetchLike;
  /** idempotency key -> response already returned for it. */
  private readonly writeCache = new Map<string, unknown>();

  constructor(private readonly cfg: ConnectorConfig) {
    this.bucket = new TokenBucket(cfg.rateLimitPerMinute);
    this.gate = new ConcurrencyGate(cfg.maxConcurrency);
    this.fetchImpl = cfg.transport ?? ((url, init) => fetch(url, init));
  }

  private authHeader(): string {
    // Freshdesk takes the API key as the basic-auth username with any password.
    return "Basic " + Buffer.from(`${this.cfg.apiKey}:X`).toString("base64");
  }

  private url(path: string, query?: RequestOptions["query"]): string {
    const u = new URL(`https://${this.cfg.domain}.freshdesk.com/api/v2${path}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  async request<T>(opts: RequestOptions): Promise<FreshdeskResponse<T>> {
    const method = opts.method ?? "GET";

    if (opts.idempotencyKey && this.writeCache.has(opts.idempotencyKey)) {
      log.info({ tool: opts.tool, event: "idempotent_replay", key: opts.idempotencyKey });
      return { data: this.writeCache.get(opts.idempotencyKey) as T };
    }

    const release = await this.gate.acquire();
    const started = Date.now();
    try {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        await sleep(this.bucket.delayMs());
        this.bucket.take();

        let res: Response;
        try {
          res = await this.fetchImpl(this.url(opts.path, opts.query), {
            method,
            headers: {
              Authorization: this.authHeader(),
              "Content-Type": "application/json",
              Accept: "application/json",
              "User-Agent": "agent-studio-freshdesk-connector/0.1",
            },
            body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          });
        } catch (cause) {
          // Network-level failure: retry a GET, surface a write immediately so we
          // never risk a duplicate side effect we cannot see.
          if (method === "GET" && attempt < MAX_ATTEMPTS - 1) {
            await sleep(backoffMs(attempt));
            continue;
          }
          throw new FreshdeskError({
            kind: "upstream_unavailable",
            message: "Could not reach Freshdesk.",
            retryable: method === "GET",
            remediation: "Report the connectivity failure rather than retrying in a loop.",
          });
        }

        const remaining = numHeader(res, "x-ratelimit-remaining");

        if (res.status === 429) {
          const retryAfter = numHeader(res, "retry-after") ?? 60;
          this.bucket.drain();
          log.warn({ tool: opts.tool, event: "rate_limited", retryAfter, attempt });
          // Only self-heal within the call if the wait is short; otherwise hand the
          // decision back to the agent, which may prefer to narrow its query.
          if (attempt < MAX_ATTEMPTS - 1 && retryAfter <= 30) {
            await sleep(retryAfter * 1000 + backoffMs(attempt, 250, 2000));
            continue;
          }
          throw new FreshdeskError(classifyHttp(429, retryAfter));
        }

        if (res.status >= 500 && attempt < MAX_ATTEMPTS - 1 && method === "GET") {
          await sleep(backoffMs(attempt));
          continue;
        }

        if (!res.ok) {
          log.warn({ tool: opts.tool, event: "upstream_error", status: res.status });
          throw new FreshdeskError(classifyHttp(res.status));
        }

        const text = await res.text();
        const data = (text ? JSON.parse(text) : null) as T;

        if (opts.idempotencyKey) this.writeCache.set(opts.idempotencyKey, data);

        log.info({
          tool: opts.tool,
          event: "ok",
          method,
          path: opts.path,
          status: res.status,
          ms: Date.now() - started,
          rate_remaining: remaining ?? this.bucket.available,
        });

        return { data, rateLimitRemaining: remaining, nextPage: parseNextPage(res) };
      }
      throw new FreshdeskError(classifyHttp(503));
    } finally {
      release();
    }
  }
}

function numHeader(res: Response, name: string): number | undefined {
  const raw = res.headers?.get?.(name);
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

/** Freshdesk paginates with an RFC5988 Link header: <...page=3...>; rel="next" */
function parseNextPage(res: Response): number | undefined {
  const link = res.headers?.get?.("link");
  if (!link) return undefined;
  const m = /[?&]page=(\d+)[^>]*>;\s*rel="next"/.exec(link);
  return m ? Number.parseInt(m[1], 10) : undefined;
}
