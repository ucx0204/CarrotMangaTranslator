import type { Dispatch, SetStateAction } from "react";
import type { ImportCreateSelection } from "../../../shared/importTypes";

export type ImportModalSubmit = {
  target:
    | {
        mode: "new";
        title: string;
      }
    | {
        mode: "existing";
        workId: string;
      };
  selections: ImportCreateSelection[];
};

export type ImportTargetMode = "new" | "existing";

type SelectionSetter = Dispatch<SetStateAction<ImportCreateSelection[]>>;

export function updateSelectionEnabled(
  setSelections: SelectionSetter,
  draftId: string,
  enabled: boolean,
): void {
  setSelections((current) =>
    current.map((item) =>
      item.draftId === draftId ? { ...item, enabled } : item,
    ),
  );
}

export function updateSelectionTitle(
  setSelections: SelectionSetter,
  draftId: string,
  title: string,
): void {
  setSelections((current) =>
    current.map((item) =>
      item.draftId === draftId ? { ...item, title } : item,
    ),
  );
}

export function buildImportSubmitPayload(
  targetMode: ImportTargetMode,
  newWorkTitle: string,
  existingWorkId: string,
  selections: ImportCreateSelection[],
): ImportModalSubmit {
  return {
    target:
      targetMode === "new"
        ? { mode: "new", title: newWorkTitle }
        : { mode: "existing", workId: existingWorkId },
    selections,
  };
}

export function isImportSubmittable(
  targetMode: ImportTargetMode,
  newWorkTitle: string,
  existingWorkId: string,
  selections: ImportCreateSelection[],
): boolean {
  if (targetMode === "new" && !newWorkTitle.trim()) {
    return false;
  }
  if (targetMode === "existing" && !existingWorkId) {
    return false;
  }
  return selections.some(
    (selection) => selection.enabled && selection.title.trim(),
  );
}
