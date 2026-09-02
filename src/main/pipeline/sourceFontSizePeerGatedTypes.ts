import type { ComponentAffinityMeasurement } from "./sourceFontSizeComponentAffinity";
import type { SourceFontSizeEstimate } from "./sourceFontSizeGeometryTypes";
import type { MajorPitchMeasurement } from "./sourceFontSizeMajorPitch";
import type { SourceTextDirection } from "../../shared/textTypes";

export type SourceFontSizeHypothesisTrial = Readonly<{
  component: ComponentAffinityMeasurement | null;
  lineCount: number;
  majorPitch: MajorPitchMeasurement | null;
  projection: SourceFontSizeEstimate | null;
}>;

export type SourceFontSizeHypothesisCandidate = Readonly<{
  baseline: SourceFontSizeEstimate;
  bboxCross: number;
  bboxMajor: number;
  direction: SourceTextDirection;
  formulaLineCount: number;
  glyphCount: number;
  trialAt: (lineCount: number) => SourceFontSizeHypothesisTrial | null;
}>;
