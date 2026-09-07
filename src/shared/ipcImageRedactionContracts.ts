import { z } from "zod";
import { defineIpcContract } from "./ipcContractCore";
import {
  confirmImageRedactionSchema,
  type ConfirmImageRedaction,
} from "./imageRedaction";

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
};
