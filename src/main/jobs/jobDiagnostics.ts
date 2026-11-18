import type { JobEvent } from "../../shared/jobTypes";
import type { AppSettings } from "../../shared/settingsTypes";

type ExecutionDiagnostic = {
  id: string;
  kind: JobEvent["kind"];
  executionId?: string;
  startedAt: string;
  lastEventAt?: string;
  finishedAt?: string;
  cancelRequestedAt?: string;
  status?: JobEvent["status"];
  phase?: JobEvent["phase"];
  lastRunningPhase?: JobEvent["phase"];
  progressCurrent?: number;
  progressTotal?: number;
  pageIndex?: number;
  pageTotal?: number;
  attempt?: number;
  attemptTotal?: number;
  settings?: ReturnType<typeof executionSettingsDiagnostic>;
};

/** Diagnostic copies only: never used for scheduling, ownership or resume. */
export class JobDiagnostics {
  private readonly active = new Map<string, ExecutionDiagnostic>();
  private readonly recent: ExecutionDiagnostic[] = [];

  start(id: string, kind: JobEvent["kind"], signal: AbortSignal): void {
    const entry: ExecutionDiagnostic = {
      id,
      kind,
      startedAt: new Date().toISOString(),
    };
    this.active.set(id, entry);
    const cancelled = () => {
      entry.cancelRequestedAt = new Date().toISOString();
    };
    if (signal.aborted) cancelled();
    else signal.addEventListener("abort", cancelled, { once: true });
  }

  settings(id: string, settings: AppSettings): void {
    const entry = this.active.get(id);
    if (entry) entry.settings = executionSettingsDiagnostic(settings);
  }

  update(event: JobEvent): void {
    const entry = this.active.get(event.id);
    if (!entry) return;
    Object.assign(entry, {
      executionId: event.executionId ?? entry.executionId,
      lastEventAt: new Date().toISOString(),
      status: event.status,
      phase: event.phase ?? entry.phase,
      lastRunningPhase:
        event.status === "running"
          ? (event.phase ?? entry.lastRunningPhase)
          : entry.lastRunningPhase,
      progressCurrent: event.progressCurrent ?? entry.progressCurrent,
      progressTotal: event.progressTotal ?? entry.progressTotal,
      pageIndex: event.pageIndex ?? entry.pageIndex,
      pageTotal: event.pageTotal ?? entry.pageTotal,
      attempt: event.attempt ?? entry.attempt,
      attemptTotal: event.attemptTotal ?? entry.attemptTotal,
    });
  }

  finish(id: string): void {
    const entry = this.active.get(id);
    if (!entry) return;
    entry.finishedAt = new Date().toISOString();
    this.recent.push(entry);
    if (this.recent.length > 12) this.recent.shift();
    this.active.delete(id);
  }

  snapshot() {
    const now = Date.now();
    return [...this.active.values(), ...this.recent.slice().reverse()].map(
      (entry) => ({
        ...structuredClone(entry),
        active: !entry.finishedAt,
        lastProgressAgeMs: Math.max(
          0,
          now - Date.parse(entry.lastEventAt ?? entry.startedAt),
        ),
      }),
    );
  }
}

function executionSettingsDiagnostic(settings: AppSettings) {
  const translation = settings.translation;
  const inpainting = settings.inpainting;
  return {
    provider: settings.modelProvider,
    model: executionModel(settings),
    maxTokens: settings.maxTokens,
    contextTokens: settings.ctx,
    translation: translation && {
      sourceLanguage: translation.sourceLanguage,
      targetLanguage: translation.targetLanguage,
    },
    ocr: {
      pipeline: settings.ocr.pipeline,
      device: settings.ocr.device,
      qualityMode: settings.ocr.qualityMode,
      gpuBackend: settings.ocr.gpuBackend,
    },
    localModel: {
      source: settings.gemma.modelSource,
      vramMode: settings.gemma.vramMode,
      runtime: settings.gemma.llamaRuntimeProfile,
    },
    inpainting: inpainting && {
      model: inpainting.model,
      fluxBackend: inpainting.fluxBackend,
      fluxMode: inpainting.fluxMode,
      koharuBackend: inpainting.koharuBackend,
    },
  };
}

function executionModel(settings: AppSettings) {
  switch (settings.modelProvider) {
    case "openai-api":
      return {
        model: settings.api.model,
        reasoningEffort: settings.api.reasoningEffort,
      };
    case "openai-codex":
      return {
        model: settings.codex.model,
        reasoningEffort: settings.codex.reasoningEffort,
      };
    case "claude-code":
      return {
        model: settings.claude?.model,
        reasoningEffort: settings.claude?.effort,
      };
    case "gemma":
      return {
        model:
          settings.gemma.modelSource === "local"
            ? "local"
            : `${settings.gemma.modelRepo}/${settings.gemma.modelFile}`,
      };
  }
}
