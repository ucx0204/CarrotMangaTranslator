import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import type { McpOperationContext } from "../application/mcpOperationService";
import type { McpContextProposalService } from "../application/mcpContextProposalService";
import { McpContextResearchService } from "../application/mcpContextResearchService";
import { assertContextTarget } from "../application/mcpContextEditPolicy";
import { McpEditError } from "../application/mcpEditPolicy";
import type { McpContextResearchTarget } from "../../shared/mcpContextEditing";
import {
  libraryStructureResource,
  pageContentResource,
  type AppActivityResource,
} from "../../shared/appActivityTypes";
import { listLibrary, readWorkContextForEdit } from "../library";
import { getAppSettings } from "../settingsStore";
import { withExecutionSettings } from "../settings/executionSettings";
import { researchWorkContext } from "../workContextResearch";
import { buildBaseOptions } from "../pipeline/options";
import { assertMcpRemoteTextApi } from "./mcpBlockTranslationOptions";
import { runMcpAppJob } from "./mcpAppJob";

/** The protected research engine and its matching/evidence algorithms stay in
 * the existing app. This adapter adds remote lifetime and context ownership. */
export function createMcpContextResearchExecutor(
  app: InpaintingJobContext,
  proposals: McpContextProposalService,
  research = researchWorkContext,
) {
  return async (
    owner: string,
    target: McpContextResearchTarget,
    operation: McpOperationContext,
  ) => {
    operation.assertAuthorized();
    const snapshot = await readWorkContextForEdit(target.chapterId);
    assertContextTarget(snapshot, target.chapterId, target.revision);
    const settings = await getAppSettings(app.appPaths);
    if (
      target.engine === "tavily" &&
      settings.internetResearch.tavilyAnalysisProvider === "api"
    )
      assertMcpRemoteTextApi(
        buildBaseOptions(
          operation.id,
          app.appPaths.dataRoot,
          { ...settings, modelProvider: "openai-api" },
          app.appPaths,
        ),
      );
    const work = (await listLibrary()).works.find(
      (entry) => entry.id === snapshot.workId,
    );
    if (!work)
      throw new McpEditError("not_found", "Research work no longer exists.");
    const chapters = work.chapters.map((entry) => entry.id);
    const resources: AppActivityResource[] = [
      { kind: "work-context", scope: snapshot.workId, access: "read" },
      libraryStructureResource("work", snapshot.workId, "read"),
      ...chapters.flatMap((id) => [
        libraryStructureResource("chapter", id, "read"),
        { ...pageContentResource(id, "**"), access: "read" as const },
      ]),
      ...(target.engine === "codex-web"
        ? [{ kind: "codex-auth" as const, scope: "*", access: "read" as const }]
        : settings.internetResearch.tavilyAnalysisProvider === "api"
          ? []
          : [
              {
                kind: "model-runtime" as const,
                scope: "*",
                access: "write" as const,
              },
            ]),
    ];
    operation.assertAuthorized();
    return runMcpAppJob(
      app,
      operation,
      "internet-research",
      (context) =>
        withExecutionSettings(settings, async () => {
          const latest = (await listLibrary()).works.find(
            (entry) => entry.id === snapshot.workId,
          );
          if (
            JSON.stringify(latest?.chapters.map((entry) => entry.id)) !==
            JSON.stringify(chapters)
          )
            throw new McpEditError(
              "revision_conflict",
              "Research chapter membership changed before execution.",
            );
          return new McpContextResearchService({
            read: readWorkContextForEdit,
            proposals,
            research: (request, job) =>
              research(request, job.signal, (progress) => {
                job.assertAuthorized();
                job.progress({
                  phase:
                    progress.research?.stage ?? progress.phase ?? "researching",
                });
              }),
          }).run(owner, target, context);
        }),
      { resources },
    );
  };
}
