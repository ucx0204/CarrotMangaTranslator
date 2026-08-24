import type {
  ImportCreateSelection,
  ImportTarget,
} from "../../../shared/importTypes";
import type { LinkedWorkspaceImportOptions } from "../../../shared/linkedWorkspaceTypes";

export type TranslateSourceMode = "images" | "folder" | "zip" | "web";

export type ImportModalSubmit = {
  target: ImportTarget;
  selections: ImportCreateSelection[];
  linkedWorkspace?: LinkedWorkspaceImportOptions;
};
