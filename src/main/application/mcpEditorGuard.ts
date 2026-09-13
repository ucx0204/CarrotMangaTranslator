import type { McpEditorState } from "../../shared/mcpEditingTypes";
import { McpEditError } from "./mcpEditPolicy";

type Pending = {
  resolve: (state: McpEditorState) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};
/** Query the trusted renderer on demand: background-window timer throttling must
 * neither disable editing nor let a stale 'clean' heartbeat authorize a write. */
export class McpEditorGuard {
  private sequence = 0;
  private readonly pending = new Map<number, Pending>();
  constructor(
    private readonly isBusy: () => boolean,
    private readonly requestProbe: (id: number) => void,
  ) {}
  report(state: McpEditorState): void {
    if (state.probeId === undefined) return;
    const entry = this.pending.get(state.probeId);
    if (!entry) return;
    this.pending.delete(state.probeId);
    clearTimeout(entry.timer);
    entry.resolve(structuredClone(state));
  }
  async assertWritable(chapterId: string, pageId: string): Promise<void> {
    if (this.isBusy())
      throw busy("An app job is running. Retry after it finishes.");
    await this.assertClean(chapterId, pageId);
    if (this.isBusy())
      throw busy("An app job started before the edit could be saved.");
  }
  /** For an adapter already holding the application's exclusive activity lease. */
  async assertClean(chapterId: string, pageId: string): Promise<void> {
    const state = await this.probe();
    if (
      state.chapterId === chapterId &&
      (state.hasPendingInpaintingMask || state.dirtyPageIds.includes(pageId))
    )
      throw busy(
        "Save or finish the local page/mask edit before applying remote translations.",
      );
  }
  private probe(): Promise<McpEditorState> {
    if (this.pending.size >= 8)
      return Promise.reject(busy("Too many pending editor checks."));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          busy("The local editor did not respond. Open the app and retry."),
        );
      }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.requestProbe(id);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(
          new McpEditError("editor_busy", "The local editor is unavailable.", {
            cause: error,
          }),
        );
      }
    });
  }
}
function busy(message: string) {
  return new McpEditError("editor_busy", message);
}
