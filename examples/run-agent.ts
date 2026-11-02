/**
 * End-to-end demo: a Claude agent using the connector through MCP.
 *
 * This is the proof that the brief asks for — "an Agent Studio agent needs to
 * read tickets" — rather than a server that merely lists its tools. It spawns
 * the connector as a stdio MCP server, hands its tool declarations to Claude,
 * and runs a plain tool-use loop until the model answers.
 *
 *   ANTHROPIC_API_KEY=... npm run agent -- "Which open tickets are about failed autopay? Add an internal note on the top two."
 *
 * Needs a built connector (npm run build) and the Freshdesk vars in .env.
 * Approval-gated tools (update_ticket) prompt on stdin before executing — the
 * same contract Agent Studio would enforce with a UI.
 */

import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createInterface } from "node:readline/promises";
import { TOOLS } from "../src/tools/index.js";
import { loadConfig } from "../src/config.js";

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5";
const APPROVAL_REQUIRED = new Set(TOOLS.filter((t) => t.requiresApproval).map((t) => t.name));

const SYSTEM = `You are a support-operations agent for a merchant that accepts payments through Razorpay.
You can read the merchant's Freshdesk helpdesk and leave internal notes. You cannot and must not
attempt to message customers. When you record a judgement, use add_private_note with a stable
idempotency_key of the form triage-<ticket_id>-<today's date>. Be concise; cite ticket ids. Notes are rendered as plain text in Freshdesk, so do not use markdown — no asterisks, no headings.`;

async function main(): Promise<void> {
  loadConfig();
  const task = process.argv.slice(2).join(" ").trim();
  if (!task) {
    console.error('Usage: npm run agent -- "<what you want the agent to do>"');
    process.exit(2);
  }

  // 1. Spawn the connector exactly as an agent host would.
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: { ...process.env } as Record<string, string>,
    stderr: "pipe",
  });
  const mcp = new Client({ name: "demo-agent", version: "0.1.0" });
  await mcp.connect(transport);
  transport.stderr?.on("data", (d: Buffer) => process.stderr.write(`[connector] ${d}`));

  // 2. Translate the MCP tool declarations into Claude tool definitions. No
  //    hand-maintained copy: what the model sees is what the server declares.
  const { tools } = await mcp.listTools();
  const claudeTools: Anthropic.Tool[] = tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  }));

  const anthropic = new Anthropic();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }];

  // 3. The agent loop.
  for (let turn = 0; turn < 12; turn++) {
    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: SYSTEM,
      tools: claudeTools,
      messages,
    });
    messages.push({ role: "assistant", content: res.content });

    const toolUses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    for (const b of res.content) if (b.type === "text" && b.text.trim()) console.log(`\n${b.text}\n`);
    if (toolUses.length === 0 || res.stop_reason === "end_turn") break;

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      console.log(`→ ${use.name} ${JSON.stringify(use.input)}`);

      // 4. The approval contract, enforced by the host — not trusted to the model.
      if (APPROVAL_REQUIRED.has(use.name)) {
        const reason = (use.input as { reason?: string }).reason ?? "(no reason given)";
        const answer = await rl.question(`   approve ${use.name}? reason: "${reason}" [y/N] `);
        if (!/^y/i.test(answer)) {
          results.push({
            type: "tool_result",
            tool_use_id: use.id,
            content: JSON.stringify({ ok: false, error: { kind: "permission_denied", message: "A human declined this change.", retryable: false } }),
            is_error: true,
          });
          continue;
        }
      }

      const out = await mcp.callTool({ name: use.name, arguments: use.input as Record<string, unknown> });
      const text = (out.content as Array<{ type: string; text?: string }>)
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n");
      console.log(`← ${text.length} chars${out.isError ? " (error)" : ""}`);
      results.push({ type: "tool_result", tool_use_id: use.id, content: text, is_error: Boolean(out.isError) });
    }
    messages.push({ role: "user", content: results });
  }

  rl.close();
  await mcp.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
