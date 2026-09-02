import { IconChevronDown, IconChevronRight } from "@tabler/icons-react";
import React, { type ComponentProps } from "react";
import { Button as UiButton } from "./ui/Button";
import { CheckboxField as UiCheckboxField } from "./ui/CheckboxField";
import { Select as UiSelect } from "./ui/Select";
import styles from "./ConditionalBatchEditor.module.css";

export function Button(props: ComponentProps<typeof UiButton>) {
  return <UiButton {...props} />;
}

export function CheckboxField(props: ComponentProps<typeof UiCheckboxField>) {
  return <UiCheckboxField {...props} />;
}

export function Select(props: ComponentProps<typeof UiSelect>) {
  return <UiSelect {...props} />;
}

export function ConditionalBatchCollapsibleCard({
  children,
  expanded,
  onToggle,
  summary,
  title,
}: {
  children: React.ReactNode;
  expanded: boolean;
  onToggle: () => void;
  summary: React.ReactNode;
  title: React.ReactNode;
}): React.JSX.Element {
  const bodyId = React.useId();
  return (
    <section className={styles.ruleCard} data-expanded={expanded}>
      <ConditionalBatchCollapsibleTrigger
        bodyId={bodyId}
        expanded={expanded}
        summary={summary}
        title={title}
        onToggle={onToggle}
      />
      {expanded ? (
        <div className={styles.cardBody} id={bodyId}>
          {children}
        </div>
      ) : null}
    </section>
  );
}

export function ConditionalBatchCollapsibleTrigger({
  bodyId,
  expanded,
  onToggle,
  summary,
  title,
}: {
  bodyId: string;
  expanded: boolean;
  onToggle: () => void;
  summary?: React.ReactNode;
  title: React.ReactNode;
}): React.JSX.Element {
  return (
    <UiButton
      className={styles.cardToggle}
      iconLeft={
        expanded ? (
          <IconChevronDown size={17} />
        ) : (
          <IconChevronRight size={17} />
        )
      }
      aria-controls={bodyId}
      aria-expanded={expanded}
      onClick={onToggle}
    >
      <strong>{title}</strong>
      {!expanded && summary ? <small>{summary}</small> : null}
    </UiButton>
  );
}
