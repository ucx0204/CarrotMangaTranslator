import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import type { ChatSendRequest, ChatSession } from "../../src/shared/chatTypes";
import type {
  AgentRuntime,
  AgentRuntimeEvents,
} from "../../src/main/application/chatRuntimePorts";
import { ChatService } from "../../src/main/application/chatService";
import { ChatRepository } from "../../src/main/chat/chatRepository";
import type { McpChatObservation } from "../../src/main/mcp/mcpLocalHost";

export async function chatFixture(
  prepare = async () => "native-persistent-thread",
) {
  const root = await mkdtemp(join(tmpdir(), "carrot-global-chat-"));
  const repository = new ChatRepository(root);
  let events!: AgentRuntimeEvents;
  let observe!: (value: McpChatObservation) => Promise<void>;
  const cancelOperations = vi.fn(async () => undefined);
  const runtime = {
    prepare: vi.fn(prepare),
    send: vi.fn<AgentRuntime["send"]>(async () => undefined),
    stop: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    compact: vi.fn(async () => undefined),
    answer: vi.fn(),
  };
  const connect = vi.fn(
    async (
      _session: ChatSession,
      value: AgentRuntimeEvents,
      observer: (value: McpChatObservation) => Promise<void>,
    ) => {
      events = value;
      observe = observer;
      return {
        runtime,
        release: vi.fn(),
        cancelOperations,
      };
    },
  );
  const errors = vi.fn();
  const deleteNativeSession = vi.fn(async (_threadId: string) => undefined);
  const service = new ChatService({
    repository,
    runtime: connect,
    publish: vi.fn(),
    reportError: errors,
    deleteNativeSession,
  });
  const session = await service.create();
  let disposal: Promise<void> | undefined;
  const dispose = () => (disposal ??= service.dispose());
  return {
    root,
    repository,
    runtime,
    connect,
    service,
    session,
    dispose,
    errors,
    deleteNativeSession,
    cancelOperations,
    observe: (value: McpChatObservation) => observe(value),
    events: () => events,
    cleanup: async () => {
      await dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

export function chatRequest(
  id: string,
  text = "이 화 번역해줘",
): ChatSendRequest {
  return {
    sessionId: id,
    messageId: randomUUID(),
    text,
    imageIds: [],
    model: null,
    effort: null,
    context: {
      workId: randomUUID(),
      workTitle: "작품",
      chapterId: randomUUID(),
      chapterTitle: "1화",
      pageId: randomUUID(),
      pageNumber: 1,
      blockIds: ["block-1"],
      revision: "page-v1:1234567890abcdef",
    },
  };
}

export function endChatTurn(events: AgentRuntimeEvents, status = "completed") {
  events.notification({
    method: "turn/completed",
    params: { turn: { id: "turn-1", status } },
  });
}
