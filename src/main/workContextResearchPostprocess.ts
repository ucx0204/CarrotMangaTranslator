import type { WorkContextUsage } from "../shared/workContextUsageTypes";
import type { TavilySearchResponse } from "./tavilyClient";
import { enrichResearchResultFromEvidence } from "./workContextResearchEvidence";
import {
  normalizeWorkContextResearchChanges,
  type NormalizedResearchChanges,
} from "./workContextResearchNormalize";
import type { WorkContextResearchPromptInput } from "./workContextResearchPrompt";

export type WorkContextResearchPostprocessInput = {
  raw: unknown;
  searches?: readonly TavilySearchResponse[];
  promptInput: WorkContextResearchPromptInput;
  usage: WorkContextUsage;
  allowedSourceUrls?: readonly string[];
};

export type WorkContextResearchPostprocessRequest = {
  type: "postprocess";
  input: WorkContextResearchPostprocessInput;
};

export type WorkContextResearchPostprocessResponse =
  | {
      type: "postprocess-done";
      result: NormalizedResearchChanges;
    }
  | {
      type: "postprocess-failed";
      error: { name: string; message: string };
    };

export function postprocessWorkContextResearch(
  input: WorkContextResearchPostprocessInput,
): NormalizedResearchChanges {
  const raw = input.searches
    ? enrichResearchResultFromEvidence(
        input.raw,
        input.searches,
        input.promptInput,
      )
    : input.raw;
  return normalizeWorkContextResearchChanges({
    raw,
    guide: input.promptInput.guide,
    usage: input.usage,
    selection: input.promptInput.selection,
    ...(input.allowedSourceUrls
      ? { allowedSourceUrls: new Set(input.allowedSourceUrls) }
      : {}),
  });
}
