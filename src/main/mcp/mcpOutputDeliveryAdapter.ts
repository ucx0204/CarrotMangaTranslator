import type {
  McpOutputDeliveryMetadata,
  McpOutputDeliveryTarget,
} from "../../shared/mcpOutputDelivery";
import {
  mcpArtifactRequiresImages,
  type McpArtifactMime,
} from "../../shared/mcpOutputFormats";
import { McpOutputDeliveryService } from "../application/mcpOutputDeliveryPolicy";
import type { McpOperationService } from "../application/mcpOperationService";
import { McpEditError } from "../application/mcpEditPolicy";
import type { McpRetentionCatalog } from "./mcpRetentionCatalog";
import type { McpArtifactStore } from "./mcpArtifactStore";
import type { McpOutputDeliveryObserver } from "./mcpOutputDeliveryObserver";
import { createMcpOutputDeliveryTools } from "./mcpOutputDeliveryTools";

type Options = {
  operations: McpOperationService;
  artifacts: McpArtifactStore;
  catalog?: McpRetentionCatalog;
  observer: McpOutputDeliveryObserver;
  allowImages: boolean;
  sync?: (
    owner: string,
    id: string,
    guard: () => void,
  ) => Promise<McpOutputDeliveryMetadata>;
};
type Resolve = ConstructorParameters<
  typeof McpOutputDeliveryService
>[0]["resolve"];
const unchecked = {
  content: "not_checked",
  source: "not_checked",
  access: "not_checked",
} as const;

/** Resolve owned native metadata before consulting optional session observations. */
export function createMcpOutputDeliveryAdapter(options: Options) {
  const resolve: Resolve = async (
    owner,
    target,
    guard,
    assertAdditionalScopes,
  ) => {
    guard();
    const format = (mime: McpArtifactMime) => {
      guard();
      if (mcpArtifactRequiresImages(mime)) {
        if (!options.allowImages)
          throw new McpEditError(
            "access_denied",
            "Image transfer is disabled.",
          );
        assertAdditionalScopes(["carrot.read", "carrot.images"]);
      }
    };
    if (target.kind === "output-sync") {
      if (!options.sync) throw unavailable();
      return { metadata: await options.sync(owner, target.receiptId, guard) };
    }
    if (target.kind === "retained-output") {
      if (!options.catalog) throw unavailable();
      return {
        metadata: await options.catalog.diagnoseOutput(
          owner,
          target.outputId,
          guard,
          format,
        ),
        observation: { retainedOutputId: target.outputId },
      };
    }
    return inspectJob(options, owner, target, guard, format);
  };
  return createMcpOutputDeliveryTools(
    new McpOutputDeliveryService({
      resolve,
      observe: (reference) => options.observer.inspect(reference),
    }),
  );
}

async function inspectJob(
  options: Options,
  owner: string,
  target: Extract<McpOutputDeliveryTarget, { kind: "job" }>,
  guard: () => void,
  format: (mime: McpArtifactMime) => void,
) {
  await options.operations.ready();
  guard();
  const status = options.operations.status(target.jobId, owner);
  const output = options.operations.outputMetadata(
    target.jobId,
    owner,
    target.pageId,
  );
  const metadata: McpOutputDeliveryMetadata = {
    generation: {
      status: status.status,
      jobId: target.jobId,
      ...(status.finishedAt === undefined
        ? {}
        : { finishedAt: status.finishedAt }),
    },
    retention: { state: "not_retained", ...unchecked },
  };
  if (!output) return { metadata };
  metadata.artifact = output.artifact;
  const retainedOutputId = output.artifact.retainedOutputId;
  if (retainedOutputId && options.catalog)
    metadata.retention = await inspectRetention(
      options.catalog,
      owner,
      retainedOutputId,
      output.artifact,
      guard,
      format,
    );
  guard();
  const session = await inspectSession(
    options.artifacts,
    output,
    guard,
    format,
  );
  metadata.sessionFile = session.file;
  return {
    metadata,
    observation: retainedOutputId ? { retainedOutputId } : session.observation,
  };
}

async function inspectRetention(
  catalog: McpRetentionCatalog,
  owner: string,
  id: string,
  artifact: NonNullable<McpOutputDeliveryMetadata["artifact"]>,
  guard: () => void,
  format: (mime: McpArtifactMime) => void,
): Promise<McpOutputDeliveryMetadata["retention"]> {
  try {
    const retained = await catalog.diagnoseOutput(owner, id, guard, format);
    if (
      retained.artifact &&
      (retained.artifact.sha256 !== artifact.sha256 ||
        retained.artifact.bytes !== artifact.bytes ||
        retained.artifact.mimeType !== artifact.mimeType)
    )
      return { ...retained.retention, content: "mismatch", access: "blocked" };
    return retained.retention;
  } catch (error) {
    guard();
    if (!(error instanceof McpEditError) || error.code !== "not_found")
      throw error;
    return { state: "unavailable", ...unchecked, access: "blocked" };
  }
}

async function inspectSession(
  artifacts: McpArtifactStore,
  output: NonNullable<ReturnType<McpOperationService["outputMetadata"]>>,
  guard: () => void,
  format: (mime: McpArtifactMime) => void,
) {
  if (!output.url) return { file: { state: "unavailable" as const } };
  try {
    guard();
    format(output.artifact.mimeType);
    await artifacts.assertAvailable(output.url);
    guard();
    format(output.artifact.mimeType);
    const observation = await artifacts.observation(output.url);
    guard();
    return {
      file: { state: "available" as const, checkedAt: Date.now() },
      observation: { artifactKey: observation.artifactKey },
    };
  } catch (error) {
    guard();
    if (
      !(error instanceof McpEditError) ||
      !["not_found", "access_denied", "revision_conflict"].includes(error.code)
    )
      throw error;
    return { file: { state: "unavailable" as const, checkedAt: Date.now() } };
  }
}
function unavailable() {
  return new McpEditError(
    "not_found",
    "Owned output delivery metadata is unavailable.",
  );
}
