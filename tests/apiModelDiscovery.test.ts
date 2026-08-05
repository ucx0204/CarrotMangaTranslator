import { describe, expect, it, vi } from "vitest";
import { discoverApiModels } from "../src/main/apiModelDiscovery";
import {
  buildVertexOpenAiBaseUrl,
  GOOGLE_AI_STUDIO_BASE_URL,
  inferApiProviderPreset,
  NVIDIA_NIM_BASE_URL,
  OLLAMA_BASE_URL,
  OPENROUTER_BASE_URL,
} from "../src/shared/apiProviderPresets";

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("API provider presets", () => {
  it("builds and infers all supported provider base URLs", () => {
    const vertex = buildVertexOpenAiBaseUrl("sample-project", "us-central1");

    expect(vertex).toBe(
      "https://us-central1-aiplatform.googleapis.com/v1/projects/sample-project/locations/us-central1/endpoints/openapi",
    );
    expect(inferApiProviderPreset(NVIDIA_NIM_BASE_URL)).toBe("nvidia-nim");
    expect(inferApiProviderPreset(GOOGLE_AI_STUDIO_BASE_URL)).toBe(
      "google-ai-studio",
    );
    expect(inferApiProviderPreset(vertex ?? "")).toBe("google-vertex");
    expect(inferApiProviderPreset(OPENROUTER_BASE_URL)).toBe("openrouter");
    expect(inferApiProviderPreset(OLLAMA_BASE_URL)).toBe("ollama");
    expect(inferApiProviderPreset("http://192.168.1.5:11434/v1")).toBe(
      "ollama",
    );
    expect(inferApiProviderPreset("https://my-api.example/v1")).toBe("custom");
  });
});

