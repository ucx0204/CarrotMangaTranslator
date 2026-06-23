import {
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type { JobState } from "../../../../shared/jobTypes";
import type {
  ChapterSnapshot,
  LibraryIndex,
} from "../../../../shared/libraryTypes";
import type { RegionSelectionState } from "../../lib/appHelpers";

const EMPTY_JOB: JobState = {
  id: "idle",
  kind: "gemma-analysis",
  status: "idle",
  progressText: "대기 중",
};

export type AppSessionCoreState = {
  currentChapter: ChapterSnapshot | null;
  currentChapterRef: RefObject<ChapterSnapshot | null>;
  imageRef: RefObject<HTMLImageElement | null>;
  jobState: JobState;
  library: LibraryIndex;
  regionSelection: RegionSelectionState | null;
  selectedBlockId: string | null;
  selectedBlockIdRef: RefObject<string | null>;
  /** Multi-selection (Ctrl/⌘+click) within the current page, for batch format apply. */
  selectedBlockIds: string[];
  selectedPageId: string | null;
  selectedPageIdRef: RefObject<string | null>;
  setCurrentChapter: Dispatch<SetStateAction<ChapterSnapshot | null>>;
  setJobState: Dispatch<SetStateAction<JobState>>;
  setLibrary: Dispatch<SetStateAction<LibraryIndex>>;
  setRegionSelection: Dispatch<SetStateAction<RegionSelectionState | null>>;
  setSelectedBlockId: Dispatch<SetStateAction<string | null>>;
  setSelectedBlockIds: Dispatch<SetStateAction<string[]>>;
  setSelectedPageId: Dispatch<SetStateAction<string | null>>;
  stageRef: RefObject<HTMLDivElement | null>;
  workspacePanelRef: RefObject<HTMLElement | null>;
};

export function useAppSessionCoreState(): AppSessionCoreState {
  const [library, setLibrary] = useState<LibraryIndex>({
    workOrder: [],
    works: [],
  });
  const [currentChapter, setCurrentChapter] = useState<ChapterSnapshot | null>(
    null,
  );
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [selectedBlockIds, setSelectedBlockIds] = useState<string[]>([]);
  const [regionSelection, setRegionSelection] =
    useState<RegionSelectionState | null>(null);
  const [jobState, setJobState] = useState<JobState>(EMPTY_JOB);
  const workspacePanelRef = useRef<HTMLElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const currentChapterRef = useRef<ChapterSnapshot | null>(null);
  const selectedPageIdRef = useRef<string | null>(null);
  const selectedBlockIdRef = useRef<string | null>(null);

  return {
    currentChapter,
    currentChapterRef,
    imageRef,
    jobState,
    library,
    regionSelection,
    selectedBlockId,
    selectedBlockIdRef,
    selectedBlockIds,
    selectedPageId,
    selectedPageIdRef,
    setCurrentChapter,
    setJobState,
    setLibrary,
    setRegionSelection,
    setSelectedBlockId,
    setSelectedBlockIds,
    setSelectedPageId,
    stageRef,
    workspacePanelRef,
  };
}
