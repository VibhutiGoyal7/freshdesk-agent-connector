/**
 * Tool surface.
 *
 * Five tools, chosen to match what an agent actually does in a support workflow:
 * find the relevant tickets, read one properly, record a judgement, change state.
 * This is deliberately *not* a 1:1 mirror of the Freshdesk API — a mirror makes
 * the model do integration work at inference time, badly and expensively.
 *
 * The write split is the important design decision:
 *   add_private_note  — internal, reversible, allowed autonomously
 *   update_ticket     — state change, requires human approval, logged with a reason
 *   reply_to_customer — NOT exposed. Customer-facing text needs a human.
 */

import { z } from "zod";
import { FreshdeskClient, FreshdeskResponse } from "../freshdesk/client.js";
import { ConnectorConfig } from "../config.js";
import { FreshdeskError } from "../errors.js";
import { log } from "../log.js";
import {
  PRIORITY,
  RawConversation,
  RawTicket,
  STATUS,
  capPayload,
  capRows,
  project,
  redactPii,
  stripHtml,
  toSummary,
} from "../normalize.js";

/**
 * Freshdesk embeds at most this many conversations on GET /tickets/{id}?include=conversations,
 * and they are the ten OLDEST (ascending created_at), not the latest. Longer threads
 * are paged from /tickets/{id}/conversations instead.
 */
const FRESHDESK_EMBEDDED_CONVERSATION_CAP = 10;
/** 30 per page is Freshdesk's maximum for /conversations; three pages covers 90 messages. */
const CONVERSATION_PAGES_MAX = 3;

const statusName = z.enum(["open", "pending", "resolved", "closed"]);
const priorityName = z.enum(["low", "medium", "high", "urgent"]);

