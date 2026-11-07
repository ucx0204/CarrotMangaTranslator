import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { AppPaths } from "../appPaths";
import {
  CodexAppServerClient,
  type CodexAppServerClientStartRuntime,
} from "../codexAppServerClient";
import {
  asRecord,
  type JsonRecord,
  type CodexAppServerTurnInput,
} from "../codexAppServerProtocol";
import type { ChatSession } from "../../shared/chatTypes";
import type {
  AgentRuntime,
  AgentRuntimeEvents,
} from "../application/chatRuntimePorts";
import { CHAT_INSTRUCTIONS } from "./chatInstructions";

export class CodexChatRuntime implements AgentRuntime {
  static async deleteThread(
    paths: AppPaths,
    appVersion: string,
    threadId: string,
    runtime?: CodexAppServerClientStartRuntime,
  ): Promise<void> {
    z.string().uuid().parse(threadId);
    const client = await CodexAppServerClient.start(
      { paths, appVersion },
      runtime,
    );
    try {
      await client.connection.request("thread/delete", { threadId });
    } catch (error) {
      // A previous successful deletion may have lost its acknowledgement.
      // Only this exact missing-thread response is safe to treat as complete.
      if (
        !(error instanceof Error) ||
        error.message !==
          `Codex App Server thread/delete 요청 실패: no rollout found for thread id ${threadId}`
      )
        throw error;
    } finally {
      await client.dispose();
    }
  }
  private threadId: string | null = null;
  private preparing: Promise<string> | null = null;
  private turnId: string | null = null;
  private completedTurns = new Set<string>();
  private stopGeneration = 0;
  private release: () => void;
  private pending = new Map<string, (value: unknown) => void>();
  private constructor(
    private readonly client: CodexAppServerClient,
    private readonly cwd: string,
    private readonly events: AgentRuntimeEvents,
  ) {
    this.release = client.connection.subscribe(
      (value) => this.notification(value),
      events.failed,
    );
    client.connection.handleServerRequests((value) => this.request(value));
  }
  static async start(
    paths: AppPaths,
    appVersion: string,
    connection: { url: string; token: string },
    events: AgentRuntimeEvents,
    runtime?: CodexAppServerClientStartRuntime,
  ) {
    const cwd = join(paths.dataRoot, "chat", "runtime");
    await mkdir(cwd, { recursive: true });
    const client = await CodexAppServerClient.start(
      {
        paths,
        appVersion,
        capability: "chat",
        chatConnection: connection,
      },
      runtime,
    );
    return new CodexChatRuntime(client, cwd, events);
  }
  prepare(session: ChatSession): Promise<string> {
    if (this.threadId) return Promise.resolve(this.threadId);
    this.preparing ??= this.prepareThread(session).catch((error: unknown) => {
      this.preparing = null;
      throw error;
    });
    return this.preparing;
  }
  private async prepareThread(session: ChatSession): Promise<string> {
    const account = await this.client.readAccount();
    if (account.account?.type !== "chatgpt")
      throw new Error("앱 설정에서 ChatGPT 계정으로 로그인해 주세요.");
    const result = asRecord(
      await this.client.connection.request(
        session.nativeThreadId ? "thread/resume" : "thread/start",
        {
          ...(session.nativeThreadId
            ? { threadId: session.nativeThreadId, excludeTurns: true }
            : { ephemeral: false, serviceName: "carrot_global_chat" }),
          cwd: this.cwd,
          approvalPolicy: "never",
          sandbox: "read-only",
          model: session.model,
          developerInstructions: CHAT_INSTRUCTIONS,
          config: {
            include_environment_context: false,
            include_permissions_instructions: false,
            include_apps_instructions: false,
            project_doc_max_bytes: 0,
            project_doc_fallback_filenames: [],
            features: {
              shell_tool: false,
              unified_exec: false,
              image_generation: false,
              code_mode: true,
              code_mode_host: true,
            },
          },
        },
      ),
    );
    const thread = asRecord(result?.thread);
    if (typeof thread?.id !== "string")
      throw new Error("Codex 대화 ID를 받지 못했습니다.");
    this.threadId = thread.id;
    return thread.id;
  }
  async send(
    messageId: string,
    input: CodexAppServerTurnInput[],
    model: string | null,
    effort: string | null,
  ): Promise<void> {
    if (!this.threadId) throw new Error("대화를 먼저 연결해 주세요.");
    const generation = this.stopGeneration;
    const active = this.turnId;
    if (active && (await this.steer(active, messageId, input))) return;
    if (generation !== this.stopGeneration) return;
    const response = asRecord(
      await this.client.connection.request("turn/start", {
        threadId: this.threadId,
        input,
        clientUserMessageId: messageId,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
      }),
    );
    this.acceptStartedTurn(response);
    if (generation !== this.stopGeneration) await this.stop();
  }
  private acceptStartedTurn(response: JsonRecord | null) {
    const turn = asRecord(response?.turn);
    if (typeof turn?.id !== "string")
      throw new Error("Codex 실행 ID를 받지 못했습니다.");
    this.turnId =
      this.completedTurns.has(turn.id) || turn.status === "completed"
        ? null
        : turn.id;
  }
  private async steer(
    active: string,
    messageId: string,
    input: CodexAppServerTurnInput[],
  ) {
    try {
      await this.client.connection.request("turn/steer", {
        threadId: this.threadId,
        expectedTurnId: active,
        input,
        clientUserMessageId: messageId,
      });
      return true;
    } catch (error) {
      // Only a definite ended-turn rejection is safe to deliver as a new turn.
      if (
        !(error instanceof Error) ||
        !/no active turn|turn[^\n]*(?:not active|has completed)|expected turn[^\n]*but/i.test(
          error.message,
        )
      )
        throw error;
      if (this.turnId === active) this.turnId = null;
      return false;
    }
  }
  async stop(): Promise<void> {
    this.stopGeneration++;
    this.cancelQuestions();
    if (this.threadId && this.turnId)
      await this.client.connection.request("turn/interrupt", {
        threadId: this.threadId,
        turnId: this.turnId,
      });
  }
  async compact(): Promise<void> {
    if (!this.threadId) throw new Error("대화를 먼저 연결해 주세요.");
    if (this.turnId)
      throw new Error("현재 응답이 끝난 뒤 대화를 압축할 수 있습니다.");
    await this.client.connection.request("thread/compact/start", {
      threadId: this.threadId,
    });
  }
  answer(id: string, answers: Record<string, string>): void {
    const resolve = this.pending.get(id);
    if (!resolve)
      throw new Error("이 질문은 더 이상 응답을 기다리지 않습니다.");
    this.pending.delete(id);
    resolve({
      answers: Object.fromEntries(
        Object.entries(answers).map(([key, value]) => [
          key,
          { answers: [value] },
        ]),
      ),
    });
  }
  async close(): Promise<void> {
    this.cancelQuestions();
    this.release();
    await this.client.dispose(true);
  }
  private cancelQuestions() {
    for (const resolve of this.pending.values()) resolve({ answers: {} });
    this.pending.clear();
  }
  private notification(value: JsonRecord) {
    const params = asRecord(value.params);
    if (params?.threadId !== this.threadId) return;
    if (value.method === "turn/started") {
      const turn = asRecord(params.turn);
      if (typeof turn?.id === "string") this.turnId = turn.id;
    }
    if (value.method === "turn/completed") {
      const turn = asRecord(params.turn);
      if (typeof turn?.id === "string") this.completedTurns.add(turn.id);
      if (this.turnId === turn?.id) this.turnId = null;
    }
    this.events.notification(
      value.method === "thread/compacted"
        ? {
            ...value,
            params: { ...params, continuesTurn: this.turnId !== null },
          }
        : value,
    );
  }
  private request(value: JsonRecord): Promise<unknown> | undefined {
    if (value.method !== "item/tool/requestUserInput") return undefined;
    const params = asRecord(value.params);
    if (params?.threadId !== this.threadId) return undefined;
    const id = String(value.id);
    const questions = Array.isArray(params.questions)
      ? params.questions.flatMap(readQuestion)
      : [];
    const result = new Promise((resolve) => {
      this.pending.set(id, resolve);
    });
    this.events.question({ id, questions });
    return result;
  }
}
function readQuestion(value: unknown) {
  const question = asRecord(value);
  if (typeof question?.id !== "string" || typeof question.question !== "string")
    return [];
  const options = Array.isArray(question.options)
    ? question.options.flatMap((item) => {
        const option = asRecord(item);
        return typeof option?.label === "string"
          ? [
              {
                label: option.label,
                description:
                  typeof option.description === "string"
                    ? option.description
                    : "",
              },
            ]
          : [];
      })
    : [];
  return [{ id: question.id, question: question.question, options }];
}
