import type { CodexProgressUpdate } from "../../shared/codexTypesettingProgress";
import type {
  CodexPageReading,
  CodexSourceFontGroup,
  CodexSfxRendering,
  CodexTypesettingOptions,
} from "../../shared/codexTypesettingTypes";
import type { MangaPage } from "../../shared/libraryTypes";
import type { BBox, Point, TranslationBlock } from "../../shared/textTypes";
import type { WarpPresetName } from "../../shared/warpTransformMath";
import type { CodexPageView } from "../../shared/codexTypesettingViews";
import type { TextStyleRun } from "../../shared/richTextMarkup";
import type { PageExportLayoutEvidence } from "../../shared/pageExportContracts";

export type TypesettingImage = { label: string; dataUrl: string };
export type TypesettingPageImage = TypesettingImage & {
  view: CodexPageView;
  measurements?: Array<
    Omit<PageExportLayoutEvidence[number], "blockId"> & {
      regionId: string;
      /** Native transparent production raster bounds; null means no painted pixels. */
      paintedBounds?: BBox | null;
    }
  >;
};
export type TypesettingIssue = {
  regionId: string;
  reason: string;
  kind: "text" | "background" | "image";
};
export type TypesettingComposition = {
  page: MangaPage;
  issues: TypesettingIssue[];
  backgroundCandidates?: Array<{
    regionId: string;
    dataUrl: string;
    crop: BBox;
    sha256: string;
    blendMask?: string;
    reused?: boolean;
  }>;
};
export type TypesettingBackgroundReview = {
  issues: TypesettingIssue[];
  corrections: Array<{
    regionId: string;
    erasePolygons: Point[][];
    background: "white" | "black" | "artwork";
    reason: string;
  }>;
};
export type TypesettingRepair = {
  attempt: number;
  issues: TypesettingIssue[];
  reuseBackgroundIds?: string[];
};
export type TypesettingLetteringContext = TypesettingRepair & {
  plan: CodexChapterPlan;
  previousPage?: MangaPage;
};
export type TypesettingLayout = {
  action?: "text" | "image";
  bold?: boolean;
  italic?: boolean;
  runs?: Array<
    Pick<TextStyleRun, "text" | "bold" | "italic" | "sizePx" | "color">
  >;
  regionId: string;
  translatedText: string;
  renderBbox: TranslationBlock["bbox"];
  fontSizePx: number;
  lineHeight: number;
  rotationDeg: number;
  outlineWidthPx: number;
  textColor: string;
  outlineColor: string;
  textAlign: "left" | "center" | "right";
  direction: "horizontal" | "vertical";
  warpPreset?: "none" | WarpPresetName;
  curvePreset?: "none" | "archUp" | "archDown";
};

export type CodexTypesettingPorts = {
  preview?: (
    page: MangaPage,
    reading: CodexPageReading | undefined,
    stage: "reading" | "background" | "review",
  ) => void;
  confirmReading?: (reading: CodexPageReading) => Promise<CodexPageReading>;
  eraseOriginal?: boolean;
  regionOutput?: "text" | "image";
  targetLanguage: string;
  translationContext?: (page: MangaPage) => string;
  rememberReading?: (page: MangaPage, reading: CodexPageReading) => void;
  signal: AbortSignal;
  ask: (
    stage: string,
    prompt: string,
    images: TypesettingImage[],
    erasurePreview?: { page: MangaPage; reading: CodexPageReading },
  ) => Promise<unknown>;
  readPage: (page: MangaPage) => Promise<TypesettingPageImage[]>;
  cropRegions: (
    pages: MangaPage[],
    readings: Map<string, CodexPageReading>,
    includeContext?: boolean,
  ) => Promise<TypesettingImage[]>;
  fontSamples: (
    options: CodexTypesettingOptions,
    sample: string,
  ) => Promise<TypesettingImage[]>;
  cleanPage: (
    page: MangaPage,
    reading: CodexPageReading,
    repair?: TypesettingRepair,
  ) => Promise<TypesettingComposition>;
  inspectBackground: (
    composition: TypesettingComposition,
    reading: CodexPageReading,
    attempt: number,
  ) => Promise<TypesettingBackgroundReview>;
  restoreRegions: (
    page: MangaPage,
    reading: CodexPageReading,
    ids: string[],
  ) => Promise<MangaPage>;
  illustrate: (
    page: MangaPage,
    reading: CodexPageReading,
    context: TypesettingLetteringContext,
  ) => Promise<TypesettingComposition>;
  render: (page: MangaPage) => Promise<TypesettingPageImage[]>;
  saveEvidence: (name: string, value: unknown) => Promise<void>;
  commit: (
    page: MangaPage,
    reading?: CodexPageReading,
  ) => Promise<boolean | void>;
  progress: (update: CodexProgressUpdate) => void;
  blockId: (regionId: string) => string;
};

export type CodexChapterPlan = {
  sfxRendering?: CodexSfxRendering;
  groups: CodexSourceFontGroup[];
  fonts: Array<{ groupId: string; fontId: string }>;
};
