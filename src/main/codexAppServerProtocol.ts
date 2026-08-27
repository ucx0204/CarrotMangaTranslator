export type JsonRecord = Record<string, unknown>;

type CodexAppServerAccount =
  | { type: "apiKey" }
  | { type: "chatgpt"; email: string | null; planType: string }
  | { type: "amazonBedrock"; usesCodexManagedCredentials: boolean };

export type CodexAppServerAccountResult = {
  account: CodexAppServerAccount | null;
  requiresOpenaiAuth: boolean;
};

export type CodexAppServerModel = {
  id: string;
  displayName: string;
  hidden: boolean;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort: string;
  isDefault: boolean;
};

export type CodexAppServerTurnInput =
  | { type: "text"; text: string }
  | { type: "image"; url: string; detail?: "low" | "high" | "original" };

export type CodexAppServerTurnRequest = {
  model: string;
  effort: string;
  instructions: string;
  input: CodexAppServerTurnInput[];
  cwd: string;
  outputSchema?: JsonRecord;
  signal?: AbortSignal;
};

export type CodexAppServerTurnResult = {
  text: string;
  threadId: string;
  turnId: string;
  itemId: string | null;
};

export type CodexChatGptLogin = {
  loginId: string;
  authUrl: string;
};

export function parseAccountResult(
  value: unknown,
): CodexAppServerAccountResult {
  const record = asRecord(value);
  if (!record || typeof record.requiresOpenaiAuth !== "boolean") {
    throw new Error("Codex App Server 계정 응답 형식이 올바르지 않습니다.");
  }
  return {
    account: parseAccount(record.account),
    requiresOpenaiAuth: record.requiresOpenaiAuth,
  };
}

export function parseModel(value: unknown): CodexAppServerModel | null {
  const record = asRecord(value);
  if (!record || typeof record.id !== "string") return null;
  const effortEntries = Array.isArray(record.supportedReasoningEfforts)
    ? record.supportedReasoningEfforts
    : [];
  return {
    id: record.id,
    displayName:
      typeof record.displayName === "string" ? record.displayName : record.id,
    hidden: record.hidden === true,
    supportedReasoningEfforts: effortEntries.flatMap((entry) => {
      const parsed = asRecord(entry);
      return typeof parsed?.reasoningEffort === "string"
        ? [parsed.reasoningEffort]
        : [];
    }),
    defaultReasoningEffort:
      typeof record.defaultReasoningEffort === "string"
        ? record.defaultReasoningEffort
        : "medium",
    isDefault: record.isDefault === true,
  };
}

export function extractCompletedTurn(
  notification: JsonRecord,
  threadId: string,
  turnId: string,
): CodexAppServerTurnResult {
  const params = asRecord(notification.params);
  const turn = asRecord(params?.turn);
  assertCompletedTurn(turn);
  const selected = selectFinalMessage(readAgentMessages(turn));
  const text = readFinalText(selected);
  return {
    text,
    threadId,
    turnId,
    itemId: typeof selected?.id === "string" ? selected.id : null,
  };
}

export function readNestedString(
  value: JsonRecord | null,
  objectKey: string,
  stringKey: string,
): string | null {
  const nested = asRecord(value?.[objectKey]);
  return typeof nested?.[stringKey] === "string"
    ? String(nested[stringKey])
    : null;
}

export function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function parseAccount(value: unknown): CodexAppServerAccount | null {
  if (value === null || value === undefined) return null;
  const record = asRecord(value);
  if (!record) throw unsupportedAccountError();
  if (record.type === "apiKey") return { type: "apiKey" };
  if (record.type === "chatgpt") return parseChatGptAccount(record);
  if (record.type === "amazonBedrock") return parseBedrockAccount(record);
  throw unsupportedAccountError();
}

function parseChatGptAccount(record: JsonRecord): CodexAppServerAccount {
  const validEmail = typeof record.email === "string" || record.email === null;
  if (!validEmail || typeof record.planType !== "string") {
    throw unsupportedAccountError();
  }
  return {
    type: "chatgpt",
    email: record.email as string | null,
    planType: record.planType,
  };
}

function parseBedrockAccount(record: JsonRecord): CodexAppServerAccount {
  if (typeof record.usesCodexManagedCredentials !== "boolean") {
    throw unsupportedAccountError();
  }
  return {
    type: "amazonBedrock",
    usesCodexManagedCredentials: record.usesCodexManagedCredentials,
  };
}

function unsupportedAccountError(): Error {
  return new Error("Codex App Server 계정 유형을 해석하지 못했습니다.");
}

function assertCompletedTurn(
  turn: JsonRecord | null,
): asserts turn is JsonRecord {
  if (turn?.status === "completed") return;
  const turnError = asRecord(turn?.error);
  const error = new Error(readTurnFailureMessage(turn?.status, turnError));
  Object.assign(error, { failureCategory: "model-request" });
  throw error;
}

function readTurnFailureMessage(
  status: unknown,
  turnError: JsonRecord | null,
): string {
  if (typeof turnError?.message === "string") return turnError.message;
  return status === "interrupted"
    ? "Codex 요청이 중단되었습니다."
    : "Codex 요청이 실패했습니다.";
}

function readAgentMessages(turn: JsonRecord): JsonRecord[] {
  const items = Array.isArray(turn.items) ? turn.items : [];
  return items.flatMap((item) => {
    const record = asRecord(item);
    return record?.type === "agentMessage" && typeof record.text === "string"
      ? [record]
      : [];
  });
}

function selectFinalMessage(messages: JsonRecord[]): JsonRecord | undefined {
  const newestFirst = [...messages].reverse();
  return (
    newestFirst.find((message) => message.phase === "final_answer") ??
    newestFirst.find((message) => message.phase === null) ??
    messages.at(-1)
  );
}

function readFinalText(message: JsonRecord | undefined): string {
  const text = typeof message?.text === "string" ? message.text.trim() : "";
  if (text) return text;
  const error = new Error("Codex App Server가 빈 최종 응답을 반환했습니다.");
  Object.assign(error, {
    failureCategory: "empty-model-response",
    nonRetriable: true,
  });
  throw error;
}
