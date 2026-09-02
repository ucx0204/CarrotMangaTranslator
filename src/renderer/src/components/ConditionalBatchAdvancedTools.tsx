import { IconFileExport, IconFileImport } from "@tabler/icons-react";
import React from "react";
import type { ConditionalBatchRulePanelProps } from "./conditionalBatchRulePanelTypes";
import {
  Button,
  ConditionalBatchCollapsibleTrigger,
} from "./ConditionalBatchControls";
import { Textarea } from "./ui/Field";
import { InlineMessage } from "./ui/InlineMessage";
import styles from "./ConditionalBatchEditor.module.css";

type ConditionalBatchAdvancedToolsProps = Pick<
  ConditionalBatchRulePanelProps,
  | "onExportYaml"
  | "onImportYaml"
  | "onOpenYaml"
  | "onOpenYamlFile"
  | "onReflectYaml"
  | "onSetYamlOpen"
  | "onSetYamlText"
  | "yamlError"
  | "yamlOpen"
  | "yamlText"
> & {
  expanded: boolean;
  onToggle: () => void;
};

export function ConditionalBatchAdvancedTools(
  props: ConditionalBatchAdvancedToolsProps,
): React.JSX.Element {
  const bodyId = React.useId();
  return (
    <section className={styles.advancedTools} data-expanded={props.expanded}>
      <ConditionalBatchCollapsibleTrigger
        bodyId={bodyId}
        expanded={props.expanded}
        title="고급"
        onToggle={props.onToggle}
      />
      {props.expanded ? <YamlToolsBody {...props} id={bodyId} /> : null}
    </section>
  );
}

function YamlToolsBody(
  props: ConditionalBatchAdvancedToolsProps & { id: string },
): React.JSX.Element {
  return (
    <div className={styles.advancedBody} id={props.id}>
      <div className={styles.advancedButtons}>
        <Button
          size="sm"
          iconLeft={<IconFileExport size={15} />}
          onClick={() => props.onExportYaml(false)}
        >
          규칙 내보내기
        </Button>
        <Button
          size="sm"
          iconLeft={<IconFileExport size={15} />}
          onClick={() => props.onExportYaml(true)}
        >
          전체 내보내기
        </Button>
        <Button size="sm" onClick={props.onOpenYaml}>
          직접 편집
        </Button>
        <Button
          size="sm"
          iconLeft={<IconFileImport size={15} />}
          onClick={props.onOpenYamlFile}
        >
          가져오기
        </Button>
      </div>
      {props.yamlOpen ? <YamlEditor {...props} /> : null}
    </div>
  );
}

function YamlEditor(
  props: Pick<
    ConditionalBatchAdvancedToolsProps,
    | "onImportYaml"
    | "onReflectYaml"
    | "onSetYamlOpen"
    | "onSetYamlText"
    | "yamlError"
    | "yamlText"
  >,
): React.JSX.Element {
  return (
    <div className={styles.yamlEditor}>
      <Textarea
        aria-label="일괄 편집 YAML"
        spellCheck={false}
        value={props.yamlText}
        onChange={(event) => props.onSetYamlText(event.target.value)}
      />
      {props.yamlError ? (
        <InlineMessage
          variant="danger"
          title="YAML 오류"
          detail={props.yamlError}
        />
      ) : null}
      <div className={styles.yamlActions}>
        <Button size="sm" onClick={props.onReflectYaml}>
          카드에 반영
        </Button>
        <Button
          size="sm"
          iconLeft={<IconFileImport size={15} />}
          onClick={() => props.onImportYaml("duplicate")}
        >
          새 규칙으로 가져오기
        </Button>
        <Button
          size="sm"
          variant="danger"
          onClick={() => props.onImportYaml("overwrite")}
        >
          같은 ID 덮어쓰기
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => props.onSetYamlOpen(false)}
        >
          닫기
        </Button>
      </div>
    </div>
  );
}
