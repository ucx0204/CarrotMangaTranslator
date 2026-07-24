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
  appPaths: AppPaths;
  jobs: ActiveJobStore;
  getMainWindow: () => JobEventWindow | null;
  decodeImage: ImageDecodeFallback;
  inpaintingRevisionStore?: InpaintingJobRevisionStore;
};
