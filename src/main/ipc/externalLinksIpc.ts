import { shell } from "electron";
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
}
