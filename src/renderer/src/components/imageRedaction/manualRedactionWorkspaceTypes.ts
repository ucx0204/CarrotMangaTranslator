import type { RedactionWorkspace } from "../../../../shared/imageRedactionWorkspace";
import type { RedactionCopySource } from "./redactionWorkspaceModel";

export type ManualRedactionWorkspaceProps = {
  workspace: RedactionWorkspace;
  job?: { jobId: string; sessionId: string };
  onClose: () => void;
};

export type RedactionBatchIntent =
  | { kind: "review"; ids: string[] }
  | { kind: "copy"; ids: string[]; source: RedactionCopySource };
