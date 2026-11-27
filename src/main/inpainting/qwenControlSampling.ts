import {
  isBrushHint,
  namedCoverPrint,
  referenceInstructions,
} from "./qwenPrintedReference";
import { writeFile } from "node:fs/promises";
import type { ensureQwenControlRuntime } from "./qwenControlRuntime";
import type { ensureQwenControlModels } from "./qwenImageAssets";
import {
  hasTwoToneDisplayType,
  isLargeIllustratedPrint,
} from "./qwenTextArtwork";
import type {
  FluxWorkerRequest,
  IllustratedTitleHint,
} from "./fluxWorkerTypes";
import type { NativeImage } from "electron";
import type { PixelRect } from "./maskGeometry";
import {
  writeQwenReferenceFiles,
  type QwenReferenceCrop,
  type InterruptedDialogue,
} from "./qwenControlReferences";

const referenceEditSizes = [960, 832, 736, 640];
const editionSizes = [832, 736, 640, 576];
const controlledSizes = [896, 768, 672, 576];
const standardSizes = [1010, 864, 736, 640];

const measuredPrintNegatives: ReadonlyMap<string, string> = new Map([
  [
    "paperEdgeCaption",
    "letters, furigana, spots, gray vertical smudges on white paper, double hair outline, missing thin pen, broken thin strands, warped panel rules",
  ],
  [
    "facetedFrame",
    "letters, missing section of frame, new border, rounded balloon, gray haze, wavy line, gray letter shapes, missing motion lines",
  ],
  [
    "roughStone",
    "residual letters, white letter shapes in texture, holes in the rock drawing, gray smudges, curved cracks, repeated square texture",
  ],
  [
    "drawnCloth",
    "remaining text, dark scribbles from letters, cloudy smears, flat white patches in the costume, double outlines, new objects, broken balloon border",
  ],
  [
    "screenedMolding",
    "lingering letters or dots, gray spots in white space, new objects, detached lines, broken pillar edges, smudged or missing dot screen",
  ],
  [
    "actionFan",
    "remaining text, white lettering halo, shadows of letters, blurry smudges, zigzag lines, added details",
  ],
  [
    "solid-impact",
    "text, glyphs, dark smears, double panel lines, severed contours, damaged screentone",
  ],
]);

export function measuredPrintNegative(edit: string) {
  return measuredPrintNegatives.get(edit);
}

function markedReferenceSampling(edit?: string) {
  const negative = measuredPrintNegative(edit ?? "");
  if (negative)
    return {
      pairedReference: true,
      referencePrior: false,
      // The stone compositor restores print from the surrounding scan. The
      // sampled image only guides the contours between those source patches.
      steps: edit === "roughStone" ? 16 : 28,
      seed: 20,
      cfg: 2.5,
      negative,
    };
  return {
    pairedReference: true,
    cfg: 3.1,
    seed: 42,
    negative:
      "letters, Japanese writing, sound effect, watermark, white ghost strokes, residual type, duplicated arms, extra fingers",
  };
}

function usesMarkedReference(edit?: string) {
  return (
    isBrushHint(edit) ||
    edit === "pigment" ||
    measuredPrintNegatives.has(edit ?? "")
  );
}
export function qwenSamplingSizes(crop?: {
  referenceEdit?: string;
  pairedWindow?: PixelRect;
  compactSound?: true;
}) {
  if (!crop) return standardSizes;
  if (crop.compactSound) return [768, 704, 640, 512];
  if (crop.referenceEdit === "actionFan") return [832, 768, 640, 512];
  if (measuredPrintNegatives.has(crop.referenceEdit ?? ""))
    return [896, 768, 640, 512];
  if (crop.referenceEdit === "uprightJacket") return [708, 640, 576, 512];
  if (crop.pairedWindow)
    return ["guide" in crop.pairedWindow ? 648 : 640, 576, 512, 448];
  if (usesMarkedReference(crop.referenceEdit)) return standardSizes;
  if (!crop.referenceEdit) return controlledSizes;
  return namedCoverPrint.has(crop.referenceEdit)
    ? editionSizes
    : referenceEditSizes;
}

export function illustrationHint(
  request: FluxWorkerRequest,
  inputs: Parameters<typeof isLargeIllustratedPrint>[0],
) {
  if (request.illustratedTitle === "caption" && hasTwoToneDisplayType(inputs))
    return false;
  if (request.illustratedTitle) return request.illustratedTitle;
  return !request.speechBubble && isLargeIllustratedPrint(inputs)
    ? "lettering"
    : false;
}

function isSimplePrint(
  hint: string,
): hint is "masthead" | "lettering" | "caption" {
  return hint === "masthead" || hint === "lettering" || hint === "caption";
}

