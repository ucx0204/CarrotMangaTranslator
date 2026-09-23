import {
  backupUiSchema,
  type BackupUiPreferences,
} from "../../shared/environmentBackup";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  openSync,
  fsyncSync,
  closeSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { RESTORE_NAMES } from "./policy";

const journalSchema = z
  .object({
    version: z.literal(1),
    previousUi: backupUiSchema.optional(),
    id: z.string().uuid(),
    phase: z.enum(["install", "rollback"]),
    entries: z
      .array(
        z
          .object({
            name: z.enum(RESTORE_NAMES),
            hadOriginal: z.boolean(),
            hasReplacement: z.boolean(),
          })
          .strict(),
      )
      .length(RESTORE_NAMES.length),
  })
  .strict();
type Journal = z.infer<typeof journalSchema>;
export const backupWorkspace = (root: string): string =>
  join(root, ".environment-backup");
export const stagePath = (root: string, id: string): string =>
  join(backupWorkspace(root), "staging", z.string().uuid().parse(id));
export const recoveryPath = (root: string, id: string): string =>
  join(backupWorkspace(root), "recovery", z.string().uuid().parse(id));

function durableJson(path: string, value: unknown): void {
  const temp = `${path}.writing`;
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  const fd = openSync(temp, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
}
function assertPlain(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink())
      throw new Error("Cannot replace a linked data directory.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
export function createBackupStage(root: string, id: string): string {
  for (const path of [
    root,
    backupWorkspace(root),
    join(backupWorkspace(root), "staging"),
    stagePath(root, id),
  ])
    assertPlain(path);
  const stage = stagePath(root, id);
  mkdirSync(join(backupWorkspace(root), "staging"), { recursive: true });
  mkdirSync(stage);
  return stage;
}
function validateTransaction(root: string, journal: Journal): void {
  if (
    new Set(journal.entries.map((entry) => entry.name)).size !==
    RESTORE_NAMES.length
  )
    throw new Error("Duplicate restore entry.");
  for (const path of [
    root,
    backupWorkspace(root),
    join(backupWorkspace(root), "staging"),
    join(backupWorkspace(root), "recovery"),
    stagePath(root, journal.id),
    recoveryPath(root, journal.id),
  ])
    assertPlain(path);
  for (const entry of journal.entries) {
    assertPlain(join(root, entry.name));
    assertPlain(join(stagePath(root, journal.id), entry.name));
    assertPlain(join(recoveryPath(root, journal.id), entry.name));
  }
}

export function scheduleEnvironmentRestore(
  root: string,
  id: string,
  previousUi: BackupUiPreferences = {},
): void {
  const workspace = backupWorkspace(root);
  if (existsSync(join(workspace, "journal.json")))
    throw new Error("Another restore is awaiting restart.");
  const journal: Journal = {
    version: 1,
    id,
    phase: "install",
    previousUi,
    entries: RESTORE_NAMES.map((name) => ({
      name,
      hadOriginal: existsSync(join(root, name)),
      hasReplacement: existsSync(join(stagePath(root, id), name)),
    })),
  };
  validateTransaction(root, journal);
  mkdirSync(recoveryPath(root, id), { recursive: true });
  durableJson(join(workspace, "journal.json"), journal);
}

function installEntry(
  root: string,
  journal: Journal,
  entry: Journal["entries"][number],
): void {
  const current = join(root, entry.name),
    staged = join(stagePath(root, journal.id), entry.name),
    old = join(recoveryPath(root, journal.id), entry.name);
  if (entry.hadOriginal && !existsSync(old)) renameSync(current, old);
  if (entry.hasReplacement && existsSync(staged)) renameSync(staged, current);
  if (entry.hasReplacement && !existsSync(current))
    throw new Error("Restore replacement is missing.");
}
function rollbackEntry(
  root: string,
  journal: Journal,
  entry: Journal["entries"][number],
): void {
  const current = join(root, entry.name),
    staged = join(stagePath(root, journal.id), entry.name),
    old = join(recoveryPath(root, journal.id), entry.name);
  if (entry.hasReplacement && !existsSync(staged) && existsSync(current))
    renameSync(current, staged);
  if (existsSync(old)) renameSync(old, current);
}

/** Runs under the data-root instance lock, before settings, models or user stores initialize. */
export function recoverEnvironmentRestore(
  root: string,
  step?: (name: string) => void,
): void {
  const journalPath = join(backupWorkspace(root), "journal.json");
  assertPlain(backupWorkspace(root));
  assertPlain(journalPath);
  if (!existsSync(journalPath)) return;
  const journal = journalSchema.parse(
    JSON.parse(readFileSync(journalPath, "utf8")),
  );
  validateTransaction(root, journal);
  if (journal.phase === "install") {
    try {
      for (const entry of journal.entries) {
        installEntry(root, journal, entry);
        step?.(entry.name);
      }
      durableJson(join(recoveryPath(root, journal.id), "recovery.json"), {
        id: journal.id,
        createdAt: new Date().toISOString(),
        ui: journal.previousUi ?? {},
      });
      unlinkSync(journalPath);
      return;
    } catch (error) {
      journal.phase = "rollback";
      durableJson(journalPath, journal);
      rollbackTransaction(root, journal);
      throw new Error(
        "Restore failed; the previous environment was recovered.",
        { cause: error },
      );
    }
  }
  rollbackTransaction(root, journal);
}
function rollbackTransaction(root: string, journal: Journal): void {
  for (const entry of [...journal.entries].reverse())
    rollbackEntry(root, journal, entry);
  unlinkSync(join(backupWorkspace(root), "journal.json"));
}
