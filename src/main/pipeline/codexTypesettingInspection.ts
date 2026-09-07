import { PNG } from "pngjs";
import type { TypesettingImage } from "../application/codexTypesettingContracts";
import { assertPageExportPngBuffer } from "../pageExportRasterSafety";
import {
  estimateBase64DecodedByteLength,
  MAX_PAGE_EXPORT_PNG_BYTES,
  MAX_PAGE_EXPORT_IMAGE_SOURCE_CHARS,
} from "../../shared/pageExportLimits";

/** Opaque inspection copies only; original editable RGBA assets are untouched. */
export function prepareTypesettingInspection(
  stage: string,
  prompt: string,
  images: TypesettingImage[],
): { prompt: string; images: TypesettingImage[] } {
  if (!stage.startsWith("readback-") || !images.length)
    return { prompt, images };
  return {
    prompt:
      prompt +
      " Each distinct region ID is shown twice: the SAME lettering pixels composited on opaque white and opaque black. These are complementary views, not repeated words. Transcribe the lettering ONCE per distinct ID, using the view where its ink is visible. Do not duplicate words because there are two views.",
    images: images.flatMap(inspectionMattes),
  };
}

function inspectionMattes(image: TypesettingImage): TypesettingImage[] {
  const prefix = "data:image/png;base64,";
  if (
    !image.dataUrl.startsWith(prefix) ||
    image.dataUrl.length > MAX_PAGE_EXPORT_IMAGE_SOURCE_CHARS
  )
    throw new Error("효과음 검수 이미지가 유효한 PNG가 아닙니다.");
  const encoded = image.dataUrl.slice(prefix.length);
  const estimated = estimateBase64DecodedByteLength(encoded);
  if (estimated > MAX_PAGE_EXPORT_PNG_BYTES)
    throw new Error("효과음 검수 이미지가 너무 큽니다.");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.byteLength !== estimated)
    throw new Error("효과음 검수 이미지 크기가 일치하지 않습니다.");
  assertPageExportPngBuffer(bytes, undefined, "효과음 검수");
  const source = PNG.sync.read(bytes);
  return [255, 0].map((matte) => ({
    label: image.label,
    dataUrl: `data:image/png;base64,${PNG.sync
      .write(compositeInspectionMatte(source, matte))
      .toString("base64")}`,
  }));
}

function compositeInspectionMatte(source: PNG, matte: number): PNG {
  const output = new PNG({ width: source.width, height: source.height });
  for (let at = 0; at < source.data.length; at += 4) {
    const alpha = source.data[at + 3] / 255;
    for (let channel = 0; channel < 3; channel++)
      output.data[at + channel] = Math.round(
        source.data[at + channel] * alpha + matte * (1 - alpha),
      );
    output.data[at + 3] = 255;
  }
  return output;
}
