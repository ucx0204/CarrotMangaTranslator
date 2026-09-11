import type { RedactionSession } from "./redactionSession";
import type {
  RedactionCommand,
  RedactionCommandResult,
} from "./redactionCommand";
import type { RedactionSaveStatus } from "./redactionDraftWriter";
import type { RedactionPreviewCache } from "./redactionPreviewCache";

/** Rendering can request previews, but cannot dispose the session's cache. */
export type RedactionPreviewSource = Pick<
  RedactionPreviewCache,
  "read" | "retryPage" | "subscribe" | "version"
>;
export type RedactionPreviewState = {
  previews: RedactionPreviewSource;
  ready: ReadonlySet<string>;
  failed: ReadonlySet<string>;
  markPreview: (
    pageId: string,
    status: "ready" | "error",
    source?: string,
  ) => void;
};

/** Explicit feature contract: the hook implements it, leaf views only pick their capabilities. */
export type RedactionWorkspaceController = RedactionPreviewState & {
  readonly state: RedactionSession;
  readonly live: { readonly current: RedactionSession };
  commit: (command: RedactionCommand) => RedactionCommandResult;
  dirty: boolean;
  saveStatus: RedactionSaveStatus;
  error: string;
  setError: (message: string) => void;
  report: (error: unknown, fallback?: string) => void;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  drawing: boolean;
  setDrawing: (drawing: boolean) => void;
  flush: () => Promise<number>;
  pauseSaving: () => () => void;
};
