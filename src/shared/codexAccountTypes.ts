import type { CodexReasoningEffort } from "./codexSettings";

type CodexAccountKind = "chatgpt" | "api-key" | "amazon-bedrock" | null;

export type CodexAccountModel = {
  id: string;
  displayName: string;
  supportedReasoningEfforts: CodexReasoningEffort[];
  defaultReasoningEffort: CodexReasoningEffort;
  isDefault: boolean;
};

export type CodexAccountSnapshot = {
  authenticated: boolean;
  accountKind: CodexAccountKind;
  email: string | null;
  planType: string | null;
  requiresOpenaiAuth: boolean;
  appServerVersion: string;
  models: CodexAccountModel[];
};
