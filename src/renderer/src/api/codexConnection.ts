import type { CodexAccountSnapshot } from "../../../shared/codexAccountTypes";
import { settingsGateway } from "./settingsGateway";

let snapshot: CodexAccountSnapshot | null = null;
let pending: Promise<CodexAccountSnapshot | null> | null = null;
let revision = 0;
let checked = false;
const listeners = new Set<() => void>();

export const codexConnection = {
  getSnapshot: () => snapshot,
  isChecked: () => checked,
  getRevision: () => revision,
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  publish: (next: CodexAccountSnapshot | null) => {
    revision++;
    checked = true;
    snapshot = next;
    for (const listener of listeners) listener();
  },
  refresh: (): Promise<CodexAccountSnapshot | null> => {
    if (pending) return pending;
    const started = revision;
    pending = settingsGateway
      .getCodexAccount()
      .then((next) => {
        if (revision === started) codexConnection.publish(next);
        return snapshot;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  },
};
