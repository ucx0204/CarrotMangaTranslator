import type {
  JobKind,
  JobPhase,
  JobStatus,
  ProgressMode,
} from "./jobContracts";

export type { JobPhase } from "./jobContracts";

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
};

export type JobEvent = JobState & {
  detail?: string;
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
};
