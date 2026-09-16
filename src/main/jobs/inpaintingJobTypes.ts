import type { AppPaths } from "../appPaths";
import type { ImageDecodeFallback } from "../regionCrop";
import type { ActiveJobStore } from "./activeJob";
import type { InpaintingRevisionStore } from "../inpainting/inpaintingRevisionStore";
import type { JobEventWindow } from "./jobEventDispatchQueue";

export type InpaintingJobRevisionStore = Pick<
  InpaintingRevisionStore,
  | "addChange"
  | "beginTransaction"
  | "discardIfEmpty"
  | "getReference"
  | "getRetainedArtifactPaths"
  | "removeChange"
>;

export type InpaintingJobContext = {
  /** Trusted callers can hold the target page before model setup through finalization. */
  retainPageOwnership?: boolean;
  executionSettings?: import("../../shared/settingsTypes").AppSettings;
  appPaths: AppPaths;
  jobs: ActiveJobStore;
  getMainWindow: () => JobEventWindow | null;
  decodeImage: ImageDecodeFallback;
  inpaintingRevisionStore?: InpaintingJobRevisionStore &
    Partial<
      Pick<
        InpaintingRevisionStore,
        "inspectSinglePageTransaction" | "applySinglePageTransaction"
      >
    >;
};
