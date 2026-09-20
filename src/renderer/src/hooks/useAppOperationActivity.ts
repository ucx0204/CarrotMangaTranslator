import React from "react";
import { useTranslation } from "react-i18next";
import type { AppOperationActivityEvent } from "../../../shared/appOperationTypes";
import { appGateway } from "../api/appGateway";
import {
  formatAppOperationActivity,
  isAppOperationActive,
} from "../lib/appOperationPresentation";
import { toastNotificationPort } from "../lib/notificationPort";
import { createAppOperationEventScheduler } from "./appOperationEventScheduler";

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
  const [activities, setActivities] = React.useState<
    AppOperationActivityEvent[]
  >([]);
  const activityRef = React.useRef<AppOperationActivityEvent | null>(null);
  const activitiesRef = React.useRef(
    new Map<string, AppOperationActivityEvent>(),
  );
  const previousLineByIdRef = React.useRef(new Map<string, string>());
  useAppOperationSubscription({
    activityRef,
    activitiesRef,
    appendStatusLine,
    previousLineByIdRef,
    setActivity,
    setActivities,
    t,
  });

  const cancel = React.useCallback(
    async (id?: string): Promise<void> => {
      const current = id ? activitiesRef.current.get(id) : activityRef.current;
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
    },
    [appendStatusLine, t],
  );

  const clearTerminal = React.useCallback((): void => {
    const current = activityRef.current;
    if (!current || isAppOperationActive(current)) return;
    activityRef.current = null;
    setActivity(null);
  }, []);

  return {
    activity,
    activities,
    active: activities.some(isAppOperationActive),
    libraryMutationBlocked:
      isAppOperationActive(activity) && Boolean(activity?.mutatesLibrary),
    cancel,
    clearTerminal,
  };
}

type AppOperationSubscriptionOptions = UseAppOperationActivityOptions & {
  activityRef: React.MutableRefObject<AppOperationActivityEvent | null>;
  activitiesRef: React.MutableRefObject<Map<string, AppOperationActivityEvent>>;
  previousLineByIdRef: React.MutableRefObject<Map<string, string>>;
  setActivity: React.Dispatch<
    React.SetStateAction<AppOperationActivityEvent | null>
  >;
  setActivities: React.Dispatch<
    React.SetStateAction<AppOperationActivityEvent[]>
  >;
  t: ReturnType<typeof useTranslation>["t"];
};

function useAppOperationSubscription({
  activityRef,
  activitiesRef,
  appendStatusLine,
  previousLineByIdRef,
  setActivity,
  setActivities,
  t,
}: AppOperationSubscriptionOptions): void {
  const finishedIds = React.useRef(new Set<string>());
  React.useEffect(() => {
    let disposed = false;
    const applyEvent = (
      event: AppOperationActivityEvent,
      announce: boolean,
    ): void => {
      if (disposed) return;
      const previous = activitiesRef.current.get(event.id);
      if (previous && previous.updatedAt > event.updatedAt) {
        return;
      }
      activitiesRef.current.set(event.id, event);
      const next = selectOperation(
        activitiesRef.current,
        activityRef.current,
        event,
      );
      setActivities([...activitiesRef.current.values()]);
      activityRef.current = next;
      setActivity({ ...next });
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

    const events = createAppOperationEventScheduler(
      applyEvent,
      finishedIds.current,
    );
    const unsubscribe = subscribeOperations((event) =>
      events.enqueue(event, true),
    );
    void appGateway
      .getActiveAppOperation()
      .then((event) => {
        if (event) events.enqueue(event, false);
      })
      .catch((error) => console.warn("Could not hydrate app operation", error));
    void appGateway
      .getActiveAppOperations()
      .then((active) => active.forEach((event) => events.enqueue(event, false)))
      .catch((error) =>
        console.warn("Could not hydrate concurrent operations", error),
      );
    return () => {
      disposed = true;
      events.dispose();
      unsubscribe();
    };
  }, [
    activityRef,
    activitiesRef,
    appendStatusLine,
    previousLineByIdRef,
    setActivity,
    setActivities,
    t,
  ]);
}

function selectOperation(
  activities: Map<string, AppOperationActivityEvent>,
  selected: AppOperationActivityEvent | null,
  event: AppOperationActivityEvent,
): AppOperationActivityEvent {
  for (const [id, item] of activities) {
    if (id !== event.id && !isAppOperationActive(item)) activities.delete(id);
  }
  return selected && selected.id !== event.id && isAppOperationActive(selected)
    ? selected
    : ([...activities.values()].find(isAppOperationActive) ?? event);
}

function subscribeOperations(
  applyEvent: (event: AppOperationActivityEvent) => void,
): () => void {
  let unsubscribe = (): void => undefined;
  try {
    const subscription = appGateway.onAppOperationActivity(applyEvent);
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
  return unsubscribe;
}
