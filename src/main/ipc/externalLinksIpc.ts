import { shell } from "electron";
import type { IpcContext } from "./context";
import { trustedHandle } from "./trustedIpc";

const AMD_HIP_SDK_URL =
  "https://www.amd.com/en/developer/resources/rocm-hub/hip-sdk.html";

export function registerExternalLinksIpc(context: IpcContext): void {
  trustedHandle(context, "external:open-amd-hip-sdk", async () => {
    await shell.openExternal(AMD_HIP_SDK_URL);
    return { opened: true, url: AMD_HIP_SDK_URL };
  });
}
