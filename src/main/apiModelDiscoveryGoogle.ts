import {
  buildVertexOpenAiBaseUrl,
  GOOGLE_AI_STUDIO_BASE_URL,
  type ApiModelDiscoveryRequest,
  type ApiModelDiscoveryResult,
  type ApiModelOption,
} from "../shared/apiProviderPresets";
import {
  bearerHeaders,
  discoveryResult,
  type FetchLike,
  GOOGLE_PROBE_CONCURRENCY,
  type JsonRecord,
  mapWithConcurrency,
  MAX_GOOGLE_PROBE_CANDIDATES,
  modelOption,
  readArray,
  readRecord,
  readString,
  readStringArray,
  recordOrEmpty,
  requireApiKeys,
} from "./apiModelDiscoveryCommon";
import { fetchJsonUsingParsedKeys } from "./apiModelDiscoveryHttp";

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const MAX_MODEL_LIST_PAGES = 20;
const MAX_PROBE_KEYS = 3;

export async function discoverGoogleAiStudioModels(
  request: ApiModelDiscoveryRequest,
  fetchImpl: FetchLike,
): Promise<ApiModelDiscoveryResult> {
  const keys = requireApiKeys(request.apiKey, "Google AI Studio");
  const entries = await listGoogleAiStudioModels(keys, fetchImpl);
  const compatibleIds = await listGoogleAiStudioOpenAiModelIds(keys, fetchImpl);
  const candidates = entries
    .filter(
      (entry) =>
        isGoogleGenerateContentCandidate(entry) &&
        compatibleIds.has(readGoogleModelId(entry)),
    )
    .slice(0, MAX_GOOGLE_PROBE_CANDIDATES);
  const probeKeys = keys.slice(0, MAX_PROBE_KEYS);
  const verified = await mapWithConcurrency(
    candidates,
    GOOGLE_PROBE_CONCURRENCY,
    async (entry) =>
      verifyAiStudioCandidate(entry, probeKeys.slice(), fetchImpl),
  );
  const models = verified.filter((model): model is ApiModelOption => !!model);
  return discoveryResult(
    "google-ai-studio",
    models,
    candidates.length,
    candidates.length - models.length,
  );
}

export async function discoverGoogleVertexModels(
  request: ApiModelDiscoveryRequest,
  fetchImpl: FetchLike,
): Promise<ApiModelDiscoveryResult> {
  const keys = requireApiKeys(request.apiKey, "Google Vertex AI");
  const project = request.vertexProject?.trim() ?? "";
  const location = request.vertexLocation?.trim().toLowerCase() || "global";
  const baseUrl = buildVertexOpenAiBaseUrl(project, location);
  if (!baseUrl) {
    throw new Error("Vertex 프로젝트 ID와 리전을 확인해 주세요.");
  }
  const host = vertexHost(location);
  const entries = await listVertexPublisherModels(host, keys, fetchImpl);
  const candidates = entries
    .map(toVertexCandidate)
    .filter((candidate): candidate is VertexCandidate => !!candidate)
    .slice(0, MAX_GOOGLE_PROBE_CANDIDATES);
  const probeKeys = keys.slice(0, MAX_PROBE_KEYS);
  const verified = await mapWithConcurrency(
    candidates,
    GOOGLE_PROBE_CONCURRENCY,
    async (candidate) =>
      verifyVertexCandidate(
        candidate,
        host,
        project,
        location,
        baseUrl,
        probeKeys.slice(),
        fetchImpl,
      ),
  );
  const models = verified.filter((model): model is ApiModelOption => !!model);
  return discoveryResult(
    "google-vertex",
    models,
    candidates.length,
    candidates.length - models.length,
  );
}

