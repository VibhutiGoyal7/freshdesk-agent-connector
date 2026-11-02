# Freshdesk connector — what an agent can and can't do with it

A private connector for Agent Studio that gives an agent read access to a
merchant's Freshdesk helpdesk and a tightly bounded ability to write back.

Written for three readers: the engineer wiring it up, the merchant's support
lead who has to sign off on it, and the next person who has to extend it.

---

## 1. The problem this is for

A merchant's support queue is where payment failures surface first, in the
customer's words rather than in a dashboard. "My autopay failed and I don't know
if I'm still subscribed" lands in Freshdesk hours before it shows up in a
subscription-recovery report, and it lands phrased forty different ways.

The operational cost is triage: a human reads every ticket to decide which are
payment problems, which are urgent, and which need a payments person rather than
a support person. That reading is the work an agent can take over.

So the target metric for anything built on this connector is
**time-to-correct-routing** on payment-related tickets, with **mis-routing rate**
as the guardrail metric. Not tickets closed, and not replies sent — see §5.

## 2. What the agent can do

| Tool | Effect | Approval | What it's for |
|---|---|---|---|
| `list_tickets` | read | none | Scan the queue in recency order. Compact summaries. |
| `search_tickets` | read | none | Server-side filter by status, priority, tag, type, created-after. |
| `get_ticket_thread` | read | none | One ticket, its latest messages, plain text. The expensive call. |
| `add_private_note` | write, internal | none | Record a finding or draft a reply for a human. Invisible to the customer. |
| `update_ticket` | write, state | **required** | Change status, priority or tags. Visible in the merchant's SLA reporting. |

Concretely, an agent on this connector can:

- Find every open ticket tagged `autopay` created in the last week.
- Read those threads and judge which are mandate failures versus card declines.
- Write an internal note on each with its reading and a suggested next action.
- Propose a priority bump or a tag, and wait for a human to approve it.

## 3. What the agent cannot do

**It cannot send anything to a customer.** There is no tool on the surface that
produces a customer-visible message. This is not a permission that is switched
off — the tool does not exist, so no instruction smuggled into a ticket body can
talk the model into calling it. Drafts go into internal notes and a human sends
them. An eval asserts this property on every CI run.

**It cannot act on another merchant's data.** Credentials come from the process
environment, one connector process per merchant. Tool arguments never carry a
domain or a key.

**It cannot free-text search message bodies.** Freshdesk's search index filters
on structured fields, not conversation content. An agent looking for "tickets
mentioning UPI" must filter structurally and then read. Attempting the former
will silently under-return; the tool descriptions say so, so the model stops
rather than paginating hopefully.

**It cannot see more than roughly 300 search results.** 30 per page, 10 pages.
Past that the connector reports `total_matching` alongside a note telling the
agent to narrow rather than page. Silent truncation would make the agent
confidently wrong about volume, which is worse than a smaller answer.

**It cannot delete, merge, or reassign.** Deliberately out of scope for v1 —
these are the operations where a wrong call is expensive and hard to walk back.

**It cannot read attachments.** Payment screenshots are common in these tickets
and the agent is blind to them. This is the most-felt gap; see §7.

**It may not see a whole thread.** Freshdesk embeds only the ten *oldest*
messages when a ticket is fetched — not the latest, which is the one a triage
agent needs. When the embed is full the connector pages the real thread (up to
90 messages) and returns the most recent `max_messages`. Beyond that it reports
`thread_complete: false`, so the agent knows it is reading an excerpt rather
than assuming it has everything.

**It will not see tickets older than 30 days unless asked.** Freshdesk's list
endpoint defaults to the last 30 days of updates. `list_tickets` states the
window it covered in every response and takes `updated_since` to widen it.

### A note on auth

The brief allows OAuth or API key. Freshdesk's REST API authenticates with a
per-agent API key sent as the basic-auth username — it does not offer OAuth for
API access, so API key is the correct choice here rather than the easy one.
The key is read from the environment, never from tool arguments, and is
redacted from logs. For a tool that does offer OAuth2 (Zoho Inventory, say),
the swap is contained: `authHeader()` in `client.ts` becomes a token lookup
with refresh, and nothing above it changes.

