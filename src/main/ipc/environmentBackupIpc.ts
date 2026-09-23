import { environmentBackupIpcContracts as contracts } from "../../shared/ipcEnvironmentBackupContracts";
import { createEnvironmentBackupService } from "../environmentBackup/runtime";
import type { IpcContext } from "./context";
import { trustedHandleContract } from "./trustedIpc";

export function registerEnvironmentBackupIpc(context: IpcContext): void {
  const service = createEnvironmentBackupService(context);
  trustedHandleContract(
    context,
    contracts.discardEnvironmentBackup,
    (_event, id) => service.discard(id),
  );
  trustedHandleContract(context, contracts.getEnvironmentRestoreReceipt, () =>
    service.receipt(),
  );
  trustedHandleContract(context, contracts.getEnvironmentBackupStatus, () =>
    service.status(),
  );
  trustedHandleContract(
    context,
    contracts.exportEnvironmentBackup,
    (_event, ui) => service.export(ui),
  );
  trustedHandleContract(context, contracts.previewEnvironmentBackup, () =>
    service.preview(),
  );
  trustedHandleContract(
    context,
    contracts.restoreEnvironmentBackup,
    (_event, id, ui) => service.restore(id, ui),
  );
  trustedHandleContract(
    context,
    contracts.recoverEnvironmentBackup,
    (_event, id, ui) => service.recover(id, ui),
  );
}
