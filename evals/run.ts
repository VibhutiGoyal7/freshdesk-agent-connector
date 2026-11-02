/**
 * Eval pack.
 *
 * These are not unit tests of functions; they are assertions about what the
 * *agent sees*. Each case runs a real tool handler against a recorded upstream
 * and checks the contract the model depends on: that enums are words, that PII
 * is gone, that a 429 arrives as a waitable instruction rather than an
 * exception, that a retried write does not double-post.
 *
 * Run: npm run evals
 */

import { ConnectorConfig } from "../src/config.js";
import { FreshdeskClient } from "../src/freshdesk/client.js";
import { FreshdeskError } from "../src/errors.js";
import { TOOLS, ToolContext } from "../src/tools/index.js";
import { recordedTransport, routes } from "./fixtures.js";
import { ConcurrencyGate, TokenBucket, backoffMs } from "../src/freshdesk/limiter.js";

interface Case {
  name: string;
  why: string;
  run: () => Promise<void>;
}

function ctxWith(transport: ConnectorConfig["transport"], over: Partial<ConnectorConfig> = {}): ToolContext {
  const cfg: ConnectorConfig = {
    domain: "acme",
    apiKey: "test-key",
    merchantId: "acme",
    rateLimitPerMinute: 600,
    maxConcurrency: 4,
    maxResponseChars: 12_000,
    allowCustomerFacingWrites: false,
    transport,
    ...over,
  };
  return { cfg, client: new FreshdeskClient(cfg) };
}

const tool = (name: string) => {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};

