import type {
  Dispatch,
  MutableRefObject,
  RefObject,
  SetStateAction,
} from "react";
import type {
  InpaintingMaskStroke,
  InpaintingRetouchGeometry,
} from "../../../shared/inpaintingTypes";
import type { MangaPage } from "../../../shared/libraryTypes";
import type { InpaintingTool } from "../inpainting/inpaintingTypes";
import type { ImagePoint } from "./workspaceInpaintingPointerState";

export type UseWorkspaceInpaintingPointerHandlersOptions = {
  appendRetouchPoint: (point: ImagePoint) => ImagePoint | null;
  applyRetouchOperation: (operation: {
    geometry: InpaintingRetouchGeometry;
    mode: "paint" | "restore";
  }) => Promise<void>;
  imageRef: RefObject<HTMLImageElement | null>;
  inpaintingBrushRadius: number;
  inpaintingPaintColor: string;
  inpaintingRetouchDrawingRef: MutableRefObject<boolean>;
  inpaintingRetouchPointsRef: MutableRefObject<ImagePoint[]>;
  inpaintingTool: InpaintingTool;
  inpaintingToolActive: boolean;
  jobActive: boolean;
  lastInpaintingRetouchPointRef: MutableRefObject<ImagePoint | null>;
  onPatternMaskChange: (
    pageId: string,
    before: InpaintingMaskStroke[],
    after: InpaintingMaskStroke[],
  ) => void;
  patternMaskStrokesByPage: Record<string, InpaintingMaskStroke[]>;
  pushStatus: (line: string) => void;
  selectedPage: MangaPage | null;
  selectedPageIdRef: MutableRefObject<string | null>;
  selectedPageImagePath: string | null;
  setInpaintingPaintColor: Dispatch<SetStateAction<string>>;
  setInpaintingBrushRadius?: Dispatch<SetStateAction<number>>;
  setPatternMaskStrokesByPage: Dispatch<
    SetStateAction<Record<string, InpaintingMaskStroke[]>>
  >;
  setSelectedBlockId: Dispatch<SetStateAction<string | null>>;
  stageRef: RefObject<HTMLDivElement | null>;
};

export type BrushRadiusDrag = {
  pointerId: number;
  startClientX: number;
  startRadius: number;
};
