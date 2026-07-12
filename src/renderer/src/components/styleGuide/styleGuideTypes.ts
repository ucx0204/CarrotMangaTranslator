import type { WorkStyleGuide } from "../../../../shared/workContextTypes";

export type StyleGuideTab = "glossary" | "characters" | "rules" | "memory";

export type StyleGuideEditorProps = {
  guide: WorkStyleGuide;
  onGuideChange: (guide: WorkStyleGuide) => void;
};
