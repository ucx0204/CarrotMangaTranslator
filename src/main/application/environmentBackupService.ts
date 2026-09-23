import type {
  BackupPreview,
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
    kind: "environment-backup" | "environment-restore",
    action: (
      signal: AbortSignal,
      progress: (current: number, total: number) => void,
      seal: () => void,
    ) => Promise<T>,
  ) => Promise<T>;
  export: (
    target: string,
    ui: BackupUiPreferences,
    signal: AbortSignal,
    progress: (current: number, total: number) => void,
  ) => Promise<void>;
  preview: (
    archive: string,
    signal: AbortSignal,
    progress: (current: number, total: number) => void,
  ) => Promise<BackupPreview>;
  prepareRecovery: (id: string, signal: AbortSignal) => Promise<string>;
  schedule: (id: string, ui: BackupUiPreferences) => Promise<void>;
  restart: () => void;
};

export class EnvironmentBackupService {
  private readonly previews = new Set<string>();
  constructor(private readonly ports: EnvironmentBackupPorts) {}
  receipt(): Promise<BackupStatus["restored"]> {
    return this.ports.receipt();
  }
  status(): Promise<BackupStatus> {
    return this.ports.status();
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
    if (this.previews.delete(id)) await this.ports.discard(id);
    return null;
  }
  async preview(): Promise<BackupPreview | null> {
    const archive = await this.ports.pickImport();
    if (!archive) return null;
    for (const id of this.previews) await this.discard(id);
    const preview = await this.ports.exclusive(
      "environment-restore",
      (signal, progress) => this.ports.preview(archive, signal, progress),
    );
    this.previews.add(preview.id);
    return preview;
  }
  async restore(id: string, ui: BackupUiPreferences): Promise<null> {
    if (!this.previews.has(id))
      throw new Error("Select and validate the backup again before restoring.");
    await this.apply(id, ui, false);
    this.previews.delete(id);
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
        this.ports.restart();
      },
    );
  }
}
