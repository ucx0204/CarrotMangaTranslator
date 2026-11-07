import { cancelChatOperations } from "./chatOperationControl";
import type { AppPaths } from "../appPaths";
import type { ChatEvent } from "../../shared/chatTypes";
import type { createMcpDesktopRuntime } from "../mcpDesktopRuntime";
import { ChatService } from "../application/chatService";
import { ChatRepository } from "./chatRepository";
import { CodexChatRuntime } from "./codexChatRuntime";
import { ClaudeChatRuntime } from "./claudeChatRuntime";
import { GrokChatRuntime } from "./grokChatRuntime";

export function createChatService(options: {
  paths: AppPaths;
  appVersion: string;
  mcp: Pick<ReturnType<typeof createMcpDesktopRuntime>, "connectChat">;
  publish: (event: ChatEvent) => void;
  reportError: (error: unknown) => void;
}) {
  return new ChatService({
    repository: new ChatRepository(options.paths.dataRoot),
    publish: options.publish,
    reportError: options.reportError,
    deleteNativeSession: (threadId) =>
      CodexChatRuntime.deleteThread(
        options.paths,
        options.appVersion,
        threadId,
      ),
    runtime: async (session, events, observe) => {
      const connection = await options.mcp.connectChat(
        session.id,
        observe,
        { claude: "Claude Code", codex: "Codex", grok: "Grok Build" }[
          session.runtime
        ],
      );
      try {
        const runtime =
          session.runtime === "claude"
            ? new ClaudeChatRuntime(options.paths, connection, events)
            : session.runtime === "grok"
              ? new GrokChatRuntime(options.paths, connection, events)
              : await CodexChatRuntime.start(
                  options.paths,
                  options.appVersion,
                  connection,
                  events,
                );
        return {
          runtime,
          release: connection.close,
          cancelOperations: (current) =>
            cancelChatOperations(connection, current),
        };
      } catch (error) {
        connection.close();
        throw error;
      }
    },
  });
}
