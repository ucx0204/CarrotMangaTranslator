import { closeRedactionWorkspace } from "../imageRedactionWorkspaceSessions";

type DraftWindow = {
  id: number;
  isDestroyed: () => boolean;
  once(event: "destroyed", listener: () => void): unknown;
  once(event: "render-process-gone", listener: () => void): unknown;
  removeListener(event: "destroyed", listener: () => void): unknown;
  removeListener(event: "render-process-gone", listener: () => void): unknown;
};
type Owner = {
  sender: DraftWindow;
  sessions: Set<string>;
  dispose: () => void;
};
const owners = new Map<number, Owner>();

/** The window owns draft lifetime after its waiting job is cancelled. */
export async function ownRedactionWorkspace(
  sender: DraftWindow,
  sessionId: string,
): Promise<void> {
  if (sender.isDestroyed()) {
    await closeRedactionWorkspace(sessionId);
    throw new Error("The redaction editor window was closed");
  }
  let owner = owners.get(sender.id);
  if (!owner) {
    const sessions = new Set<string>();
    const dispose = () => {
      owners.delete(sender.id);
      sender.removeListener("destroyed", dispose);
      sender.removeListener("render-process-gone", dispose);
      for (const id of sessions)
        void closeRedactionWorkspace(id).catch((error: unknown) =>
          console.error(
            "Redaction draft cleanup failed after window exit",
            error,
          ),
        );
      sessions.clear();
    };
    owner = { sender, sessions, dispose };
    owners.set(sender.id, owner);
    sender.once("destroyed", dispose);
    sender.once("render-process-gone", dispose);
  }
  owner.sessions.add(sessionId);
}

export function releaseRedactionWorkspaceOwner(sessionId: string): void {
  for (const owner of owners.values()) {
    if (!owner.sessions.delete(sessionId)) continue;
    if (!owner.sessions.size) owner.dispose();
    return;
  }
}
