import {
  NVIDIA_NIM_BASE_URL,
  OLLAMA_BASE_URL,
  OPENROUTER_BASE_URL,
  type ApiModelDiscoveryRequest,
  type ApiModelDiscoveryResult,
} from "../shared/apiProviderPresets";
import {
  bearerHeaders,
  discoveryResult,
  type FetchLike,
  isExpired,
  modelOption,
  readArray,
  readRecord,
  readString,
  readStringArray,
} from "./apiModelDiscoveryCommon";
import { fetchJsonWithKeys, fetchText } from "./apiModelDiscoveryHttp";

const NVIDIA_IMAGE_TO_TEXT_CATALOG_URL =
  "https://build.nvidia.com/models?filters=nimType%3Anim_type_preview%2Cusecase%3Ausecase_image_to_text&orderBy=weightPopular%3ADESC";

export async function discoverNvidiaNimModels(
  request: ApiModelDiscoveryRequest,
  fetchImpl: FetchLike,
): Promise<ApiModelDiscoveryResult> {
  const payload = await fetchJsonWithKeys(
    `${NVIDIA_NIM_BASE_URL}/models`,
    request.apiKey,
    bearerHeaders,
    fetchImpl,
    true,
  );
  const liveIds = readArray(payload.data)
    .map((entry) => readString(readRecord(entry)?.id))
    .filter((id): id is string => Boolean(id));
  const catalogIds = await readNvidiaImageToTextCatalog(fetchImpl);
  const models = liveIds
    .filter((id) => catalogIds.has(id))
    .map((id) => modelOption(id, id, NVIDIA_NIM_BASE_URL));
  return discoveryResult(
    "nvidia-nim",
    models,
    catalogIds.size,
    Math.max(0, catalogIds.size - models.length),
  );
}

export async function discoverOpenRouterModels(
  request: ApiModelDiscoveryRequest,
  fetchImpl: FetchLike,
): Promise<ApiModelDiscoveryResult> {
  const payload = await fetchJsonWithKeys(
    `${OPENROUTER_BASE_URL}/models?input_modalities=image&output_modalities=text`,
    request.apiKey,
    bearerHeaders,
    fetchImpl,
    true,
  );
  const entries = readArray(payload.data);
  const models = entries.flatMap(toOpenRouterImageModel);
  return discoveryResult(
    "openrouter",
    models,
    entries.length,
    entries.length - models.length,
  );
}

/**
 * Ollama는 로컬 OpenAI 호환 엔드포인트(`/v1/models`)를 제공한다. API 키 없이
 * 동작하며, 응답은 OpenAI와 동일한 `{ data: [{ id }] }` 형태. `/v1/models`는
 * 모달리티(비전 여부)를 노출하지 않아 비전 필터링은 하지 않고 전체 모델을
 * 반환 — 사용자가 llava/minicpm-v 등 비전 모델을 직접 선택한다.
 */
export async function discoverOllamaModels(
  request: ApiModelDiscoveryRequest,
  fetchImpl: FetchLike,
): Promise<ApiModelDiscoveryResult> {
  const payload = await fetchJsonWithKeys(
    `${OLLAMA_BASE_URL}/models`,
    request.apiKey,
    bearerHeaders,
    fetchImpl,
    true,
  );
  const liveIds = readArray(payload.data)
    .map((entry) => readString(readRecord(entry)?.id))
    .filter((id): id is string => Boolean(id));
  const models = liveIds.map((id) => modelOption(id, id, OLLAMA_BASE_URL));
  return discoveryResult("ollama", models, liveIds.length, 0);
}

async function readNvidiaImageToTextCatalog(
  fetchImpl: FetchLike,
): Promise<Set<string>> {
  try {
    return parseNvidiaCatalog(
      await fetchText(NVIDIA_IMAGE_TO_TEXT_CATALOG_URL, fetchImpl),
    );
  } catch (error) {
    throw new Error(
      "NVIDIA Image-to-Text 카탈로그를 확인하지 못해 안전하게 모델 검색을 중단했습니다.",
      { cause: error },
    );
  }
}

function parseNvidiaCatalog(html: string): Set<string> {
  const cardPattern =
    /<a\b(?=[^>]*data-nvtrack-nav-object="artifact-card")[^>]*href="\/([^"/]+)\/([^"/]+)"/g;
  const models = new Set<string>();
  for (const match of html.matchAll(cardPattern)) {
    models.add(normalizeNvidiaCatalogId(match[1], match[2]));
  }
  if (models.size === 0) {
    throw new Error(
      "NVIDIA Image-to-Text 카탈로그에서 모델을 찾지 못했습니다.",
    );
  }
  return models;
}

function normalizeNvidiaCatalogId(publisher: string, rawSlug: string): string {
  const googlePrefix = "google-";
  const slug =
    publisher === "google" && rawSlug.startsWith(googlePrefix)
      ? rawSlug.slice(googlePrefix.length)
      : rawSlug;
  return `${publisher}/${slug}`;
}

function toOpenRouterImageModel(entry: unknown) {
  const record = readRecord(entry);
  const architecture = readRecord(record?.architecture);
  const inputModalities = readStringArray(architecture?.input_modalities);
  const outputModalities = readStringArray(architecture?.output_modalities);
  const id = readString(record?.id);
  const expirationDate = readString(record?.expiration_date);
  if (
    !id ||
    isExpired(expirationDate) ||
    !inputModalities.includes("image") ||
    !outputModalities.includes("text")
  ) {
    return [];
  }
  return [modelOption(id, readString(record?.name) ?? id, OPENROUTER_BASE_URL)];
}
