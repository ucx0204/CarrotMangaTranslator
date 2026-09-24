import { McpSoundEffectImageSchema } from "../../shared/mcpSoundEffects";
import type { SoundEffectPlan } from "../application/mcpSoundEffectPolicy";
import { readImageRedactionState } from "../imageRedactionStore";
import { McpEditError } from "../application/mcpEditPolicy";
import { captureSoundEffectPage } from "../../shared/soundEffectPageSnapshot";
import { hashStableValue } from "../../shared/blockFingerprint";
import {
  readMcpImageEditPage,
  verifyMcpImageFiles,
} from "./mcpImageEditEvidence";
import { createMcpBatchTool } from "./mcpBatchTool";
import { textContent } from "./mcpReadTools";
import { reduceMcpCandidatePng } from "./mcpCandidatePng";

type Access = (
  owner: string,
  batchId: string,
  guard: () => void,
) => Promise<{ chapterId: string; plan: SoundEffectPlan }>;
export function createMcpSoundEffectImageTool(
  access: Access,
  lifetime: AbortSignal,
) {
  return createMcpBatchTool({
    name: "carrot_get_sound_effect_image",
    schema: McpSoundEffectImageSchema,
    scopes: ["carrot.read", "carrot.images"],
    write: false,
    description:
      "Fetch only the reviewed foreground image for one selected sound-effect block in an owned live plan. This is the asset, not the final transformed page renderer. Metadata polling never attaches an image. Long edge <=1600px, PNG <=4MiB. Rechecks image permission, redaction, original/cleaned/mask hashes, current page and review snapshot. No inference, page save, export artifact or URL access.",
    execute: async (value, owner, guard) => {
      const input = McpSoundEffectImageSchema.parse(value);
      const check = () => {
        lifetime.throwIfAborted();
        guard();
      };
      const { chapterId, plan } = await access(owner, input.batchId, check);
      const target = plan.pages[0];
      const state = target.state === "applied" ? plan.after : plan.before;
      const validate = async () => {
        check();
        if ((await readImageRedactionState()).enabled)
          throw new McpEditError(
            "access_denied",
            "Sound-effect image transfer is blocked by redaction review.",
          );
        const current = await readMcpImageEditPage(
          {
            chapterId,
            pageId: target.pageId,
            revision: target.expectedRevision,
          },
          check,
        );
        if (
          hashStableValue(captureSoundEffectPage(current)) !==
          hashStableValue(state)
        )
          throw new McpEditError(
            "revision_conflict",
            "Sound-effect page changed since review.",
          );
        await verifyMcpImageFiles(plan.files, check);
        check();
      };
      await validate();
      const block = plan.after.blocks.find(
        (block) => block.id === input.blockId && block.textRole === "sound",
      );
      if (
        !block?.generatedLettering ||
        !plan.changes.some(
          (change) => change.id === input.blockId && change.changed,
        )
      )
        throw new McpEditError(
          "not_found",
          "No reviewed image exists for this selected sound-effect block.",
        );
      const url = block.generatedLettering.dataUrl;
      const png = imagePreview(url);
      await validate();
      return {
        ...input,
        kind: "sound-effect-asset" as const,
        ...png,
        note: "Foreground asset only; use the existing page renderer after applying to inspect final placement.",
      };
    },
    formatResult: ({ imageData, ...metadata }) => [
      ...textContent(metadata),
      { type: "image", data: imageData, mimeType: "image/png" },
    ],
  });
}

function imagePreview(url: string) {
  if (!url.startsWith("data:image/png;base64,"))
    throw new McpEditError(
      "invalid_edit",
      "The reviewed sound-effect image is not PNG.",
    );

  const bytes = Buffer.from(
    url.slice("data:image/png;base64,".length),
    "base64",
  );
  return reduceMcpCandidatePng(bytes);
}
