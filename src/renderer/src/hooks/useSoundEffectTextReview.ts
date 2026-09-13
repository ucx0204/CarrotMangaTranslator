import { useEffect, useRef, useState } from "react";
import type {
  SoundEffectTextReview,
  ConfirmSoundEffectTextReview,
} from "../../../shared/soundEffectTextReview";
import { analysisGateway } from "../api/analysisGateway";

type Pending = { jobId: string; review: SoundEffectTextReview };
export function useSoundEffectTextReview() {
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const current = useRef<Pending | null>(null);
  const submitting = useRef(false);
  useEffect(
    () =>
      analysisGateway.onJobEvent((event) => {
        if (event.kind !== "sound-effect-translation") return;
        if (event.soundEffectTextReview) {
          current.current = {
            jobId: event.id,
            review: event.soundEffectTextReview,
          };
          setPending(current.current);
          setError("");
        } else if (
          event.id === current.current?.jobId &&
          ["completed", "partial", "failed", "cancelled"].includes(event.status)
        ) {
          current.current = null;
          setPending(null);
        }
      }),
    [],
  );
  const submit = async (
    pages: ConfirmSoundEffectTextReview["pages"] | null,
  ) => {
    const session = current.current;
    if (!session || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      if (pages)
        await analysisGateway.confirmSoundEffectTextReview({
          jobId: session.jobId,
          sessionId: session.review.sessionId,
          pages,
        });
      else await analysisGateway.cancelJob({ jobId: session.jobId });
      if (current.current === session) {
        current.current = null;
        setPending(null);
      }
    } catch (failure) {
      if (current.current === session)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  return {
    pending,
    busy,
    error,
    confirm: (pages: ConfirmSoundEffectTextReview["pages"]) => submit(pages),
    cancel: () => submit(null),
  };
}
