import React from "react";
import { useTranslation } from "react-i18next";
import type { AppOperationActivityEvent } from "../../../shared/appOperationTypes";
import { appGateway } from "../api/appGateway";
import {
  formatAppOperationActivity,
  isAppOperationActive,
} from "../lib/appOperationPresentation";
import { toastNotificationPort } from "../lib/notificationPort";

type UseAppOperationActivityOptions = {
  appendStatusLine: (
    line: string,
    replaceExisting?: (line: string) => boolean,
  ) => void;
};

export function useAppOperationActivity({
  appendStatusLine,
}: UseAppOperationActivityOptions) {
  const { t } = useTranslation("renderer");
  const [activity, setActivity] =
    React.useState<AppOperationActivityEvent | null>(null);
  const activityRef = React.useRef<AppOperationActivityEvent | null>(null);
  const previousLineByIdRef = React.useRef(new Map<string, string>());
  useAppOperationSubscription({
    activityRef,
    appendStatusLine,
    previousLineByIdRef,
    setActivity,
    t,
  });

  const cancel = React.useCallback(async (): Promise<void> => {
    const current = activityRef.current;
    if (!current || !isAppOperationActive(current) || !current.cancellable) {
      return;
    }
    try {
      await appGateway.cancelAppOperation(current.id);
    } catch (error) {
      console.error(error);
      const line = t("statusDock.operation.cancelFailed");
      appendStatusLine(line);
      toastNotificationPort.error(line);
    }
  }, [appendStatusLine, t]);

  const clearTerminal = React.useCallback((): void => {
    const current = activityRef.current;
    if (!current || isAppOperationActive(current)) return;
    activityRef.current = null;
    setActivity(null);
  }, []);

  return {
    activity,
    active: isAppOperationActive(activity),
    libraryMutationBlocked:
      isAppOperationActive(activity) && Boolean(activity?.mutatesLibrary),
    cancel,
    clearTerminal,
  };
}

function useAppOperationSubscription({
  activityRef,
  appendStatusLine,
  previousLineByIdRef,
  setActivity,
  t,
}: UseAppOperationActivityOptions & {
  activityRef: React.MutableRefObject<AppOperationActivityEvent | null>;
  previousLineByIdRef: React.MutableRefObject<Map<string, string>>;
  setActivity: React.Dispatch<
    React.SetStateAction<AppOperationActivityEvent | null>
  >;
  t: ReturnType<typeof useTranslation>["t"];
}): void {
  React.useEffect(() => {
    let disposed = false;
    const applyEvent = (
      event: AppOperationActivityEvent,
      announce: boolean,
    ): void => {
      if (disposed) return;
      const previous = activityRef.current;
      if (previous?.id === event.id && previous.updatedAt > event.updatedAt) {
        return;
      }
      activityRef.current = event;
      setActivity(event);
      if (!announce) return;
      const line = formatAppOperationActivity(event, t);
      const previousLine = previousLineByIdRef.current.get(event.id);
      appendStatusLine(
        line,
        previousLine ? (candidate) => candidate === previousLine : undefined,
      );
      previousLineByIdRef.current.set(event.id, line);
      if (event.status === "failed") {
        toastNotificationPort.error(line);
      }
    };

    let unsubscribe = (): void => undefined;
    try {
      const subscription = appGateway.onAppOperationActivity((event) =>
        applyEvent(event, true),
      );
      if (typeof subscription === "function") {
        unsubscribe = subscription;
      } else {
        void Promise.resolve(subscription as unknown).catch((error) =>
          console.warn("Could not subscribe to app operations", error),
        );
      }
    } catch (error) {
      console.warn("Could not subscribe to app operations", error);
    }
    void appGateway
      .getActiveAppOperation()
      .then((event) => {
        if (event) applyEvent(event, false);
      })
      .catch((error) => console.warn("Could not hydrate app operation", error));
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [activityRef, appendStatusLine, previousLineByIdRef, setActivity, t]);
}
