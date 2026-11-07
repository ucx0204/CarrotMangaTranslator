import { addChatStatus } from "../chat/chatReducer";
import type { RuntimeLease } from "./chatRuntimePorts";
import type { ChatSession } from "../../shared/chatTypes";
import type { ChatRepository } from "../chat/chatRepository";

export type ChatStoragePorts = {
  repository: Pick<
    ChatRepository,
    "list" | "read" | "save" | "delete" | "image" | "addImage"
  >;
  deleteNativeSession: (threadId: string) => Promise<void>;
};

export async function deleteChatRecords(
  session: ChatSession,
  ports: ChatStoragePorts,
) {
  if (session.runtime === "codex" && session.nativeThreadId) {
    await ports.deleteNativeSession(session.nativeThreadId);
    session.nativeThreadId = null;
    // Persist provider completion before local cleanup so retries/restarts
    // cannot resume a native thread that was already deleted.
    await ports.repository.save(session);
  }
  await ports.repository.delete(session.id);
}

export async function closeChatRuntime(lease: RuntimeLease): Promise<void> {
  try {
    await lease.runtime.close();
  } finally {
    lease.release();
  }
}

/** Provider failure must never skip cancellation of native app operations. */
export async function stopChatRuntime(
  pending: Promise<RuntimeLease> | undefined,
  session: ChatSession,
): Promise<void> {
  const lease = await pending;
  if (!lease) return;
  const failures: unknown[] = [];
  try {
    const cancelled = await Promise.allSettled([
      Promise.resolve().then(() => lease.runtime.stop()),
      Promise.resolve().then(() => lease.cancelOperations(session)),
    ]);
    for (const result of cancelled)
      if (result.status === "rejected") failures.push(result.reason);
  } finally {
    try {
      await closeChatRuntime(lease);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(failures, "중지 상태를 확인하지 못했습니다.");
}

export async function stopAndSaveChat(
  pending: Promise<RuntimeLease> | undefined,
  session: ChatSession,
  save: (session: ChatSession) => Promise<void>,
  reportError: (error: unknown) => void,
) {
  const results = await Promise.allSettled([
    save(session),
    stopChatRuntime(pending, session),
  ]);
  const failures = results.filter((value) => value.status === "rejected");
  if (failures.length) {
    for (const failure of failures) reportError(failure.reason);
    session.state = "failed";
    addChatStatus(
      session,
      "일부 작업의 중지 상태를 확인하지 못했습니다. 작업 기록을 확인한 뒤 이어가세요.",
      "failed",
    );
  }
  await save(session);
}

export async function cancelPendingChatOperations(
  session: ChatSession,
  lease: RuntimeLease,
  save: (session: ChatSession) => Promise<void>,
  reportError: (error: unknown) => void,
) {
  try {
    await lease.cancelOperations(session);
  } catch (error) {
    reportError(error);
    addChatStatus(
      session,
      "일부 앱 작업의 중지 상태를 확인하지 못했습니다. 작업 기록을 확인해 주세요.",
      "failed",
    );
    await save(session);
  }
}
