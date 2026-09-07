import type {
  CodexPageReading,
  CodexSfxRendering,
} from "../../shared/codexTypesettingTypes";
import { serializeRichTextRuns } from "../../shared/richTextMarkup";
import type { TypesettingLayout } from "./codexTypesettingContracts";
import { assertExactMembership } from "./codexTypesettingValidation";

/** Presentation may change after actual font samples; source/erase geometry never does. */
export function applyCodexLayoutTreatment(
  reading: CodexPageReading,
  layouts: TypesettingLayout[],
  sfxRendering?: CodexSfxRendering,
): CodexPageReading {
  assertExactMembership(
    reading.regions
      .filter((region) => region.action !== "keep")
      .map((region) => region.id),
    layouts.map((layout) => layout.regionId),
    "Layout treatment",
  );
  return {
    ...reading,
    regions: reading.regions.map((region) => {
      const layout = layouts.find((item) => item.regionId === region.id);
      if (!layout) return region;
      return {
        ...region,
        action:
          region.role === "sound" && sfxRendering
            ? sfxRendering === "image"
              ? "image"
              : "text"
            : (layout.action ?? region.action),
        translatedText: layout.translatedText,
        renderBbox: layout.renderBbox,
      };
    }),
  };
}

export function serializeCodexLayoutText(layout: TypesettingLayout): string {
  if (!layout.runs?.length)
    return serializeRichTextRuns([
      { text: layout.translatedText, bold: false, italic: false },
    ]);
  if (layout.runs.map((run) => run.text).join("") !== layout.translatedText)
    throw new Error("부분 강조 문구가 번역문과 다릅니다.");
  return serializeRichTextRuns(layout.runs);
}
