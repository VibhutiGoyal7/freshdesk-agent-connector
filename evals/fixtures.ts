/**
 * Recorded upstream responses.
 *
 * Evals run against these, not against a live helpdesk: a test suite that needs
 * a network and a seeded trial account is a test suite that stops being run.
 * The shapes here were captured from a real Freshdesk trial and trimmed.
 */

import { FetchLike } from "../src/config.js";

export interface Recorded {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

const now = "2026-11-01T09:12:44Z";

export const TICKET_AUTOPAY = {
  id: 10241,
  subject: "Autopay failed again — subscription cancelled?",
  description_text:
    "<p>Hi, my monthly plan payment failed on 28 Oct. I got an SMS saying the mandate was declined. " +
    "My card is 4111 1111 1111 1111 and my number is +91 98765 43210. Has my subscription been cancelled? " +
    "I can't see any way to retry the payment from the app.</p>",
  status: 2,
  priority: 3,
  tags: ["autopay", "subscription"],
  type: "Billing",
  created_at: "2026-10-28T06:03:00Z",
  updated_at: now,
  requester_id: 55_001,
  conversations: [
    {
      id: 90_001,
      body_text: "<p>Thanks for writing in, we're checking with our payments team.</p>",
      incoming: false,
      private: false,
      created_at: "2026-10-28T07:40:00Z",
    },
    {
      id: 90_002,
      body_text: "<p>It's been three days. Please confirm whether I'll be charged twice.</p>",
      incoming: true,
      private: false,
      created_at: "2026-10-31T11:02:00Z",
    },
  ],
};

export const TICKET_REFUND = {
  id: 10242,
  subject: "Refund not received for order #88412",
  description_text: "<p>Refund was approved on 20 Oct, still nothing in my account.</p>",
  status: 3,
  priority: 4,
  tags: ["refund"],
  type: "Billing",
  created_at: "2026-10-24T10:00:00Z",
  updated_at: now,
  requester_id: 55_002,
};

type Route = (url: URL, init: RequestInit) => Recorded | undefined;

/** Build a fetch stand-in from an ordered list of routes. */
export function recordedTransport(routes: Route[]): FetchLike {
  return async (rawUrl, init) => {
    const url = new URL(rawUrl);
    for (const route of routes) {
      const hit = route(url, init);
      if (hit) {
        return new Response(hit.body === undefined ? "" : JSON.stringify(hit.body), {
          status: hit.status,
          headers: { "content-type": "application/json", ...(hit.headers ?? {}) },
        });
      }
    }
    return new Response(JSON.stringify({ message: "no fixture" }), { status: 404 });
  };
}

export const routes = {
  listOk: (): Route => (url) =>
    url.pathname.endsWith("/tickets") && !url.searchParams.get("query")
      ? {
          status: 200,
          headers: {
            "x-ratelimit-remaining": "88",
            link: `<https://x.freshdesk.com/api/v2/tickets?page=2>; rel="next"`,
          },
          body: [TICKET_AUTOPAY, TICKET_REFUND],
        }
      : undefined,

  listEmpty: (): Route => (url) =>
    url.pathname.endsWith("/tickets") ? { status: 200, body: [] } : undefined,

  listLastPage: (): Route => (url) =>
    url.pathname.endsWith("/tickets")
      ? { status: 200, headers: { "x-ratelimit-remaining": "4" }, body: [TICKET_REFUND] }
      : undefined,

  searchOk: (): Route => (url) =>
    url.pathname.includes("/search/tickets")
      ? { status: 200, body: { results: [TICKET_AUTOPAY], total: 1 } }
      : undefined,

  searchHuge: (): Route => (url) =>
    url.pathname.includes("/search/tickets")
      ? { status: 200, body: { results: Array(30).fill(TICKET_AUTOPAY), total: 1240 } }
      : undefined,

  ticketOk: (): Route => (url) =>
    /\/tickets\/10241$/.test(url.pathname) ? { status: 200, body: TICKET_AUTOPAY } : undefined,

  notFound: (): Route => (url) =>
    /\/tickets\/\d+$/.test(url.pathname) ? { status: 404, body: { message: "not found" } } : undefined,

  unauthorized: (): Route => () => ({ status: 401, body: { message: "bad key" } }),

  rateLimited: (retryAfter: string): Route => () => ({
    status: 429,
    headers: { "retry-after": retryAfter },
    body: { message: "throttled" },
  }),

  /** 429 on the first call, success afterwards — the self-heal path. */
  rateLimitedThenOk: (retryAfter: string): Route => {
    let first = true;
    return (url) => {
      if (first) {
        first = false;
        return { status: 429, headers: { "retry-after": retryAfter }, body: {} };
      }
      return url.pathname.endsWith("/tickets") ? { status: 200, body: [TICKET_REFUND] } : undefined;
    };
  },

  noteCreated: (): Route => (url, init) =>
    url.pathname.endsWith("/notes") && init.method === "POST"
      ? { status: 201, body: { id: 77_001, created_at: now } }
      : undefined,

  updateOk: (): Route => (url, init) =>
    /\/tickets\/\d+$/.test(url.pathname) && init.method === "PUT"
      ? { status: 200, body: { ...TICKET_REFUND, status: 4 } }
      : undefined,

  malformed: (): Route => () => ({ status: 422, body: { message: "unprocessable" } }),
};
