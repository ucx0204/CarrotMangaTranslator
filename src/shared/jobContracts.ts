import { z } from "zod";

const JOB_KIND_VALUES = [
  "gemma-analysis",
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
  "completed",
] as const;
export type JobStatus = (typeof JOB_STATUS_VALUES)[number];
export const JobStatusSchema = z.enum(JOB_STATUS_VALUES);

const JOB_PHASE_VALUES = [
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

const PROGRESS_MODE_VALUES = [
  "determinate",
  "indeterminate",
  "log-only",
] as const;
export type ProgressMode = (typeof PROGRESS_MODE_VALUES)[number];
export const ProgressModeSchema = z.enum(PROGRESS_MODE_VALUES);
