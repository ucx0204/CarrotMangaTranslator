/**
 * Converts a caught runtime failure into a localized, user-safe status line.
 *
 * Raw errors can contain API responses, local paths, or other diagnostics.
 * Callers log the original error at their boundary and pass the localized
 * fallback here for presentation.
 */
export function formatErrorMessage(
  _error: unknown,
  localizedFallback: string,
): string {
  return localizedFallback;
}
