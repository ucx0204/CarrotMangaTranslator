import type {
  ChapterStoryMemory,
  WorkStyleGuide,
} from "../../shared/workContextTypes";

export type PageWorkflowContextCommit = {
  storyMemory?: ChapterStoryMemory;
  styleGuide?: WorkStyleGuide;
};
