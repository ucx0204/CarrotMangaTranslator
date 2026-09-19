import { hashStableValue } from "../../shared/blockFingerprint";
import type { McpExternalImagePreview } from "../../shared/mcpExternalImages";
import type { McpImageFileEvidence } from "../application/mcpImageEditPolicy";
import { McpEditError } from "../application/mcpEditPolicy";
import type { McpImageUploadStore } from "./mcpImageUploadStore";

export type ExternalImageAssets = {
  image: Buffer; mask?: Buffer; protectedMask?: Buffer;
  width: number; height: number; files: McpImageFileEvidence[]; guard: () => void;
};
export function withExternalImageAssets<T>(
  store: McpImageUploadStore, owner: string, input: McpExternalImagePreview,
  guard: () => void, run: (assets: ExternalImageAssets) => Promise<T>,
) {
  const command = input.command;
  const references = [
    { key: "image" as const, id: command.imageUploadId, purpose: "image" },
    ...(command.maskUploadId ? [{ key: "mask" as const, id: command.maskUploadId, purpose: "mask" }] : []),
    ...(command.protectedMaskUploadId ? [{ key: "protectedMask" as const, id: command.protectedMaskUploadId, purpose: "mask" }] : []),
  ];
  let result: ExternalImageAssets | undefined;
  const visit = (index: number, check: () => void): Promise<T> => {
    const reference = references[index];
    if (!reference) {
      if (!result) throw new Error("External image is missing.");
      return run({ ...result, guard: check });
    }
    return store.use(owner, reference.id, check, async (asset) => {
      const binding = asset.input;
      if (binding.chapterId !== input.chapterId || binding.pageId !== input.pageId ||
          binding.revision !== input.revision || binding.contextRevision !== input.contextRevision ||
          binding.purpose !== reference.purpose)
        throw new McpEditError("revision_conflict", "Upload purpose or saved page/context binding differs from this plan.");
      if (!result) result = { image: asset.bytes, width: binding.width, height: binding.height, files: asset.files, guard: asset.guard };
      else {
        if (binding.width !== result.width || binding.height !== result.height ||
            hashStableValue(asset.files) !== hashStableValue(result.files))
          throw new McpEditError("revision_conflict", "Image and masks must have identical dimensions and original/cleaned evidence.");
        result[reference.key] = asset.bytes;
      }
      return visit(index + 1, asset.guard);
    });
  };
  return visit(0, guard);
}