describe("API image-model discovery", () => {
  it("intersects NVIDIA's Image-to-Text catalog with the live NIM list", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === `${NVIDIA_NIM_BASE_URL}/models`) {
        return jsonResponse({
          data: [
            { id: "meta/llama-3.2-11b-vision-instruct" },
            { id: "meta/text-only-model" },
          ],
        });
      }
      return new Response(
        '<a href="/meta/llama-3.2-11b-vision-instruct" data-nvtrack-nav-object="artifact-card"></a>' +
          '<a data-nvtrack-nav-object="artifact-card" href="/google/google-paligemma"></a>',
        { status: 200 },
      );
    });

    const result = await discoverApiModels(
      { provider: "nvidia-nim", apiKey: "nv-key" },
      fetchMock as typeof fetch,
    );

    expect(result.models).toEqual([
      {
        id: "meta/llama-3.2-11b-vision-instruct",
        label: "meta/llama-3.2-11b-vision-instruct",
        baseUrl: NVIDIA_NIM_BASE_URL,
      },
    ]);
    expect(result.checkedCount).toBe(2);
    expect(result.unverifiedCount).toBe(1);
  });

  it("fails closed when NVIDIA's Image-to-Text catalog cannot be verified", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === `${NVIDIA_NIM_BASE_URL}/models`) {
        return jsonResponse({
          data: [{ id: "meta/llama-3.2-11b-vision-instruct" }],
        });
      }
      return new Response("unavailable", {
        status: 503,
        statusText: "Unavailable",
      });
    });

    await expect(
      discoverApiModels(
        { provider: "nvidia-nim", apiKey: "nv-key" },
        fetchMock as typeof fetch,
      ),
    ).rejects.toThrow("안전하게 모델 검색을 중단");
  });

  it("keeps only non-expired OpenRouter models declaring image input and text output", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toContain("/models?");
      return jsonResponse({
        data: [
          {
            id: "vendor/vision",
            name: "Vision",
            architecture: {
              input_modalities: ["text", "image"],
              output_modalities: ["text"],
            },
          },
          {
            id: "vendor/text-only",
            architecture: {
              input_modalities: ["text"],
              output_modalities: ["text"],
            },
          },
          {
            id: "vendor/expired",
            expiration_date: "2000-01-01T00:00:00Z",
            architecture: {
              input_modalities: ["image"],
              output_modalities: ["text"],
            },
          },
        ],
      });
    });

    const result = await discoverApiModels(
      { provider: "openrouter", apiKey: "or-key" },
      fetchMock as typeof fetch,
    );

    expect(result.models.map((model) => model.id)).toEqual(["vendor/vision"]);
    expect(result.unverifiedCount).toBe(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "input_modalities=image&output_modalities=text",
    );
  });

  it("probes Google AI Studio candidates with an actual image and fails closed", async () => {
    const bodies: string[] = [];
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/v1beta/models?")) {
          return jsonResponse({
            models: [
              {
                name: "models/gemini-vision-ok",
                displayName: "Vision OK",
                supportedGenerationMethods: ["generateContent"],
              },
              {
                name: "models/gemini-text-only",
                supportedGenerationMethods: ["generateContent"],
              },
              {
                name: "models/embedding-001",
                supportedGenerationMethods: ["embedContent"],
              },
            ],
          });
        }
        if (url.endsWith("/v1beta/openai/models")) {
          return jsonResponse({
            data: [
              { id: "models/gemini-vision-ok" },
              { id: "models/gemini-text-only" },
            ],
          });
        }
        bodies.push(String(init?.body ?? ""));
        return url.includes("gemini-vision-ok")
          ? jsonResponse({
              promptTokensDetails: [
                { modality: "TEXT", tokenCount: 2 },
                { modality: "IMAGE", tokenCount: 258 },
              ],
            })
          : jsonResponse({
              promptTokensDetails: [{ modality: "TEXT", tokenCount: 1 }],
            });
      },
    );

    const result = await discoverApiModels(
      { provider: "google-ai-studio", apiKey: "google-key" },
      fetchMock as typeof fetch,
    );

    expect(result.models).toEqual([
      {
        id: "gemini-vision-ok",
        label: "Vision OK",
        baseUrl: GOOGLE_AI_STUDIO_BASE_URL,
      },
    ]);
    expect(result.checkedCount).toBe(2);
    expect(result.unverifiedCount).toBe(1);
    expect(bodies).toHaveLength(2);
    expect(bodies.every((body) => body.includes("inlineData"))).toBe(true);
  });

  it("lists and image-probes Vertex models with the project OAuth token", async () => {
    const requestedUrls: string[] = [];
    const authorizationHeaders: string[] = [];
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        requestedUrls.push(url);
        const headers = new Headers(init?.headers);
        authorizationHeaders.push(headers.get("Authorization") ?? "");
        if (url.includes("/v1beta1/publishers/google/models?")) {
          return jsonResponse({
            publisherModels: [
              {
                name: "publishers/google/models/gemini-2.5-flash@001",
                displayName: "Gemini 2.5 Flash",
              },
              { name: "publishers/google/models/text-bison" },
            ],
          });
        }
        return jsonResponse({
          promptTokensDetails: [{ modality: "IMAGE", tokenCount: 1 }],
        });
      },
    );

    const result = await discoverApiModels(
      {
        provider: "google-vertex",
        apiKey: "oauth-token",
        vertexProject: "sample-project",
        vertexLocation: "global",
      },
      fetchMock as typeof fetch,
    );

    expect(result.models).toEqual([
      {
        id: "google/gemini-2.5-flash-001",
        label: "Gemini 2.5 Flash",
        baseUrl:
          "https://aiplatform.googleapis.com/v1/projects/sample-project/locations/global/endpoints/openapi",
      },
    ]);
    expect(requestedUrls).toContain(
      "https://aiplatform.googleapis.com/v1/projects/sample-project/locations/global/publishers/google/models/gemini-2.5-flash@001:countTokens",
    );
    expect(authorizationHeaders).toEqual([
      "Bearer oauth-token",
      "Bearer oauth-token",
    ]);
  });

  it("lists Ollama models from /v1/models without auth", async () => {
    const authorizationHeaders: string[] = [];
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        expect(String(input)).toBe(`${OLLAMA_BASE_URL}/models`);
        const headers = new Headers(init?.headers);
        authorizationHeaders.push(headers.get("Authorization") ?? "");
        return jsonResponse({
          data: [
            { id: "llava:latest" },
            { id: "qwen2.5:7b" },
            { id: "" },
            { notId: "broken-entry" },
          ],
        });
      },
    );

    const result = await discoverApiModels(
      { provider: "ollama", apiKey: "" },
      fetchMock as typeof fetch,
    );

    expect(result.models).toEqual([
      { id: "llava:latest", label: "llava:latest", baseUrl: OLLAMA_BASE_URL },
      { id: "qwen2.5:7b", label: "qwen2.5:7b", baseUrl: OLLAMA_BASE_URL },
    ]);
    expect(result.checkedCount).toBe(2);
    expect(result.unverifiedCount).toBe(0);
    // 빈 키면 Bearer Authorization 헤더를 보내지 않는다.
    expect(authorizationHeaders[0] ?? "").not.toMatch(/^Bearer /);
  });

  it("does not spend additional keys on a non-retryable discovery error", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        { error: { message: "bad request key-two-must-not-be-used" } },
        { status: 400, statusText: "Bad Request" },
      ),
    );

    await expect(
      discoverApiModels(
        { provider: "openrouter", apiKey: "first-key\nsecond-key" },
        fetchMock as typeof fetch,
      ),
    ).rejects.toThrow("400 Bad Request");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("tries the next discovery key for Google's 400 API_KEY_INVALID response", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: { reason: "API_KEY_INVALID", message: "API key not valid" },
          },
          { status: 400, statusText: "Bad Request" },
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              id: "vendor/vision",
              architecture: {
                input_modalities: ["image"],
                output_modalities: ["text"],
              },
            },
          ],
        }),
      );

    const result = await discoverApiModels(
      { provider: "openrouter", apiKey: "invalid-key\nvalid-key" },
      fetchMock,
    );

    expect(result.models.map((model) => model.id)).toEqual(["vendor/vision"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
