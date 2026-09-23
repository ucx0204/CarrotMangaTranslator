import type { AppSettings } from "../../shared/settingsTypes";
import type {
  PageWorkflowPlan,
  FrozenPageWorkflowRules,
} from "../../shared/pageWorkflowTypes";
import type { JobEvent } from "../../shared/jobTypes";
import type { AppPaths } from "../appPaths";
import type { ChapterRunPaths } from "../library";
import type { WholePagePipelineDependencies } from "../pipeline/wholePagePipelinePorts";
import type { ImageDecodeFallback } from "../regionCrop";

export type PageWorkflowRuntimeContext = {
  previousStoryPages?: import("../../shared/workContextTypes").PageStoryMemory[];
  runId: string;
  plan: PageWorkflowPlan;
  rules: FrozenPageWorkflowRules;
  settings: AppSettings;
  paths: AppPaths;
  signal: AbortSignal;
  emit: (event: JobEvent) => void;
  dependencies: WholePagePipelineDependencies;
  runPaths: (chapterId: string) => Promise<ChapterRunPaths>;
  decodeImage: ImageDecodeFallback;
};
