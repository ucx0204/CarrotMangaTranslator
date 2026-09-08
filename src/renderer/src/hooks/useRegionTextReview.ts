import { useCallback, useEffect, useRef, useState } from "react";
import type {
  RegionTextReview,
  ConfirmRegionTranslationRequest,
} from "../../../shared/regionTextReview";
import { analysisGateway } from "../api/analysisGateway";

type Session = {
  id: string;
  jobId?: string;
  cancelled?: boolean;
  cancelSent?: boolean;
  submitting?: boolean;
  unsubscribe?: () => void;
};
type State = { busy: boolean; review?: RegionTextReview; error?: string };
export function useRegionTextReview() {
  const current = useRef<Session | null>(null);
  const [state, setState] = useState<State>({ busy: false });
  const cancel = useCallback(() => {
    const session = current.current;
    if (!session) return;
    session.cancelled = true;
    cancelSession(session);
  }, []);
  useEffect(() => cancel, [cancel]);
  return {
    ...state,
    cancel,
    begin: () => {
      const id = crypto.randomUUID();
      cancel();
      const session: Session = { id };
      current.current = session;
      session.unsubscribe = analysisGateway.onJobEvent((event) => {
        if (event.regionRequestId !== session.id) return;
        session.jobId = event.id;
        if (session.cancelled) {
          cancelSession(session);
          return;
        }
        if (event.regionTextReview)
          setState({ busy: false, review: event.regionTextReview });
        if (event.status === "failed" || event.status === "cancelled") {
          session.unsubscribe?.();
          setState({ busy: false, error: event.detail ?? event.progressText });
        }
      });
      setState({ busy: true });
      return id;
    },
    finish: (completed: boolean) => {
      current.current?.unsubscribe?.();
      if (current.current?.cancelled || completed) {
        current.current = null;
        setState({ busy: false });
      } else setState((previous) => ({ ...previous, busy: false }));
    },
    confirm: async (
      translations: ConfirmRegionTranslationRequest["translations"],
      onConfirmed?: () => void,
      protection?: ConfirmRegionTranslationRequest["protection"],
    ) => {
      const session = current.current;
      if (!session?.jobId || session.cancelled || session.submitting)
        return false;
      session.submitting = true;
      setState((previous) => ({ ...previous, busy: true, error: undefined }));
      try {
        await analysisGateway.confirmRegionTranslation({
          jobId: session.jobId,
          sessionId: session.id,
          translations,
          protection,
        });
        if (current.current !== session || session.cancelled) return false;
        onConfirmed?.();
        session.unsubscribe?.();
        current.current = null;
        setState({ busy: false });
        return true;
      } catch (error) {
        session.submitting = false;
        setState((previous) => ({
          ...previous,
          busy: false,
          error: error instanceof Error ? error.message : String(error),
        }));
        return false;
      }
    },
  };
}
function cancelSession(session: Session) {
  if (!session.jobId || session.cancelSent) return;
  session.cancelSent = true;
  session.unsubscribe?.();
  void analysisGateway
    .cancelJob({ jobId: session.jobId })
    .catch((error: unknown) =>
      console.error("Region translation cancellation failed", error),
    );
}
