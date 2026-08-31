import { dialog } from "electron";
import { readFile, stat, writeFile } from "node:fs/promises";
import { conditionalBatchIpcContracts } from "../../shared/ipcConditionalBatchContracts";
import { MAX_CONDITIONAL_BATCH_FILE_BYTES } from "../../shared/conditionalBatchRules";
import { ConditionalBatchSchemeStore } from "../conditionalBatchSchemeStore";
import { tMain } from "../i18n";
import {
  getRecentDialogDirectory,
  getRecentDialogFileDefaultPath,
  recentDialogPathKeys,
  rememberRecentDialogFile,
} from "../recentDialogPaths";
import type { IpcContext } from "./context";
import { registeredRendererHandleContract } from "./trustedIpc";

export function registerConditionalBatchIpc(context: IpcContext): void {
  const store = new ConditionalBatchSchemeStore(context.appPaths.dataRoot);
  registeredRendererHandleContract(
    context,
    conditionalBatchIpcContracts.listConditionalBatchSchemes,
    () => store.list(),
  );
  registeredRendererHandleContract(
    context,
    conditionalBatchIpcContracts.saveConditionalBatchScheme,
    (_event, input) => store.save(input),
  );
  registeredRendererHandleContract(
    context,
    conditionalBatchIpcContracts.deleteConditionalBatchScheme,
    (_event, id) => store.delete(id),
  );
  registeredRendererHandleContract(
    context,
    conditionalBatchIpcContracts.saveConditionalBatchSequence,
    (_event, sequence) => store.saveSequence(sequence),
  );
  registeredRendererHandleContract(
    context,
    conditionalBatchIpcContracts.deleteConditionalBatchSequence,
    (_event, id) => store.deleteSequence(id),
  );
  registeredRendererHandleContract(
    context,
    conditionalBatchIpcContracts.exportConditionalBatchYaml,
    (_event, input) => store.exportYaml(input.ids),
  );
  registeredRendererHandleContract(
    context,
    conditionalBatchIpcContracts.importConditionalBatchYaml,
    (_event, input) => store.importYaml(input.yaml, input.conflictPolicy),
  );
  registerConditionalBatchYamlDialogs(context);
}

function registerConditionalBatchYamlDialogs(context: IpcContext): void {
  registeredRendererHandleContract(
    context,
    conditionalBatchIpcContracts.openConditionalBatchYamlFile,
    () => openConditionalBatchYamlFile(context),
  );
  registeredRendererHandleContract(
    context,
    conditionalBatchIpcContracts.saveConditionalBatchYamlFile,
    (_event, input) => saveConditionalBatchYamlFile(context, input),
  );
}

async function openConditionalBatchYamlFile(context: IpcContext) {
  const window = context.getMainWindow();
  const options = {
    title: tMain("dialogs.openConditionalBatchYaml"),
    defaultPath: getRecentDialogDirectory(
      context.appPaths.dataRoot,
      recentDialogPathKeys.conditionalBatchYaml,
    ),
    properties: ["openFile"],
    filters: [yamlDialogFilter()],
  } satisfies Electron.OpenDialogOptions;
  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);
  const filePath = result.filePaths[0];
  if (result.canceled || !filePath) return null;
  const fileStat = await stat(filePath);
  if (fileStat.size > MAX_CONDITIONAL_BATCH_FILE_BYTES) {
    throw new Error(tMain("dialogs.conditionalBatchYamlTooLarge"));
  }
  const yaml = await readFile(filePath, "utf8");
  rememberConditionalBatchYamlPath(context, filePath);
  return { path: filePath, yaml };
}

async function saveConditionalBatchYamlFile(
  context: IpcContext,
  input: { defaultName: string; yaml: string },
) {
  const window = context.getMainWindow();
  const options = {
    title: tMain("dialogs.saveConditionalBatchYaml"),
    defaultPath: getRecentDialogFileDefaultPath(
      context.appPaths.dataRoot,
      recentDialogPathKeys.conditionalBatchYaml,
      sanitizeYamlFileName(input.defaultName),
    ),
    filters: [yamlDialogFilter()],
  } satisfies Electron.SaveDialogOptions;
  const result = window
    ? await dialog.showSaveDialog(window, options)
    : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return null;
  const filePath = /\.ya?ml$/iu.test(result.filePath)
    ? result.filePath
    : `${result.filePath}.yaml`;
  await writeFile(filePath, input.yaml, "utf8");
  rememberConditionalBatchYamlPath(context, filePath);
  return { saved: true as const, path: filePath };
}

function yamlDialogFilter(): Electron.FileFilter {
  return {
    name: tMain("dialogs.filters.yaml"),
    extensions: ["yaml", "yml"],
  };
}

function rememberConditionalBatchYamlPath(
  context: IpcContext,
  filePath: string,
): void {
  rememberRecentDialogFile(
    context.appPaths.dataRoot,
    recentDialogPathKeys.conditionalBatchYaml,
    filePath,
  );
}

function sanitizeYamlFileName(name: string): string {
  const base = name
    .replace(/[\\/:*?"<>|]+/gu, "_")
    .replace(/\s+/gu, " ")
    .trim();
  const safe = base || "batch-edit-schemes";
  return /\.ya?ml$/iu.test(safe) ? safe : `${safe}.yaml`;
}
