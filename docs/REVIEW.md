# Pre-submission review

## Verification log

All steps run from a clean checkout state on 2026-11-02 (UTC). Commands are the
ones a reviewer would run; nothing below was hand-edited.

| Time | Step | Result |
|---|---|---|
| 05:08:25 | `git status` | Clean. `.env` untracked (`git ls-files .env` → no match). Only untracked file: `CLAUDE.md` (local tooling config, not committed). |
| 05:08:40 | `rm -rf node_modules dist && npm ci` | OK. `npm audit`: 1 high in `zod <4.6.6` (memory exhaustion on oversized constrained collections, GHSA-mrhx-c7xc-m3w5). Fix is a major bump to zod 4 — deferred, see Findings. |
| 05:08:55 | `npm run typecheck` | Clean. |
| 05:08:58 | `npm run build` | Clean. |
| 05:09:00 | `npm run evals` | **29/29 passed** in 335 ms. |
| 05:09:21 | MCP handshake over stdio (`node dist/index.js`, `FRESHDESK_DOMAIN=x FRESHDESK_API_KEY=x`) | `initialize` → `freshdesk-connector 0.1.0`, protocol `2024-11-05`. `tools/list` → 5 tools (`list_tickets`, `search_tickets`, `get_ticket_thread`, `add_private_note`, `update_ticket`), every one with an `inputSchema`. |
| 05:09:21 | `docs/TOOL_SPEC.json` vs live `tools/list` | **Identical** after both are pretty-printed with `JSON.stringify(tools, null, 2)`. No regeneration needed. |
| 05:09:21 | `tools/call list_tickets {cursor:"abc"}` | `isError: true`, body `{ok:false, error:{kind:"invalid_input", message:"cursor must be a value returned as next_cursor by a previous call.", retryable:false}}`. No stack trace. No HTTP request made. |
| 05:09:21 | `tools/call search_tickets {}` | `isError: true`, body `{ok:false, error:{kind:"invalid_input", retryable:false, remediation:"Add status, priority, tag, type or created_after — or call list_tickets instead."}}`. No HTTP request made. |
| 05:09:34 | `npm run smoke` (live, read-only) | Exit 0. 3 calls: `GET /tickets` (513 ms, rate_remaining 49), `GET /tickets/4` (167 ms, 47), `GET /search/tickets` (198 ms, 46). Word enums throughout (`"status": "open"`, `"priority": "urgent"`). `[card-redacted]` and `[phone-redacted]` present in ticket #3's preview. `window` field present on `list_tickets`. `thread_complete: true` on `get_ticket_thread`. |
| 05:09:54 | `npm run agent -- "List the open autopay tickets with their priorities. Do not add any notes."` | Exit 0. Tool-call sequence: `search_tickets {"status":"open","tag":"autopay"}` → 200, 268 ms, rate_remaining 45 → 2480 chars. Agent answered with 4 tickets (#5 urgent, #4 urgent, #3 high, #9 medium), correct against the seeded data. **Zero write calls.** |

Example `get_ticket_thread` response from the smoke run (already redacted by the connector; nothing removed afterwards):

```json
{
  "ok": true,
  "capped": false,
  "data": {
    "ticket": {
      "id": 4,
      "subject": "Mandate declined, SMS said insufficient funds but I have balance",
      "status": "open",
      "priority": "urgent",
      "tags": ["autopay"],
      "type": "Problem",
      "created_at": "2026-11-02T04:19:38Z",
      "updated_at": "2026-11-02T04:19:42Z",
      "preview": "The UPI autopay for my subscription was declined this morning with 'insufficient funds'. I have more than enough balance. This is the second month this has happened. Please fix or I will cancel.",
      "preview_truncated": false
    },
    "full_description": "The UPI autopay for my subscription was declined this morning with 'insufficient funds'. I have more than enough balance. This is the second month this has happened. Please fix or I will cancel.",
    "messages": [],
    "messages_omitted": 0,
    "thread_complete": true,
    "pii_redacted": true
  }
}
```

### Re-verification after fixes (same steps, 05:35 UTC)

| Time | Step | Result |
|---|---|---|
| 05:35:14 | `git status` | 14 modified, `docs/REVIEW.md` new. `.env` untracked (`git ls-files .env` → 0). |
| 05:35:28 | `rm -rf node_modules dist && npm ci` | OK. |
| 05:35:30 | `npm run typecheck && npm run build` | 0 errors each. |
| 05:35:34 | `npm run evals` | **43/43 passed** in 255 ms (29 original + 14 added below). |
| 05:35:35 | MCP handshake, `tools/list` | 5 tools, every one with `inputSchema`; 14 parameter descriptions now published (was 2). |
| 05:35:35 | `docs/TOOL_SPEC.json` vs live | **Identical** after regeneration from the running server. |
| 05:35:35 | Bad cursor / empty search | Both `isError: true` with `{ok:false, error:{kind:"invalid_input", retryable:false}}`. |
| 05:35:37 | `npm run smoke` (live, read-only) | Exit 0. Same three calls, rate_remaining 49 → 47 → 46; word enums, `[card-redacted]`/`[phone-redacted]`, `window`, `thread_complete: true` all present. New: every log line carries `attempt`, `search_tickets` echoes its effective `query` (`status:2`). |

## Findings

Five parallel review lenses — hiring manager, payments security/compliance,
reliability, product/technical writer, adversarial agent user — each returned
a table of concrete, code-verified findings. Merged and deduplicated below.
Rules applied: fix every P0; fix a P1 only if it fits in ten minutes and keeps
the eval pack green; defer the rest with a reason. Every behavioural fix has an
eval case (`evals/run.ts`, "Added in the pre-submission review"). 29 → 43 cases.

| # | Sev | Where | Finding | Status |
|---|---|---|---|---|
| 1 | P0 | `src/schema.ts:33-36` | `.describe()` after `.optional()`/`.default()` was dropped by the zod→JSON-Schema converter. Only 2 of 14 parameter descriptions reached the published spec; the `include_contact` PII warning, `cursor`, `fields`, `tag` guidance were invisible to the model. (Found by 4 of 5 lenses.) | **FIXED** — wrappers now carry the description; `TOOL_SPEC.json` regenerated; eval. |
| 2 | P0 | `src/tools/index.ts` `update_ticket` | `body.tags = a.add_tags` on a Freshdesk PUT *replaces* the tag array. A tool named `add_tags` silently stripped a merchant's `fraud`/`chargeback` tags. | **FIXED** — read-merge before the PUT (one extra GET, only when tags are supplied); eval. |
| 3 | P0 | `src/freshdesk/client.ts` write cache | Idempotency cache keyed on the key alone. Same key on a different ticket returned ticket A's note for ticket B and skipped the write while reporting success. | **FIXED** — key scoped to `method path key`; `replayed: true/false` in every write result; eval. |
| 4 | P0 | `src/tools/index.ts` `get_ticket_thread`; CAPABILITIES §3, PRD §9 | Code and docs said the embed is "the 10 most recent"; Freshdesk's `include=conversations` returns the ten **oldest**. On any thread > 10 the agent never saw the customer's latest reply. | **FIXED** — when the embed is full, page `/tickets/{id}/conversations` (≤ 90) and return the tail; eval. Docs corrected. |
| 5 | P0 | `src/freshdesk/limiter.ts` + `client.ts` | Check-then-act race: `delayMs()` then `take()` let every parallel waiter wake together and overdraw an empty bucket (after a 429, 4 callers per refill tick ≈ 4× the plan). | **FIXED** — `reserve()` hands each caller its own slot; `syncTo()` clamps to `X-RateLimit-Remaining` on every response; eval. |
| 6 | P0 | `include_contact` description; CAPABILITIES §4; PRD N7 | Described as "return the requester's email and phone … which is logged". It never fetched contact data and nothing logged it. | **FIXED** — description now says what it does (unredacts ticket text, does not fetch the contact record); `pii_unredacted` audit line with ticket id; eval. |
| 7 | P0 | README line 9 | "driving **all five** tools" — the sentence names three; `update_ticket` is approval-gated and the verified run made zero writes. | **FIXED** — "three of the five". |
| 8 | P0 | `update_ticket` description; CAPABILITIES §5 | Resolving/closing fires Freshdesk's own requester notifications; "cannot send anything to the customer" was true of the connector but not of the status change. | **FIXED** — stated in the tool description, §5 and the PRD risk table; pilot advice: keep `status` to open/pending. |
| 9 | P1 | `src/normalize.ts` `redactPii` | Email regex required a dot after `@`, so UPI VPAs (`rahul@okaxis`) passed through. IFSC, GSTIN, Amex, hyphenated Aadhaar also missed. | **FIXED** — VPA/IFSC/GSTIN/Amex rules added; eval. |
| 10 | P1 | `client.ts` 5xx on POST/PUT | Classified `retryable: true` — a 502 from a proxy after the note was created invites the duplicate the docs warn about. | **FIXED** — writes on 5xx are non-retryable with a "re-read before re-posting" remediation; eval. |
| 11 | P1 | `client.ts` fetch init | No timeout; a stalled connection held a concurrency slot for undici's 5-minute default, ×4 retries. | **FIXED** — `AbortSignal.timeout(30s)`; eval asserts it is wired. |
| 12 | P1 | `client.ts:129` `JSON.parse` | A non-JSON 200 (maintenance page) surfaced as "unexpected internal error, not retryable". | **FIXED** — `upstream_error`, retryable, body never echoed; eval. |
| 13 | P1 | `z.string().datetime()` | Rejected any timezone offset; an IST timestamp was a dead end for an Indian merchant's agent. | **FIXED** — `offset: true`, normalised to UTC before Freshdesk; eval. |
| 14 | P1 | All five `z.object` schemas | Unknown keys were stripped while the spec said `additionalProperties: false`; a typo'd filter returned an unfiltered page with `ok: true`. | **FIXED** — `.strict()`; eval. |
| 15 | P1 | `get_ticket_thread` at default args | 10 × 1500-char messages overflow the 12 000-char budget; truncation ate `thread_complete`/`messages_omitted` and the hint named parameters the tool does not have. | **FIXED** — metadata ordered before message text; hint names `max_messages`/`max_chars_per_message`; eval. |
| 16 | P1 | `reason` "written to the audit log" | Only echoed in the response; nothing logged it. | **FIXED** — `state_change` audit line with `applied` and `reason`; eval. |
| 17 | P1 | README mount example | `FRESHDESK_RATE_LIMIT_PER_MINUTE: "100"` for a 50/min trial, 2× the ceiling. | **FIXED** — 50, with a note on the default. |
| 18 | P1 | README "Run it" | `smoke -- --write` claimed to prove idempotency but posted once per process. | **FIXED** — posts the same key twice and shows the replay. |
| 19 | P1 | README | Assignment deliverable 1 (auth flow) had no README presence; the decision lived under "What the agent cannot do". | **FIXED** — a five-row "deliverables and where each one is" table. |
| 20 | P1 | PRD §4, CAPABILITIES §6 | "Measurable improvement", "must not rise", "meaningfully" — no numbers, no owner, no sample size. | **FIXED** — ≥ 30% faster routing vs a 4-week baseline, mis-routing ≤ baseline + 2 pts on ≥ 200 tickets, kill at < 15% in week 4, measured weekly by the support lead from Freshdesk audit timestamps. |
| 21 | P1 | `src/index.ts` annotations | `idempotentHint: false` on `update_ticket` while PRD F5 says "idempotently" and the code caches it. | **FIXED** — `true` for all tools; spec regenerated. |
| 22 | P1 | `requiresApproval` not in `tools/list` | Any host other than `examples/run-agent.ts` cannot see the approval requirement. | **DEFERRED** — custom annotation keys are not part of the MCP spec; stated honestly under "Mount in any MCP host". Agent Studio should own the approval contract (CAPABILITIES §7). |
| 23 | P1 | `redactPii` over-redaction | 12/16-digit UTR/RRN look like Aadhaar/card and are redacted — the join to a Razorpay payment is lost. | **DEFERRED** — Luhn/Verhoeff validation is > 10 min and needs test vectors; documented in CAPABILITIES §4 and §8 as a known cost. |
| 24 | P2 | `.positive()` published as `minimum: 0` | Spec said `ticket_id: 0` is valid; runtime rejected it. | **FIXED** — `exclusiveMinimum`; spec regenerated; eval. |
| 25 | P2 | Search literal escaping | `"` and control chars in `tag`/`type` passed into the double-quoted query. | **FIXED** — stripped; effective `query` echoed in the result; eval. |
| 26 | P2 | `Dockerfile` | Ran as root. | **FIXED** — `USER node`. Base image digest pin deferred (needs a registry lookup). |
| 27 | P2 | `.gitignore` | Only `.env`; `.env.local` etc. would be committed. | **FIXED** — `.env.*` with `!.env.example`. |
| 28 | P2 | `npm audit` zod GHSA-mrhx-c7xc-m3w5 | No 3.x patch exists; fix is a major bump. | **DEFERRED** — every array input now bounded (`fields` ≤ 20, `add_tags` ≤ 10); only caller is the host over stdio; reasoned acceptance in CAPABILITIES §8. |
| 29 | P2 | 400/422 body discarded | Freshdesk's `errors[].field` never reaches the agent. | **DEFERRED** — needs a safe parse of an untrusted body and a fixture; noted in §8. |
| 30 | P2 | Cursor not bound to `limit`/`updated_since` | Reusing a page cursor with a different limit silently skips/overlaps. | **DEFERRED** — described on the parameter and in §8; a structured cursor is a small follow-up. |
| 31 | P2 | Write cache unbounded | One entry per write for the life of the process. | **FIXED** — FIFO cap at 1,000; documented. |
| 32 | P2 | Docs: "full conversation", broken bold span, "approves in Freshdesk", "read-only" shadow mode, 422 "human must act", layout missing `seed.ts`, stale eval count | Wording mismatches with code. | **FIXED** — surgical edits, voice preserved. |

Checked by the lenses and found correct, so not listed: the API key reaches only the `Authorization` header and is redacted from logs; no log line carries ticket content; every error path returns a fixed message with no stack or upstream body; no code path can create a customer-visible reply; `add_private_note` always sends `private: true`; `Retry-After` is parsed as seconds and short waits are absorbed; the concurrency gate releases exactly once; `parseNextPage` handles the documented Link shapes; authority model is identical across README, PRD, CAPABILITIES, tool descriptions and flags; all doc anchors resolve; CI runs the eval pack.