## 4. Behaviour under load and failure

**Rate limits.** Freshdesk's limit is per-plan and per-minute. The connector runs
a token bucket sized to the configured plan ceiling, corrected downward from
Freshdesk's `X-RateLimit-Remaining` on every response, so it stays at or under
the limit rather than discovering it by being throttled. Being throttled is not a neutral
event for an agent: the model has already spent tokens deciding to make the call.

On a real 429 the connector trusts the server over its own estimate: it drains
the bucket and honours `Retry-After`. Short waits (≤30s) are absorbed inside the
call — burning a model turn on a two-second wait is waste. Longer waits are
handed back as a structured, waitable error, because a two-minute wait is a
decision the agent should make, possibly by narrowing its query instead.

**Errors.** Every failure arrives as `{ ok: false, error: { kind, message,
retryable, remediation } }`. The `retryable` flag matters more than it looks: an
agent that loops on a revoked API key overnight is a real incident, so 401 and
422 are explicitly non-retryable: 401 says a human must act, 422 says fix the
arguments. Every request carries a 30-second timeout so a stalled connection
cannot hold a concurrency slot.

**Writes.** Both write tools take an `idempotency_key`, scoped to the ticket and
tool, and the connector caches the response against it; a replay is marked
`replayed: true` in the result. Agents retry; a merchant's ticket must not
collect three identical notes. Network failures *and* 5xx responses on writes
are surfaced as non-retryable rather than retried, because a timed-out or
proxied POST may already have succeeded and the connector cannot see which —
the agent is told to re-read the ticket before posting again.

**Context budget.** Treated as a production constraint, not a nicety — it sets
how many tickets an agent can hold before it starts forgetting. The connector
pays the cost instead of the model: numeric enums become words, HTML becomes
plain text, previews are truncated with a visible marker, `fields` lets a caller
ask for three columns instead of forty, and oversized list responses shed rows
while keeping their totals and cursors intact.

**PII.** Card numbers (including Amex), phone numbers, email and UPI ids, PAN,
Aadhaar, GSTIN and IFSC-shaped strings are redacted from ticket text by default.
`get_ticket_thread` with `include_contact: true` leaves the text unredacted and
writes a `pii_unredacted` audit line; it does not fetch the contact record.
Redaction is coarse on purpose and has a known cost: a 12- or 16-digit payment
reference (UTR, RRN) looks like an Aadhaar or card number and is redacted too,
so an agent that needs one must ask a human or use `include_contact`.

## 5. Where a human stands in the loop

| Action | Who decides |
|---|---|
| Reading, searching, summarising | Agent, alone |
| Recording a judgement as an internal note | Agent, alone — reversible and invisible to the customer |
| Changing status, priority or tags | Agent proposes with a written `reason`, human approves |
| Anything a customer sees | Human, always. The agent drafts. |

One caveat the approver must know: resolving or closing a ticket can trigger the
merchant's own Freshdesk notifications and automations ("agent solved your
ticket"). The connector authors nothing to the customer, but a status change is
not silent. For a pilot, keep `status` to `open`/`pending` or disable those two
notifications for the API agent.

The line is drawn at **reversibility and visibility**, not at confidence. A
confident agent and a reckless one produce the same tool calls; only the blast
radius differs, so the blast radius is what's constrained.

`update_ticket` requires a `reason` string. It goes into the audit log and is
shown to the approver — an approval gate where the approver can't see the
argument is theatre.

## 6. How you'd know it worked

Set before rollout, not after:

- **Shadow first.** Run read-only for a week against the live queue. The agent
  writes its routing judgement to an internal note; nothing changes. Compare
  against what the humans actually did.
- **Ship when** agreement with human triage is ≥ 90% on payment-related
  tickets, measured on a sample of at least 200 a human re-reads.
