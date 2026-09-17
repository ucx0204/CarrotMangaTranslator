import { isIP } from "node:net";
import type { TranslationOptions } from "../appSettings";
import { parseApiKeys } from "../../shared/apiKeySettings";
import { inferApiProviderPreset } from "../../shared/apiProviderPresets";
import { McpEditError } from "../application/mcpEditPolicy";

const SAFE_EXTRA_KEYS = new Set([
  "temperature", "top_p", "top_k", "seed", "presence_penalty", "frequency_penalty",
  "repeat_penalty", "reasoning_effort", "reasoning_budget", "enable_thinking",
]);

/** Task-local overrides never rewrite the user's configured provider/settings.
 * No key rotation or generation repair: an uncertain response is not retried. */
export function prepareMcpBlockTranslationOptions(base: TranslationOptions) {
  if (base.modelProvider === "openai-api") assertRemoteTextApi(base);
  const execution = base.modelProvider === "gemma" ? "local" : "external";
  const options: TranslationOptions = {
    ...base,
    imagePath: "",
    textOnlyModel: true,
    reuseServer: false,
    useDraft: false,
    skipOcrBboxHints: true,
    autoFontMatching: false,
    aiFontSizeMatching: false,
    naturalTextLayout: false,
    collectPageContext: false,
    maxTokens: Math.min(4096, base.maxTokens),
    apiKey: parseApiKeys(base.apiKey)[0] ?? "",
    apiKeyMaxAttempts: 1,
    apiRetryDelaySeconds: 0,
  };
  if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1)
    throw new McpEditError("invalid_edit", "Invalid translation output token limit.");
  return { options, execution: execution as "local" | "external" };
}

function assertRemoteTextApi(options: TranslationOptions): void {
  let url: URL;
  try { url = new URL(options.apiBaseUrl); }
  catch { throw new McpEditError("invalid_edit", "Invalid configured translation API URL."); }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (url.protocol !== "https:" || url.username || url.password ||
      isIP(host) || !host.includes(".") || /\.(?:localhost|local|lan|internal)$/.test(host) ||
      inferApiProviderPreset(options.apiBaseUrl) === "ollama")
    throw new McpEditError("invalid_edit", "This text proposal tool supports app-managed Gemma, Codex, and externally hosted HTTPS APIs. Local compatible servers need a strict unload contract and are not started by this tool.");
  const raw = options.apiExtraBodyJson?.trim();
  if (!raw) return;
  let extra: unknown;
  try { extra = JSON.parse(raw); }
  catch { throw new McpEditError("invalid_edit", "Invalid API extra body JSON."); }
  if (!extra || typeof extra !== "object" || Array.isArray(extra) ||
      Object.entries(extra).some(([key, value]) => !SAFE_EXTRA_KEYS.has(key) ||
        !["string", "number", "boolean"].includes(typeof value)))
    throw new McpEditError("invalid_edit", "API extra body must contain only scalar sampling settings for this single text request; tool, image, stream and multiple-generation overrides are not accepted.");
}
