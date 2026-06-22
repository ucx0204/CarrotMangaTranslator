import {
  reportRefreshLibraryFailure,
  useTranslationActionsImpl,
} from "./translationActionHooks";
import type {
  TranslationActions,
  UseTranslationActionsOptions,
} from "./translationActionTypes";

export { reportRefreshLibraryFailure };
export type {
  RunAnalysisMode,
  TranslationActions,
  TranslationFlowOptions,
  UseTranslationActionsOptions,
} from "./translationActionTypes";

export function useTranslationActions(
  options: UseTranslationActionsOptions,
): TranslationActions {
  return useTranslationActionsImpl(options);
}
