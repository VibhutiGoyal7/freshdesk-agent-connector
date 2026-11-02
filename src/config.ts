/**
 * Connector configuration.
 *
 * Credentials are read from the environment, never from tool arguments and never
 * from the model's context. A merchant's Freshdesk key is tenant-scoped: one
 * running connector instance serves exactly one merchant, so a prompt-injected
 * instruction cannot make the agent reach another merchant's helpdesk.
 */

import { existsSync, readFileSync } from "node:fs";

export interface ConnectorConfig {
  /** Freshdesk subdomain, e.g. "acme" for acme.freshdesk.com */
  domain: string;
  /** Freshdesk API key (used as the basic-auth username, password is "X"). */
  apiKey: string;
  /** Merchant identifier used in logs. Never sent upstream. */
  merchantId: string;
  /** Requests per minute allowed by the merchant's Freshdesk plan. */
  rateLimitPerMinute: number;
  /** Max in-flight HTTP requests. Keeps a burst of parallel tool calls civil. */
  maxConcurrency: number;
  /** Hard ceiling on characters returned by any single tool call. */
  maxResponseChars: number;
  /**
   * Whether customer-facing writes (public replies) are permitted at all.
   * Default false: the agent may draft internally, a human sends.
   */
  allowCustomerFacingWrites: boolean;
  /** Set by the eval harness to replay recorded fixtures instead of real HTTP. */
  transport?: FetchLike;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return v.trim();
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer, got "${raw}".`);
  }
  return n;
}

/**
 * Load .env from the working directory if present. Real env vars win, so an
 * agent host that injects credentials is unaffected; this only helps local
 * runs (smoke, evals, the demo agent) on machines without direnv.
 */
function loadDotEnv(): void {
  if (!existsSync(".env")) return;
  for (const raw of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

export function loadConfig(): ConnectorConfig {
  loadDotEnv();
  return {
    domain: requireEnv("FRESHDESK_DOMAIN").replace(/\.freshdesk\.com$/i, ""),
    apiKey: requireEnv("FRESHDESK_API_KEY"),
    merchantId: process.env.MERCHANT_ID?.trim() || "unknown-merchant",
    // Freshdesk rate limits are per-plan and per-minute. Set this to your plan's
    // documented ceiling; the connector stays strictly under it rather than
    // discovering the limit by being throttled.
    rateLimitPerMinute: intEnv("FRESHDESK_RATE_LIMIT_PER_MINUTE", 100),
    maxConcurrency: intEnv("MAX_CONCURRENCY", 4),
    maxResponseChars: intEnv("MAX_RESPONSE_CHARS", 12000),
    allowCustomerFacingWrites: process.env.ALLOW_CUSTOMER_FACING_WRITES === "true",
  };
}
