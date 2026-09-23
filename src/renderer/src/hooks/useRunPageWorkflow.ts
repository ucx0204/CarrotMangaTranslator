import { useCallback, useRef } from "react";
import type { PageWorkflowRequest } from "../../../shared/pageWorkflowTypes";
import { pageWorkflowGateway } from "../api/pageWorkflowGateway";
import type { UseTranslationActionsOptions } from "./translationActionTypes";
import type { NotificationPort } from "../lib/notificationPort";
import { formatErrorMessage } from "../lib/errorPresentation";

export function useRunPageWorkflow(
  options: UseTranslationActionsOptions,
  notifications: NotificationPort,
) {
  const busy = useRef(false);
  return useCallback(
    async (request: PageWorkflowRequest) => {
      if (busy.current || options.jobActive) return;
      busy.current = true;
      options.setFlowActive(true);
      try {
        await options.beforeTranslate?.();
        await options.saveNow();
        const before = options.currentChapterRef.current;
        const result = await pageWorkflowGateway.startPageWorkflow(request);
        options.clearPageImageCache();
        adoptWorkflowResult(options, request, result, before);
        await options.refreshLibrary();
        options.setShowBlockChrome(true);
        if (result.issues.length)
          notifications.warn(
            result.issues.map((issue) => issue.message).join("\n"),
          );
        options.pushStatus(
          result.status === "completed"
            ? "페이지 작업 완료"
            : "페이지 작업이 중단되었습니다. 같은 실행을 이어갈 수 있습니다.",
        );
      } catch (error) {
        notifications.error(
          formatErrorMessage(error, "페이지 작업에 실패했습니다."),
        );
      } finally {
        busy.current = false;
        options.setFlowActive(false);
      }
    },
    [options, notifications],
  );
}

function adoptWorkflowResult(
  options: UseTranslationActionsOptions,
  request: PageWorkflowRequest,
  result: Awaited<ReturnType<typeof pageWorkflowGateway.startPageWorkflow>>,
  before: UseTranslationActionsOptions["currentChapter"],
) {
  for (const chapter of result.chapters) {
    options.mergeLiveChapter(chapter);
    for (const pageId of request.selection.find(
      (s) => s.chapterId === chapter.id,
    )?.pageIds ?? [])
      options.syncSavedPageVersion(chapter, pageId);
    if (before?.id === chapter.id)
      options.recordTranslationCheckpoint?.({
        before,
        after: chapter,
        pageIds:
          request.selection.find((s) => s.chapterId === chapter.id)?.pageIds ??
          [],
        label: "페이지 작업",
      });
  }
}
