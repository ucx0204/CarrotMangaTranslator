import React from "react";
import { analysisGateway } from "../../api/analysisGateway";
import { redactionProgress } from "./redactionSession";
import { changeRedactionView, decideAndAdvanceRedaction, navigateRedactionPage } from "./redactionWorkspaceModel";
import type { RedactionWorkspaceController } from "./useRedactionWorkspace";

type Job = { jobId: string; sessionId: string };
type Options = {
  form: RedactionWorkspaceController; root: React.RefObject<HTMLDivElement | null>;
  job?: Job; detailReady: boolean; onClose: () => void; setSelected: (index: number) => void;
};
export function useRedactionWorkspaceActions(options: Options) {
  const { form, root, setSelected } = options;
  const entry = React.useRef(form.state);
  const focus = () => requestAnimationFrame(() => {
    root.current?.querySelector<HTMLElement>("[data-redaction-stage], [role=listbox]")?.focus();
  });
  const open = (id: string) => {
    if (form.busy || form.drawing) return;
    form.commit((current) => changeRedactionView(navigateRedactionPage(current, id), { mode: "edit" }));
    setSelected(-1); focus();
  };
  const adjacent = (direction: number) => {
    const current = form.live.current;
    const index = current.workspace.pages.findIndex((page) => page.id === current.workspace.view.currentId);
    const page = current.workspace.pages[index + direction];
    if (page) open(page.id);
  };
  const decide = (decision: "reviewed" | "deferred") => {
    if (form.busy || form.drawing || decision === "reviewed" && !options.detailReady) return;
    form.commit((current) => changeRedactionView(decideAndAdvanceRedaction(current, decision), { mode: "edit" }));
    setSelected(-1); focus();
  };
  const finish = async (send: boolean, discard = false) => {
    if (form.busy || form.drawing) return;
    form.setBusy(true); form.setError("");
    try {
      if (discard) form.commit((current) => ({ ...entry.current, generation: current.generation + 1 }));
      const revision = await form.flush();
      const snapshot = form.live.current;
      if (send && options.job) await confirmSnapshot(snapshot, options.job, revision);
      else if (options.job) await analysisGateway.cancelJob({ jobId: options.job.jobId });
      await analysisGateway.closeRedactionWorkspace(snapshot.workspace.sessionId);
      options.onClose();
    } catch (error) { form.report(error); }
    finally { form.setBusy(false); }
  };
  const continueWork = () => {
    const target = unresolvedPage(form);
    if (target) { open(target); return; }
    void finish(true);
  };
  return { open, focus, previous: () => adjacent(-1), next: () => adjacent(1), confirm: () => decide("reviewed"), defer: () => decide("deferred"), continueWork,
    saveExit: () => { void finish(false); }, discard: () => { void finish(false, true); } };
}

function unresolvedPage(form: RedactionWorkspaceController): string | undefined {
  const state = form.live.current;
  const firstError = state.workspace.pages.find((page) => form.failed.has(page.id));
  if (firstError) return firstError.id;
  for (const decision of ["unreviewed", "deferred"] as const) {
    const page = state.workspace.pages.find((item) => state.documents[item.id].decision === decision);
    if (page) return page.id;
  }
  return undefined;
}
async function confirmSnapshot(snapshot: RedactionWorkspaceController["state"], job: Job, revision: number): Promise<void> {
  const progress = redactionProgress(snapshot.documents);
  if (progress.unreviewed || progress.deferred) throw new Error("Unreviewed redaction pages remain");
  const confirmed = await analysisGateway.confirmImageRedaction({
    ...job, workspaceRevision: revision,
    pages: Object.values(snapshot.documents).map(({ id, fingerprint, strokes }) => ({ id, fingerprint, strokes })),
  });
  if (!confirmed) throw new Error("The redaction review was not accepted");
}
