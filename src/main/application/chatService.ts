import { chatSnapshot, chatSummary } from "../../shared/chatSnapshot";
import { randomUUID } from "node:crypto";
import type {
  ChatEvent,
  ChatSendRequest,
  ChatSession,
  ChatSnapshot,
  ChatSummary,
} from "../../shared/chatTypes";
import type { RuntimeLease, AgentRuntimeEvents } from "./chatRuntimePorts";
import { deliverChatMessage } from "./chatDelivery";
import {
  cancelPendingChatOperations,
  closeChatRuntime,
  deleteChatRecords,
  type ChatStoragePorts,
  stopAndSaveChat,
  stopChatRuntime,
} from "./chatRuntimeLifecycle";
import {
  addChatStatus,
  reduceChatNotification,
  restoredState,
  restoreChatSession,
} from "../chat/chatReducer";
import { observeChatTool } from "../chat/chatToolObservation";
import type { McpChatObservation } from "../mcp/mcpLocalHost";

type Ports = ChatStoragePorts & {
  runtime: (
    session: ChatSession,
    events: AgentRuntimeEvents,
    observe: (value: McpChatObservation) => Promise<void>,
  ) => Promise<RuntimeLease>;
  publish: (event: ChatEvent) => void;
  reportError: (error: unknown) => void;
};

