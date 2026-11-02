/**
 * Error model.
 *
 * Every failure the connector can produce is turned into a *structured, readable*
 * result rather than a thrown stack trace. An agent that receives
 * `{ ok: false, error: { kind: "rate_limited", retry_after_seconds: 23 } }`
 * can decide to wait, narrow its query, or escalate. An agent that receives a
 * 500-character stack trace burns context and usually retries blindly.
 */

export type ErrorKind =
  | "auth_failed"
  | "not_found"
  | "rate_limited"
  | "invalid_input"
  | "permission_denied"
  | "upstream_unavailable"
  | "upstream_error";

export interface ConnectorError {
  kind: ErrorKind;
  /** One sentence the model can act on. No stack traces, no raw HTML. */
  message: string;
  /** Present when kind === "rate_limited". */
  retry_after_seconds?: number;
  /** True when retrying the identical call could plausibly succeed. */
  retryable: boolean;
  /** What the agent should do instead, when there is a sensible alternative. */
  remediation?: string;
}

export class FreshdeskError extends Error {
  readonly detail: ConnectorError;
  constructor(detail: ConnectorError) {
    super(detail.message);
    this.name = "FreshdeskError";
    this.detail = detail;
  }
}

export function classifyHttp(status: number, retryAfterSeconds?: number): ConnectorError {
  switch (status) {
    case 401:
    case 403:
      return {
        kind: status === 401 ? "auth_failed" : "permission_denied",
        message:
          status === 401
            ? "Freshdesk rejected the API key for this merchant."
            : "The API key is valid but lacks permission for this resource.",
        retryable: false,
        remediation:
          "Stop and surface this to a human: the merchant needs to reissue or re-scope the key. Retrying will not help.",
      };
    case 404:
      return {
        kind: "not_found",
        message: "No such ticket or resource in this merchant's Freshdesk.",
        retryable: false,
        remediation: "Check the ticket id, or use search_tickets to find the right one.",
      };
    case 429:
      return {
        kind: "rate_limited",
        message: "Freshdesk rate limit reached for this merchant.",
        retry_after_seconds: retryAfterSeconds ?? 60,
        retryable: true,
        remediation:
          "Wait the stated number of seconds before the next call, or narrow the query so fewer pages are needed.",
      };
    case 400:
    case 422:
      return {
        kind: "invalid_input",
        message: "Freshdesk rejected the request as malformed.",
        retryable: false,
        remediation: "Re-read the tool schema and correct the arguments before retrying.",
      };
    case 502:
    case 503:
    case 504:
      return {
        kind: "upstream_unavailable",
        message: "Freshdesk is temporarily unavailable.",
        retryable: true,
        remediation: "Retry with backoff; if it persists, report the outage rather than looping.",
      };
    default:
      return {
        kind: "upstream_error",
        message: `Freshdesk returned an unexpected status ${status}.`,
        retryable: status >= 500,
      };
  }
}
