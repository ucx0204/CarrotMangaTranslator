import type { BBox } from "../../../shared/textTypes";
import type {
  RegionTextReview,
  ConfirmRegionTranslationRequest,
} from "../../../shared/regionTextReview";

/** The image/text editor's contract, shared by a crop and a batch page. */
export type RegionReviewInput = {
  busy?: boolean;
  review?: RegionTextReview;
  page: { width: number; height: number };
  bbox: BBox;
  editSourceText?: boolean;
  onConfirm?: (
    translations: ConfirmRegionTranslationRequest["translations"],
    protection?: ConfirmRegionTranslationRequest["protection"],
  ) => void;
};
