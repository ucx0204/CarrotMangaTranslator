import type {
  ImportCreateSelection,
  ImportTarget,
} from "../../../shared/importTypes";

export type TranslateSourceMode = "images" | "folder" | "zip";

export type ImportModalSubmit = {
  target: ImportTarget;
  selections: ImportCreateSelection[];
};
