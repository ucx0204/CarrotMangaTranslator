import { z } from "zod";
import { defineIpcContract } from "./ipcContractCore";
import {
  confirmImageRedactionSchema,
  type ConfirmImageRedaction,
} from "./imageRedaction";
import {
  openRedactionWorkspaceSchema,
  redactionWorkspaceSchema,
  saveRedactionWorkspaceSchema,
  redactionPreviewRequestSchema,
  type OpenRedactionWorkspace,
  type RedactionWorkspace,
  type SaveRedactionWorkspace,
  type RedactionPreviewRequest,
} from "./imageRedactionWorkspace";

export const imageRedactionIpcContracts = {
  confirmImageRedaction: defineIpcContract<[ConfirmImageRedaction], boolean>({
    apiKey: "confirmImageRedaction",
    channel: "job:confirm-image-redaction",
    args: z.tuple([confirmImageRedactionSchema]),
    result: z.boolean(),
  }),
  getImageRedactionEnabled: defineIpcContract<[], boolean>({
    apiKey: "getImageRedactionEnabled",
    channel: "image-redaction:get-enabled",
    args: z.tuple([]),
    result: z.boolean(),
  }),
  setImageRedactionEnabled: defineIpcContract<[boolean], boolean>({
    apiKey: "setImageRedactionEnabled",
    channel: "image-redaction:set-enabled",
    args: z.tuple([z.boolean()]),
    result: z.boolean(),
  }),
  openRedactionWorkspace: defineIpcContract<
    [OpenRedactionWorkspace],
    RedactionWorkspace
  >({
    apiKey: "openRedactionWorkspace",
    channel: "image-redaction:open-workspace",
    args: z.tuple([openRedactionWorkspaceSchema]),
    result: redactionWorkspaceSchema,
  }),
  saveRedactionWorkspace: defineIpcContract<[SaveRedactionWorkspace], number>({
    apiKey: "saveRedactionWorkspace",
    channel: "image-redaction:save-workspace",
    args: z.tuple([saveRedactionWorkspaceSchema]),
    result: z.number().int().nonnegative(),
  }),
  closeRedactionWorkspace: defineIpcContract<[string], boolean>({
    apiKey: "closeRedactionWorkspace",
    channel: "image-redaction:close-workspace",
    args: z.tuple([z.string().uuid()]),
    result: z.boolean(),
  }),
  getRedactionWorkspacePreview: defineIpcContract<
    [RedactionPreviewRequest],
    string
  >({
    apiKey: "getRedactionWorkspacePreview",
    channel: "image-redaction:workspace-preview",
    args: z.tuple([redactionPreviewRequestSchema]),
    result: z.string().max(32 * 1024 * 1024),
  }),
};