async function verifyAiStudioCandidate(
  entry: JsonRecord,
  keys: string[],
  fetchImpl: FetchLike,
): Promise<ApiModelOption | null> {
  const name = readString(entry.name);
  if (!name) {
    return null;
  }
  const supported = await probeGoogleImageTokens(
    `https://generativelanguage.googleapis.com/v1beta/${name}:countTokens`,
    keys,
    fetchImpl,
  );
  if (!supported) {
    return null;
  }
  const id = name.replace(/^models\//, "");
  return modelOption(
    id,
    readString(entry.displayName) ?? id,
    GOOGLE_AI_STUDIO_BASE_URL,
  );
}

async function verifyVertexCandidate(
  candidate: VertexCandidate,
  host: string,
  project: string,
  location: string,
  baseUrl: string,
  keys: string[],
  fetchImpl: FetchLike,
): Promise<ApiModelOption | null> {
  const url = `https://${host}/v1/projects/${project}/locations/${location}/publishers/google/models/${candidate.resourceId}:countTokens`;
  const supported = await probeGoogleImageTokens(url, keys, fetchImpl, true);
  return supported
    ? modelOption(candidate.openAiId, candidate.label, baseUrl)
    : null;
}

async function listGoogleAiStudioModels(
  keys: string[],
  fetchImpl: FetchLike,
): Promise<JsonRecord[]> {
  const entries: JsonRecord[] = [];
  const seenPageTokens = new Set<string>();
  let pageToken = "";
  let pageCount = 0;
  do {
    assertPageLimit(++pageCount);
    const query = new URLSearchParams({ pageSize: "1000" });
    if (pageToken) {
      query.set("pageToken", pageToken);
    }
    const payload = await fetchJsonUsingParsedKeys(
      `https://generativelanguage.googleapis.com/v1beta/models?${query}`,
      keys,
      (key) => ({ "x-goog-api-key": key }),
      fetchImpl,
    );
    entries.push(...readArray(payload.models).flatMap(recordOrEmpty));
    pageToken = readNextPageToken(payload, seenPageTokens);
  } while (pageToken);
  return entries;
}

async function listGoogleAiStudioOpenAiModelIds(
  keys: string[],
  fetchImpl: FetchLike,
): Promise<Set<string>> {
  const payload = await fetchJsonUsingParsedKeys(
    "https://generativelanguage.googleapis.com/v1beta/openai/models",
    keys,
    bearerHeaders,
    fetchImpl,
  );
  return new Set(
    readArray(payload.data)
      .map((entry) => normalizeGoogleModelId(readString(readRecord(entry)?.id)))
      .filter((id): id is string => Boolean(id)),
  );
}

async function listVertexPublisherModels(
  host: string,
  keys: string[],
  fetchImpl: FetchLike,
): Promise<JsonRecord[]> {
  const entries: JsonRecord[] = [];
  const seenPageTokens = new Set<string>();
  let pageToken = "";
  let pageCount = 0;
  do {
    assertPageLimit(++pageCount);
    const query = new URLSearchParams({
      pageSize: "100",
      view: "PUBLISHER_MODEL_VIEW_BASIC",
    });
    if (pageToken) {
      query.set("pageToken", pageToken);
    }
    const payload = await fetchJsonUsingParsedKeys(
      `https://${host}/v1beta1/publishers/google/models?${query}`,
      keys,
      bearerHeaders,
      fetchImpl,
    );
    entries.push(...readArray(payload.publisherModels).flatMap(recordOrEmpty));
    pageToken = readNextPageToken(payload, seenPageTokens);
  } while (pageToken);
  return entries;
}

function isGoogleGenerateContentCandidate(entry: JsonRecord): boolean {
  const name = readGoogleModelId(entry);
  return (
    /^gemini-/i.test(name) &&
    isTextOutputGeminiId(name) &&
    readStringArray(entry.supportedGenerationMethods).includes(
      "generateContent",
    )
  );
}

type VertexCandidate = {
  resourceId: string;
  openAiId: string;
  label: string;
};

function toVertexCandidate(entry: JsonRecord): VertexCandidate | null {
  const name = readString(entry.name) ?? "";
  const resourceId = name.split("/models/")[1] ?? "";
  if (!/^gemini-/i.test(resourceId) || !isTextOutputGeminiId(resourceId)) {
    return null;
  }
  const openAiModelId = resourceId.replace("@", "-");
  return {
    resourceId,
    openAiId: `google/${openAiModelId}`,
    label: readString(entry.displayName) ?? openAiModelId,
  };
}

function readGoogleModelId(entry: JsonRecord): string {
  return normalizeGoogleModelId(readString(entry.name)) ?? "";
}

function normalizeGoogleModelId(modelId: string | null): string | null {
  return modelId?.replace(/^models\//, "") ?? null;
}

function isTextOutputGeminiId(modelId: string): boolean {
  return !/(?:^|-)(?:image|imagen|embedding|veo|tts)(?:-|$)/i.test(modelId);
}

function assertPageLimit(pageCount: number): void {
  if (pageCount > MAX_MODEL_LIST_PAGES) {
    throw new Error("모델 목록 페이지 수가 안전 제한을 초과했습니다.");
  }
}

function readNextPageToken(
  payload: JsonRecord,
  seenPageTokens: Set<string>,
): string {
  const nextPageToken = readString(payload.nextPageToken) ?? "";
  if (!nextPageToken) return "";
  if (seenPageTokens.has(nextPageToken)) {
    throw new Error("모델 목록이 같은 페이지 토큰을 반복했습니다.");
  }
  seenPageTokens.add(nextPageToken);
  return nextPageToken;
}

function vertexHost(location: string): string {
  return location === "global"
    ? "aiplatform.googleapis.com"
    : `${location}-aiplatform.googleapis.com`;
}

async function probeGoogleImageTokens(
  url: string,
  keys: string[],
  fetchImpl: FetchLike,
  bearer = false,
): Promise<boolean> {
  try {
    const payload = await fetchJsonUsingParsedKeys(
      url,
      keys,
      (key) => googleProbeHeaders(key, bearer),
      fetchImpl,
      false,
      { method: "POST", body: googleProbeBody() },
    );
    return hasImageTokenDetails(payload);
  } catch (_error) {
    // A transport, quota, or auth error is not proof of image support.
    return false;
  }
}

function googleProbeHeaders(
  key: string,
  bearer: boolean,
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(bearer ? bearerHeaders(key) : { "x-goog-api-key": key }),
  };
}

function googleProbeBody(): string {
  return JSON.stringify({
    contents: [
      {
        role: "user",
        parts: [
          { text: "." },
          {
            inlineData: {
              mimeType: "image/png",
              data: TINY_PNG_BASE64,
            },
          },
        ],
      },
    ],
  });
}

function hasImageTokenDetails(payload: JsonRecord): boolean {
  return readArray(payload.promptTokensDetails).some((detail) => {
    const record = readRecord(detail);
    return (
      readString(record?.modality)?.toUpperCase() === "IMAGE" &&
      Number(record?.tokenCount) > 0
    );
  });
}