export class ChatService {
  private sessions = new Map<string, Promise<ChatSession>>();
  private runtimes = new Map<string, Promise<RuntimeLease>>();
  private sending = new Map<string, Promise<void>>();
  private saves = new Map<string, ReturnType<typeof setTimeout>>();
  private generations = new Map<string, number>();
  private stopping = new Map<string, Promise<ChatSnapshot>>();
  private runtimeEpochs = new Map<string, symbol>();
  private deleted = new Set<string>();
  private closed = false;
  constructor(private readonly ports: Ports) {}
  async list(): Promise<ChatSummary[]> {
    const saved = await this.ports.repository.list();
    return Promise.all(
      saved.map(async (item) => {
        if (item.loadError) return item;
        const current = this.sessions.has(item.id)
          ? await this.get(item.id)
          : item;
        return {
          ...chatSummary(current),
          state: restoredState(current.state, this.runtimes.has(item.id)),
        };
      }),
    );
  }
  async create(runtime?: ChatSession["runtime"]): Promise<ChatSnapshot> {
    this.assertOpen();
    const history = await this.list();
    runtime ??= history.find((entry) => !entry.loadError)?.runtime ?? "codex";
    const previous = history.find(
      (entry) => !entry.loadError && entry.runtime === runtime,
    );
    const now = Date.now();
    const session: ChatSession = {
      version: 1,
      id: randomUUID(),
      title: "새 대화",
      runtime,
      nativeThreadId: null,
      model: previous?.model ?? null,
      effort: previous?.effort ?? null,
      state: "idle",
      createdAt: now,
      updatedAt: now,
      items: [],
      checkpoint: [],
      question: null,
    };
    await this.ports.repository.save(session);
    this.sessions.set(session.id, Promise.resolve(session));
    return chatSnapshot(session);
  }
  async read(id: string, before?: number) {
    return chatSnapshot(await this.get(id), before);
  }
  async delete(id: string): Promise<void> {
    this.assertOpen();
    const session = await this.get(id);
    this.assertAvailable(id);
    if (["running", "compacting", "needs-input"].includes(session.state))
      throw new Error("현재 작업을 중지한 뒤 대화를 삭제해 주세요.");
    this.deleted.add(id);
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    const timer = this.saves.get(id);
    if (timer) clearTimeout(timer);
    this.saves.delete(id);
    try {
      const lease = await this.runtimes.get(id);
      if (lease) {
        try {
          await closeChatRuntime(lease);
        } finally {
          this.runtimes.delete(id);
        }
      }
      await this.sending.get(id);
      await deleteChatRecords(session, this.ports);
      this.sessions.delete(id);
      this.sending.delete(id);
    } catch (error) {
      this.deleted.delete(id);
      throw error;
    }
  }
  async send(request: ChatSendRequest): Promise<ChatSnapshot> {
    this.assertOpen();
    await this.stopping.get(request.sessionId);
    const session = await this.get(request.sessionId);
    if (session.items.some((item) => item.id === request.messageId))
      return chatSnapshot(session);
    await Promise.all(
      request.imageIds.map((id) => this.ports.repository.image(session.id, id)),
    );
    this.assertOpen();
    if (session.items.some((item) => item.id === request.messageId))
      return chatSnapshot(session);
    this.assertAvailable(session.id);
    const generation = this.generations.get(session.id) ?? 0;
    session.items.push({
      id: request.messageId,
      role: "user",
      text: request.text,
      state: "completed",
      createdAt: Date.now(),
      context: structuredClone(request.context),
      imageIds: [...request.imageIds],
      delivery: "pending",
    });
    if (session.title === "새 대화")
      session.title = request.text.trim().slice(0, 60) || "이미지 검토";
    session.model = request.model;
    session.effort = request.effort;
    session.state = "running";
    await this.save(session);
    const previous = this.sending.get(session.id) ?? Promise.resolve();
    const next = previous
      .then(() =>
        deliverChatMessage(session, request, {
          stopped: () => this.shouldStop(session, generation),
          runtime: () => this.runtime(session),
          save: (value) => this.save(value),
          repository: this.ports.repository,
        }),
      )
      .catch((error: unknown) => {
        if (this.shouldStop(session, generation)) this.ports.reportError(error);
        else return this.fail(session, error);
      });
    this.sending.set(session.id, next);
    return chatSnapshot(session);
  }
  stop(id: string): Promise<ChatSnapshot> {
    const existing = this.stopping.get(id);
    if (existing) return existing;
    const pending = this.runStop(id).finally(() => this.stopping.delete(id));
    this.stopping.set(id, pending);
    return pending;
  }
  private async runStop(id: string): Promise<ChatSnapshot> {
    const session = await this.get(id);
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    session.state = "paused";
    session.question = null;
    this.runtimeEpochs.delete(id);
    const pending = this.runtimes.get(id);
    this.runtimes.delete(id);
    await stopAndSaveChat(
      pending,
      session,
      (value) => this.save(value),
      this.ports.reportError,
    );
    return chatSnapshot(session);
  }
  async compact(id: string): Promise<ChatSnapshot> {
    this.assertOpen();
    await this.stopping.get(id);
    const session = await this.get(id);
    this.assertAvailable(id);
    if (["running", "compacting", "needs-input"].includes(session.state))
      throw new Error("현재 작업이 끝난 뒤 압축할 수 있습니다.");
    session.state = "compacting";
    const generation = this.generations.get(id) ?? 0;
    try {
      const lease = await this.runtime(session);
      if (this.shouldStop(session, generation)) return chatSnapshot(session);
      session.nativeThreadId = await lease.runtime.prepare(session);
      await this.save(session);
      if (this.shouldStop(session, generation)) return chatSnapshot(session);
      await lease.runtime.compact();
    } catch (error) {
      if (this.shouldStop(session, generation)) this.ports.reportError(error);
      else await this.fail(session, error);
    }
    return chatSnapshot(session);
  }
  async answer(
    id: string,
    questionId: string,
    answers: Record<string, string>,
  ): Promise<ChatSnapshot> {
    const session = await this.get(id);
    if (session.question?.id !== questionId)
      throw new Error("질문 상태가 변경되었습니다. 대화를 다시 확인해 주세요.");
    const lease = await this.runtimes.get(id);
    if (!lease) throw new Error("대화를 다시 연결해 주세요.");
    if (session.question?.id !== questionId)
      throw new Error("질문 상태가 변경되었습니다. 대화를 다시 확인해 주세요.");
    lease.runtime.answer(questionId, answers);
    session.question = null;
    session.state = "running";
    await this.save(session);
    return chatSnapshot(session);
  }
  async attachImage(id: string, name: string, dataUrl: string) {
    this.assertOpen();
    this.assertAvailable(id);
    return this.ports.repository.addImage(id, name, dataUrl);
  }
  async image(id: string, imageId: string, preview = false) {
    return this.ports.repository.image(id, imageId, preview);
  }
  async dispose(): Promise<void> {
    this.closed = true;
    await this.pauseAll();
  }
  async pauseAll(): Promise<void> {
    for (const timer of this.saves.values()) clearTimeout(timer);
    this.saves.clear();
    const results = await Promise.allSettled(
      [...this.sessions].map(async ([id, value]) => {
        const session = await value;
        this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
        try {
          await stopChatRuntime(this.runtimes.get(id), session);
        } finally {
          this.runtimes.delete(id);
          session.state = restoredState(session.state, false);
          session.question = null;
          await this.save(session);
        }
      }),
    );
    const failed = results.filter((value) => value.status === "rejected");
    if (failed.length)
      throw new AggregateError(
        failed.map((value) => value.reason),
        "채팅 종료 중 오류가 발생했습니다.",
      );
  }
  private get(id: string): Promise<ChatSession> {
    this.assertAvailable(id);
    let entry = this.sessions.get(id);
    if (!entry) {
      entry = this.ports.repository.read(id).then(restoreChatSession);
      this.sessions.set(id, entry);
      void entry.catch(() => {
        // error-policy-allow: callers receive the read error; an invalid ID or
        // temporary read failure must not poison shutdown or later retries.
        this.sessions.delete(id);
      });
    }
    return entry;
  }

