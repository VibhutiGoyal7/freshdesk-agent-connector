#!/usr/bin/env node
/**
 * MCP entrypoint. Speaks stdio, so stdout belongs to the protocol and all
 * logging goes to stderr.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "./schema.js";
import { TOOLS, ToolContext } from "./tools/index.js";
import { FreshdeskClient } from "./freshdesk/client.js";
import { loadConfig } from "./config.js";
import { FreshdeskError } from "./errors.js";
import { log } from "./log.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const ctx: ToolContext = { cfg, client: new FreshdeskClient(cfg) };

  const server = new Server(
    { name: "freshdesk-connector", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.filter(
      // Customer-facing writes are not merely gated, they are absent from the
      // surface unless explicitly enabled. A tool the model cannot see is a tool
      // no prompt injection can talk it into calling.
      (t) => cfg.allowCustomerFacingWrites || t.effect !== "write_customer_facing",
    ).map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: zodToJsonSchema(t.schema),
      annotations: {
        readOnlyHint: t.effect === "read",
        destructiveHint: false,
        // Both writes are keyed and cached, so a repeat with the same key is a no-op.
        idempotentHint: true,
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = TOOLS.find((t) => t.name === req.params.name);
    if (!tool) {
      return errorResult({
        kind: "invalid_input",
        message: `No tool named ${req.params.name}.`,
        retryable: false,
      });
    }
    const parsed = tool.schema.safeParse(req.params.arguments ?? {});
    if (!parsed.success) {
      return errorResult({
        kind: "invalid_input",
        message: "Arguments did not match the tool schema.",
        retryable: false,
        remediation: parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; "),
      });
    }
    try {
      const out = await tool.run(ctx, parsed.data);
      return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
    } catch (err) {
      if (err instanceof FreshdeskError) return errorResult(err.detail);
      log.error({ tool: tool.name, event: "unhandled", message: String(err) });
      return errorResult({
        kind: "upstream_error",
        message: "The connector hit an unexpected internal error.",
        retryable: false,
      });
    }
  });

  await server.connect(new StdioServerTransport());
  log.info({ event: "ready", merchant: cfg.merchantId, tools: TOOLS.length });
}

function errorResult(detail: unknown) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: detail }, null, 2) }],
  };
}

main().catch((err) => {
  log.error({ event: "fatal", message: String(err?.message ?? err) });
  process.exit(1);
});
