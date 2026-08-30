import type { TFunction } from "i18next";
import type {
  AppOperationActivityEvent,
  AppOperationPhase,
} from "../../../shared/appOperationTypes";

type AppOperationActivityPresentation = Pick<
  AppOperationActivityEvent,
  "kind" | "status" | "phase" | "sourceKind"
>;

export function formatAppOperationActivity(
  activity: AppOperationActivityPresentation,
  t: TFunction<"renderer">,
): string {
  const kind = resolveAppOperationKindLabel(activity, t);
  const state =
    activity.status === "running" && activity.phase
      ? resolveAppOperationPhaseLabel(activity.phase, t)
      : t(`statusDock.operation.status.${activity.status}`);
  return t("statusDock.operation.summary", { kind, state });
}

function resolveAppOperationKindLabel(
  activity: AppOperationActivityPresentation,
  t: TFunction<"renderer">,
): string {
  if (activity.kind === "library-import-preview") {
    return t("statusDock.operation.kind.importPreview", {
      source: activity.sourceKind
        ? t(`statusDock.operation.source.${activity.sourceKind}`)
        : t("statusDock.operation.source.files"),
    });
  }
  if (activity.kind === "library-import") {
    return t("statusDock.operation.kind.libraryImport");
  }
  if (activity.kind === "web-import-preview") {
    return activity.phase === "web-preparing"
      ? t("statusDock.operation.kind.webPrepare")
      : t("statusDock.operation.kind.webScan");
  }
  if (activity.kind === "work-share-import") {
    return t("statusDock.operation.kind.shareImport");
  }
  if (activity.kind === "work-share-export") {
    return t("statusDock.operation.kind.shareExport");
  }
  if (activity.kind === "model-test") {
    return t("statusDock.operation.kind.modelTest");
  }
  if (activity.kind === "codex-auth") {
    return t("statusDock.operation.kind.codexAuth");
  }
  return t("statusDock.operation.kind.background");
}

function resolveAppOperationPhaseLabel(
  phase: AppOperationPhase,
  t: TFunction<"renderer">,
): string {
  return t(`statusDock.operation.phase.${phase}`);
}

export function isAppOperationActive(
  activity: AppOperationActivityEvent | null,
): boolean {
  return activity?.status === "running" || activity?.status === "cancelling";
}
