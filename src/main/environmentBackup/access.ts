let exclusive = false;
const pending = new Set<Promise<unknown>>();
const allowed = new Set([
  "app-operation:cancel",
  "app-operation:get-active",
  "app-operation:get-all",
  "app-activity:get",
]);

export async function trackEnvironmentAccess<T>(
  channel: string,
  action: () => Promise<T> | T,
): Promise<T> {
  if (channel.startsWith("environment-backup:") || allowed.has(channel))
    return action();
  if (exclusive)
    throw new Error(
      "A backup or restore is in progress. Wait until it finishes.",
    );
  const task = Promise.resolve().then(action);
  pending.add(task);
  try {
    return await task;
  } finally {
    pending.delete(task);
  }
}
export async function suspendEnvironmentAccess(): Promise<() => void> {
  if (exclusive)
    throw new Error("An environment backup operation is already active.");
  exclusive = true;
  await Promise.allSettled([...pending]);
  return () => {
    exclusive = false;
  };
}
