import {
  asRecord,
  type CodexAppServerPreviewTool,
  type JsonRecord,
} from "./codexAppServerProtocol";

type ToolResult = Awaited<ReturnType<CodexAppServerPreviewTool["execute"]>>;
type Registration = {
  tool: CodexAppServerPreviewTool;
  signal?: AbortSignal;
  active: boolean;
  calls: Map<string, { input: string; result: Promise<ToolResult> }>;
};

const CODEX_PREVIEW_TOOL_NAME = "preview_erasure";
export function codexPreviewToolConfig(
  tool?: CodexAppServerPreviewTool,
): JsonRecord {
  return tool
    ? {
        dynamicTools: [
          {
            type: "function",
            name: CODEX_PREVIEW_TOOL_NAME,
            description:
              "Preview every proposed erasure using the actual registered source geometry and mask. Returns images, region-specific unresolved diagnostics and an artifact reference. Submit exactly one proposal. Finalize by acknowledging the returned artifact. If the tool fails, report its error; never invent an artifact reference.",
            inputSchema: tool.inputSchema,
          },
        ],
      }
    : {};
}
export const CODEX_PREVIEW_MEDIA_INSTRUCTIONS =
  'Use only preview_erasure via functions.exec. Its nested result is a string: metadata JSON and image data URLs on separate lines. Await tools.preview_erasure(args), split the result on newline, call image(line, "original") for each line starting with "data:image/", and text(line) for other nonempty lines. Never text-print or manually decode the media string. Store the result if you need to emit it again. Submit exactly one proposal and emit and SEE every returned preview image before finalizing. Do not retry after a tool failure or invent a revision or hash. Return only the requested JSON final answer.';

export class CodexAppServerPreviewHost {
  private readonly registrations = new Map<string, Registration>();

  register(
    threadId: string,
    tool: CodexAppServerPreviewTool,
    signal?: AbortSignal,
  ): () => void {
    if (this.registrations.has(threadId))
      throw new Error("Preview tool is already registered.");
    const registration: Registration = {
      tool,
      signal,
      active: true,
      calls: new Map(),
    };
    this.registrations.set(threadId, registration);
    return () => {
      registration.active = false;
      this.registrations.delete(threadId);
    };
  }

  dispatch(message: JsonRecord, reply: (result: JsonRecord) => void): boolean {
    if (message.method !== "item/tool/call") return false;
    const params = asRecord(message.params);
    const registration = this.registrations.get(String(params?.threadId));
    if (
      !registration ||
      params?.tool !== CODEX_PREVIEW_TOOL_NAME ||
      params.namespace != null ||
      typeof params.callId !== "string"
    )
      return false;
    const result = this.invoke(registration, params.callId, params.arguments);
    void result.then((value) => {
      if (registration.active) reply({ id: message.id, result: value });
    });
    return true;
  }

  clear(): void {
    for (const registration of this.registrations.values())
      registration.active = false;
    this.registrations.clear();
  }

  private invoke(
    registration: Registration,
    callId: string,
    input: unknown,
  ): Promise<ToolResult> {
    if (registration.signal?.aborted)
      return Promise.resolve(toolFailure("Preview cancelled."));
    const serialized = JSON.stringify(input);
    const previous = registration.calls.get(callId);
    if (previous)
      return previous.input === serialized
        ? previous.result
        : Promise.resolve(
            toolFailure("Call ID was reused with different input."),
          );
    if (registration.calls.size >= 1)
      return Promise.resolve(
        toolFailure(
          "Single-preview budget exhausted. Report the first result; do not retry or invent an artifact reference.",
        ),
      );
    const result = Promise.resolve()
      .then(() => {
        registration.signal?.throwIfAborted();
        return registration.tool.execute(input);
      })
      .catch((error: unknown) =>
        toolFailure(error instanceof Error ? error.message : String(error)),
      );
    registration.calls.set(callId, { input: serialized, result });
    return result;
  }
}

function toolFailure(text: string): ToolResult {
  return { success: false, contentItems: [{ type: "inputText", text }] };
}
