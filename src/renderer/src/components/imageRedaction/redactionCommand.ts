import type { RedactionSession } from "./redactionSession";

export type RedactionCommand = (current: RedactionSession) => RedactionSession;
export type RedactionCommandResult =
  | { ok: true; state: RedactionSession }
  | { ok: false; error: unknown };

/** A rejected command never commits a partial state or acknowledges UI success. */
export function runRedactionCommand(
  current: RedactionSession,
  command: RedactionCommand,
): RedactionCommandResult {
  try {
    return { ok: true, state: command(current) };
  } catch (error) {
    return { ok: false, error };
  }
}
