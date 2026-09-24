import type { AppPaths } from "../appPaths";
import { McpSoundEffectReadSchema } from "../../shared/mcpSoundEffects";
import {
  createPageRevision,
  createSoundEffectReviewPageRevision,
} from "../../shared/pageRevision";
import { mcpContextRevision } from "../../shared/mcpContextEditing";
import { readWorkContextForEdit } from "../library";
import { McpEditError } from "../application/mcpEditPolicy";
import { createMcpBatchTool } from "./mcpBatchTool";
import { soundEffectItems } from "./mcpSoundEffectState";
import { readMcpSoundEffectSettings } from "./mcpSoundEffectSettings";

/** Only stored candidates are reported: listing never starts detection or generation. */
export function createMcpSoundEffectReadTool(paths: AppPaths) {
  return createMcpBatchTool({
    name: "carrot_get_sound_effects",
    schema: McpSoundEffectReadSchema,
    scopes: ["carrot.read"],
    write: false,
    description:
      "Read stored sound-effect candidates and saved sound blocks with ORIGINAL pixel rectangles, pending/excluded/resolved/overlap-hidden decisions and active/disabled/stale image state. Existing OCR-produced candidates and manual review regions only; no new detection. Paginated reads require the returned reviewRevision after offset zero. Configured image controller is metadata, NOT account/quota/runtime readiness. No image bytes, paths, credentials, model calls, settings repair or page writes. Use independent selection OCR/translation and image-erasure tools for those stages; external images use validated uploads.",
    execute: async (value, _owner, guard) => {
      const input = McpSoundEffectReadSchema.parse(value);
      const saved = await readWorkContextForEdit(input.chapterId);
      guard();
      const page = saved.chapter.pages.find((page) => page.id === input.pageId);
      if (!page)
        throw new McpEditError("not_found", "Sound-effect page not found.");
      const reviewRevision = createSoundEffectReviewPageRevision(page);
      if (input.reviewRevision && input.reviewRevision !== reviewRevision)
        throw new McpEditError(
          "revision_conflict",
          "Sound-effect review changed during pagination.",
        );
      const settings = await readMcpSoundEffectSettings(paths);
      const items = soundEffectItems(page);
      const current = await readWorkContextForEdit(input.chapterId);
      const latest = current.chapter.pages.find(
        (item) => item.id === input.pageId,
      );
      guard();
      if (
        !latest ||
        current.workId !== saved.workId ||
        mcpContextRevision(current) !== mcpContextRevision(saved) ||
        createSoundEffectReviewPageRevision(latest) !== reviewRevision
      )
        throw new McpEditError(
          "revision_conflict",
          "Sound-effect page or context changed during inspection.",
        );
      return {
        chapterId: input.chapterId,
        pageId: input.pageId,
        revision: createPageRevision(page),
        reviewRevision,
        contextRevision: mcpContextRevision(saved),
        width: page.width,
        height: page.height,
        total: items.length,
        offset: input.offset,
        limit: input.limit,
        nextOffset:
          input.offset + input.limit < items.length
            ? input.offset + input.limit
            : null,
        items: items.slice(input.offset, input.offset + input.limit),
        generation: {
          provider: "codex" as const,
          configuredModel: settings.codex.imageModel,
          runtimeChecked: false as const,
        },
        warnings: [
          "stored_candidates_only_no_detection",
          "image_state_is_text_metadata_not_visual_quality",
          "runtime_account_and_quota_not_checked",
        ],
      };
    },
  });
}
