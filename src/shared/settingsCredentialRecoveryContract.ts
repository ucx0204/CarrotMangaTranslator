import { z } from "zod";
import { defineIpcContract } from "./ipcContractCore";
import { AppSettingsSchema } from "./ipcSchemas";
import type { AppSettings } from "./settingsTypes";

const recoverSettingsCredentials = defineIpcContract<[true], AppSettings>({
  apiKey: "recoverSettingsCredentials",
  channel: "settings:recover-credentials",
  args: z.tuple([z.literal(true)]),
  result: AppSettingsSchema,
});

export const settingsRecoveryIpcContracts = {
  recoverSettingsCredentials,
  getDefaultSettings: defineIpcContract<[], AppSettings>({
    apiKey: "getDefaultSettings",
    channel: "settings:get-defaults",
    args: z.tuple([]),
    result: AppSettingsSchema,
  }),
};
