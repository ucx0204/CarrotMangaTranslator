import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { PageWorkflowRequestSchema } from "../shared/ipcPageWorkflowContracts";
import { ConditionalBatchSchemeDraftV2Schema } from "../shared/conditionalBatchRules";
import { freezeWorkflowRules } from "../shared/pageWorkflowRules";
import type { PageWorkflowRequest } from "../shared/pageWorkflowTypes";
import { ConditionalBatchSchemeStore } from "./conditionalBatchSchemeStore";
import { writeJsonFile } from "./libraryStore/storage";

const RunSchema = z
  .object({
    id: z.string().uuid(),
    request: PageWorkflowRequestSchema,
    rules: z
      .object({
        "source-rules": z.array(ConditionalBatchSchemeDraftV2Schema).optional(),
        "translation-rules": z
          .array(ConditionalBatchSchemeDraftV2Schema)
          .optional(),
        "format-rules": z.array(ConditionalBatchSchemeDraftV2Schema).optional(),
      })
      .strict(),
  })
  .strict();

export async function readPageWorkflowRun(dataRoot: string, id: string) {
  const safeId = z.string().uuid().parse(id);
  return RunSchema.parse(
    JSON.parse(
      await readFile(
        join(dataRoot, "page-workflows", `${safeId}.json`),
        "utf8",
      ),
    ),
  );
}

export async function preparePageWorkflowRun(
  dataRoot: string,
  request: PageWorkflowRequest,
) {
  if (request.resumeRunId) {
    const run = await readPageWorkflowRun(dataRoot, request.resumeRunId);
    return run;
  }
  const snapshot = await new ConditionalBatchSchemeStore(dataRoot).list();
  const run = {
    id: randomUUID(),
    request,
    rules: freezeWorkflowRules(request.plan, snapshot),
  };
  await writeJsonFile(join(dataRoot, "page-workflows", `${run.id}.json`), run);
  return run;
}
