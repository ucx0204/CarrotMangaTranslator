import { z } from "zod";

export const JOB_KIND_VALUES = ["gemma-analysis", "inpainting"] as const;
export type JobKind = (typeof JOB_KIND_VALUES)[number];
export const JobKindSchema = z.enum(JOB_KIND_VALUES);

export const JOB_STATUS_VALUES = [
  "idle",
  "starting",
  "running",
  "cancelling",
  "cancelled",
  "failed",
  "completed",
] as const;
export type JobStatus = (typeof JOB_STATUS_VALUES)[number];
export const JobStatusSchema = z.enum(JOB_STATUS_VALUES);

export const JOB_PHASE_VALUES = [
  "booting",
  "model_downloading",
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
] as const;
export type JobPhase = (typeof JOB_PHASE_VALUES)[number];
export const JobPhaseSchema = z.enum(JOB_PHASE_VALUES);

export const PROGRESS_MODE_VALUES = [
  "determinate",
  "indeterminate",
  "log-only",
] as const;
export type ProgressMode = (typeof PROGRESS_MODE_VALUES)[number];
export const ProgressModeSchema = z.enum(PROGRESS_MODE_VALUES);

export function isJobKind(value: unknown): value is JobKind {
  return JobKindSchema.safeParse(value).success;
}

export function isJobStatus(value: unknown): value is JobStatus {
  return JobStatusSchema.safeParse(value).success;
}

export function isJobPhase(value: unknown): value is JobPhase {
  return JobPhaseSchema.safeParse(value).success;
}

export function isProgressMode(value: unknown): value is ProgressMode {
  return ProgressModeSchema.safeParse(value).success;
}
