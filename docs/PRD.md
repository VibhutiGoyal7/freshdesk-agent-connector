# PRD — Freshdesk connector for Agent Studio

| | |
|---|---|
| Status | v0.1, ready for shadow-mode pilot |
| Owner | Vibhuti Goyal |
| Audience | Agent Studio product & engineering, the pilot merchant's support lead, Razorpay legal/compliance |
| Companion | [CAPABILITIES.md](CAPABILITIES.md) — the full can / can't do document |

This is the document everyone is meant to agree on before anything ships. It is
deliberately short. Anything that needs more than a paragraph is a sign the
decision isn't settled yet.

---

## 1. Problem

Payment failures surface in a merchant's support queue before they surface in
any dashboard — in the customer's words, phrased forty different ways. Today a
human reads every ticket to work out which are payment problems, how urgent
they are, and whether they need a payments person rather than a support person.

Agent Studio agents can see Razorpay's side of a payment. They cannot see the
merchant's helpdesk, so they cannot join *what happened to the money* with
*what happened to the customer*. That join is where the value is.

## 2. Users

| User | What they need from this |
|---|---|
| **Merchant support lead** | Fewer tickets to triage by hand; certainty that the agent can't embarrass them in front of a customer |
| **Agent Studio agent** | Tickets in a shape it can reason over cheaply; honest signals when data is incomplete |
| **FDE / integration engineer** | Set up in minutes, verify without credentials, extend without re-learning |
| **Compliance** | A clear statement of what customer data the model sees, and when |

## 3. Goals and non-goals

**Goals**

1. An agent can find, read and classify payment-related tickets in a merchant's Freshdesk.
2. An agent can record its judgement where humans will see it, without customers seeing it.
3. The connector behaves predictably under rate limits, auth failures and large result sets.
4. A non-engineer can read one document and know exactly what the agent can and cannot do.

**Non-goals for v0.1**

- Replying to customers. Drafts only; a human sends.
- Deleting, merging or reassigning tickets.
- Contacts, companies, SLA policies, time entries, attachments.
- Multi-merchant tenancy in one process.
- Real-time (webhook) ingestion. Polling via `list_tickets` is sufficient for a pilot.

## 4. Success metrics

| Metric | Type | Target |
|---|---|---|
| Agreement with human triage on payment-related tickets | Gate to ship | ≥ 90% on a human-reviewed sample, after one week in shadow mode |
| Median time-to-correct-routing | Primary | Measurable improvement over the pre-rollout baseline within four weeks |
| Mis-routing rate | Guardrail | Must not rise |
| Customer-visible actions taken by the agent | Guardrail | Zero, by construction |

**Kill criterion**, stated now so it can't be negotiated later: if after four
weeks time-to-routing has not improved meaningfully, the agent is switched off
and the result written up. Tuning prompts indefinitely is not an outcome.

## 5. Requirements

### Functional

| ID | Requirement | Where |
|---|---|---|
| F1 | List tickets by recency with status/priority filters and cursor pagination | `list_tickets` |
| F2 | Server-side search by status, priority, tag, type, created-after | `search_tickets` |
| F3 | Read one ticket with its conversation as plain text | `get_ticket_thread` |
| F4 | Attach an internal note, idempotently | `add_private_note` |
| F5 | Change status / priority / tags, idempotently, with a written reason | `update_ticket` |
| F6 | Expose tools via MCP so any Claude Agent SDK host can mount them | `src/index.ts` |

### Non-functional

