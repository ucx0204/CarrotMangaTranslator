import { z } from "zod";
import {
  ConditionalBatchSchemeIdSchema,
  ConditionalBatchSequenceV2Schema,
  ConditionalBatchSnapshotV2Schema,
  MAX_CONDITIONAL_BATCH_FILE_BYTES,
  SaveConditionalBatchSchemeInputSchema,
  type ConditionalBatchSequenceV2,
  type ConditionalBatchSnapshotV2,
  type SaveConditionalBatchSchemeInput,
} from "./conditionalBatchRules";
import type {
  ConditionalBatchYamlFileResult,
  ConditionalBatchYamlSaveResult,
} from "./conditionalBatchExchangeTypes";
import { defineIpcContract, localPathResult } from "./ipcContractCore";

const ConditionalBatchYamlFileResultSchema = z
  .object({
    path: localPathResult,
    yaml: z.string().max(MAX_CONDITIONAL_BATCH_FILE_BYTES),
  })
  .strict();

const ConditionalBatchYamlSaveResultSchema = z
  .object({ saved: z.boolean(), path: localPathResult })
  .strict();

export const conditionalBatchIpcContracts = {
  listConditionalBatchSchemes: defineIpcContract<
    [],
    ConditionalBatchSnapshotV2
  >({
    apiKey: "listConditionalBatchSchemes",
    channel: "conditional-batch:list",
    args: z.tuple([]),
    result: ConditionalBatchSnapshotV2Schema,
  }),
  saveConditionalBatchScheme: defineIpcContract<
    [SaveConditionalBatchSchemeInput],
    ConditionalBatchSnapshotV2
  >({
    apiKey: "saveConditionalBatchScheme",
    channel: "conditional-batch:save",
    args: z.tuple([SaveConditionalBatchSchemeInputSchema]),
    result: ConditionalBatchSnapshotV2Schema,
  }),
  deleteConditionalBatchScheme: defineIpcContract<
    [string],
    ConditionalBatchSnapshotV2
  >({
    apiKey: "deleteConditionalBatchScheme",
    channel: "conditional-batch:delete",
    args: z.tuple([ConditionalBatchSchemeIdSchema]),
    result: ConditionalBatchSnapshotV2Schema,
  }),
  saveConditionalBatchSequence: defineIpcContract<
    [ConditionalBatchSequenceV2],
    ConditionalBatchSnapshotV2
  >({
    apiKey: "saveConditionalBatchSequence",
    channel: "conditional-batch:sequence-save",
    args: z.tuple([ConditionalBatchSequenceV2Schema]),
    result: ConditionalBatchSnapshotV2Schema,
  }),
  deleteConditionalBatchSequence: defineIpcContract<
    [string],
    ConditionalBatchSnapshotV2
  >({
    apiKey: "deleteConditionalBatchSequence",
    channel: "conditional-batch:sequence-delete",
    args: z.tuple([ConditionalBatchSchemeIdSchema]),
    result: ConditionalBatchSnapshotV2Schema,
  }),
  exportConditionalBatchYaml: defineIpcContract<[{ ids?: string[] }], string>({
    apiKey: "exportConditionalBatchYaml",
    channel: "conditional-batch:export-yaml",
    args: z.tuple([
      z
        .object({
          ids: z.array(ConditionalBatchSchemeIdSchema).max(100).optional(),
        })
        .strict(),
    ]),
    result: z.string().max(MAX_CONDITIONAL_BATCH_FILE_BYTES),
  }),
  importConditionalBatchYaml: defineIpcContract<
    [
      {
        yaml: string;
        conflictPolicy: "duplicate" | "overwrite";
      },
    ],
    ConditionalBatchSnapshotV2
  >({
    apiKey: "importConditionalBatchYaml",
    channel: "conditional-batch:import-yaml",
    args: z.tuple([
      z
        .object({
          yaml: z.string().max(MAX_CONDITIONAL_BATCH_FILE_BYTES),
          conflictPolicy: z
            .enum(["duplicate", "overwrite"])
            .default("duplicate"),
        })
        .strict(),
    ]),
    result: ConditionalBatchSnapshotV2Schema,
  }),
  openConditionalBatchYamlFile: defineIpcContract<
    [],
    ConditionalBatchYamlFileResult | null
  >({
    apiKey: "openConditionalBatchYamlFile",
    channel: "conditional-batch:open-yaml-file",
    args: z.tuple([]),
    result: ConditionalBatchYamlFileResultSchema.nullable(),
  }),
  saveConditionalBatchYamlFile: defineIpcContract<
    [{ yaml: string; defaultName: string }],
    ConditionalBatchYamlSaveResult | null
  >({
    apiKey: "saveConditionalBatchYamlFile",
    channel: "conditional-batch:save-yaml-file",
    args: z.tuple([
      z
        .object({
          yaml: z.string().max(MAX_CONDITIONAL_BATCH_FILE_BYTES),
          defaultName: z.string().trim().min(1).max(120),
        })
        .strict(),
    ]),
    result: ConditionalBatchYamlSaveResultSchema.nullable(),
  }),
} as const;