async function call(ctx: ToolContext, name: string, args: unknown): Promise<any> {
  const t = tool(name);
  const parsed = t.schema.parse(args);
  return t.run(ctx, parsed);
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const cases: Case[] = [
  // ---- Rate limiting, tested directly rather than only through the 429 path ----
  {
    name: "token bucket refuses the N+1th call inside a minute",
    why: "Staying under the plan ceiling is the whole point; prove the arithmetic.",
    async run() {
      let t = 0;
      const bucket = new TokenBucket(60, () => t); // 60/min = 1 token per second
      for (let i = 0; i < 60; i++) bucket.take();
      assert(bucket.delayMs() > 0, "61st call should have to wait");
      assert(bucket.delayMs() <= 1000, `wait should be ~1s at this rate, got ${bucket.delayMs()}ms`);
    },
  },
  {
    name: "token bucket refills with elapsed time, not with retries",
    why: "A limiter that refills on retry is a limiter in name only.",
    async run() {
      let t = 0;
      const bucket = new TokenBucket(60, () => t);
      for (let i = 0; i < 60; i++) bucket.take();
      t += 30_000; // half a minute later
      assert(bucket.available === 30, `expected 30 tokens after 30s, got ${bucket.available}`);
    },
  },
  {
    name: "a real 429 drains the bucket regardless of local estimate",
    why: "The server's view of the limit is authoritative; ours is a guess.",
    async run() {
      const bucket = new TokenBucket(600);
      const before: number = bucket.available;
      assert(before === 600, "fresh bucket should be full");
      bucket.drain();
      const after: number = bucket.available;
      assert(after === 0, "drain must zero the bucket");
    },
  },
  {
    name: "backoff grows with attempts, is capped, and is jittered",
    why: "Un-jittered backoff synchronises retries across agents into a thundering herd.",
    async run() {
      const hi = backoffMs(10, 500, 20_000, () => 0.999);
      assert(hi < 20_000, `cap not applied: ${hi}`);
      const a0 = backoffMs(0, 500, 20_000, () => 0.999);
      const a3 = backoffMs(3, 500, 20_000, () => 0.999);
      assert(a3 > a0, "later attempts should wait longer");
      const lo = backoffMs(3, 500, 20_000, () => 0);
      assert(lo === 0, "full jitter must allow zero wait");
    },
  },
  {
    name: "concurrency gate never admits more than its limit",
    why: "One agent turn can fan out into a dozen parallel tool calls; the helpdesk is not a load target.",
    async run() {
      const gate = new ConcurrencyGate(2);
      let active = 0;
      let peak = 0;
      const job = async () => {
        const release = await gate.acquire();
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        release();
      };
      await Promise.all([job(), job(), job(), job(), job()]);
      assert(peak === 2, `peak concurrency was ${peak}, limit is 2`);
    },
  },
  {
    name: "parallel tool calls are serialised through the gate at the client level",
    why: "The gate must actually be wired in, not just exist as a class.",
    async run() {
      let inFlight = 0;
      let peak = 0;
      const ctx = ctxWith(
        async (url, init) => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight--;
          return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
        },
        { maxConcurrency: 2 },
      );
      await Promise.all(Array.from({ length: 6 }, () => call(ctx, "list_tickets", {})));
      assert(peak <= 2, `client let ${peak} requests through at once`);
    },
  },

  // ---- Tool contract ----
  {
    name: "get_ticket_thread says whether the thread is complete",
    why: "Freshdesk embeds only the latest 10 messages; implying completeness would mislead the agent.",
    async run() {
      const ctx = ctxWith(recordedTransport([routes.ticketOk()]));
      const out = await call(ctx, "get_ticket_thread", { ticket_id: 10241 });
      assert(out.data.thread_complete === true, "2-message fixture should be reported complete");
    },
  },
  {
    name: "list_tickets states the time window it covered",
    why: "Freshdesk's 30-day default is invisible otherwise, and an agent will report 'no older tickets' when it simply never asked.",
    async run() {
      const ctx = ctxWith(recordedTransport([routes.listOk()]));
      const out = await call(ctx, "list_tickets", {});
      assert(/30 days/.test(out.data.window), "window should mention the 30-day default");
    },
  },
  {
    name: "list_tickets returns word enums, not Freshdesk integers",
    why: "A model reasoning over status:2 will guess. Over 'open' it will not.",
    async run() {
      const ctx = ctxWith(recordedTransport([routes.listOk()]));
      const out = await call(ctx, "list_tickets", { limit: 20 });
      assert(out.ok, "expected ok");
      assert(out.data.tickets[0].status === "open", "status should be 'open'");
      assert(out.data.tickets[0].priority === "high", "priority should be 'high'");
    },
  },
  {
    name: "list_tickets exposes a next cursor from the Link header",
    why: "Pagination the agent can continue without constructing URLs itself.",
    async run() {
      const ctx = ctxWith(recordedTransport([routes.listOk()]));
      const out = await call(ctx, "list_tickets", {});
      assert(out.data.next_cursor === "2", `expected cursor '2', got ${out.data.next_cursor}`);
    },
  },
  {
    name: "last page reports next_cursor: null rather than omitting it",
    why: "An absent field reads as 'unknown'; null reads as 'you are done'.",
    async run() {
      const ctx = ctxWith(recordedTransport([routes.listLastPage()]));
      const out = await call(ctx, "list_tickets", {});
      assert(out.data.next_cursor === null, "expected explicit null");
    },
  },
  {
    name: "empty result is a successful empty list, not an error",
    why: "'No tickets match' is an answer. Agents retry errors; they report answers.",
    async run() {
      const ctx = ctxWith(recordedTransport([routes.listEmpty()]));
      const out = await call(ctx, "list_tickets", {});
      assert(out.ok && out.data.count === 0, "expected ok with zero rows");
    },
  },
  {
    name: "customer PII is redacted by default",
    why: "Card and phone numbers must not reach the model unless explicitly requested.",
    async run() {
      const ctx = ctxWith(recordedTransport([routes.listOk()]));
      const out = await call(ctx, "list_tickets", {});
      const blob = JSON.stringify(out);
      assert(!blob.includes("4111"), "card number leaked into tool output");
      assert(!blob.includes("98765"), "phone number leaked into tool output");
      assert(blob.includes("[card-redacted]"), "redaction marker missing");
    },
  },
  {
    name: "get_ticket_thread can return contact details when explicitly asked",
    why: "Redaction is a default, not a wall — the escape hatch is auditable.",
    async run() {
      const ctx = ctxWith(recordedTransport([routes.ticketOk()]));
      const out = await call(ctx, "get_ticket_thread", { ticket_id: 10241, include_contact: true });
      assert(out.data.pii_redacted === false, "flag should report unredacted");
      assert(JSON.stringify(out).includes("4111"), "expected raw body when include_contact is set");
    },
  },
  {
    name: "get_ticket_thread orders messages and labels who sent them",
    why: "Direction and visibility are what a triage agent reasons over.",
    async run() {
      const ctx = ctxWith(recordedTransport([routes.ticketOk()]));
      const out = await call(ctx, "get_ticket_thread", { ticket_id: 10241 });
      assert(out.data.messages[0].from === "agent", "first message should be from the agent");
      assert(out.data.messages[1].from === "customer", "second should be the customer");
      assert(out.data.messages[0].visibility === "customer_visible", "visibility must be labelled");
    },
  },
  {
    name: "field projection actually shrinks the payload",
    why: "The token budget claim has to be measurable, not asserted in a README.",
    async run() {
      const ctx = ctxWith(recordedTransport([routes.listOk()]));
      const full = await call(ctx, "list_tickets", {});
      const thin = await call(ctx, "list_tickets", { fields: ["id", "subject", "status"] });
      const fullLen = JSON.stringify(full).length;
      const thinLen = JSON.stringify(thin).length;
      assert(thinLen < fullLen * 0.7, `projection saved too little: ${fullLen} -> ${thinLen}`);
    },
  },
  {
    name: "429 surfaces as a structured, waitable error",
    why: "The agent needs to know how long to wait — not to see a stack trace.",
    async run() {
      const ctx = ctxWith(recordedTransport([routes.rateLimited("120")]));
      try {
        await call(ctx, "list_tickets", {});
        throw new Error("expected a rate limit error");
      } catch (e) {
        assert(e instanceof FreshdeskError, "expected FreshdeskError");
        assert(e.detail.kind === "rate_limited", "wrong kind");
        assert(e.detail.retry_after_seconds === 120, "Retry-After not propagated");
        assert(e.detail.retryable === true, "should be marked retryable");
      }
    },
  },
  {
    name: "a short 429 is absorbed by the connector, not handed to the agent",
    why: "Burning a model turn on a two-second wait is waste; a two-minute wait is a decision.",
    async run() {
      const ctx = ctxWith(recordedTransport([routes.rateLimitedThenOk("0")]));
      const out = await call(ctx, "list_tickets", {});
      assert(out.ok, "expected the retry to succeed transparently");
    },
  },
  {
    name: "401 is non-retryable and says a human must act",
    why: "An agent looping on a revoked key is the classic overnight incident.",
    async run() {
      const ctx = ctxWith(recordedTransport([routes.unauthorized()]));
      try {
        await call(ctx, "list_tickets", {});
        throw new Error("expected auth failure");
      } catch (e) {
        assert(e instanceof FreshdeskError, "expected FreshdeskError");
        assert(e.detail.kind === "auth_failed", "wrong kind");
        assert(e.detail.retryable === false, "auth failure must not be retryable");
        assert(!!e.detail.remediation, "must tell the agent what to do instead");
      }
    },
  },
  {
    name: "404 points the agent at search instead of dead-ending",
    why: "Remediation turns a failure into the next correct call.",
    async run() {
      const ctx = ctxWith(recordedTransport([routes.notFound()]));
      try {
        await call(ctx, "get_ticket_thread", { ticket_id: 999_999 });
        throw new Error("expected not found");
      } catch (e) {
        assert(e instanceof FreshdeskError && /search_tickets/.test(e.detail.remediation ?? ""), "no remediation");
      }
    },
  },
  {
    name: "search with no filters is refused before a request is made",
    why: "Cheaper to reject locally than to let the agent scan the whole helpdesk.",
    async run() {
      const ctx = ctxWith(recordedTransport([routes.searchOk()]));
      try {
        await call(ctx, "search_tickets", {});
        throw new Error("expected refusal");
      } catch (e) {
        assert(e instanceof FreshdeskError && e.detail.kind === "invalid_input", "wrong kind");
      }
    },
  },
  {
    name: "search warns when the index cannot return everything that matches",
    why: "Silent truncation makes an agent confidently wrong about volume.",
    async run() {
      const ctx = ctxWith(recordedTransport([routes.searchHuge()]));
      const out = await call(ctx, "search_tickets", { tag: "autopay" });
      assert(out.data.total_matching === 1240, "total should be reported");
      assert(/Narrow the filters/.test(out.data.note ?? ""), "missing truncation warning");
    },
  },
  {
    name: "a retried note with the same idempotency key posts once",
    why: "Agents retry. A merchant's ticket must not collect three identical notes.",
    async run() {
      let posts = 0;
      const ctx = ctxWith(
        recordedTransport([
          (url, init) => {
            if (url.pathname.endsWith("/notes") && init.method === "POST") {
              posts++;
              return { status: 201, body: { id: 77_001, created_at: "2026-11-01T09:00:00Z" } };
            }
            return undefined;
          },
        ]),
      );
      const args = { ticket_id: 10241, body: "Autopay mandate declined.", idempotency_key: "triage-10241-run7" };
      await call(ctx, "add_private_note", args);
      await call(ctx, "add_private_note", args);
      assert(posts === 1, `expected one POST, got ${posts}`);
    },
  },
  {
    name: "notes are always internal",
    why: "The connector's core guardrail: the agent cannot speak to a customer.",
    async run() {
      let sentPrivate: unknown;
      const ctx = ctxWith(
        recordedTransport([
          (url, init) => {
            if (url.pathname.endsWith("/notes")) {
              sentPrivate = JSON.parse(String(init.body)).private;
              return { status: 201, body: { id: 1, created_at: "x" } };
            }
            return undefined;
          },
        ]),
      );
      await call(ctx, "add_private_note", { ticket_id: 1, body: "x", idempotency_key: "k-00000001" });
      assert(sentPrivate === true, "note was not marked private");
    },
  },
  {
    name: "no tool on the surface can send a customer-visible message",
    why: "Stated as a guarantee in the doc, so it is asserted here rather than trusted.",
    async run() {
      const exposed = TOOLS.filter((t) => t.effect === "write_customer_facing");
      assert(exposed.length === 0, "a customer-facing write tool is exposed");
    },
  },
  {
    name: "update_ticket is flagged as needing approval",
    why: "Agent Studio reads this to decide where a human stands in the loop.",
    async run() {
      assert(tool("update_ticket").requiresApproval === true, "state change must require approval");
      assert(tool("add_private_note").requiresApproval === false, "internal notes should not block");
    },
  },
  {
    name: "update_ticket with nothing to change is rejected",
    why: "A no-op write still costs a call and muddies the audit log.",
    async run() {
      const ctx = ctxWith(recordedTransport([routes.updateOk()]));
      try {
        await call(ctx, "update_ticket", { ticket_id: 1, idempotency_key: "k-00000002", reason: "because reasons" });
        throw new Error("expected rejection");
      } catch (e) {
        assert(e instanceof FreshdeskError && e.detail.kind === "invalid_input", "wrong kind");
      }
    },
  },
  {
    name: "422 from upstream is reported as invalid input, not a transient fault",
    why: "Retrying a malformed request forever is the other classic overnight incident.",
    async run() {
      const ctx = ctxWith(recordedTransport([routes.malformed()]));
      try {
        await call(ctx, "list_tickets", {});
        throw new Error("expected invalid_input");
      } catch (e) {
        assert(e instanceof FreshdeskError && e.detail.retryable === false, "must not be retryable");
      }
    },
  },
  {
    name: "oversized list results drop rows but keep their metadata",
    why: "The totals and warnings are what tell the agent to narrow — losing them to truncation is the worst outcome.",
    async run() {
      const ctx = ctxWith(recordedTransport([routes.searchHuge()]), { maxResponseChars: 1200 });
      const out = await call(ctx, "search_tickets", { tag: "autopay" });
      assert(out.capped === true, "expected capped flag");
      assert(/row\(s\) omitted/.test(out.budget_note ?? ""), "missing budget note");
      assert(out.data.total_matching === 1240, "metadata must survive capping");
      assert(out.data.tickets.length < 30, "rows should have been dropped");
    },
  },
];

async function main(): Promise<void> {
  let passed = 0;
  const failures: Array<{ name: string; error: string }> = [];
  const started = Date.now();

  for (const c of cases) {
    try {
      await c.run();
      passed++;
      process.stdout.write(`  PASS  ${c.name}\n`);
    } catch (err) {
      failures.push({ name: c.name, error: String((err as Error)?.message ?? err) });
      process.stdout.write(`  FAIL  ${c.name}\n        ${String((err as Error)?.message ?? err)}\n`);
    }
  }

  process.stdout.write(
    `\n${passed}/${cases.length} passed in ${Date.now() - started}ms\n`,
  );
  if (failures.length) process.exit(1);
}

main();
