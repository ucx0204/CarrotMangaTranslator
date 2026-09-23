import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AppPaths } from "./appPaths";
import type { CodexImageGenerationModel } from "../shared/codexSettings";
import { CODEX_IMAGE_GENERATION_MODELS } from "../shared/codexSettings";
import {
  asRecord,
  type CodexAppServerTurnRequest,
  type CodexAppServerTurnResult,
  type JsonRecord,
} from "./codexAppServerProtocol";
import { extractCodexImageTurn } from "./codexAppServerImageResult";
import {
  codexImageResponseError,
  readCodexImageResponse,
} from "./codexImageResponseStream";

const IMAGE_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";

/** Refresh stays with App Server; credentials are read only inside the main process. */
export async function runCodexImageResponse(
  paths: Pick<AppPaths, "dataRoot" | "codexHomeDir">,
  imageGenerationModel: Exclude<CodexImageGenerationModel, "auto">,
  request: CodexAppServerTurnRequest,
): Promise<CodexAppServerTurnResult> {
  if (!CODEX_IMAGE_GENERATION_MODELS.includes(imageGenerationModel))
    throw new Error("지원하지 않는 이미지 생성 모델입니다.");
  const signal = AbortSignal.any([
    AbortSignal.timeout(12 * 60_000),
    ...(request.signal ? [request.signal] : []),
  ]);
  signal.throwIfAborted();
  const auth = await readImageCredentials(paths);
  const response = await fetch(IMAGE_RESPONSES_URL, {
    method: "POST",
    redirect: "error",
    signal,
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      "ChatGPT-Account-Id": auth.accountId,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "OpenAI-Beta": "responses=experimental",
      originator: "carrot_manga_translator",
    },
    body: JSON.stringify(imageResponseRequest(imageGenerationModel, request)),
  });
  if (!response.ok) {
    const text = (await response.text()).slice(0, 16_000);
    let detail: unknown = { message: response.statusText };
    try {
      detail = JSON.parse(text);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      // error-policy-allow: a non-JSON proxy response is represented by HTTP status only.
    }
    throw codexImageResponseError(detail, response.status);
  }
  const completed = await readCodexImageResponse(response);
  signal.throwIfAborted();
  return imageResponseResult(completed, imageGenerationModel);
}

function imageResponseResult(
  completed: JsonRecord,
  imageGenerationModel: string,
): CodexAppServerTurnResult {
  const output = Array.isArray(completed.output) ? completed.output : [];
  const images = output
    .map(asRecord)
    .filter((item) => item?.type === "image_generation_call");
  const image = images[0];
  if (images.length !== 1 || !image)
    throw new Error("Codex 이미지 결과는 한 장이어야 합니다.");
  if (image.status !== "completed" || image.error)
    throw codexImageResponseError(image.error ?? image, 502);
  if (typeof image.result !== "string" || !image.result)
    throw new Error("Codex 이미지 데이터가 없습니다.");
  const id = typeof completed.id === "string" ? completed.id : randomUUID();
  const result = extractCodexImageTurn(
    {
      params: {
        item: {
          ...image,
          type: "imageGeneration",
          failure: image.error,
          revisedPrompt: image.revised_prompt,
        },
      },
    },
    id,
    id,
  );
  return {
    ...result,
    requestedImageGenerationModel: imageGenerationModel,
    tokenUsage: asRecord(completed.usage),
    routedModel: typeof completed.model === "string" ? completed.model : null,
  };
}

function imageResponseRequest(
  model: string,
  request: CodexAppServerTurnRequest,
) {
  return {
    model: request.model,
    reasoning: { effort: request.effort },
    store: false,
    stream: true,
    instructions: request.instructions,
    input: [
      {
        role: "user",
        content: request.input.map((item) =>
          item.type === "text"
            ? { type: "input_text", text: item.text }
            : {
                type: "input_image",
                image_url: item.url,
                detail: item.detail ?? "original",
              },
        ),
      },
    ],
    tools: [
      {
        type: "image_generation",
        model,
        output_format: "png",
        size: request.imageGenerationSize ?? "auto",
        quality: "auto",
        background: "auto",
      },
    ],
    tool_choice: { type: "image_generation" },
    parallel_tool_calls: false,
  };
}

async function readImageCredentials(
  paths: Pick<AppPaths, "dataRoot" | "codexHomeDir">,
) {
  const path = join(
    paths.codexHomeDir ?? join(paths.dataRoot, "codex"),
    "auth.json",
  );
  const auth = asRecord(JSON.parse(await readFile(path, "utf8")));
  const tokens = asRecord(auth?.tokens);
  if (
    auth?.auth_mode !== "chatgpt" ||
    typeof tokens?.access_token !== "string" ||
    !tokens.access_token ||
    typeof tokens.account_id !== "string" ||
    !tokens.account_id
  )
    throw new Error(
      "Codex 로그인 정보를 확인할 수 없습니다. 설정에서 다시 로그인해 주세요.",
    );
  return { accessToken: tokens.access_token, accountId: tokens.account_id };
}
