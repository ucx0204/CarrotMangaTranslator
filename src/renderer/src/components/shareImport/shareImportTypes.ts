export type LeftItem =
  | {
      key: string;
      source: "existing";
      chapterId: string;
      title: string;
      pageCount: number;
    }
  | {
      key: string;
      source: "package";
      packageChapterId: string;
      title: string;
      pageCount: number;
    };

export type NewSelection = {
  packageChapterId: string;
  title: string;
  enabled: boolean;
};

export type MergeContainer = "final" | "candidate";

export type ActiveDrag = {
  container: MergeContainer;
  item: LeftItem;
};

export const FINAL_CONTAINER_ID = "final";
export const CANDIDATE_CONTAINER_ID = "candidate";
