import { vi } from "vitest";
import { z } from "zod/v4";
import { randomUUID } from "node:crypto";
import { soundEffectFixture } from "./mcpSoundEffect.fixture";
import {
  mcpSoundEffectOutputs,
  McpSoundEffectPlanReferenceSchema,
  type McpSoundEffectPrepare,
} from "../src/shared/mcpSoundEffects";

export async function soundEffectToolsFixture() {
  const f = await soundEffectFixture();
  const { McpOperationService } =
    await import("../src/main/application/mcpOperationService");
  const { createMcpSoundEffectSession } =
    await import("../src/main/mcp/mcpSoundEffectSession");
  const { mcpToolResult } = await import("../src/main/mcp/mcpToolResult");
  const errors: unknown[] = [];
  const operations = new McpOperationService((error) => errors.push(error));
  const session = createMcpSoundEffectSession(
    f.app,
    operations,
    f.editing,
    true,
    true,
    { startClient: f.startClient },
  );
  const invoke = async (name: string, args: object, caller = f.auth()) => {
    const tool = session.tools.find((tool) => tool.name === name);
    if (!tool) throw new Error(`Missing sound-effect tool ${name}`);
    return mcpToolResult(
      tool,
      await tool.invoke(args as Record<string, unknown>, caller),
    );
  };
  const prepare = async (
    command: McpSoundEffectPrepare["command"],
    suppliedRequestId?: string,
  ) => {
    const input = {
      ...(await f.input(command)),
      ...(suppliedRequestId ? { requestId: suppliedRequestId } : {}),
    };
    const name =
      command.kind === "generate"
        ? "carrot_generate_sound_effects"
        : "carrot_prepare_sound_effect_batch";
    const receipt = await invoke(name, input);
    const { jobId } = z
      .object({ jobId: z.uuid() })
      .parse(receipt.structuredContent);
    await vi.waitFor(
      async () => {
        if ((await operations.status(jobId, f.owner)).status === "running")
          throw new Error("Preparation running");
      },
      { timeout: 10000 },
    );
    const job = await operations.status(jobId, f.owner);
    if (job.status !== "completed" && job.status !== "partial")
      throw new Error(JSON.stringify(job));
    const plan = McpSoundEffectPlanReferenceSchema.parse(
      job.result?.soundEffectPlan,
    );
    return { ...plan, input, job, receipt };
  };
  const inspect = async (batchId: string) =>
    mcpSoundEffectOutputs.carrot_get_sound_effect_batch.parse(
      (await invoke("carrot_get_sound_effect_batch", { batchId }))
        .structuredContent,
    );
  const action = async (
    batchId: string,
    direction: string,
    requestId = randomUUID(),
  ) => {
    const receipt = await invoke(`carrot_${direction}_sound_effect_batch`, {
      batchId,
      requestId,
    });
    await vi.waitFor(
      async () => {
        if ((await inspect(batchId)).status === "running")
          throw new Error("Action running");
      },
      { timeout: 10000 },
    );
    return { receipt, result: await inspect(batchId) };
  };
  return {
    ...f,
    errors,
    operations,
    soundSession: session,
    invoke,
    preparePlan: prepare,
    inspectPlan: inspect,
    toolAction: action,
    close: async () => {
      session.stop();
      operations.stop();
      await session.close();
      await operations.close();
      await f.close();
    },
  };
}
