export type ReviewStatus = "confirmed" | "deferred";

export interface PageBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ReviewCandidate {
  id: number;
  bbox?: unknown;
  x1?: unknown;
  y1?: unknown;
  x2?: unknown;
  y2?: unknown;
  reviewFragmentId?: unknown;
  reviewStatus?: unknown;
  reviewReasons?: unknown;
  reviewOrder?: unknown;
  reviewContextId?: unknown;
  paddleGroupId?: unknown;
  paddleOrder?: unknown;
  paddleGroupSize?: unknown;
  animeTextRegionId?: unknown;
  animeTextRegionScore?: unknown;
  animeTextContainment?: unknown;
  animeTextRegionBbox?: unknown;
  animeTextEvidenceVersion?: unknown;
  animeTextModelRevision?: unknown;
  [key: string]: unknown;
}

export interface NormalizedCandidate {
  id: number;
  fragmentId: string;
  status: ReviewStatus;
  reasons: string[];
  order: number;
  reviewContextId: string | null;
  bbox: PageBox;
  paddleGroupId: string | null;
  paddleOrder: number | null;
  paddleGroupSize: number | null;
  animeTextRegionId: string | null;
  animeTextRegionScore: number | null;
  animeTextContainment: number | null;
}

export interface ReviewFragment {
  fragmentId: string;
  status: ReviewStatus;
  reasons: string[];
  reviewContextId: string | null;
  candidates: NormalizedCandidate[];
  bbox: PageBox;
}

export interface InternalRegion {
  reasons: string[];
  fragments: ReviewFragment[];
  contentBbox: PageBox;
  cropBbox: PageBox;
  padding: { x: number; y: number };
}

export interface CropCandidate {
  candidateId: number;
  reviewFragmentId: string;
  reviewContextId: string | null;
  reviewStatus: ReviewStatus;
  reviewOrder: number;
  paddleGroupId: string | null;
  paddleOrder: number | null;
  paddleGroupSize: number | null;
  bbox: PageBox;
  bbox1000: [number, number, number, number];
}

export interface CropFragment {
  reviewFragmentId: string;
  reviewContextId: string | null;
  reviewStatus: ReviewStatus;
  reviewReasons: string[];
  candidateIds: number[];
  bbox: PageBox;
  bbox1000: [number, number, number, number];
}

export interface GroupReviewCropRegion {
  [key: string]: unknown;
  cropId: string;
  reasons: string[];
  confirmedFragmentIds: string[];
  deferredFragmentIds: string[];
  fragmentIds: string[];
  candidateIds: number[];
  fragments: CropFragment[];
  candidates: CropCandidate[];
  contentBbox: PageBox;
  cropBbox: PageBox;
  cropRect: CropRect;
  padding: { x: number; y: number };
}

export interface GroupReviewCropPlan {
  version: number;
  pageWidth: number;
  pageHeight: number;
  fragmentCount: number;
  candidateCount: number;
  regions: GroupReviewCropRegion[];
}

export interface GroupReviewImageVariant {
  [key: string]: unknown;
  role: string;
  path: string;
  dataUrl: string;
  mime: string;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  semanticReviewCropId: string;
  semanticCropRect: CropRect;
}

export interface PreparedGroupReviewCrop {
  region: GroupReviewCropRegion;
  variant: GroupReviewImageVariant;
}

export interface GroupReviewImageResult {
  crops: PreparedGroupReviewCrop[];
  fallbackReason: string | null;
}

export interface GroupReviewCropOptions {
  imagePath?: unknown;
  [key: string]: unknown;
}

export interface NativeImageLike {
  isEmpty(): boolean;
  crop(rect: CropRect): NativeImageLike;
  toPNG(): Buffer;
  getSize?(): { width: number; height: number };
}

export interface NativeImageModule {
  createFromPath(path: string): NativeImageLike;
}