- **Then measure** median time-to-correct-routing against the four-week
  pre-rollout baseline, weekly, from Freshdesk's audit timestamps (ticket
  created → first priority or tag set). That is the number that justifies the
  agent existing.
- **Guardrail:** mis-routing rate (tickets a human re-tags after the agent) must
  stay within two percentage points of baseline. If routing gets faster and
  worse, the agent is a regression wearing a dashboard.
- **Kill criterion** stated up front: if at week four time-to-routing is less
  than 15% better than baseline, the right outcome is to switch it off and say
  so, not to keep tuning prompts.

Every upstream call emits a structured stderr line with latency, status, attempt
number and rate-limit headroom; unredacted PII access and every approved state
change emit their own audit lines. These are the numbers you need when the
merchant asks why the agent was slow, and two eval cases assert on them.

## 7. What I'd build next, and what belongs in the platform

Split deliberately, because the point of a field-built connector is to find out
which problems are Freshdesk's and which are everyone's.

**Belongs in this connector:**
- Attachment OCR. Payment screenshots are the single biggest blind spot.
- Contact and company lookup, so an agent can see a customer's ticket history
  rather than judging each ticket cold.
- Webhook ingestion, so the agent reacts to a new ticket instead of polling.

**Belongs in the platform, because every connector will need it:**
- **A shared rate-limit and retry policy.** I have implemented a token bucket,
  Retry-After handling and jittered backoff here. The next connector will
  implement it again, slightly differently, and the bugs will be slightly
  different too. This is platform work.
- **A response-budget primitive.** Row-shedding, field projection and truncation
  markers are generic. Every connector returning a list needs them.
- **A first-class approval contract.** I express "this tool needs a human" as a
  flag plus a `reason` argument plus a convention. It should be a platform
  primitive that renders an approval UI and records who approved what.
- **Idempotency as infrastructure.** Every connector with writes needs it;
  none of them should hand-roll a cache.
- **A fixture-recording harness.** The eval pack here is only cheap to run
  because the upstream responses are recorded. Making that a one-command
  capture would raise the floor on every connector anyone writes.

The pattern across all five: the interesting, merchant-specific work is the tool
*surface* — deciding that notes are internal and replies are human. The plumbing
underneath is the same every time, and it is where a platform earns its keep.

## 8. Honest limitations of this build

- Status and priority filters on `list_tickets` are applied connector-side after
  fetching a page, so a page can return fewer rows than `limit`. The response
  says so. `search_tickets` filters server-side and should be preferred.
- Rate limits are configured, not discovered. If the merchant's plan changes,
  `FRESHDESK_RATE_LIMIT_PER_MINUTE` must change with it (default 100 if unset).
  The bucket starts full, so a cold start can burst up to the ceiling in its
  first second; Freshdesk's own remaining-count header then corrects it.
- The idempotency cache is in-process and capped at 1,000 keys (FIFO). A
  restart loses it. A real deployment wants Redis, which is three lines here
  and a platform concern in general.
- `update_ticket` with `add_tags` reads the ticket and merges before writing;
  a tag a human adds between that read and the write is lost.
- Threads are paged to 90 messages; `thread_complete: false` beyond that.
- `list_tickets` cursors are page numbers, not bound to `limit` or
  `updated_since`; reuse them with the same arguments.
- On a 400/422 the connector reports "malformed" without Freshdesk's own field
  message, so the agent knows *that* an argument was rejected but not which.
- Redaction catches 12- and 16-digit payment references (see §4). Luhn and
  Verhoeff checks would separate card/Aadhaar from UTR/RRN; not done yet.
- `npm audit` reports one high in `zod` (GHSA-mrhx-c7xc-m3w5, oversized array
  inputs). Every array argument is bounded (`maxItems` ≤ 20) and the only caller
  is the agent host over stdio; the fix is a major bump to zod 4, deferred.
- Only ticket objects are modelled. Contacts, companies, SLA policies and
  time entries are untouched.
- Rate-limit ceilings and search caps follow Freshdesk's documented behaviour at
  time of writing; both are plan-dependent and worth re-checking against current
  docs before a production rollout.
