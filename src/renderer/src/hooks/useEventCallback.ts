import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * Stable function identity with current behavior. Use at memoized component or
 * long-lived listener boundaries where callback identity is not data.
 */
export function useEventCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
): (...args: Args) => Result {
  const callbackRef = useRef(callback);
  useLayoutEffect(() => {
    callbackRef.current = callback;
  }, [callback]);
  return useCallback((...args: Args) => callbackRef.current(...args), []);
}
