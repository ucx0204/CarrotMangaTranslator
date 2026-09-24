import type { PageSessionOptions } from "./mcpPageSessionTypes";
import type { McpParentAdmission } from "./mcpParentAdmission";
import { McpRetentionStorage } from "./mcpRetentionStorage";
import { McpOutputSyncRepository } from "./mcpOutputSyncRepository";
import { McpCompositeRepository } from "./mcpCompositeRepository";
import { McpOutputDeliveryObserver } from "./mcpOutputDeliveryObserver";
import { McpArtifactStore } from "./mcpArtifactStore";
import { createRetainedOutputPublisher } from "./mcpRetainedOutputs";
import { createMcpRetentionSession } from "./mcpRetentionSession";
import { McpEditError } from "../application/mcpEditPolicy";

/** One shared native catalog pins only issued settlement/cleanup, without extending reads or admissions. */
export function createMcpPageRetentionSession(
  options: PageSessionOptions,
  admission: McpParentAdmission,
) {
  const { app, editing, preferences } = options;
  const active = (id: string) =>
    Boolean(
      outputSyncReceipts?.isActive(id) ||
      compositeRepository?.isActive(id) ||
      admission.isActive(id),
    );
  const storage = options.retentionCodec
    ? new McpRetentionStorage(options.retentionCodec, Date.now, active)
    : undefined;
  const outputSyncReceipts: McpOutputSyncRepository | undefined = storage
    ? new McpOutputSyncRepository(storage)
    : undefined;
  const compositeRepository: McpCompositeRepository | undefined = storage
    ? new McpCompositeRepository(storage)
    : undefined;
  const observer = new McpOutputDeliveryObserver();
  const artifacts = new McpArtifactStore(
    options.origin,
    Date.now,
    storage ? createRetainedOutputPublisher(storage) : undefined,
    observer,
  );
  const retained = storage
    ? createMcpRetentionSession(
        storage,
        artifacts,
        app,
        editing,
        Boolean(preferences.allowEditing && preferences.allowProcessing),
        preferences.allowImages,
        (kind, id) => {
          if (
            (kind === "output-sync" || kind === "composite-workflow") &&
            active(id)
          )
            throw new McpEditError(
              "editor_busy",
              "The owned native operation and cleanup must settle before its retained metadata can be discarded.",
            );
        },
      )
    : undefined;
  return {
    artifacts,
    retained,
    storage,
    observer,
    outputSyncReceipts,
    compositeRepository,
  };
}