/** Freshdesk search literals are single-quoted inside a double-quoted query: strip both plus control chars. */
const searchLiteral = (s: string) => s.replace(/["'\p{Cc}]/gu, "");

const codeFor = (map: Record<number, string>, name: string): number =>
  Number(Object.entries(map).find(([, v]) => v === name)?.[0]);

export interface ToolContext {
  client: FreshdeskClient;
  cfg: ConnectorConfig;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  schema: z.ZodTypeAny;
  /** Declared for the capability doc and for Agent Studio's approval model. */
  effect: "read" | "write_internal" | "write_state" | "write_customer_facing";
  requiresApproval: boolean;
  run: (ctx: ToolContext, args: any) => Promise<unknown>;
}

const ok = (payload: unknown, cfg: ConnectorConfig) => {
  // List results shed rows; single objects fall back to string truncation.
  if (payload && typeof payload === "object" && Array.isArray((payload as any).tickets)) {
    const { value, capped, dropped } = capRows(payload as { tickets: unknown[] }, cfg.maxResponseChars);
    return {
      ok: true,
      capped,
      ...(capped
        ? {
            budget_note: `${dropped} row(s) omitted to stay within the response budget. Request fewer fields, a smaller limit, or a narrower filter.`,
          }
        : {}),
      data: value,
    };
  }
  const { value, capped } = capPayload(payload, cfg.maxResponseChars);
  return { ok: true, capped, data: value };
};

export const TOOLS: ToolDef[] = [
  {
    name: "list_tickets",
    title: "List tickets",
    effect: "read",
    requiresApproval: false,
    description:
      "List tickets in recency order, optionally filtered by status, priority or last-updated time. " +
      "Returns compact summaries with a short preview, not full conversation history. " +
      "Freshdesk only returns tickets updated in the last 30 days unless updated_since is set — " +
      "pass it explicitly for anything older. " +
      "Use this to scan a queue; use get_ticket_thread once you have narrowed to a specific ticket.",
    schema: z.object({
      status: statusName.optional().describe("Only tickets in this state."),
      priority: priorityName.optional(),
      updated_since: z
        .string()
        .datetime({ offset: true })
        .optional()
        .describe("ISO-8601, any offset (e.g. +05:30). Only tickets updated at or after this instant."),
      limit: z.number().int().min(1).max(50).default(20),
      cursor: z
        .string()
        .optional()
        .describe(
          "Page cursor from a previous call's next_cursor. Omit for the first page. " +
            "Reuse the same limit and updated_since with it, or pages will overlap or skip.",
        ),
      fields: z
        .array(z.string())
        .max(20)
        .optional()
        .describe(
          "Return only these fields of each ticket (e.g. ['id','subject','status']). " +
            "Use it when scanning many tickets: it cuts the response several-fold.",
        ),
    }).strict(),
    async run({ client, cfg }, a) {
      const page = a.cursor === undefined ? 1 : /^[1-9]\d*$/.test(a.cursor) ? Number(a.cursor) : NaN;
      if (Number.isNaN(page)) {
        throw new FreshdeskError({
          kind: "invalid_input",
          message: "cursor must be a value returned as next_cursor by a previous call.",
          retryable: false,
        });
      }
      const res = await client.request<RawTicket[]>({
        tool: "list_tickets",
        path: "/tickets",
        query: {
          per_page: a.limit,
          page,
          order_by: "updated_at",
          order_type: "desc",
          // Freshdesk wants UTC; the agent may well have been given IST.
          updated_since: a.updated_since && new Date(a.updated_since).toISOString(),
        },
      });
      let rows = (res.data ?? []).map((t) => toSummary(t, { redact: true }));
      // Freshdesk has no first-class status/priority filter on /tickets, so we
      // filter client-side and say so, rather than pretending the API did it.
      if (a.status) rows = rows.filter((r) => r.status === a.status);
      if (a.priority) rows = rows.filter((r) => r.priority === a.priority);
      return ok(
        {
          tickets: rows.map((r) => project(r, a.fields)),
          count: rows.length,
          next_cursor: res.nextPage ? String(res.nextPage) : null,
          window: a.updated_since
            ? `tickets updated since ${a.updated_since}`
            : "tickets updated in the last 30 days (Freshdesk default); set updated_since to widen",
          note:
            a.status || a.priority
              ? "status/priority were filtered on the connector after fetching the page, so a page may return fewer rows than `limit`. Use search_tickets for server-side filtering across the whole helpdesk."
              : undefined,
        },
        cfg,
      );
    },
  },

  {
    name: "search_tickets",
    title: "Search tickets",
    effect: "read",
    requiresApproval: false,
    description:
      "Server-side search across the whole helpdesk by status, priority, tag, type or creation window. " +
      "Prefer this over list_tickets when you know what you are looking for. " +
      "Freshdesk's search index caps results at roughly 300 (30 per page, 10 pages) and does not " +
      "do free-text search over message bodies — narrow with filters, do not paginate hoping for more.",
    schema: z.object({
      status: statusName.optional(),
      priority: priorityName.optional(),
      tag: z.string().optional().describe("Exact tag match, e.g. 'autopay'."),
      type: z.string().optional(),
      created_after: z
        .string()
        .datetime({ offset: true })
        .optional()
        .describe("ISO-8601. Freshdesk search filters by calendar date, so the time of day is dropped."),
      page: z.number().int().min(1).max(10).default(1),
      fields: z.array(z.string()).max(20).optional(),
    }).strict(),
    async run({ client, cfg }, a) {
      const clauses: string[] = [];
      if (a.status) clauses.push(`status:${codeFor(STATUS, a.status)}`);
      if (a.priority) clauses.push(`priority:${codeFor(PRIORITY, a.priority)}`);
      if (a.tag) clauses.push(`tag:'${searchLiteral(a.tag)}'`);
      if (a.type) clauses.push(`type:'${searchLiteral(a.type)}'`);
      if (a.created_after) clauses.push(`created_at:>'${a.created_after.slice(0, 10)}'`);
      if (clauses.length === 0) {
        throw new FreshdeskError({
          kind: "invalid_input",
          message: "search_tickets needs at least one filter.",
          retryable: false,
          remediation: "Add status, priority, tag, type or created_after — or call list_tickets instead.",
        });
      }
      const res = await client.request<{ results: RawTicket[]; total: number }>({
        tool: "search_tickets",
        path: "/search/tickets",
        query: { query: `"${clauses.join(" AND ")}"`, page: a.page },
      });
      const rows = (res.data?.results ?? []).map((t) =>
        project(toSummary(t, { redact: true }), a.fields),
      );
      const total = res.data?.total ?? rows.length;
      return ok(
        {
          tickets: rows,
          // The effective filter, so the agent can see what the date clause became.
          query: clauses.join(" AND "),
          page: a.page,
          returned: rows.length,
          total_matching: total,
          more_pages: rows.length === 30 && a.page < 10,
          note:
            total > 300
              ? "More than 300 tickets match; the search index will not return them all. Narrow the filters instead of paging."
              : undefined,
        },
        cfg,
      );
    },
  },

  {
    name: "get_ticket_thread",
    title: "Get one ticket with its conversation",
    effect: "read",
    requiresApproval: false,
    description:
      "Fetch a single ticket with its message thread, oldest first, as plain text. " +
      "Returns the most recent max_messages messages; thread_complete tells you whether " +
      "older messages exist beyond what is returned. " +
      "This is the expensive call — use it on the handful of tickets you have already narrowed to. " +
      "A busy thread can exceed the response budget: lower max_messages or max_chars_per_message if the result is capped.",
    schema: z.object({
      ticket_id: z.number().int().positive(),
      max_messages: z.number().int().min(1).max(50).default(12),
      max_chars_per_message: z.number().int().min(200).max(8000).default(1500),
      include_contact: z
        .boolean()
        .default(false)
        .describe(
          "Leave ticket and message text unredacted (emails, UPI ids, phone numbers — and any " +
            "card/PAN/Aadhaar-shaped strings the customer typed). It does not fetch the contact record. " +
            "Only set this when the task genuinely needs it; it puts customer PII into the model's context and is logged.",
        ),
    }).strict(),
    async run({ client, cfg }, a) {
      const res = await client.request<RawTicket>({
        tool: "get_ticket_thread",
        path: `/tickets/${a.ticket_id}`,
        query: { include: "conversations" },
      });
      const t = res.data;
      const redact = !a.include_contact;
      if (!redact) log.warn({ tool: "get_ticket_thread", event: "pii_unredacted", ticket_id: a.ticket_id });
      const clip = (s: string) =>
        s.length > a.max_chars_per_message ? s.slice(0, a.max_chars_per_message) + "…" : s;
      let all: RawConversation[] = t.conversations ?? [];
      let complete = all.length < FRESHDESK_EMBEDDED_CONVERSATION_CAP;
      if (!complete) {
        // The embed is the ten oldest messages. A triage agent needs the latest
        // reply, so page the real thread (ascending) and take its tail.
        const paged: RawConversation[] = [];
        let page: number | undefined = 1;
        for (let i = 0; i < CONVERSATION_PAGES_MAX && page; i++) {
          const r: FreshdeskResponse<RawConversation[]> = await client.request<RawConversation[]>({
            tool: "get_ticket_thread",
            path: `/tickets/${a.ticket_id}/conversations`,
            query: { per_page: 30, page },
          });
          paged.push(...(r.data ?? []));
          page = r.nextPage;
        }
        all = paged;
        complete = page === undefined;
      }
      const shown = all.slice(-a.max_messages);
      return ok(
        {
          ticket: toSummary(t, { redact }),
          // Metadata first: if the budget truncates this object, it should eat
          // message text, not the flags that tell the agent what it is missing.
          messages_omitted: Math.max(0, all.length - shown.length),
          thread_complete: complete,
          pii_redacted: redact,
          full_description: clip(
            redact ? redactPii(stripHtml(t.description_text)) : stripHtml(t.description_text),
          ),
          messages: shown.map((c) => {
            const body = stripHtml(c.body_text);
            return {
              id: c.id,
              from: c.incoming ? "customer" : "agent",
              visibility: c.private ? "internal" : "customer_visible",
              at: c.created_at,
              text: clip(redact ? redactPii(body) : body),
            };
          }),
        },
        cfg,
      );
    },
  },

  {
    name: "add_private_note",
    title: "Add an internal note",
    effect: "write_internal",
    requiresApproval: false,
    description:
      "Attach an internal note to a ticket. The customer never sees it. This is the agent's default " +
      "way to record a finding, a draft reply for a human to send, or a recommended action. " +
      "Idempotent within a connector process: re-sending a call that already succeeded with the same " +
      "idempotency_key and ticket_id returns the cached result (replayed: true) instead of posting again.",
    schema: z.object({
      ticket_id: z.number().int().positive(),
      body: z.string().min(1).max(10_000),
      idempotency_key: z
        .string()
        .min(8)
        .max(128)
        .describe("Stable key for this logical note, e.g. 'triage-<ticket_id>-<run_id>'."),
    }).strict(),
    async run({ client, cfg }, a) {
      const res = await client.request<{ id: number; created_at: string }>({
        tool: "add_private_note",
        method: "POST",
        path: `/tickets/${a.ticket_id}/notes`,
        body: { body: a.body.replace(/\n/g, "<br>"), private: true },
        idempotencyKey: a.idempotency_key,
      });
      return ok(
        {
          note_id: res.data?.id,
          ticket_id: a.ticket_id,
          visibility: "internal",
          created_at: res.data?.created_at,
          replayed: res.replayed ?? false,
        },
        cfg,
      );
    },
  },

  {
    name: "update_ticket",
    title: "Update ticket state",
    effect: "write_state",
    requiresApproval: true,
    description:
      "Change a ticket's status, priority or tags. This is visible in the merchant's helpdesk and in " +
      "their SLA reporting, so it is gated on human approval by default. It cannot author anything to " +
      "the customer — there is no tool in this connector that can — but resolving or closing a ticket " +
      "may trigger the merchant's own Freshdesk notifications and automations. " +
      "add_tags merges with the ticket's existing tags; it never removes any.",
    schema: z.object({
      ticket_id: z.number().int().positive(),
      status: statusName.optional(),
      priority: priorityName.optional(),
      add_tags: z.array(z.string()).max(10).optional(),
      idempotency_key: z.string().min(8).max(128),
      reason: z
        .string()
        .min(10)
        .describe("Why this change is correct. Written to the audit log and shown to the approver."),
    }).strict(),
    async run({ client, cfg }, a) {
      if (!a.status && !a.priority && !a.add_tags?.length) {
        throw new FreshdeskError({
          kind: "invalid_input",
          message: "update_ticket needs at least one of status, priority or add_tags.",
          retryable: false,
        });
      }
      const body: Record<string, unknown> = {};
      if (a.status) body.status = codeFor(STATUS, a.status);
      if (a.priority) body.priority = codeFor(PRIORITY, a.priority);
      if (a.add_tags?.length) {
        // Freshdesk's PUT replaces the whole tag array. Read-merge so "add" never
        // silently strips a merchant's fraud/chargeback tag.
        const current = await client.request<RawTicket>({
          tool: "update_ticket",
          path: `/tickets/${a.ticket_id}`,
        });
        body.tags = [...new Set([...(current.data?.tags ?? []), ...a.add_tags])];
      }
      const res = await client.request<RawTicket>({
        tool: "update_ticket",
        method: "PUT",
        path: `/tickets/${a.ticket_id}`,
        body,
        idempotencyKey: a.idempotency_key,
      });
      // The audit line the approval contract promises: what changed and why.
      log.info({ tool: "update_ticket", event: "state_change", ticket_id: a.ticket_id, applied: body, reason: a.reason, replayed: res.replayed ?? false });
      return ok(
        { ticket: toSummary(res.data, { redact: true }), applied: body, reason: a.reason, replayed: res.replayed ?? false },
        cfg,
      );
    },
  },
];
