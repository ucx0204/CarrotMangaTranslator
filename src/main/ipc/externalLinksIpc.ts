import { app, shell } from "electron";
import { APP_RELEASES_URL } from "../../shared/appRelease";
import { externalIpcContracts } from "../../shared/ipcContracts";
import type { IpcContext } from "./context";
import { trustedHandleContract } from "./trustedIpc";
import { resolveBuildChannel } from "../buildChannel";
import { detectBestGpuInfo } from "../gpuInfo";
import { buildRuntimeCapabilities } from "../runtimeCapabilities";

const AMD_HIP_SDK_URL =
  "https://www.amd.com/en/developer/resources/rocm-hub/hip-sdk.html";
const API_PROVIDER_URLS = {
  "nvidia-nim": "https://build.nvidia.com/settings/api-keys",
  "google-ai-studio": "https://aistudio.google.com/api-keys",
  "google-vertex":
    "https://docs.cloud.google.com/vertex-ai/generative-ai/docs/start/quickstart",
  openrouter: "https://openrouter.ai/keys",
  ollama: "https://ollama.com/library",
} as const;
const VERTEX_SETUP_PAGE_URLS = {
  "project-create": "https://console.cloud.google.com/projectcreate",
  "vertex-ai-api":
    "https://console.cloud.google.com/marketplace/product/google/aiplatform.googleapis.com",
  "service-accounts":
    "https://console.cloud.google.com/iam-admin/serviceaccounts",
} as const;

export function registerExternalLinksIpc(context: IpcContext): void {
  trustedHandleContract(
    context,
    externalIpcContracts.openResearchSource,
    async (_event, rawUrl) => {
      const url = new URL(rawUrl);
      if (url.protocol !== "https:") {
        throw new Error("HTTPS 조사 출처만 열 수 있습니다.");
      }
      await shell.openExternal(url.href);
      return { opened: true, url: url.href };
    },
  );
  trustedHandleContract(
    context,
    externalIpcContracts.openAmdHipSdkDownload,
    async () => {
      await shell.openExternal(AMD_HIP_SDK_URL);
      return { opened: true, url: AMD_HIP_SDK_URL };
    },
  );

  trustedHandleContract(
    context,
    externalIpcContracts.getAppUpdateInfo,
    async () => ({
      currentVersion: app.getVersion(),
      releasesUrl: APP_RELEASES_URL,
      buildChannel: resolveBuildChannel(),
    }),
  );

  trustedHandleContract(
    context,
    externalIpcContracts.getRuntimeCapabilities,
    async () =>
      buildRuntimeCapabilities({
        gpu: await detectBestGpuInfo(),
      }),
  );

  trustedHandleContract(
    context,
    externalIpcContracts.openReleasesPage,
    async () => {
      await shell.openExternal(APP_RELEASES_URL);
      return { opened: true, url: APP_RELEASES_URL };
    },
  );

  trustedHandleContract(
    context,
    externalIpcContracts.openApiProviderPage,
    async (_event, provider) => {
      const url = API_PROVIDER_URLS[provider];
      await shell.openExternal(url);
      return { opened: true, url };
    },
  );

  trustedHandleContract(
    context,
    externalIpcContracts.openVertexSetupPage,
    async (_event, page) => {
      const url = VERTEX_SETUP_PAGE_URLS[page];
      await shell.openExternal(url);
      return { opened: true, url };
    },
  );
}
