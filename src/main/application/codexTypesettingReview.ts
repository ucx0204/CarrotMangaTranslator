import type { CodexPageReading } from "../../shared/codexTypesettingTypes";
import type {
  CodexTypesettingPorts,
  TypesettingIssue,
} from "./codexTypesettingContracts";

export async function keepFirstResultOnReviewFailure<
  T extends { issues: TypesettingIssue[] },
>(
  reading: CodexPageReading,
  ports: CodexTypesettingPorts,
  kind: TypesettingIssue["kind"],
  name: string,
  review: () => Promise<T>,
  fallback: Omit<T, "issues">,
): Promise<T> {
  try {
    return await review();
  } catch (error) {
    ports.signal.throwIfAborted();
    const message = error instanceof Error ? error.message : String(error);
    await ports.saveEvidence(`review-failure-${name}`, {
      error: message,
      resultPreserved: true,
    });
    return {
      ...fallback,
      issues: reading.regions
        .filter((region) => region.action !== "keep")
        .map((region) => ({
          regionId: region.id,
          kind,
          reason: `결과 검수를 완료하지 못했습니다: ${message}`,
        })),
    } as T;
  }
}
