import React from "react";
import { ConditionalBatchActionCard } from "./ConditionalBatchActionCard";
import { ConditionalBatchAdvancedTools } from "./ConditionalBatchAdvancedTools";
import { ConditionalBatchConditionsCard } from "./ConditionalBatchConditionsCard";
import { ConditionalBatchRecipePicker } from "./ConditionalBatchRecipePicker";
import { ConditionalBatchSchemeManager } from "./ConditionalBatchSchemeManager";
import {
  ConditionalBatchSequenceManager,
  ConditionalBatchSequenceRunCard,
} from "./ConditionalBatchSequenceManager";
import type { ConditionalBatchRulePanelProps } from "./conditionalBatchRulePanelTypes";
import { InlineMessage } from "./ui/InlineMessage";
import { SegmentedControl } from "./ui/SegmentedControl";
import styles from "./ConditionalBatchEditor.module.css";

export function ConditionalBatchRulePanel(
  props: ConditionalBatchRulePanelProps,
): React.JSX.Element {
  const [conditionsExpanded, setConditionsExpanded] = React.useState(true);
  const [actionsExpanded, setActionsExpanded] = React.useState(true);
  const [sequenceExpanded, setSequenceExpanded] = React.useState(true);
  const [advancedExpanded, setAdvancedExpanded] = React.useState(true);
  return (
    <aside className={styles.rulePanel} aria-label="일괄 편집 규칙">
      {props.activeSequence ? null : (
        <ConditionalBatchSchemeManager {...props} />
      )}
      <div className={styles.rulePanelScroll}>
        {props.activeSequence ? (
          <ConditionalBatchSequenceRunCard {...props} />
        ) : props.recipePickerOpen ? (
          <ConditionalBatchRecipePicker {...props} />
        ) : (
          <>
            <ScopeSection {...props} />
            <ConditionalBatchConditionsCard
              currentResult={props.currentResult}
              draft={props.draft}
              expanded={conditionsExpanded}
              ruleId={props.selectedSchemeId}
              onChangeDraft={props.onChangeDraft}
              onToggle={() => setConditionsExpanded((current) => !current)}
            />
            <ConditionalBatchActionCard
              blockStylePresets={props.blockStylePresets}
              currentResult={props.currentResult}
              draft={props.draft}
              expanded={actionsExpanded}
              onChangeDraft={props.onChangeDraft}
              onToggle={() => setActionsExpanded((current) => !current)}
            />
            <ConditionalBatchSequenceManager
              {...props}
              expanded={sequenceExpanded}
              onToggle={() => setSequenceExpanded((current) => !current)}
            />
            <ConditionalBatchAdvancedTools
              {...props}
              expanded={advancedExpanded}
              onToggle={() => setAdvancedExpanded((current) => !current)}
            />
            <RuleNotices {...props} />
          </>
        )}
      </div>
    </aside>
  );
}

function ScopeSection(
  props: Pick<
    ConditionalBatchRulePanelProps,
    "onChangeScope" | "scopeKind" | "selectedBlockCount"
  >,
): React.JSX.Element {
  return (
    <section className={styles.scopeCard}>
      <strong>범위</strong>
      <SegmentedControl
        ariaLabel="적용 범위"
        singleRow
        options={[
          {
            id: "selection",
            label: "선택",
            badge: props.selectedBlockCount || undefined,
            disabled: props.selectedBlockCount === 0,
          },
          { id: "page", label: "페이지" },
          { id: "chapter", label: "화" },
        ]}
        value={props.scopeKind}
        onChange={props.onChangeScope}
      />
    </section>
  );
}

function RuleNotices(
  props: Pick<
    ConditionalBatchRulePanelProps,
    "applyNotice" | "storageError" | "validationMessage"
  >,
): React.JSX.Element {
  return (
    <>
      {props.validationMessage ? (
        <InlineMessage
          variant="warning"
          title="규칙 오류"
          detail={props.validationMessage}
        />
      ) : null}
      {props.storageError ? (
        <InlineMessage
          variant="danger"
          title="저장 오류"
          detail={props.storageError}
        />
      ) : null}
      {props.applyNotice ? (
        <InlineMessage
          variant={props.applyNotice.kind}
          title={props.applyNotice.message}
        />
      ) : null}
    </>
  );
}
