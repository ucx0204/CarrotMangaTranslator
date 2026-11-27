import type {
  BackupPreview,
  BackupProgress,
  BackupStatus,
  BackupUiPreferences,
} from "../../shared/environmentBackup";

export type EnvironmentBackupPorts = {
  receipt: () => Promise<BackupStatus["restored"]>;
  discard: (id: string) => Promise<void>;
  status: () => Promise<BackupStatus>;
  pickExport: () => Promise<string | null>;
  pickImport: () => Promise<string | null>;
  exclusive: <T>(
    kind:
      | "environment-backup"
      | "environment-backup-preview"
      | "environment-restore",
    action: (
      signal: AbortSignal,
      progress: BackupProgress,
      seal: () => void,
    ) => Promise<T>,
  ) => Promise<T>;
  export: (
    target: string,
    ui: BackupUiPreferences,
    signal: AbortSignal,
    progress: BackupProgress,
  ) => Promise<void>;
  preview: (
    archive: string,
    signal: AbortSignal,
    progress: (current: number, total: number) => void,
  ) => Promise<BackupPreview>;
  prepareRecovery: (id: string, signal: AbortSignal) => Promise<string>;
  schedule: (id: string, ui: BackupUiPreferences) => Promise<void>;
  restart: () => void | Promise<void>;
};

export class EnvironmentBackupService {
  private pendingPreview: BackupPreview | null = null;
  private inspection: Promise<BackupPreview | null> | null = null;
  constructor(private readonly ports: EnvironmentBackupPorts) {}
  receipt(): Promise<BackupStatus["restored"]> {
    return this.ports.receipt();
  }
  async status(): Promise<BackupStatus> {
    const status = await this.ports.status();
    return { ...status, pendingPreview: this.pendingPreview };
  }
  async export(ui: BackupUiPreferences): Promise<string | null> {
    const target = await this.ports.pickExport();
    if (!target) return null;
    await this.ports.exclusive("environment-backup", (signal, progress) =>
      this.ports.export(target, ui, signal, progress),
    );
    return target;
  }
  async discard(id: string): Promise<null> {
    if (this.pendingPreview?.id !== id) return null;
    this.pendingPreview = null;
    await this.ports.discard(id);
    return null;
  }
  preview(): Promise<BackupPreview | null> {
    this.inspection ??= this.inspectArchive().finally(() => {
      this.inspection = null;
    });
    return this.inspection;
  }
  private async inspectArchive(): Promise<BackupPreview | null> {
    const archive = await this.ports.pickImport();
    if (!archive) return null;
    return this.ports.exclusive(
      "environment-backup-preview",
      async (signal, progress) => {
        if (this.pendingPreview) await this.discard(this.pendingPreview.id);
        this.pendingPreview = await this.ports.preview(
          archive,
          signal,
          progress,
        );
        return this.pendingPreview;
      },
    );
  }
  async restore(id: string, ui: BackupUiPreferences): Promise<null> {
    if (this.pendingPreview?.id !== id)
      throw new Error("Select and validate the backup again before restoring.");
    await this.apply(id, ui, false);
    this.pendingPreview = null;
    return null;
  }
  async recover(id: string, ui: BackupUiPreferences): Promise<null> {
    await this.apply(id, ui, true);
    return null;
  }
  private async apply(
    id: string,
    ui: BackupUiPreferences,
    recovery: boolean,
  ): Promise<void> {
    await this.ports.exclusive(
      "environment-restore",
      async (signal, _progress, seal) => {
        const prepared = recovery
          ? await this.ports.prepareRecovery(id, signal)
          : id;
        signal.throwIfAborted();
        seal();
        await this.ports.schedule(prepared, ui);
        await this.ports.restart();
      },
    );
  }
}
