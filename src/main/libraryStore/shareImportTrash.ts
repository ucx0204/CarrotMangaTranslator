import {
  recoverLegacyShareImportTrash as recoverLegacyShareImportTrashImpl,
  type LegacyShareTrashRecoveryResult,
} from "./legacyShareTrashRecovery";

// Legacy share-import trash is no longer part of the production commit path.
// Keep this compatibility module only as a startup-recovery adapter.
export async function recoverLegacyShareImportTrash(): Promise<LegacyShareTrashRecoveryResult> {
  return recoverLegacyShareImportTrashImpl();
}

export type { LegacyShareTrashRecoveryResult };
