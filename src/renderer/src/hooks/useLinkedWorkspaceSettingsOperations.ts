import React from "react";

export function useLinkedWorkspaceSettingsOperations(
  refresh: () => Promise<void>,
): {
  busyChapterIds: ReadonlySet<string>;
  errors: ReadonlyMap<string, string>;
  run: (chapterId: string, operation: () => Promise<unknown>) => Promise<void>;
} {
  const [busyChapterIds, setBusyChapterIds] = React.useState<Set<string>>(
    () => new Set(),
  );
  const [errors, setErrors] = React.useState<Map<string, string>>(
    () => new Map(),
  );
  const run = React.useCallback(
    async (chapterId: string, operation: () => Promise<unknown>) => {
      setBusyChapterIds((current) => new Set(current).add(chapterId));
      setErrors((current) => mapWithoutKey(current, chapterId));
      try {
        await operation();
        await refresh();
      } catch (error) {
        setErrors((current) =>
          new Map(current).set(chapterId, formatError(error)),
        );
      } finally {
        setBusyChapterIds((current) => setWithoutValue(current, chapterId));
      }
    },
    [refresh],
  );
  return { busyChapterIds, errors, run };
}

function setWithoutValue<T>(current: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(current);
  next.delete(value);
  return next;
}

function mapWithoutKey<K, V>(current: ReadonlyMap<K, V>, key: K): Map<K, V> {
  const next = new Map(current);
  next.delete(key);
  return next;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
