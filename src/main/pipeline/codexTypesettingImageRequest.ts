import { nativeImage } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { PNG } from "pngjs";
import { CODEX_TYPESETTING_MODEL } from "../../shared/codexTypesettingDefaults";
import type { CodexAppServerClient } from "../codexAppServerClient";

export async function generateImage(
  client: Pick<CodexAppServerClient, "runEphemeralTurn">,
  directory: string,
  signal: AbortSignal,
  prompt: string,
  images: string[],
  nativeSize: { width: number; height: number },
): Promise<Buffer> {
  signal.throwIfAborted();
  const targetSize = {
    width: Math.ceil(nativeSize.width * 1.2),
    height: Math.ceil(nativeSize.height * 1.2),
  };
  const sizedPrompt =
    prompt +
    `\nOutput budget: native destination ${nativeSize.width}x${nativeSize.height}px; desired output ${targetSize.width}x${targetSize.height}px (1.2x each edge). Request that size if the tool allows it; otherwise use its smallest supported size preserving this aspect ratio. Do not select high resolution or upscale beyond that minimum. Generate once only.`;
  const started = Date.now();
  const response = await client.runEphemeralTurn({
    model: CODEX_TYPESETTING_MODEL,
    effort: "low",
    cwd: directory,
    signal,
    instructions:
      "Generate exactly one requested image using the built-in imagegen tool.",
    input: [
      { type: "text", text: sizedPrompt },
      ...images.map((url) => ({
        type: "image" as const,
        url,
        detail: "original" as const,
      })),
    ],
  });
  const { text, ...accounting } = response;
  const callId = response.itemId?.replace(/[^\w-]/g, "_") ?? response.turnId;
  await writeFile(
    resolve(directory, `image-call-${callId}.json`),
    JSON.stringify(
      {
        prompt: sizedPrompt,
        nativeSize,
        targetSize,
        imageCount: images.length,
        elapsedMs: Date.now() - started,
        ...accounting,
      },
      null,
      2,
    ),
  );
  if (response.routedModel && response.routedModel !== CODEX_TYPESETTING_MODEL)
    throw new Error(
      `검증되지 않은 모델로 변경되었습니다: ${response.routedModel}`,
    );
  signal.throwIfAborted();
  const output = await readGeneratedImage(text, directory);
  // Preserve failed alpha/registration outputs as evidence before consumer validation.
  await writeFile(resolve(directory, `image-output-${callId}.png`), output);
  return output;
}

async function readGeneratedImage(
  text: string,
  directory: string,
): Promise<Buffer> {
  const result: { result?: string; savedPath?: string } = JSON.parse(text);
  if (result.result) {
    const data = result.result.replace(/^data:image\/[\w+.-]+;base64,/, "");
    if (data.length > 90_000_000 || !/^[\da-z+/=\s]+$/i.test(data))
      throw new Error("ImageGen 이미지 데이터가 올바르지 않습니다.");
    return Buffer.from(data, "base64");
  }
  if (!result.savedPath) throw new Error("ImageGen 이미지 자산이 없습니다.");
  const path = resolve(directory, result.savedPath);
  const local = relative(directory, path);
  if (!local || local.startsWith("..") || isAbsolute(local))
    throw new Error("ImageGen 자산 경로가 작업 폴더 밖입니다.");
  return readFile(path);
}

/** Conceal every authorized source stroke before generation so it cannot be retained as artwork. */
export function erasureImageInputs(source: string, mask: PNG): string[] {
  const canvas = PNG.sync.read(
    nativeImage
      .createFromBuffer(Buffer.from(source.split(",")[1], "base64"))
      .toPNG(),
  );
  if (canvas.width !== mask.width || canvas.height !== mask.height)
    throw new Error("제거 마스크와 원본 크기가 다릅니다.");
  for (let at = 0; at < mask.width * mask.height; at++) {
    if (!mask.data[at * 4]) continue;
    canvas.data.set([255, 0, 255, 255], at * 4);
  }
  const dataUrl = (image: PNG) =>
    `data:image/png;base64,${PNG.sync.write(image).toString("base64")}`;
  return [dataUrl(canvas), dataUrl(mask), source];
}
