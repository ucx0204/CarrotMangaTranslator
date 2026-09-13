import type { ImageRedactionStroke } from "./imageRedaction";
import { isSupportedRedactionSize } from "./imageRedactionLimits";

type Size = { width: number; height: number };
export type RedactionCopyProblem = "size" | "aspect" | "brush" | "dimensions";

/** Stroke brushes support uniform scaling only. Never silently distort or clamp a mask. */
export function redactionCopyProblem(
  strokes: readonly ImageRedactionStroke[],
  source: Size,
  target: Size,
  scaling: "exact" | "proportional",
): RedactionCopyProblem | null {
  if (!isSupportedRedactionSize(source) || !isSupportedRedactionSize(target))
    return "dimensions";
  if (
    scaling === "exact" &&
    (source.width !== target.width || source.height !== target.height)
  )
    return "size";
  if (source.width * target.height !== target.width * source.height)
    return "aspect";
  const factor = target.width / source.width;
  if (
    strokes.some((stroke) => {
      if (stroke.shape === "rectangle") return false;
      const size = stroke.size * factor;
      return !Number.isFinite(size) || size < 1 || size > 4000;
    })
  )
    return "brush";
  return null;
}

export function assertRedactionCopyCompatible(
  strokes: readonly ImageRedactionStroke[],
  source: Size,
  target: Size,
  scaling: "exact" | "proportional",
): void {
  const problem = redactionCopyProblem(strokes, source, target, scaling);
  if (!problem) return;
  const messages = {
    size: "이미지 크기가 다릅니다. 비율 맞추기를 선택해 주세요.",
    aspect: "종횡비가 달라 가림을 복사할 수 없습니다.",
    brush: "확대·축소한 브러시가 지원 크기를 벗어납니다.",
    dimensions: "가리기 이미지 크기가 지원 범위를 벗어났습니다.",
  };
  throw new Error(messages[problem]);
}
