import { asRecord } from "./codexAppServerProtocol";

/** Only a provider's explicit sexual moderation refusal is a skippable result. */
export function isSexualImageRefusal(reason: unknown): boolean {
  if (reason instanceof AggregateError) return false;
  const error = asRecord(reason);
  if (!error || error.name === "AbortError") return false;
  const diagnostics = asRecord(error.imageGenerationDiagnostics);
  const provider = asRecord(diagnostics?.processError) ?? error;
  const moderation = asRecord(
    provider.moderationDetails ?? provider.moderation_details,
  );
  if (
    provider.code === "moderation_blocked" &&
    Array.isArray(moderation?.categories) &&
    moderation.categories.includes("sexual")
  )
    return true;
  return [error.message, provider.message].some(
    (message) =>
      typeof message === "string" &&
      /\bsafety_violations\s*=\s*\[[^\]]*\bsexual\b[^\]]*\]/iu.test(message),
  );
}
