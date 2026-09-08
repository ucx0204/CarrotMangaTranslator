import { nativeImage } from "electron";
import { PNG } from "pngjs";
import type { BBox } from "../../shared/textTypes";
import type { TypesettingImage } from "../application/codexTypesettingContracts";

/** Foreground-only canvas planning. Transparent room extends the layer, never stretches the word. */
export function prepareCodexLetteringCanvas(
  reference: TypesettingImage,
  size: { w: number; h: number },
  renderBbox: BBox,
  page: { width: number; height: number },
  matte: string,
) {
  if (Math.max(size.w, size.h) <= Math.min(size.w, size.h) * 3)
    return { reference, size, renderBbox };
  const width = Math.max(size.w, Math.ceil(size.h / 3));
  const height = Math.max(size.h, Math.ceil(size.w / 3));
  const left = Math.floor((width - size.w) / 2),
    top = Math.floor((height - size.h) / 2);
  const canvas = new PNG({ width, height });
  const rgb = [1, 3, 5].map((index) =>
    Number.parseInt(matte.slice(index, index + 2), 16),
  );
  for (let at = 0; at < width * height; at++)
    canvas.data.set([...rgb, 255], at * 4);
  const source = nativeImage.createFromBuffer(
    Buffer.from(reference.dataUrl.split(",")[1], "base64"),
  );
  if (source.isEmpty())
    throw new Error("효과음 원문 참고 이미지를 읽지 못했습니다.");
  const crop = PNG.sync.read(
    source.resize({ width: size.w, height: size.h, quality: "best" }).toPNG(),
  );
  PNG.bitblt(crop, canvas, 0, 0, size.w, size.h, left, top);
  return {
    reference: {
      label: `${reference.label}; Foreground-only canvas planned before generation: ${width}x${height}; original lettering area x=${left}, y=${top}, width=${size.w}, height=${size.h}. Added flat matte is empty alpha space, not source artwork. Preserve the original lettering positions within this canvas.`,
      dataUrl: `data:image/png;base64,${PNG.sync.write(canvas).toString("base64")}`,
    },
    size: { w: width, h: height },
    renderBbox: {
      x: renderBbox.x - (left * 1000) / page.width,
      y: renderBbox.y - (top * 1000) / page.height,
      w: (width * 1000) / page.width,
      h: (height * 1000) / page.height,
    },
  };
}
