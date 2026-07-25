export interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export type TupleBox = [number, number, number, number];
export type ReviewRole = "body" | "ruby";
export type ReviewSource = "model" | "upstream-fallback" | "singleton";

export interface ReviewLabel {
  group: number;
  role: ReviewRole;
}

export interface ReviewCandidate {
  id: number;
  index: number;
  hint: Record<string, unknown>;
  bbox: Box;
  text: string;
  score: number | null;
  bbox1000: TupleBox;
  paddleGroup: string | null;
  paddleOrder: number | null;
}

export interface UpstreamFragment {
  fragment: string;
  status: string;
  candidateIds: number[];
}

export interface ReviewPlan {
  version: number;
  reviewCase: Record<string, unknown>;
  region: Record<string, unknown>;
  candidates: ReviewCandidate[];
  candidateOrder: number[];
  upstreamFragments: UpstreamFragment[];
  spatialRelations: Record<string, unknown>;
}

export interface ReviewedGroup {
  localGroupIndex: number;
  modelGroup: number | null;
  candidateIds: number[];
  bodyCandidateIds: number[];
  rubyCandidateIds: number[];
  jp: string;
  bbox: Box;
}

export interface ReviewProjection {
  [key: string]: unknown;
  source: ReviewSource;
  labels: ReviewLabel[];
  groups: ReviewedGroup[];
  candidateOrder: number[];
}

export interface ReviewResult extends ReviewProjection {
  status: "reviewed" | "fallback" | "singleton";
  usedFallback: boolean;
  requestSkipped: boolean;
  requestCount: number;
  rawResponse: unknown;
  fallbackError?: Record<string, unknown>;
}

export interface HintAssignment {
  groupId: string;
  orderInGroup: number;
  groupSize: number;
  reviewRole: ReviewRole;
}
