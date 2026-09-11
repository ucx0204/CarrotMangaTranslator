import type { ImageRedactionStroke } from "../../shared/imageRedaction";
import type { RedactionDraftStore } from "./redactionWorkspaceMerge";

/** Effects are supplied at the composition boundary, never imported by policy. */
export type RedactionWorkspacePorts = {
  readDraft: (root: string) => Promise<RedactionDraftStore>;
  updateDraft: (
    root: string,
    change: (state: RedactionDraftStore) => Promise<void>,
  ) => Promise<number>;
  readApproved: (root: string) => Promise<{
    pages: Record<
      string,
      { fingerprint: string; strokes: ImageRedactionStroke[] }
    >;
  }>;
  fingerprint: (path: string) => Promise<string>;
  reportCleanupError: (message: string, error: unknown) => void;
};
