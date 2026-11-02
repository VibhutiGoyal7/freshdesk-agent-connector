# Freshdesk connector for Agent Studio

A private connector that lets an Agent Studio agent read a merchant's Freshdesk
helpdesk and write back under guardrails. Shipped as an MCP server — the native
connector shape for an agent platform built on the Claude Agent SDK.

[![ci](https://github.com/VibhutiGoyal7/freshdesk-agent-connector/actions/workflows/ci.yml/badge.svg)](https://github.com/VibhutiGoyal7/freshdesk-agent-connector/actions/workflows/ci.yml)

> **Verified live** on a Freshdesk trial (50 req/min plan) with a Claude agent driving all five tools over MCP — search → read two threads → two internal notes, in four seconds, rate-limit headroom logged on every call. Reproduce it with `npm run agent` below.

## If you have 60 seconds

Three decisions are the point of this submission; the code is their consequence.

1. **No tool can message a customer.** Not disabled — absent from the surface.
   A prompt injected into a ticket body cannot make the model call a tool it
   cannot see. An eval asserts this on every CI run.
2. **The connector pays the integration cost, not the model.** Numeric enums
   become words, HTML becomes text, PII is redacted, `fields` projection trims
   columns, oversized lists shed rows *while keeping their totals and cursors*
   — because the metadata is exactly what tells an agent to narrow its query.
3. **Errors are instructions.** A 429 arrives as `{ kind: "rate_limited",
   retry_after_seconds: 23, retryable: true }`. A 401 arrives as "stop, a human
   must act." An agent looping on a revoked key overnight is a real incident.

Then read **[docs/CAPABILITIES.md](docs/CAPABILITIES.md)** — what an agent can
and can't do with this, and §7 on what belongs in the platform instead.

## Documents

| | |
|---|---|
| [docs/PRD.md](docs/PRD.md) | The one-page spec product, engineering, the merchant and compliance sign off on: problem, metrics, authority model, decisions, rollout, risks |
| [docs/CAPABILITIES.md](docs/CAPABILITIES.md) | The full can / can't do document, behaviour under failure, where a human stands |
| [docs/TOOL_SPEC.json](docs/TOOL_SPEC.json) | The MCP tool declarations, dumped from a live `tools/list` — not hand-written |

## Run it

```bash
npm install
npm run evals            # 29 cases, recorded fixtures — no credentials, no network
```

```bash
cp .env.example .env     # Freshdesk subdomain + API key (Profile Settings → Your API Key)
npm run build
npm run seed             # creates 8 realistic merchant tickets in your trial helpdesk
npm run smoke            # read-only against your real helpdesk; prints what the agent sees
npm run smoke -- --write # also posts one internal note, proving the write path + idempotency
```

```bash
npm run agent -- "Which open tickets are about failed autopay? Add an internal note on the top two."
```

Needs `ANTHROPIC_API_KEY` in `.env`.

The last command is the end-to-end proof: it spawns the connector over stdio,
hands its tool declarations to Claude, and runs the agent loop. `update_ticket`
prompts for approval on stdin — the same contract Agent Studio would enforce
with a UI.

### Mount in any MCP host

```json
{
  "mcpServers": {
    "freshdesk": {
      "command": "node",
      "args": ["/absolute/path/to/dist/index.js"],
      "env": {
        "FRESHDESK_DOMAIN": "acme",
        "FRESHDESK_API_KEY": "...",
        "MERCHANT_ID": "acme",
        "FRESHDESK_RATE_LIMIT_PER_MINUTE": "100"
      }
    }
  }
}
```

Docker: `docker build -t freshdesk-connector . && docker run --rm -i --env-file .env freshdesk-connector`

## Tools

| Tool | Effect | Human approval |
|---|---|---|
| `list_tickets` | read | — |
| `search_tickets` | read | — |
| `get_ticket_thread` | read | — |
| `add_private_note` | write — internal only | — |
| `update_ticket` | write — status / priority / tags | **required**, with a written reason |

## What the evals cover

Rate limiting directly (bucket arithmetic, refill, drain, jittered backoff,
concurrency gate wired into the client). The tool contract (enums, cursors,
empty results, PII redaction and its explicit escape hatch, field projection
measured not asserted, 429 / 401 / 404 / 422 shapes, idempotent writes,
notes always private, approval flags, honest signals about incomplete threads
and time windows). No network, so CI is green or red, never flaky.

## Layout

```
src/
  index.ts            MCP server: declarations, dispatch, error envelope
  config.ts           Credentials from env — never from tool arguments
  errors.ts           Every failure as { kind, retryable, remediation }
  normalize.ts        Enums → words, HTML → text, PII redaction, budgeting
  schema.ts           zod → JSON Schema for tool declarations
  log.ts              Structured stderr logs (stdout belongs to MCP)
  freshdesk/
    client.ts         Auth, retries, idempotency, pagination
    limiter.ts        Token bucket, concurrency gate, jittered backoff
  tools/index.ts      The five tools and their contracts
evals/                Recorded fixtures + the eval pack
examples/run-agent.ts End-to-end: Claude driving the connector over MCP
scripts/smoke.ts      Live read-only check against a real helpdesk
docs/                 PRD, capabilities, tool spec
```

## Known limitations

Stated plainly in [CAPABILITIES.md §8](docs/CAPABILITIES.md#8-honest-limitations-of-this-build):
connector-side status filtering on `list_tickets`, Freshdesk's 10-message
embed and 30-day default window (both surfaced to the agent, neither yet worked
around), in-process idempotency cache, no attachments, tickets only.
