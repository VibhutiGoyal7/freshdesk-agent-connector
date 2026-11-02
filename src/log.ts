/**
 * Structured logging to stderr.
 *
 * stdout is the MCP transport — anything written there corrupts the protocol.
 * Every line is JSON so a run can be replayed against latency, retry count and
 * rate-limit headroom after the fact. These are the numbers you need when a
 * merchant asks why the agent was slow, and the numbers an eval pack grades.
 */

type Level = "info" | "warn" | "error";

function emit(level: Level, fields: Record<string, unknown>): void {
  process.stderr.write(
    JSON.stringify({ ts: new Date().toISOString(), level, ...redact(fields) }) + "\n",
  );
}

const SECRET_KEYS = /api[_-]?key|authorization|password|token|secret/i;

function redact(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = SECRET_KEYS.test(k) ? "[redacted]" : v;
  }
  return out;
}

export const log = {
  info: (f: Record<string, unknown>) => emit("info", f),
  warn: (f: Record<string, unknown>) => emit("warn", f),
  error: (f: Record<string, unknown>) => emit("error", f),
};
