import type { ConfirmRegionTranslationRequest } from "../../shared/regionTextReview";
import type { CodexPageReading } from "../../shared/codexTypesettingTypes";

/** Validate the whole edit before resolving either a region or batch review. */
export function applyRegionTextReview(
  reading: CodexPageReading,
  request: Pick<ConfirmRegionTranslationRequest, "translations" | "protection">,
): CodexPageReading {
  const expected = reading.regions.filter((region) => region.action !== "keep");
  const values = new Map(
    request.translations.map((value) => [value.regionId, value]),
  );
  if (
    values.size !== request.translations.length ||
    expected.some((region) => !values.has(region.id)) ||
    request.protection?.regions?.some(
      (region) =>
        !values.has(region.regionId) || values.get(region.regionId)?.excluded,
    )
  )
    throw new Error("확인한 글자 목록이 인식 결과와 다릅니다.");
  const updated = request.translations.map((value) => {
    const region = expected.find(
      (item) => item.id === (value.parentRegionId ?? value.regionId),
    );
    if (!region) throw new Error("확인한 글자 목록이 인식 결과와 다릅니다.");
    return {
      ...region,
      id: value.regionId,
      parentRegionId: region.parentRegionId ?? region.id,
      sourceText: value.sourceText ?? region.sourceText,
      styleGroupId: value.styleGroupId ?? region.styleGroupId,
      translatedText: value.text,
      translationLocked: true,
      action: value.excluded ? ("keep" as const) : region.action,
      ...(value.sourceBbox &&
      (["x", "y", "w", "h"] as const).some(
        (key) => value.sourceBbox?.[key] !== region.sourceBbox[key],
      )
        ? {
            sourceBbox: value.sourceBbox,
            renderBbox: value.sourceBbox,
            erasePolygons: undefined,
          }
        : {}),
    };
  });
  if (!updated.some((region) => region.action !== "keep"))
    throw new Error("생성할 영역을 하나 이상 남겨 주세요.");
  return {
    ...reading,
    editProtection: request.protection,
    regions: [
      ...reading.regions.map(
        (region) => updated.find((value) => value.id === region.id) ?? region,
      ),
      ...updated.filter(
        (value) => !reading.regions.some((region) => region.id === value.id),
      ),
    ],
  };
}
