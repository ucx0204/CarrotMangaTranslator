import type { BubbleRecoveryHint } from "./bubbleQualityRecovery";

export type BubbleQualityRefiner = {
  backend: string;
  model: "sam2.1" | "sam3";
  refine: (
    bitmap: Buffer,
    width: number,
    height: number,
    hints: BubbleRecoveryHint[],
    options?: { signal?: AbortSignal },
  ) => Promise<Uint8Array>;
};

export type BubbleQualityRefinerLease = {
  refiner: BubbleQualityRefiner;
  release: () => void;
};

export type BubbleQualityRefinerEngine = BubbleQualityRefiner & {
  dispose: () => Promise<void>;
  isHealthy: () => boolean;
};
