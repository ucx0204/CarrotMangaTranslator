/** GPT Image 2 canvas constraints; native destination pixels stay unchanged. */
export function resolveCodexImageSize(native: {
  width: number;
  height: number;
}) {
  const ratio = native.width / native.height;
  if (
    !Number.isFinite(ratio) ||
    Math.min(native.width, native.height) <= 0 ||
    ratio > 3 ||
    ratio < 1 / 3
  )
    throw new Error("이미지 생성 영역을 3:1 이내로 나눠 주세요.");
  const pixels = Math.min(
    8_294_400,
    Math.max(655_360, native.width * native.height * 1.21),
  );
  let best: { width: number; height: number; cost: number } | undefined;
  for (let height = 16; height <= 3840; height += 16) {
    for (const width of [
      Math.floor((height * ratio) / 16) * 16,
      Math.ceil((height * ratio) / 16) * 16,
    ]) {
      const area = width * height;
      if (!supportedSize(width, height)) continue;
      const cost =
        Math.abs(Math.log(width / height / ratio)) * 5 +
        Math.abs(Math.log(area / pixels));
      if (!best || cost < best.cost) best = { width, height, cost };
    }
  }
  if (!best) throw new Error("지원하는 이미지 생성 크기를 정하지 못했습니다.");
  return { width: best.width, height: best.height };
}

function supportedSize(width: number, height: number): boolean {
  return (
    width >= 16 &&
    width <= 3840 &&
    width * height >= 655_360 &&
    width * height <= 8_294_400 &&
    Math.max(width, height) <= Math.min(width, height) * 3
  );
}
