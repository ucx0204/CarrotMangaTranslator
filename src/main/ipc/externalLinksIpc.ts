import { app, shell } from "electron";
import { APP_RELEASES_URL } from "../../shared/appRelease";
import { externalIpcContracts } from "../../shared/ipcContracts";
import type { IpcContext } from "./context";
import { trustedHandleContract } from "./trustedIpc";

const AMD_HIP_SDK_URL =
  "https://www.amd.com/en/developer/resources/rocm-hub/hip-sdk.html";

export function registerExternalLinksIpc(context: IpcContext): void {
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
}
