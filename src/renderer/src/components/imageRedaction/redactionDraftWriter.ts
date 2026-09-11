import type { SaveRedactionWorkspace } from "../../../../shared/imageRedactionWorkspace";
import type { RedactionSession } from "./redactionSession";

export type RedactionSaveStatus = {
  kind: "saved" | "saving" | "error";
  error?: unknown;
};
type Options = {
  read: () => RedactionSession;
  persist: (request: SaveRedactionWorkspace) => Promise<number>;
  notify: (status: RedactionSaveStatus) => void;
};

/** A serialized revision-aware draft writer. It has no job confirmation capability. */
export class RedactionDraftWriter {
  private paused = false;
  private saved: RedactionSession;
  private revision: number;
  private flight: Promise<number> | null = null;
  constructor(
    initial: RedactionSession,
    private readonly options: Options,
  ) {
    this.saved = initial;
    this.revision = initial.workspace.revision;
  }
  pause(): () => void {
    this.paused = true;
    return () => {
      this.paused = false;
    };
  }
  flush(): Promise<number> {
    if (this.paused) return Promise.resolve(this.revision);
    if (this.flight) return this.flight;
    this.flight = this.drain().finally(() => {
      this.flight = null;
    });
    return this.flight;
  }
  private async drain(): Promise<number> {
    try {
      while (!this.paused && this.saved !== this.options.read()) {
        const snapshot = this.options.read();
        this.options.notify({ kind: "saving" });
        this.revision = await this.options.persist(this.request(snapshot));
        this.saved = snapshot;
      }
      this.options.notify({ kind: "saved" });
      return this.revision;
    } catch (error) {
      this.options.notify({ kind: "error", error });
      throw error;
    }
  }
  private request(snapshot: RedactionSession): SaveRedactionWorkspace {
    return {
      sessionId: snapshot.workspace.sessionId,
      expectedRevision: this.revision,
      changes: Object.values(snapshot.documents).filter(
        (document) => document !== this.saved.documents[document.id],
      ),
      view: snapshot.workspace.view,
      preferences: snapshot.workspace.preferences,
      presets: snapshot.workspace.presets,
    };
  }
}
