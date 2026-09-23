import { preflightPageWorkflow } from "../../../shared/pageWorkflowPolicy";
import { useEffect, useMemo, useState } from "react";
import type { TranslationOptionsModalProps } from "./translationOptionsModalTypes";
import { initialPageWorkflowPlan } from "../../../shared/pageWorkflowSettings";
import {
  PageWorkflowPlanSchema,
  type PageWorkflowPreflight,
  type PageWorkflowRequest,
} from "../../../shared/pageWorkflowTypes";
import { createEmptyConditionalBatchSnapshot } from "../../../shared/conditionalBatchRules";
import { pageWorkflowGateway } from "../api/pageWorkflowGateway";
import { libraryGateway } from "../api/libraryGateway";
import { conditionalBatchGateway } from "../api/conditionalBatchGateway";
import {
  selectedPageIds,
  type ChapterSelectionMap,
} from "../lib/translationSelection";

export function usePageWorkflowModalState(props: TranslationOptionsModalProps) {
  const work =
    props.library.works.find((entry) => entry.id === props.chapter.workId) ??
    null;
  const [plan, setPlan] = useState(() =>
    initialPageWorkflowPlan(props.uiSettings),
  );
  const [selection, setSelection] = useState<ChapterSelectionMap>(
    () =>
      new Map(
        (props.initialScope === "work-all" && work
          ? work.chapters
          : [props.chapter]
        ).map((chapter) => [chapter.id, { kind: "all" as const }]),
      ),
  );
  const [rules, setRules] = useState(createEmptyConditionalBatchSnapshot);
  const [resume, setResume] = useState<PageWorkflowRequest | null>(null);
  const state = useWorkflowPreflight(props, plan, selection, resume);
  const { setError } = state;
  const resumeIds = useMemo(
    () => [
      ...new Set(
        props.chapter.pages.flatMap((page) =>
          page.pageWorkflow ? [page.pageWorkflow.runId] : [],
        ),
      ),
    ],
    [props.chapter],
  );
  useEffect(() => {
    let active = true;
    conditionalBatchGateway.listConditionalBatchSchemes().then(
      (value) => {
        if (active) setRules(value);
      },
      (error: unknown) => {
        if (active) setError(String(error));
      },
    );
    return () => {
      active = false;
    };
  }, [setError]);
  return {
    work,
    plan,
    setPlan,
    selection,
    setSelection,
    rules,
    ...state,
    resume,
    setResume,
    resumeIds,
  };
}

function useWorkflowPreflight(
  props: TranslationOptionsModalProps,
  plan: PageWorkflowRequest["plan"],
  selection: ChapterSelectionMap,
  resume: PageWorkflowRequest | null,
) {
  const [request, setRequest] = useState<PageWorkflowRequest | null>(null);
  const [preflight, setPreflight] = useState<PageWorkflowPreflight | null>(
    null,
  );
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setRequest(null);
    const prepare = async () => {
      const parsed = PageWorkflowPlanSchema.safeParse(plan);
      if (!parsed.success)
        throw new Error(
          parsed.error.issues.map((issue) => issue.message).join("\n"),
        );
      const checked = parsed.data;
      const liveChapters: Array<TranslationOptionsModalProps["chapter"]> = [];
      const targets = await Promise.all(
        [...selection].map(async ([chapterId, selected]) => {
          const chapter =
            chapterId === props.chapter.id
              ? props.chapter
              : await libraryGateway.openChapter(chapterId);
          liveChapters.push(chapter);
          return {
            chapterId,
            pageIds: [...selectedPageIds(selected, chapter.pages)],
          };
        }),
      );
      const next = resume ?? {
        plan: checked,
        selection: targets.filter((target) => target.pageIds.length > 0),
      };
      if (!next.selection.length) throw new Error("대상 페이지를 선택하세요.");
      const result = await pageWorkflowGateway.preflightPageWorkflow(next);
      if (active) {
        setError("");
        setRequest(next);
        const local = preflightPageWorkflow(next, liveChapters);
        setPreflight({
          ...result,
          ...local,
          issues: [
            ...local.issues,
            ...result.issues.filter((issue) => !issue.pageId),
          ],
        });
      }
    };
    prepare().catch((error: unknown) => {
      if (active) {
        setPreflight(null);
        setError(error instanceof Error ? error.message : String(error));
      }
    });
    return () => {
      active = false;
    };
  }, [plan, selection, resume, props.chapter]);
  return { request, preflight, error, setError };
}
