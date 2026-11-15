import { McpEditError } from "./mcpEditPolicy";

/** Reserve review capacity before model work; identical concurrent requests share one preparation. */
export class McpPageBatchPreparation {
  private readonly pending = new Map<
    string,
    { signature: string; task: Promise<string> }
  >();

  run(
    key: string,
    signature: string,
    occupied: number,
    bytes: number,
    prepare: () => Promise<string>,
  ) {
    const prior = this.pending.get(key);
    if (prior) {
      if (prior.signature !== signature)
        throw new McpEditError(
          "invalid_edit",
          "Preview requestId belongs to different input.",
        );
      return prior.task;
    }
    if (occupied >= 32 || bytes >= 32 * 1024 * 1024)
      throw new McpEditError(
        "plan_capacity_full",
        "Bounded session history is full. Wait for a retained plan to expire before preparing another; no model was started.",
      );
    if (occupied + this.pending.size >= 32)
      throw new McpEditError(
        "editor_busy",
        "Other plans are being prepared. Wait for preparation to settle before retrying; no model was started for this request.",
      );
    const task = Promise.resolve()
      .then(prepare)
      .finally(() => this.pending.delete(key));
    this.pending.set(key, { signature, task });
    return task;
  }
  async settle() {
    await Promise.allSettled(
      [...this.pending.values()].map((entry) => entry.task),
    );
  }
}
