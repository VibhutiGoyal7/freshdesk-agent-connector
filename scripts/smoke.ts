/**
 * Live smoke test. Hits the merchant's real Freshdesk with the credentials in
 * .env and prints exactly what an agent would receive.
 *
 *   npx tsx scripts/smoke.ts
 *
 * Read-only by default. Pass --write to also post one internal note to the
 * newest ticket, which verifies the write path and the idempotency cache
 * without touching anything a customer can see.
 */

import { loadConfig } from "../src/config.js";
import { FreshdeskClient } from "../src/freshdesk/client.js";
import { TOOLS, ToolContext } from "../src/tools/index.js";

const cfg = loadConfig();
const ctx: ToolContext = { cfg, client: new FreshdeskClient(cfg) };

const run = (name: string, args: unknown) => {
  const t = TOOLS.find((x) => x.name === name)!;
  return t.run(ctx, t.schema.parse(args));
};
const show = (label: string, v: unknown) =>
  process.stdout.write(`\n=== ${label} ===\n${JSON.stringify(v, null, 2)}\n`);

const main = async () => {
  const list: any = await run("list_tickets", {
    limit: 5,
    fields: ["id", "subject", "status", "priority"],
  });
  show("list_tickets (projected)", list);

  const first = list.data.tickets?.[0]?.id;
  if (!first) {
    process.stdout.write("\nNo tickets in this helpdesk yet — seed a few and rerun.\n");
    return;
  }

  show("get_ticket_thread", await run("get_ticket_thread", { ticket_id: first }));
  show("search_tickets", await run("search_tickets", { status: "open" }));

  if (process.argv.includes("--write")) {
    show(
      "add_private_note",
      await run("add_private_note", {
        ticket_id: first,
        body: "Connector smoke test: internal note, not visible to the customer.",
        idempotency_key: `smoke-${first}-${new Date().toISOString().slice(0, 13)}`,
      }),
    );
  }
};

main().catch((e) => {
  process.stderr.write(`smoke failed: ${e?.detail ? JSON.stringify(e.detail) : e}\n`);
  process.exit(1);
});