| ID | Requirement | Mechanism |
|---|---|---|
| N1 | Never exceed the merchant's plan rate limit in steady state | Token bucket sized to configured ceiling |
| N2 | Honour `Retry-After` on 429; absorb short waits, surface long ones | `client.ts` |
| N3 | At most N concurrent upstream requests (default 4) | Concurrency gate |
| N4 | No retry on a write whose outcome is unknown | Writes surface network errors immediately |
| N5 | Retried writes with the same key have no additional effect | Idempotency cache |
| N6 | Any single tool response fits a configurable character budget | Row-shedding, projection, truncation markers |
| N7 | Customer PII redacted by default; unredacted access is explicit and logged | `redactPii`, `include_contact` |
| N8 | Credentials never appear in tool arguments, model context or logs | Env-only config, log redaction |
| N9 | Every tool call emits a structured log line | `log.ts` |
| N10 | Contract verified without network or credentials | Recorded-fixture eval pack in CI |

## 6. Authority model

The line is drawn at **reversibility and visibility**, not at model confidence.

| Action | Decided by |
|---|---|
| Read, search, summarise | Agent alone |
| Internal note | Agent alone — reversible, invisible to customer |
| Status / priority / tag change | Agent proposes with `reason`; human approves |
| Anything a customer sees | Human. The agent drafts into a note. No tool exists for this. |

## 7. Key decisions

| Decision | Alternative rejected | Why |
|---|---|---|
| Five workflow-shaped tools | Mirror the Freshdesk API | A mirror makes the model do integration work at inference time, badly. Context budget is a production constraint. |
| Customer-facing write tool **absent**, not disabled | Expose `reply` behind a flag | A tool the model cannot see is a tool no prompt injection can invoke. |
| API key auth | OAuth | Freshdesk's REST API authenticates with per-agent API keys; it does not offer OAuth for API access. For Zoho or Freshworks' newer surfaces the same `client.ts` would carry an OAuth2 refresh-token flow in place of `authHeader()` — the tool layer is unchanged. |
| Rate limit configured, not discovered | Probe until 429 | Being throttled costs the agent a turn it has already paid for. |
| Short 429s absorbed, long ones surfaced | Always retry / never retry | A two-second wait is plumbing. A two-minute wait is a decision the agent should make. |
| Redact PII by default | Pass through | A false positive costs the model nothing; a leaked card number costs the merchant a lot. |
| In-process idempotency cache | Redis | Correct for a pilot; swap is three lines and a platform concern in general. |

## 8. Rollout

1. **Shadow (week 1).** Read-only against the live queue. Agent writes its routing judgement to an internal note. Humans triage as normal. Compare.
2. **Assist (weeks 2–4).** `update_ticket` enabled with approval. Agent proposes priority and tags; support lead approves in Freshdesk.
3. **Review (end of week 4).** Metrics in §4 against baseline. Ship, iterate, or kill.

## 9. Risks

| Risk | Mitigation |
|---|---|
| Agent mis-classifies a payment ticket as non-payment and it waits | Mis-routing rate is a guardrail metric; shadow mode first |
| Prompt injection via ticket body tries to drive a write | No customer-facing tool exists; state changes need approval; notes are internal |
| Freshdesk plan limit lower than configured → sustained 429s | `Retry-After` honoured; long waits surfaced so the agent narrows instead of looping |
| Long thread silently truncated by Freshdesk's 10-conversation embed | `thread_complete` flag; follow-up pagination is the first v0.2 item |
| Payment screenshots unreadable → agent blind to key evidence | Documented as the top gap; attachment OCR is v0.2 |

## 10. Open questions

- Does Agent Studio's approval surface accept a free-text `reason`, or does it need structured fields?
- Should `include_contact` require approval too, or is logging sufficient for the pilot merchant's compliance team?
- Who owns the merchant's Freshdesk API key rotation once this is live — merchant, FDE, or platform?

## 11. What this tells the platform

Five things were hand-built here that every connector will need again:
rate-limit policy, response budgeting, an approval contract, idempotency, and
fixture recording. The interesting merchant-specific work was the tool surface.
The plumbing is the same every time — that is where a platform earns its keep.
Full argument in [CAPABILITIES.md §7](CAPABILITIES.md#7-what-id-build-next-and-what-belongs-in-the-platform).