export function referenceEditMode(
  hint: Exclude<IllustratedTitleHint, false> | InterruptedDialogue,
) {
  if (typeof hint === "object")
    return { referenceEdit: hint.kind, material: hint };
  const illustration = { kind: "illustration" } as const;
  if (hint === "upright-jacket")
    return { referenceEdit: "uprightJacket" as const, material: illustration };
  if (hint === true)
    return { referenceEdit: "cover" as const, material: illustration };
  if (hint.startsWith("pigment:"))
    return {
      referenceEdit: "pigment" as const,
      material: { kind: "pigment" } as const,
    };
  if (isBrushHint(hint))
    return { referenceEdit: hint, material: { kind: hint } as const };
  if (isSimplePrint(hint))
    return { referenceEdit: hint, material: { kind: hint } };
  const jacket = jacketReference(hint);
  if (jacket) return jacket;
  if (hint.startsWith("edition:"))
    return {
      referenceEdit: "edition" as const,
      material: illustration,
      editionReading: hint.slice("edition:".length),
    };
  if (hint.startsWith("masthead:"))
    return {
      referenceEdit: "mastheadLines" as const,
      material: { kind: "glowing-print" } as const,
      coverReading: hint.slice("masthead:".length),
    };
  if (hint.startsWith("cover-columns:"))
    return {
      referenceEdit: "coverColumns" as const,
      material: { kind: "glowing-print" } as const,
      coverReading: hint.slice("cover-columns:".length),
    };
  if (hint.startsWith("cover-title:"))
    return {
      referenceEdit: "coverTitle" as const,
      material: illustration,
      coverReading: hint.slice("cover-title:".length),
    };
  return {
    referenceEdit: "effect" as const,
    material: { kind: "sound" } as const,
    soundReading: hint.slice("sound:".length),
  };
}

function jacketReference(hint: string) {
  if (hint.startsWith("washed-title:"))
    return {
      referenceEdit: "washedTitle" as const,
      material: { kind: "illustration" } as const,
      coverReading: hint.slice("washed-title:".length),
    };
  if (hint.startsWith("layered-title:"))
    return {
      referenceEdit: "layeredTitle" as const,
      material: { kind: "glowing-print" } as const,
    };
  if (hint.startsWith("jacket:"))
    return {
      referenceEdit: "jacket" as const,
      material: { kind: "jacket" } as const,
    };
  if (hint.startsWith("jacket-promo:"))
    return {
      referenceEdit: "promo" as const,
      material: { kind: "glowing-print" } as const,
      coverReading: hint.slice("jacket-promo:".length),
    };
  if (hint.startsWith("jacket-strap:"))
    return {
      referenceEdit: "strap" as const,
      material: { kind: "colour-strap" } as const,
      coverReading: hint.slice("jacket-strap:".length),
    };
}

export function qwenControlSampling(crop: {
  referenceEdit?: keyof typeof referenceInstructions;
  soundReading?: string;
  editionReading?: string;
  printDescription?: string;
  compactSound?: true;
  coverReading?: string;
  sourceReference: boolean;
  registered: boolean;
  titleSource?: NativeImage;
}) {
  if (crop.compactSound)
    return {
      steps: 32,
      cfg: 3,
      denoise: 0.58,
      referencePrior: true,
      seed: 20,
      negative:
        "letters, broken outlines, cropped clothing, duplicated strokes, missing speech balloons, smudges",
      prompt:
        "Restore the original grayscale comic within the masked Japanese sound lettering. Continue each visible pen line and fold from its corresponding ends. Keep the exact balloon outlines, faces, hands, clothes, line widths and shading in the reference drawing. The covered area contains only uninterrupted original art.",
    };
  if (crop.referenceEdit)
    return {
      referenceEdit: true,
      referenceSource: true,
      steps: 40,
      cfg: namedCoverPrint.has(crop.referenceEdit) ? 3.5 : 1,
      denoise: 1,
      prompt: directPrintInstruction(crop, crop.referenceEdit),
    };
  if (crop.sourceReference)
    return {
      referenceSource: true,
      steps: 32,
      cfg: 1,
      denoise: 0.71,
      prompt:
        "Remove the overprinted manga title, keylines and shadows in <image1>. Restore the illustration under the lettering. Follow the visible ends and direction of drawn contours, shading and screentones. Preserve the composition and the style of the original scan.",
    };
  return {
    steps: 36,
    cfg: 4,
    denoise: crop.titleSource ? 0.45 : crop.registered ? 0.49 : 0.54,
    prompt:
      "Faithful restoration of the original comic illustration. Continue the visible contours, colours, hatching and screentone across the masked lettering. Keep the surrounding objects, lines, and empty space." +
      (crop.registered
        ? " Preserve the measured round contour, the smooth dark background and each isolated highlight in its original position."
        : "") +
      (crop.titleSource
        ? " Match the visible ends of the drawn objects on both sides of the erased title. Continue each inked edge and shaded surface through the opening."
        : ""),
  };
}