  private runtime(session: ChatSession): Promise<RuntimeLease> {
    let pending = this.runtimes.get(session.id);
    if (!pending) {
      const epoch = Symbol(session.id);
      this.runtimeEpochs.set(session.id, epoch);
      const current = () =>
        !this.closed &&
        !this.deleted.has(session.id) &&
        this.runtimeEpochs.get(session.id) === epoch;
      pending = this.ports.runtime(
        session,
        {
          notification: (value) => {
            if (!current()) return;
            if (reduceChatNotification(session, value))
              this.scheduleSave(session);
          },
          question: (question) => {
            if (!current()) return;
            session.question = question;
            session.state = "needs-input";
            this.scheduleSave(session);
          },
          failed: (error) => {
            if (!current()) return;
            void this.disconnect(session, error).catch(this.ports.reportError);
          },
        },
        async (value) => {
          if (this.deleted.has(session.id)) return;
          await observeChatTool(session, value, this.ports.repository);
          await this.save(session);
          if (
            (!current() || session.state === "paused") &&
            !/^carrot_(get|list|cancel)_/.test(value.name)
          ) {
            const lease = await pending;
            if (lease)
              await cancelPendingChatOperations(
                session,
                lease,
                (value) => this.save(value),
                this.ports.reportError,
              );
          }
        },
      );
      this.runtimes.set(session.id, pending);
      void pending.catch((error: unknown) => {
        if (this.runtimeEpochs.get(session.id) === epoch) {
          this.runtimeEpochs.delete(session.id);
          this.runtimes.delete(session.id);
        }
        this.ports.reportError(error);
      });
    }
    return pending;
  }
  private scheduleSave(session: ChatSession) {
    if (this.deleted.has(session.id)) return;
    if (this.saves.has(session.id)) return;
    this.saves.set(
      session.id,
      setTimeout(() => {
        this.saves.delete(session.id);
        void this.save(session).catch(this.ports.reportError);
      }, 150),
    );
  }

  private async save(session: ChatSession) {
    if (this.deleted.has(session.id)) return;
    session.updatedAt = Math.max(Date.now(), session.updatedAt + 1);
    const snapshot = chatSnapshot(session);
    await this.ports.repository.save(session);
    if (this.deleted.has(session.id)) return;
    this.ports.publish({
      sessionId: session.id,
      session: snapshot,
    });
  }
  private async fail(session: ChatSession, error: unknown) {
    this.ports.reportError(error);
    session.state = "failed";
    addChatStatus(
      session,
      error instanceof Error ? error.message : String(error),
      "failed",
    );
    await this.save(session);
  }
  private async disconnect(session: ChatSession, error: unknown) {
    const pending = this.runtimes.get(session.id);
    this.runtimes.delete(session.id);
    this.runtimeEpochs.delete(session.id);
    this.generations.set(
      session.id,
      (this.generations.get(session.id) ?? 0) + 1,
    );
    try {
      await this.fail(session, error);
    } finally {
      if (pending) await closeChatRuntime(await pending);
    }
  }
  private assertOpen() {
    if (this.closed) throw new Error("앱이 종료 중입니다.");
  }
  private assertAvailable(id: string) {
    if (this.deleted.has(id)) throw new Error("삭제된 대화입니다.");
  }
  private shouldStop(session: ChatSession, generation: number) {
    return (
      this.closed ||
      this.deleted.has(session.id) ||
      generation !== (this.generations.get(session.id) ?? 0)
    );
  }
}
