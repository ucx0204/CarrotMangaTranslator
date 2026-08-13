import type {
  ImportCreateSelection,
  ImportTarget,
} from "../../../shared/importTypes";

export type TranslateSourceMode = "images" | "folder" | "zip" | "web";

export type ImportModalSubmit = {
  target: ImportTarget;
  selections: ImportCreateSelection[];
};