function directPrintInstruction(
  crop: Parameters<typeof qwenControlSampling>[0],
  mode: keyof typeof referenceInstructions,
) {
  return (
    crop.printDescription ??
    (crop.editionReading
      ? `把封面上印刷的「${crop.editionReading}」整组擦干净。${referenceInstructions.edition}`
      : crop.coverReading
        ? `擦除印在封面上的「${crop.coverReading}」。${referenceInstructions[mode]}`
        : crop.soundReading
          ? `只去掉画面中心的手写日文拟声词「${crop.soundReading}」及其描边。按周围原画恢复被文字遮住的头发、服装和漫画线条。保持其余线条、人物、姿势和所有物品完全一致。`
          : referenceInstructions[mode])
  );
}

type Size = { width: number; height: number };
export type QwenMeasuredPrint =
  | ReturnType<typeof referenceEditMode>["material"]
  | { kind: "crossed-rule"; row: number; radius: number }
  | { kind: "title" }
  | { kind: "washed-title"; prior: NativeImage }
  | { kind: "sky"; prior: NativeImage };

export type QwenSamplingCrop = Parameters<typeof qwenControlSampling>[0] &
  QwenReferenceCrop & { material?: QwenMeasuredPrint };

export function registrationOption(
  material: QwenMeasuredPrint,
  evidence?: string,
) {
  if (evidence)
    return material.kind === "washed-title"
      ? "--washed-title=" + evidence
      : evidence;
  if (material.kind === "crossed-rule")
    return `--crossed-rule=${material.row},${material.radius}`;
  return material.kind === "title" ? "finish" : "--" + material.kind;
}

function supportsTurboCrop(crop: QwenSamplingCrop) {
  if (crop.referenceEdit)
    return [
      "solid-impact",
      "facetedFrame",
      "effect",
      "brush",
      "actionFan",
      "lettering",
      "drawnCloth",
      "paperEdgeCaption",
      "screenedMolding",
    ].includes(crop.referenceEdit);
  return (
    crop.compactSound ||
    (!crop.sourceReference &&
      !crop.titleSource &&
      !crop.registered &&
      !crop.material)
  );
}

export async function writeQwenControlArguments(
  launch: QwenControlLaunch,
  crop: QwenSamplingCrop,
  target: Size,
  image: string,
  output: string,
  signal?: AbortSignal,
) {
  const { reference, maskPath, priorPath } = await writeQwenReferenceFiles(
    launch,
    crop,
    target,
    image,
    signal,
  );
  const markedEdit = usesMarkedReference(crop.referenceEdit);
  const turbo = supportsTurboCrop(crop)
    ? await launch.getTurbo?.(signal)
    : undefined;
  const { prefix } = crop;
  const config = prefix + ".control.json";
  await writeFile(
    config,
    JSON.stringify({
      comfy: launch.comfy,
      nodeDirectory: launch.nodeDirectory,
      packageDirectory: launch.packageDirectory,
      ...launch.models,
      ...(turbo
        ? {
            turbo,
            shortSchedule:
              !!crop.referenceEdit &&
              ["brush", "effect", "facetedFrame", "lettering"].includes(
                crop.referenceEdit,
              ),
          }
        : {}),
      image: reference,
      mask: maskPath,
      prior: markedEdit ? maskPath : priorPath,
      referencePrior: crop.registered || !!crop.titleSource,
      output,
      negative: crop.referenceEdit
        ? ""
        : "letters, text, lettering outlines, ghost marks, added objects, broken contours, smudged screentone",
      seed: 417,
      ...qwenControlSampling(crop),
      ...(crop.pairedWindow || crop.referenceEdit === "layeredTitle"
        ? crop.referenceEdit === "uprightJacket"
          ? { pairedReference: false, steps: 27, seed: 20 }
          : { pairedReference: true, steps: 25, seed: 20 }
        : {}),
      ...(markedEdit ? markedReferenceSampling(crop.referenceEdit) : {}),
    }),
  );
  return ["-s", "-B", "-X", "utf8", "-u", launch.script, config];
}

type ModelPaths = Awaited<ReturnType<typeof ensureQwenControlModels>>;
export type QwenControlLaunch = Awaited<
  ReturnType<typeof ensureQwenControlRuntime>
> & {
  script: string;
  getTurbo?: (signal?: AbortSignal) => Promise<string | undefined>;
  models: ModelPaths;
};
