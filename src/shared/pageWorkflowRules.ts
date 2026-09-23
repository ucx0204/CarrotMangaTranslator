import type {
  ConditionalBatchSnapshotV2,
  ConditionalBatchSchemeDraftV2,
  ConditionalBatchActionV2,
} from "./conditionalBatchRules";
import type {
  FrozenPageWorkflowRules,
  PageWorkflowPlan,
  PageWorkflowRuleStage,
} from "./pageWorkflowTypes";
import { resolveBlockStylePresetPatchFields } from "./blockStylePresetFormat";

export function workflowRuleEffects(rules: FrozenPageWorkflowRules) {
  return Object.entries(rules).flatMap(([stage, schemes]) =>
    schemes.map((scheme) => ({
      stage: stage as PageWorkflowRuleStage,
      name: scheme.name,
      fields: [
        ...new Set(
          scheme.actions
            .filter((action) => action.enabled)
            .flatMap(workflowActionFields),
        ),
      ],
    })),
  );
}

function workflowActionFields(action: ConditionalBatchActionV2): string[] {
  if (action.type === "replaceText") return [action.target];
  if (action.type === "setFields")
    return action.changes.map((change) => change.field);
  if (action.type === "applyStylePreset")
    return Object.keys(resolveBlockStylePresetPatchFields(action, {}));
  return ["translatedText"];
}

export function freezeWorkflowRules(
  plan: PageWorkflowPlan,
  snapshot: ConditionalBatchSnapshotV2,
): FrozenPageWorkflowRules {
  const result: FrozenPageWorkflowRules = {};
  for (const stage of [
    "source-rules",
    "translation-rules",
    "format-rules",
  ] as const) {
    if (!plan.stages.includes(stage)) continue;
    const reference = plan.rules[stage];
    if (!reference) throw new Error("일괄 편집 규칙을 선택하세요.");
    const sequence = snapshot.sequences.find(
      (entry) => entry.id === reference.id,
    );
    const ids =
      reference.kind === "scheme"
        ? [reference.id]
        : sequence?.steps
            .filter((step) => step.enabled)
            .map((step) => step.schemeId);
    if (!ids?.length) throw new Error("규칙 묶음이 없거나 비어 있습니다.");
    result[stage] = ids.map((id) => {
      const scheme = snapshot.schemes.find((entry) => entry.id === id);
      if (!scheme) throw new Error("저장된 일괄 편집 규칙을 찾지 못했습니다.");
      assertWorkflowRuleStage(stage, scheme);
      const { id: _id, ...draft } = scheme;
      return structuredClone(draft);
    });
  }
  return result;
}

function assertWorkflowRuleStage(
  stage: PageWorkflowRuleStage,
  scheme: ConditionalBatchSchemeDraftV2,
): void {
  if (stage === "format-rules") return;
  const target = stage === "source-rules" ? "sourceText" : "translatedText";
  for (const action of scheme.actions.filter((item) => item.enabled)) {
    const valid =
      action.type === "replaceText"
        ? action.target === target
        : action.type === "setFields" &&
          action.changes.every((change) => change.field === target);
    if (!valid)
      throw new Error(
        `‘${scheme.name}’은 이 위치에서 ${target === "sourceText" ? "원문" : "번역문"}만 수정할 수 있습니다. 서식 규칙은 최종 일괄 편집에 넣으세요.`,
      );
  }
}
