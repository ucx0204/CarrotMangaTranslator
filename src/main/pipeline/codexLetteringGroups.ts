import type { CodexPageRegion } from "../../shared/codexTypesettingTypes";
import type { TypesettingLetteringContext } from "../application/codexTypesettingContracts";
import { isSexualImageRefusal } from "../codexImageModeration";
import { throwImageStorageFailure } from "./imageJobFailure";

export async function generateStyleGroups(
  regions: CodexPageRegion[],
  context: TypesettingLetteringContext,
  signal: AbortSignal,
  generate: (region: CodexPageRegion, anchor?: string) => Promise<string>,
  onBlocked: (region: CodexPageRegion) => void,
) {
  const groups = new Map<string, CodexPageRegion[]>();
  for (const region of regions) {
    const groupId =
      context.plan.groups.find((group) =>
        group.members.some((member) => member.regionId === region.id),
      )?.id ?? region.id;
    groups.set(groupId, [...(groups.get(groupId) ?? []), region]);
  }
  const queue = [...groups.values()];
  const failures: Array<{ source: string; error: unknown }> = [];
  let fatal: unknown;
  const generateFamily = async (group: CodexPageRegion[]) => {
    let anchor: string | undefined;
    for (const region of group) {
      signal.throwIfAborted();
      if (fatal) throw fatal;
      try {
        const generated = await generate(region, anchor);
        anchor ??= generated;
      } catch (error) {
        signal.throwIfAborted();
        try {
          throwImageStorageFailure(error);
        } catch (storageError) {
          fatal = storageError;
          throw storageError;
        }
        if (isSexualImageRefusal(error)) {
          onBlocked(region);
          continue;
        }
        failures.push({ source: region.sourceText, error });
      }
    }
  };
  const worker = async () => {
    for (let group = queue.shift(); group; group = queue.shift())
      await generateFamily(group);
  };
  // Wait for all writers, including after cancellation or a failed group.
  const settled = await Promise.allSettled(
    Array.from({ length: Math.min(2, queue.length) }, worker),
  );
  for (const result of settled)
    if (result.status === "rejected") throw result.reason;
  return failures;
}
