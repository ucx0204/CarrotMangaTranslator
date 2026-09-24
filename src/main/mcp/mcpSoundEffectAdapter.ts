import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import type { SoundEffectRequest } from "../application/mcpSoundEffectPolicy";
import { McpEditError } from "../application/mcpEditPolicy";
import { openChapter, commitSoundEffectSnapshot } from "../library";
import { createMcpPageBatchPorts } from "./mcpTranslationBatchAdapter";
import { createMcpPageEditScope } from "./mcpPageEditScope";
import { assertMcpBatchMembership } from "../application/mcpPageBatchPolicy";
import { captureSoundEffectPage } from "../../shared/soundEffectPageSnapshot";
import { hashStableValue } from "../../shared/blockFingerprint";
import {
  readMcpImageEditPage,
  verifyMcpImageFiles,
} from "./mcpImageEditEvidence";

export function createMcpSoundEffectPorts(
  app: InpaintingJobContext,
  editing: {
    assertWritable: (chapterId: string, pageId: string) => Promise<void>;
    notifySaved: (chapterId: string, pageId: string) => void;
  },
  lifetime: AbortSignal,
) {
  const own = createMcpPageEditScope(app, openChapter, lifetime);
  return createMcpPageBatchPorts<SoundEffectRequest>(
    (request, membership, guard, committed, scope) =>
      own(request, guard, (authorize) =>
        scope(async () => {
          await editing.assertWritable(request.chapterId, request.pageId);
          const chapter = await openChapter(request.chapterId);
          assertMcpBatchMembership(chapter, membership);
          const page = await readMcpImageEditPage(request, authorize);
          if (
            hashStableValue(captureSoundEffectPage(page)) !==
            hashStableValue(request.expected)
          )
            throw new McpEditError(
              "revision_conflict",
              "Sound-effect review or blocks changed. Later edits will not be overwritten.",
            );
          await verifyMcpImageFiles(request.files, authorize);
          await editing.assertWritable(request.chapterId, request.pageId);
          authorize();
          await commitSoundEffectSnapshot(
            request,
            request.expected,
            request.replacement,
            authorize,
            committed,
          );
          editing.notifySaved(request.chapterId, request.pageId);
        }),
      ),
  );
}
