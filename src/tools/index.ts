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
 *   update_ticket     — state change, allowed but logged and scoped
 *   reply_to_customer — NOT exposed. Customer-facing text needs a human.
 */

import { z } from "zod";
import { FreshdeskClient } from "../freshdesk/client.js";
import { ConnectorConfig } from "../config.js";
import { FreshdeskError } from "../errors.js";
import {
  PRIORITY,
  RawTicket,
  STATUS,
  capPayload,
  capRows,
  project,
  redactPii,
  stripHtml,
  toSummary,
} from "../normalize.js";

/** Freshdesk embeds at most this many conversations on GET /tickets/{id}?include=conversations. */
const FRESHDESK_EMBEDDED_CONVERSATION_CAP = 10;

const statusName = z.enum(["open", "pending", "resolved", "closed"]);
const priorityName = z.enum(["low", "medium", "high", "urgent"]);

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
        .datetime()
        .optional()
        .describe("ISO-8601. Only tickets updated at or after this instant."),
      limit: z.number().int().min(1).max(50).default(20),
      cursor: z
        .string()
        .optional()
        .describe("Opaque cursor from a previous call's next_cursor. Omit for the first page."),
      fields: z
        .array(z.string())
        .optional()
        .describe(
          "Return only these fields of each ticket (e.g. ['id','subject','status']). " +
            "Use it when scanning many tickets: it cuts the response several-fold.",
        ),
    }),
    async run({ client, cfg }, a) {
      const page = a.cursor ? Number.parseInt(a.cursor, 10) : 1;
      if (Number.isNaN(page) || page < 1) {
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
          updated_since: a.updated_since,
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
      created_after: z.string().datetime().optional(),
      page: z.number().int().min(1).max(10).default(1),
      fields: z.array(z.string()).optional(),
    }),
    async run({ client, cfg }, a) {
      const clauses: string[] = [];
      if (a.status) clauses.push(`status:${codeFor(STATUS, a.status)}`);
      if (a.priority) clauses.push(`priority:${codeFor(PRIORITY, a.priority)}`);
      if (a.tag) clauses.push(`tag:'${a.tag.replace(/'/g, "")}'`);
      if (a.type) clauses.push(`type:'${a.type.replace(/'/g, "")}'`);
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
      "Freshdesk embeds at most the 10 most recent messages; thread_complete tells you whether " +
      "older messages exist beyond what is returned. " +
      "This is the expensive call — use it on the handful of tickets you have already narrowed to.",
    schema: z.object({
      ticket_id: z.number().int().positive(),
      max_messages: z.number().int().min(1).max(50).default(12),
      max_chars_per_message: z.number().int().min(200).max(8000).default(1500),
      include_contact: z
        .boolean()
        .default(false)
        .describe(
          "Return the requester's email and phone unredacted. Only set this when the task genuinely " +
            "needs to contact them; it puts customer PII into the model's context.",
        ),
    }),
    async run({ client, cfg }, a) {
      const res = await client.request<RawTicket>({
        tool: "get_ticket_thread",
        path: `/tickets/${a.ticket_id}`,
        query: { include: "conversations" },
      });
      const t = res.data;
      const redact = !a.include_contact;
      const clip = (s: string) =>
        s.length > a.max_chars_per_message ? s.slice(0, a.max_chars_per_message) + "…" : s;
      const all = t.conversations ?? [];
      const shown = all.slice(-a.max_messages);
      return ok(
        {
          ticket: toSummary(t, { redact }),
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
          messages_omitted: Math.max(0, all.length - shown.length),
          // Freshdesk's include=conversations embeds the latest 10 only. If we got
          // exactly 10, there may be more; say so rather than imply completeness.
          thread_complete: all.length < FRESHDESK_EMBEDDED_CONVERSATION_CAP,
          pii_redacted: redact,
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
      "Idempotent: pass a stable idempotency_key and a retry will not create a duplicate.",
    schema: z.object({
      ticket_id: z.number().int().positive(),
      body: z.string().min(1).max(10_000),
      idempotency_key: z
        .string()
        .min(8)
        .max(128)
        .describe("Stable key for this logical note, e.g. 'triage-<ticket_id>-<run_id>'."),
    }),
    async run({ client, cfg }, a) {
      const res = await client.request<{ id: number; created_at: string }>({
        tool: "add_private_note",
        method: "POST",
        path: `/tickets/${a.ticket_id}/notes`,
        body: { body: a.body.replace(/\n/g, "<br>"), private: true },
        idempotencyKey: a.idempotency_key,
      });
      return ok(
        { note_id: res.data?.id, ticket_id: a.ticket_id, visibility: "internal", created_at: res.data?.created_at },
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
      "their SLA reporting, so it is gated on human approval by default. It cannot send anything to " +
      "the customer — there is no tool in this connector that can.",
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
    }),
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
      if (a.add_tags?.length) body.tags = a.add_tags;
      const res = await client.request<RawTicket>({
        tool: "update_ticket",
        method: "PUT",
        path: `/tickets/${a.ticket_id}`,
        body,
        idempotencyKey: a.idempotency_key,
      });
      return ok({ ticket: toSummary(res.data, { redact: true }), applied: body, reason: a.reason }, cfg);
    },
  },
];
