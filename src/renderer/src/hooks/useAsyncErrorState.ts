import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { formatErrorMessage } from "../lib/errorPresentation";
import { useEventCallback } from "./useEventCallback";

/** Owns a localized async error and ignores UI updates after its view closes. */
export function useAsyncErrorState(fallback: string) {
  const [error, updateError] = useState("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const setError: Dispatch<SetStateAction<string>> = useCallback((value) => {
    if (mounted.current) updateError(value);
  }, []);
  const report = useEventCallback(
    (failure: unknown, message: string = fallback) => {
      // Keep logging and localization at the existing presentation boundary.
      const localized = formatErrorMessage(failure, message);
      setError(localized);
    },
  );
  return { error, setError, report };
}
