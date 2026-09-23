import type { ReactNode } from "react";
import type { AppSettings, UiSettings } from "../../../shared/settingsTypes";
import type {
  ChapterSnapshot,
  LibraryIndex,
} from "../../../shared/libraryTypes";
import type { TranslationFlowOptions } from "../hooks/translationActionTypes";
import type { TranslationOptionsInitialScope } from "../lib/translationSelection";
export type TranslationOptionsModalProps = {
  onStartPageWorkflow?: (
    request: import("../../../shared/pageWorkflowTypes").PageWorkflowRequest,
  ) => Promise<void>;
  settings?: AppSettings | null;
  chapter: ChapterSnapshot;
  currentPageId?: string | null;
  initialScope?: TranslationOptionsInitialScope;
  library: LibraryIndex;
  uiSettings: UiSettings | undefined;
  sourceLanguage?: string;
  targetLanguage?: string;
  onStart: (options: TranslationFlowOptions) => void;
  onPersistDefaults: (patch: Partial<UiSettings>) => void;
  onClose: () => void;
};

export type TranslationModalPresentation = {
  headerExtra?: ReactNode;
  resizeFromWidth?: string;
};
