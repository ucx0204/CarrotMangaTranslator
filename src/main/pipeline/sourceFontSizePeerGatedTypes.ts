import type { ComponentAffinityMeasurement } from "./sourceFontSizeComponentAffinity";
import type { SourceFontSizeEstimate } from "./sourceFontSizeGeometryTypes";
import type { MajorPitchMeasurement } from "./sourceFontSizeMajorPitch";

export type SourceFontSizeHypothesisTrial = Readonly<{
  component: ComponentAffinityMeasurement | null;
  lineCount: number;
  majorPitch: MajorPitchMeasurement | null;
  projection: SourceFontSizeEstimate | null;
}>;

export type SourceFontSizeHypothesisCandidate = Readonly<{
  baseline: SourceFontSizeEstimate;
  bboxCross: number;
  formulaLineCount: number;
  glyphCount: number;
  trialAt: (lineCount: number) => SourceFontSizeHypothesisTrial | null;
}>;
