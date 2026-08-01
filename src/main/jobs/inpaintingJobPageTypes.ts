import type { InpaintingMaskStroke } from "../../shared/inpaintingTypes";
import type { TranslationCompletionWorkflow } from "../../shared/libraryTypes";
import type {
  BubbleLayoutPostprocessConfig,
  BubbleLayoutRunner,
} from "../inpainting/bubbleLayoutRunner";
import type { InpaintingBlockLayoutState } from "../inpainting/inpaintingLayoutState";
import type { InpaintingJobRuntime } from "./inpaintingJobRuntime";

type InpaintingPageResult = Awaited<
  ReturnType<InpaintingJobRuntime["inpaintPatternPage"]>
>;
type OpenedChapter = Awaited<ReturnType<InpaintingJobRuntime["openChapter"]>>;
type InpaintingEngineLease = Awaited<
  ReturnType<InpaintingJobRuntime["acquireEngine"]>
>;

export type InpaintingJobState = {
  chapter: OpenedChapter | null;
  chapters: Map<string, OpenedChapter>;
  historyTransactionId: string | null;
  inpaintingEngineLease: InpaintingEngineLease | null;
  bubbleLayoutRunner: BubbleLayoutRunner | null;
  bubbleLayoutPostprocess: BubbleLayoutPostprocessConfig | null;
  pagesChanged: number;
  pagesIncomplete: number;
  blocksErased: number;
  blocksIncomplete: number;
  targetPageIds: Map<string, Set<string>>;
  requestedCompletionWorkflow?: TranslationCompletionWorkflow;
};

export type InpaintingTarget = {
  blockId?: string;
  drawnPatternMode: boolean;
  layoutOnly: boolean;
  drawnStrokes: InpaintingMaskStroke[];
  drawnFeatherPx?: number;
  targetType: "drawn" | "source";
};

export type ProcessedInpaintingPageResult = InpaintingPageResult & {
  beforeLayout?: InpaintingBlockLayoutState[];
  afterLayout?: InpaintingBlockLayoutState[];
  bubbleLayoutPostprocessed?: boolean;
  workflowReceiptChanged?: boolean;
};
