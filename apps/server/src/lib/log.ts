/**
 * Structured logs (spec §13 Observability, plan A7): one JSON object per line on stdout, so the
 * Docker json-file driver and any log agent can parse them. Same call shape as `BotDeps['log']`.
 */
export type LogLevel = 'info' | 'warn' | 'error';

export function errorFields(err: unknown): Record<string, unknown> {
  if (err instanceof Error) return { name: err.name, message: err.message, stack: err.stack };
  return { message: String(err) };
}

/** Writes one JSON log line. `fields` are merged into the line (never put secrets in them). */
export function logLine(
  level: LogLevel,
  msg: string,
  fields: Record<string, unknown> = {},
  write: (line: string) => void = (line) => process.stdout.write(line),
): void {
  write(`${JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields })}\n`);
}

/** Drop-in for `BotDeps['log']`: `info` without an error, `error` with `err` serialised. */
export function jsonLog(msg: string, err?: unknown): void {
  if (err === undefined) logLine('info', msg);
  else logLine('error', msg, { err: errorFields(err) });
}
