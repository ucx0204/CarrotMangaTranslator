export const APP_COMMAND_IDS = [
  "open-translate-options",
  "translate-pending",
  "translate-all",
  "run-current-page-inpainting",
  "cancel-job",
  "toggle-block-chrome",
  "toggle-text-blocks",
  "gather-text",
  "open-translate-source",
  "open-batch",
  "open-share-import",
  "open-share-export",
  "open-settings",
  "open-library-folder",
  "open-log-folder",
  "report-problem",
  "show-shortcuts",
] as const;

export type AppCommandId = (typeof APP_COMMAND_IDS)[number];

export type AppCommand<Id extends AppCommandId = AppCommandId> = {
  id: Id;
  label: string;
  hint?: string;
  keywords?: string;
  paletteVisible: boolean;
  run: () => void;
};

export type AppCommandMap = {
  [Id in AppCommandId]: AppCommand<Id>;
};

export type AppCommandLabels = {
  [Id in AppCommandId]: string;
};

export type AppCommandRegistry = {
  byId: AppCommandMap;
  labels: AppCommandLabels;
  paletteCommands: readonly AppCommand[];
  run: (id: AppCommandId) => void;
};

export function createAppCommandRegistry(
  byId: AppCommandMap,
): AppCommandRegistry {
  const paletteCommands = APP_COMMAND_IDS.map((id) => byId[id]).filter(
    (command) => command.paletteVisible,
  );
  const labels = Object.fromEntries(
    APP_COMMAND_IDS.map((id) => [id, byId[id].label]),
  ) as AppCommandLabels;
  return {
    byId,
    labels,
    paletteCommands,
    run: (id) => byId[id].run(),
  };
}

export function resolveAppCommandLabel(
  labels: AppCommandLabels | undefined,
  id: AppCommandId,
  fallback: string,
): string {
  return labels?.[id] ?? fallback;
}
