import { z } from "zod";

const JOB_KIND_VALUES = [
  "gemma-analysis",
  "sound-effect-translation",
  "internet-research",
  "inpainting",
  "page-export",
] as const;
export type JobKind = (typeof JOB_KIND_VALUES)[number];
export const JobKindSchema = z.enum(JOB_KIND_VALUES);

const JOB_STATUS_VALUES = [
  "idle",
  "starting",
  "running",
  "cancelling",
  "cancelled",
  "failed",
  "partial",
  "completed",
] as const;
export type JobStatus = (typeof JOB_STATUS_VALUES)[number];
export const JobStatusSchema = z.enum(JOB_STATUS_VALUES);

const TERMINAL_JOB_STATUSES: ReadonlySet<JobStatus> = new Set([
  "cancelled",
  "failed",
  "partial",
  "completed",
]);

export function isTerminalJobStatus(status: JobStatus): boolean {
  return TERMINAL_JOB_STATUSES.has(status);
}

const JOB_PHASE_VALUES = [
  "booting",
  "model_downloading",
  "font_matching_downloading",
  "ocr_preparing",
  "ocr_downloading",
  "ocr_running",
  "model_requesting",
  "ready",
  "page_running",
  "page_retry",
  "page_done",
  "page_skipped",
  "inpainting_preparing",
  "inpainting_running",
  "inpainting_done",
  "finalizing",
  "done",
  "cancelled",
  "failed",
  "partial",
] as const;
export type JobPhase = (typeof JOB_PHASE_VALUES)[number];
export const JobPhaseSchema = z.enum(JOB_PHASE_VALUES);

const PROGRESS_MODE_VALUES = [
  "determinate",
  "indeterminate",
  "log-only",
] as const;
export type ProgressMode = (typeof PROGRESS_MODE_VALUES)[number];
export const ProgressModeSchema = z.enum(PROGRESS_MODE_VALUES);

const RESEARCH_JOB_STAGE_VALUES = [
  "preparing",
  "planning",
  "searching",
  "synthesizing",
  "auditing",
  "finalizing",
] as const;
export type ResearchJobStage = (typeof RESEARCH_JOB_STAGE_VALUES)[number];
export const ResearchJobStageSchema = z.enum(RESEARCH_JOB_STAGE_VALUES);
