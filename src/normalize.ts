/**
 * Normalization: the most important file in this connector.
 *
 * A raw Freshdesk ticket is ~40 fields of nulls, numeric enums and HTML. Fifty of
 * them in one tool result is tens of thousands of tokens of which the model needs
 * maybe eight fields. Context budget is a real production constraint — it sets
 * how many tickets an agent can consider before it has to start forgetting — so
 * the connector, not the model, pays the cost of being terse.
 *
 * Rules applied here:
 *  - Enums become words. "status": 2 means nothing to a model; "open" does.
 *  - HTML bodies become plain text, truncated, with the truncation made visible
 *    so the model knows to call get_ticket_thread rather than assume it has all.
 *  - Customer PII is reduced to what triage needs. Full email/phone is available
 *    only through get_ticket_thread, and only when include_contact is set.
 */

export const STATUS: Record<number, string> = {
  2: "open",
  3: "pending",
  4: "resolved",
  5: "closed",
};

export const PRIORITY: Record<number, string> = {
  1: "low",
  2: "medium",
  3: "high",
  4: "urgent",
};

export interface RawTicket {
  id: number;
  subject?: string | null;
  description_text?: string | null;
  status?: number;
  priority?: number;
  tags?: string[];
  type?: string | null;
  created_at?: string;
  updated_at?: string;
  due_by?: string | null;
  requester_id?: number;
  responder_id?: number | null;
  custom_fields?: Record<string, unknown> | null;
  conversations?: RawConversation[];
}

export interface RawConversation {
  id: number;
  body_text?: string | null;
  incoming?: boolean;
  private?: boolean;
  user_id?: number;
  created_at?: string;
}

export interface TicketSummary {
  id: number;
  subject: string;
  status: string;
  priority: string;
  tags: string[];
  type: string | null;
  created_at: string;
  updated_at: string;
  /** First ~280 chars of the opening message, plain text. */
  preview: string;
  /** True when preview was cut: the full text is in get_ticket_thread. */
  preview_truncated: boolean;
}

const PREVIEW_CHARS = 280;

export function stripHtml(input: string | null | undefined): string {
  if (!input) return "";
  return input
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Redact the PII an agent does not need in order to triage. Deliberately coarse:
 * a false positive costs the model nothing, a leaked card number costs the
 * merchant a lot. Full values remain retrievable, explicitly, through
 * get_ticket_thread with include_contact.
 */
export function redactPii(text: string): string {
  return text
    .replace(/\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}\b/g, "[card-redacted]")
    .replace(/\b3[47]\d{2}[ -]?\d{6}[ -]?\d{5}\b/g, "[card-redacted]")
    // GSTIN embeds a PAN, so it has to go before the PAN rule.
    .replace(/\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g, "[gstin-redacted]")
    .replace(/\b[A-Z]{5}\d{4}[A-Z]\b/g, "[pan-redacted]")
    .replace(/\b[A-Z]{4}0[A-Z0-9]{6}\b/g, "[ifsc-redacted]")
    .replace(/\b\d{4}[ -]?\d{4}[ -]?\d{4}\b/g, "[aadhaar-redacted]")
    // No dot required after the @: a UPI VPA (rahul@okaxis) is as identifying
    // as an email address and far more common in a payments ticket.
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)*/g, "[email-redacted]")
    // Indian mobile numbers turn up spaced, hyphenated and with or without the
    // country code; all four shapes have to go.
    .replace(/(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/g, "[phone-redacted]");
}

export function toSummary(t: RawTicket, opts: { redact: boolean }): TicketSummary {
  const bodyRaw = stripHtml(t.description_text ?? "");
  const body = opts.redact ? redactPii(bodyRaw) : bodyRaw;
  const truncated = body.length > PREVIEW_CHARS;
  return {
    id: t.id,
    subject: (opts.redact ? redactPii(t.subject ?? "") : t.subject ?? "") || "(no subject)",
    status: STATUS[t.status ?? 0] ?? `unknown(${t.status})`,
    priority: PRIORITY[t.priority ?? 0] ?? `unknown(${t.priority})`,
    tags: t.tags ?? [],
    type: t.type ?? null,
    created_at: t.created_at ?? "",
    updated_at: t.updated_at ?? "",
    preview: truncated ? body.slice(0, PREVIEW_CHARS) + "…" : body,
    preview_truncated: truncated,
  };
}

/** Keep only the requested fields, so a caller that needs ids and status pays for ids and status. */
export function project<T extends object>(obj: T, fields?: string[]): Partial<T> {
  if (!fields || fields.length === 0) return obj;
  const out: Partial<T> = {};
  for (const f of fields) {
    if (f in obj) (out as Record<string, unknown>)[f] = (obj as Record<string, unknown>)[f];
  }
  return out;
}

/**
 * Budget guard.
 *
 * Two strategies, in order of preference:
 *
 *  1. If the payload is a list of rows, drop rows from the end until it fits and
 *     report how many were dropped. The surviving rows stay well-formed JSON and
 *     the metadata (totals, cursors, warnings) survives intact — which matters,
 *     because the metadata is exactly what tells the agent to narrow its query.
 *  2. Only if a single object is still too large do we fall back to cutting the
 *     string, which is ugly but strictly better than an unannounced overflow.
 */
export function capRows<T extends { tickets: unknown[] }>(
  payload: T,
  maxChars: number,
): { value: T; capped: boolean; dropped: number } {
  let dropped = 0;
  const rows = [...payload.tickets];
  while (rows.length > 1 && JSON.stringify({ ...payload, tickets: rows }).length > maxChars) {
    rows.pop();
    dropped++;
  }
  return { value: { ...payload, tickets: rows }, capped: dropped > 0, dropped };
}

export function capPayload<T>(value: T, maxChars: number): { value: T | string; capped: boolean } {
  const s = JSON.stringify(value);
  if (s.length <= maxChars) return { value, capped: false };
  return {
    value:
      s.slice(0, maxChars) +
      `\n…[truncated at ${maxChars} characters. Narrow the query, request fewer fields, or lower max_messages / max_chars_per_message.]`,
    capped: true,
  };
}
