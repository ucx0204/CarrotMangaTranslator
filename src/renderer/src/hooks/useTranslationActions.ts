import {
  reportRefreshLibraryFailure,
  useTranslationActionsImpl,
} from "./translationActionHooks";
import type {
  TranslationActions,
  UseTranslationActionsOptions,
} from "./translationActionTypes";
import {
  toastNotificationPort,
  type NotificationPort,
} from "../lib/notificationPort";

export { reportRefreshLibraryFailure };
export type {
  TranslationActions,
  TranslationFlowOptions,
  UseTranslationActionsOptions,
} from "./translationActionTypes";

export function useTranslationActions(
  options: UseTranslationActionsOptions,
  notificationPort: NotificationPort = toastNotificationPort,
): TranslationActions {
  return useTranslationActionsImpl(options, notificationPort);
}
