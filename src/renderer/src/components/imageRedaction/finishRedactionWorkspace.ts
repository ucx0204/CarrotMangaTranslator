export type RedactionFinishIntent = "send" | "save" | "discard" | "cancel";
type FinishPorts = {
  save: () => Promise<number>;
  restore: () => void;
  pauseSaving: () => () => void;
  confirm: (revision: number) => Promise<void>;
  cancel: () => Promise<unknown>;
  close: () => Promise<unknown>;
};

/** Sending requires a saved snapshot. Explicit cancellation never requires a write.
 * Cancellation leaves the last acknowledged/in-flight draft intact, not an
 * invented rollback. A failed exit returns ownership to the still-open editor.
 */
export async function finishRedactionWorkspace(
  intent: RedactionFinishIntent,
  ports: FinishPorts,
): Promise<void> {
  const resumeSaving = intent === "cancel" ? ports.pauseSaving() : undefined;
  try {
    if (intent !== "cancel") {
      if (intent === "discard") ports.restore();
      const revision = await ports.save();
      if (intent === "send") await ports.confirm(revision);
    }
    if (intent !== "send") await ports.cancel();
    await ports.close();
  } catch (error) {
    resumeSaving?.();
    throw error;
  }
}
