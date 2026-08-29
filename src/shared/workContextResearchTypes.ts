import type {
  CharacterProfile,
  GlossaryEntry,
  WorkStyleGuide,
} from "./workContextTypes";
import type { ResearchEngine } from "./internetResearchTypes";

export const WORK_CONTEXT_RESEARCH_CANCELLED_ERROR =
  "WORK_CONTEXT_RESEARCH_CANCELLED";

type WorkContextResearchAction = "add" | "update" | "disable";
type WorkContextResearchConfidence = "high" | "medium";

export type ResearchWorkContextRequest = {
  runId: string;
  chapterId: string;
  researchTitle: string;
  engine: ResearchEngine;
  guideSnapshot: WorkStyleGuide;
};

export type WorkContextResearchSource = {
  title: string;
  url: string;
};

type WorkContextResearchEvidence = {
  pageCount: number;
  mentionCount: number;
  sample?: string;
};

type ResearchOperationBase = {
  id: string;
  action: WorkContextResearchAction;
  reason: string;
  confidence: WorkContextResearchConfidence;
  selectedByDefault: boolean;
  evidence: WorkContextResearchEvidence;
  sources: WorkContextResearchSource[];
};

type GlossaryResearchOperation = ResearchOperationBase & {
  entity: "glossary";
  before?: GlossaryEntry;
  after: GlossaryEntry;
};

type CharacterResearchOperation = ResearchOperationBase & {
  entity: "character";
  before?: CharacterProfile;
  after: CharacterProfile;
};

export type WorkContextResearchOperation =
  | GlossaryResearchOperation
  | CharacterResearchOperation;

export type WorkContextResearchProposal = {
  engine: ResearchEngine;
  baseFingerprint: string;
  operations: WorkContextResearchOperation[];
  warnings: string[];
  stats: {
    queryCount: number;
    sourceCount: number;
    tavilyCreditsUsed: number;
    estimatedTokenDelta: number;
    elapsedMs: number;
  };
};
