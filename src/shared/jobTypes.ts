import type {
  CodexPagePreview,
  CodexTypesettingProgress,
} from "./codexTypesettingProgress";
import type {
  JobKind,
  JobPhase,
  JobStatus,
  ProgressMode,
  ResearchJobStage,
} from "./jobContracts";
import type { PageJobTargetSnapshot } from "./pageRevision";
import type { OcrPipeline } from "./settingsTypes";

export type { JobPhase } from "./jobContracts";

export type ResearchJobProgress = {
  stage: ResearchJobStage;
  query?: string;
  queryIndex?: number;
  resultCount?: number;
  creditsUsed?: number;
  creditLimit?: number;
};

export type JobFailureGuidance =
  | "increase-max-output-tokens"
  | "increase-work-context-budget"
  | "increase-context-length";

type JobProgressNotification = {
  variant: "success" | "error" | "warn" | "info";
  message: string;
};

export type JobState = {
  id: string;
  /** Distinguishes attempts of a resumable job without changing its receipt ID. */
  executionId?: string;
  kind: JobKind;
  status: JobStatus;
  progressText: string;
  detail?: string;
  phase?: JobPhase;
  ocrPipeline?: OcrPipeline;
  progressMode?: ProgressMode;
  progressPercent?: number;
  progressBytes?: number;
  progressTotalBytes?: number;
  progressBytesPerSecond?: number;
  installLogLine?: string;
  installLogLines?: string[];
  progressCurrent?: number;
  progressTotal?: number;
  /** Aggregate counters count page-stage operations, not distinct pages. */
  workflowProgress?: {
    pageCount: number;
    stageCount: number;
    chapterId?: string;
  };
  pageIndex?: number;
  pageTotal?: number;
  attempt?: number;
  attemptTotal?: number;
  pageElapsedMs?: number;
  jobElapsedMs?: number;
  failureGuidance?: JobFailureGuidance;
  research?: ResearchJobProgress;
  codexProgress?: CodexTypesettingProgress;
  codexPreviewHistory?: CodexPagePreview[];
  targets?: PageJobTargetSnapshot[];
};

export type JobEvent = JobState & {
  /** Set on jobs an MCP client (external or the built-in chat) started. */
  origin?: "mcp";
  soundEffectTextReview?: import("./soundEffectTextReview").SoundEffectTextReview;
  imageRedactionReview?: import("./imageRedaction").ImageRedactionReview;
  regionRequestId?: string;
  regionTextReview?: import("./regionTextReview").RegionTextReview;
  detail?: string;
  notification?: JobProgressNotification;
};

export type LocalModelPickResult = {
  modelPath: string;
  detectedMmprojPath?: string;
};

export type ModelTestResult = {
  ok: boolean;
  message: string;
  launchMode:
    | "huggingface"
    | "cached-hf"
    | "local"
    | "claude-code"
    | "openai-codex"
    | "openai-api";
  resolvedModelPath?: string | null;
  resolvedMmprojPath?: string | null;
  resolvedEndpoint?: string | null;
};

export type ModelTestProgressEvent = {
  id: string;
  phase?: JobPhase;
  ocrPipeline?: OcrPipeline;
  progressText: string;
  detail?: string;
  progressMode?: ProgressMode;
  progressPercent?: number;
  progressBytes?: number;
  progressTotalBytes?: number;
  progressBytesPerSecond?: number;
  installLogLine?: string;
  notification?: JobProgressNotification;
};
