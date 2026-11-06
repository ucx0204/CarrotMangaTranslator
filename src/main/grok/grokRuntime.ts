import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { AppPaths } from "../appPaths";
import type { GrokAccount } from "../../shared/grokTypes";
import {
  CliNotInstalledError,
  findManagedCli,
} from "../runtimeSupport/managedCliRuntime";
import { GrokAcpClient } from "./grokAcpClient";

export const GROK_VERSION = "1.0.77";
const modelState = z.object({
  currentModelId: z.string().optional(),
  availableModels: z
    .array(
      z.object({
        modelId: z.string(),
        name: z.string(),
        _meta: z
          .object({
            reasoningEffort: z.string().optional(),
            reasoningEfforts: z
              .array(z.object({ value: z.string() }))
              .optional(),
          })
          .passthrough()
          .optional(),
      }),
    )
    .default([]),
});
export const grokInitialization = z.object({
  authMethods: z.array(z.object({ id: z.string() })).default([]),
  _meta: z
    .object({
      agentVersion: z.string().optional(),
      modelState: modelState.optional(),
    })
    .passthrough()
    .optional(),
});
export function grokEnvironment(paths: AppPaths): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GROK_HOME: join(paths.dataRoot, "grok"),
    GROK_DISABLE_AUTOUPDATER: "1",
    GROK_SUBAGENTS: "0",
    GROK_MEMORY: "0",
    GROK_GOAL: "0",
    GROK_CLAUDE_AGENTS: "0",
    GROK_CLAUDE_SKILLS: "0",
    GROK_CURSOR_AGENTS: "0",
    GROK_CURSOR_SKILLS: "0",
  };
}
export async function startGrokRuntime(
  paths: AppPaths,
  instructions?: string,
  findBinary: typeof findManagedCli = findManagedCli,
) {
  const executable = findBinary(paths.dataRoot, "grok");
  if (!executable) throw new CliNotInstalledError("grok");
  const cwd = join(paths.dataRoot, "chat", "grok-runtime");
  await mkdir(cwd, { recursive: true });
  await mkdir(join(paths.dataRoot, "grok"), { recursive: true });
  const args = ["agent", "--no-leader"];
  if (instructions) {
    const profile = join(cwd, "carrot-agent.md");
    // Only questions and MCP discovery/dispatch are present. Filesystem,
    // terminal, browser, and subagents are absent.
    await writeFile(
      profile,
      [
        "---",
        "name: carrot",
        "description: Carrot Manga Translator assistant",
        "promptMode: full",
        "toolConfig:",
        "  tools:",
        "    - id: GrokBuild:ask_user_question",
        "    - id: GrokBuild:search_tool",
        "    - id: GrokBuild:use_tool",
        "injectDefaultTools: false",
        "discoverSkills: false",
        "inheritSkills: false",
        "agentsMd: false",
        "---",
        instructions,
        "",
      ].join("\n"),
      "utf8",
    );
    args.push("--agent-profile", profile);
  }
  args.push("stdio");
  const client = GrokAcpClient.start(
    executable,
    args,
    cwd,
    grokEnvironment(paths),
  );
  try {
    const initialization = grokInitialization.parse(
      await client.request("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "CarrotMangaTranslator", version: "1" },
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      }),
    );
    return { client, initialization, cwd };
  } catch (error) {
    await client.close();
    throw error;
  }
}
export function grokAccountFromInitialization(
  initialization: z.infer<typeof grokInitialization>,
): GrokAccount {
  const state = initialization._meta?.modelState;
  return {
    runtimeInstalled: true,
    authenticated: initialization.authMethods.some(
      (method) => method.id === "cached_token",
    ),
    version: initialization._meta?.agentVersion ?? GROK_VERSION,
    models: (state?.availableModels ?? []).map((model) => ({
      id: model.modelId,
      displayName: model.name,
      supportedReasoningEfforts:
        model._meta?.reasoningEfforts?.map((effort) => effort.value) ?? [],
      defaultReasoningEffort: model._meta?.reasoningEffort ?? "high",
      isDefault: model.modelId === state?.currentModelId,
    })),
  };
}
