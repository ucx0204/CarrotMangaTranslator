import type { ConfirmImageRedaction } from "../../src/shared/imageRedaction";
import { openPendingRedactionWorkspace } from "../../src/main/jobs/imageRedactionReview";
import { saveRedactionWorkspace } from "../../src/main/imageRedactionWorkspaceSessions";

/** Exercise the real pending session and draft store before explicitly approving. */
export async function saveReviewedRequest(
  root: string,
  request: ConfirmImageRedaction,
): Promise<ConfirmImageRedaction> {
  const workspace = await openPendingRedactionWorkspace(
    request.jobId,
    request.sessionId,
    root,
  );
  const workspaceRevision = await saveRedactionWorkspace({
    sessionId: workspace.sessionId,
    expectedRevision: workspace.revision,
    changes: request.pages.map((page) => ({ ...page, decision: "reviewed" })),
    view: workspace.view,
    preferences: workspace.preferences,
    presets: workspace.presets,
  });
  return { ...request, workspaceRevision };
}
