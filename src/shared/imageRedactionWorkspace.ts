import { z } from "zod";
import { imageRedactionStrokeSchema } from "./imageRedaction";

const id = z.string().min(1).max(500);
export const redactionDecisionSchema = z.enum([
  "unreviewed", "reviewed", "deferred",
]);
export type RedactionDecision = z.infer<typeof redactionDecisionSchema>;
export const redactionDocumentSchema = z.object({
  id,
  fingerprint: z.string().length(64),
  strokes: z.array(imageRedactionStrokeSchema).max(1000),
  decision: redactionDecisionSchema,
}).strict();
export type RedactionDocument = z.infer<typeof redactionDocumentSchema>;

export const redactionPreferencesSchema = z.object({
  tool: z.enum(["rectangle", "brush", "erase", "select", "pan"]),
  shape: z.enum(["round", "square"]),
  size: z.number().finite().min(1).max(1000),
  keepZoom: z.boolean(),
  letterShortcuts: z.boolean(),
  previousKey: z.string().max(1),
  nextKey: z.string().max(1),
}).strict();
export type RedactionPreferences = z.infer<typeof redactionPreferencesSchema>;
export const DEFAULT_REDACTION_PREFERENCES: RedactionPreferences = {
  tool: "rectangle", shape: "round", size: 40, keepZoom: false,
  letterShortcuts: true, previousKey: "z", nextKey: "x",
};
const pageView = z.object({
  zoom: z.number().finite().min(0).max(800),
  x: z.number().finite().min(0).max(1),
  y: z.number().finite().min(0).max(1),
}).strict();
export const redactionViewSchema = z.object({
  currentId: z.string().max(500),
  selectedIds: z.array(id).max(10000),
  filter: z.enum(["all", "unreviewed", "deferred", "masked", "error"]),
  mode: z.enum(["edit", "grid"]),
  thumbnailSize: z.number().int().min(100).max(260),
  gridOffset: z.number().finite().min(0).max(10000000),
  pageViews: z.record(pageView),
}).strict();
export type RedactionView = z.infer<typeof redactionViewSchema>;
export const DEFAULT_REDACTION_VIEW: RedactionView = {
  currentId: "", selectedIds: [], filter: "all", mode: "edit",
  thumbnailSize: 160, gridOffset: 0, pageViews: {},
};
export const redactionPresetSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  width: z.number().int().positive().max(200000),
  height: z.number().int().positive().max(200000),
  strokes: z.array(imageRedactionStrokeSchema).min(1).max(1000),
}).strict();
export type RedactionPreset = z.infer<typeof redactionPresetSchema>;

export const openRedactionWorkspaceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("job"), jobId: z.string().uuid(), sessionId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("chapter"), chapterId: id, pageIds: z.array(id).min(1).max(10000).optional() }).strict(),
  z.object({ kind: z.literal("work"), workId: id }).strict(),
]);
export type OpenRedactionWorkspace = z.infer<typeof openRedactionWorkspaceSchema>;
export const redactionWorkspaceSchema = z.object({
  sessionId: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  pages: z.array(redactionDocumentSchema.extend({
    name: z.string().max(2000),
    imagePath: z.string().min(1).max(32768),
    width: z.number().int().positive().max(200000),
    height: z.number().int().positive().max(200000),
  }).strict()).max(10000),
  view: redactionViewSchema,
  preferences: redactionPreferencesSchema,
  presets: z.array(redactionPresetSchema).max(30),
}).strict();
export type RedactionWorkspace = z.infer<typeof redactionWorkspaceSchema>;
export type RedactionWorkspacePage = RedactionWorkspace["pages"][number];
export const saveRedactionWorkspaceSchema = z.object({
  sessionId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative(),
  changes: z.array(redactionDocumentSchema).max(10000),
  view: redactionViewSchema,
  preferences: redactionPreferencesSchema,
  presets: z.array(redactionPresetSchema).max(30),
}).strict();
export type SaveRedactionWorkspace = z.infer<typeof saveRedactionWorkspaceSchema>;
export const redactionPreviewRequestSchema = z.object({
  sessionId: z.string().uuid(), pageId: id,
  maxEdge: z.union([z.literal(320), z.literal(2048)]),
}).strict();
export type RedactionPreviewRequest = z.infer<typeof redactionPreviewRequestSchema>;
