/**
 * Converts a caught runtime failure into a localized, user-safe status line.
 *
 * This is the failure boundary: the raw error is recorded here and only the
 * localized fallback travels on to the UI, because raw errors can carry API
 * responses, local paths, or other diagnostics. Callers must not log the error
 * again — doing so only duplicates the record.
 */
export function formatErrorMessage(
  error: unknown,
  localizedFallback: string,
): string {
  console.error(error);
  return localizedFallback;
}
