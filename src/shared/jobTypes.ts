import type {
  JobKind,
  JobPhase,
  JobStatus,
  ProgressMode,
  ResearchJobStage,
} from "./jobContracts";
import type { PageJobTargetSnapshot } from "./pageRevision";

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
  kind: JobKind;
  status: JobStatus;
  progressText: string;
  detail?: string;
  phase?: JobPhase;
  progressMode?: ProgressMode;
  progressPercent?: number;
  progressBytes?: number;
  progressTotalBytes?: number;
  progressBytesPerSecond?: number;
  installLogLine?: string;
  installLogLines?: string[];
  progressCurrent?: number;
  progressTotal?: number;
  pageIndex?: number;
  pageTotal?: number;
  attempt?: number;
  attemptTotal?: number;
  pageElapsedMs?: number;
  jobElapsedMs?: number;
  failureGuidance?: JobFailureGuidance;
  research?: ResearchJobProgress;
  targets?: PageJobTargetSnapshot[];
};

export type JobEvent = JobState & {
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
    | "openai-codex"
    | "openai-api";
  resolvedModelPath?: string | null;
  resolvedMmprojPath?: string | null;
  resolvedEndpoint?: string | null;
};

export type ModelTestProgressEvent = {
  id: string;
  phase?: JobPhase;
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
