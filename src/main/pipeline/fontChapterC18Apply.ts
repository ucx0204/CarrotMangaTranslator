import type {
  FontMatchingSemanticRole,
  WorkTypographyProfileV2,
} from "../../shared/fontMatchingProfileTypes";
import type { AutomaticFontCandidate } from "../../shared/fontMatchingTypes";
import { resolveManualUserLocks } from "./automaticFontMatchingV2RuntimeGate";
import type { FontChapterC18Style } from "./fontChapterC18Types";

export function resolveFontChapterC18Style({
  style,
  candidates,
  profile,
  workId,
  chapterId,
  pageId,
  blockId,
  role,
}: {
  style?: FontChapterC18Style;
  candidates?: readonly AutomaticFontCandidate[];
  profile?: WorkTypographyProfileV2 | null;
  workId?: string;
  chapterId?: string;
  pageId: string;
  blockId: string;
  role: FontMatchingSemanticRole;
}): FontChapterC18Style | undefined {
  if (
    !style ||
    !candidates?.some((candidate) => candidate.fontId === style.fontId)
  )
    return undefined;
  const locks = resolveManualUserLocks(
    profile ?? null,
    workId ?? "unscoped-work",
    chapterId ?? "unscoped-chapter",
    pageId,
    blockId,
    role,
  );
  return locks.block || locks.role ? undefined : style;
}
