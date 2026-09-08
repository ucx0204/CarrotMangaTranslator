import type {
  ConfirmRegionTranslationRequest,
  RegionTextReview,
} from "../../shared/regionTextReview";
import { confirmRegionTranslationSchema } from "../../shared/regionTextReview";
import type { CodexPageReading } from "../../shared/codexTypesettingTypes";

type Pending = {
  sessionId: string;
  reading: CodexPageReading;
  resolve: (reading: CodexPageReading) => void;
};
const pending = new Map<string, Pending>();

export async function waitForRegionTextReview(options: {
  jobId: string;
  sessionId: string;
  reading: CodexPageReading;
  signal: AbortSignal;
  show: (review: RegionTextReview) => void;
}): Promise<CodexPageReading> {
  const { jobId, sessionId, reading, signal } = options;
  signal.throwIfAborted();
  const regions = reading.regions.filter((region) => region.action !== "keep");
  if (!regions.length)
    throw new Error("선택 영역에서 번역할 글자를 찾지 못했습니다.");
  if (pending.has(jobId)) throw new Error("이미 번역문을 확인하고 있습니다.");
  let cancel = () => {};
  try {
    return await new Promise<CodexPageReading>((resolve, reject) => {
      cancel = () =>
        reject(signal.reason ?? new Error("영역 번역이 취소되었습니다."));
      pending.set(jobId, { sessionId, reading, resolve });
      signal.addEventListener("abort", cancel, { once: true });
      options.show({
        sessionId,
        regions: regions.map(
          ({ id, sourceText, translatedText, sourceBbox, styleGroupId }) => ({
            id,
            sourceText,
            translatedText,
            sourceBbox,
            styleGroupId,
          }),
        ),
      });
    });
  } finally {
    pending.delete(jobId);
    signal.removeEventListener("abort", cancel);
  }
}

export function confirmRegionTranslation(
  input: ConfirmRegionTranslationRequest,
): boolean {
  const request = confirmRegionTranslationSchema.parse(input);
  const review = pending.get(request.jobId);
  if (!review || review.sessionId !== request.sessionId)
    throw new Error("번역문 확인이 만료되었습니다. 영역을 다시 선택해 주세요.");
  const expected = review.reading.regions.filter(
    (region) => region.action !== "keep",
  );
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
  review.resolve({
    ...review.reading,
    editProtection: request.protection,
    regions: [
      ...review.reading.regions.map(
        (region) => updated.find((value) => value.id === region.id) ?? region,
      ),
      ...updated.filter(
        (value) =>
          !review.reading.regions.some((region) => region.id === value.id),
      ),
    ],
  });
  pending.delete(request.jobId);
  return true;
}
