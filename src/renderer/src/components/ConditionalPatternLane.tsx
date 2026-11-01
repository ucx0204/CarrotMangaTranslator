import { useTranslation } from "react-i18next";
import { IconPlus } from "@tabler/icons-react";
import React from "react";
import { Button as UiButton } from "./ui/Button";

import {
  createConditionalPatternId,
  createConditionalPatternRepeat,
  type ConditionalPatternNodeV3,
} from "../../../shared/conditionalTextPattern";

import styles from "./ConditionalBatchEditor.module.css";

import { Input } from "./ui/Field";

import {
  PatternChip,
  PatternNodeToolbar,
} from "./ConditionalPatternNodeControls";

import {
  createPatternNode,
  moveArrayItem,
  moveArrayItemTo,
} from "./conditionalPatternEditorModel";

export function PatternLane({
  label,
  nodes,
  captureLabels,
  onChange,
  depth = 0,
}: {
  label: string;
  nodes: ConditionalPatternNodeV3[];
  captureLabels: ReadonlyMap<string, string>;
  onChange: (nodes: ConditionalPatternNodeV3[]) => void;
  depth?: number;
}) {
  const { t } = useTranslation("components");
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [draggedId, setDraggedId] = React.useState<string | null>(null);
  const activeNode = nodes.find((node) => node.id === activeId);
  const activeCaptureLabel = patternCaptureLabel(activeNode, captureLabels);
  const updateNode = (id: string, next: ConditionalPatternNodeV3) =>
    onChange(nodes.map((node) => (node.id === id ? next : node)));
  return (
    <div className={styles.patternLane} data-depth={depth}>
      <span className={styles.patternLaneLabel}>{label}</span>
      <PatternSequence
        nodes={nodes}
        captureLabels={captureLabels}
        onChange={onChange}
        activeId={activeId}
        draggedId={draggedId}
        setActiveId={setActiveId}
        setDraggedId={setDraggedId}
        updateNode={updateNode}
      />
      {activeNode ? (
        <PatternNodeToolbar
          node={activeNode}
          captureLabel={activeCaptureLabel}
          canMoveLeft={nodes[0]?.id !== activeNode.id}
          canMoveRight={nodes.at(-1)?.id !== activeNode.id}
          onChange={(next) => updateNode(activeNode.id, next)}
          onMove={(offset) =>
            onChange(moveArrayItem(nodes, nodes.indexOf(activeNode), offset))
          }
          onRemove={() => {
            const remaining = nodes.filter((node) => node.id !== activeNode.id);
            onChange(
              remaining.length ? remaining : [createPatternNode("literal")],
            );
            setActiveId(null);
          }}
        />
      ) : null}
      {activeNode?.kind === "group" ? (
        <PatternLane
          label={t("batchEditorCopy.group")}
          depth={depth + 1}
          nodes={activeNode.nodes}
          captureLabels={captureLabels}
          onChange={(children) =>
            updateNode(activeNode.id, { ...activeNode, nodes: children })
          }
        />
      ) : null}
    </div>
  );
}

function patternCaptureLabel(
  node: ConditionalPatternNodeV3 | undefined,
  labels: ReadonlyMap<string, string>,
): string | undefined {
  if (!node || !("captureId" in node) || !node.captureId) return undefined;
  return labels.get(node.captureId);
}

function EmptyPatternLiteral({
  onChange,
  setActiveId,
}: {
  onChange: (nodes: ConditionalPatternNodeV3[]) => void;
  setActiveId: React.Dispatch<React.SetStateAction<string | null>>;
}) {
  const { t } = useTranslation("components");
  return (
    <span className={styles.patternLiteralPart}>
      <Input
        className={styles.patternLiteralInput}
        aria-label={t("patternEditorCopy.literalText")}
        placeholder={t("conditionalBatch.then.find")}
        value=""
        onChange={(event) => {
          const node: Extract<ConditionalPatternNodeV3, { kind: "literal" }> = {
            id: createConditionalPatternId("literal"),
            kind: "literal",
            text: event.target.value,
            repeat: createConditionalPatternRepeat(),
          };
          onChange([node]);
          setActiveId(node.id);
        }}
      />
    </span>
  );
}

function PatternSequence({
  nodes,
  captureLabels,
  onChange,
  activeId,
  draggedId,
  setActiveId,
  setDraggedId,
  updateNode,
}: {
  nodes: ConditionalPatternNodeV3[];
  captureLabels: ReadonlyMap<string, string>;
  onChange: (nodes: ConditionalPatternNodeV3[]) => void;
  activeId: string | null;
  draggedId: string | null;
  setActiveId: React.Dispatch<React.SetStateAction<string | null>>;
  setDraggedId: React.Dispatch<React.SetStateAction<string | null>>;
  updateNode: (id: string, next: ConditionalPatternNodeV3) => void;
}) {
  useTranslation();
  return (
    <div className={styles.patternSequence}>
      {nodes.length === 0 ? (
        <EmptyPatternLiteral onChange={onChange} setActiveId={setActiveId} />
      ) : null}
      {nodes.map((node, index) => (
        <PatternChip
          key={node.id}
          node={node}
          captureLabel={
            "captureId" in node && node.captureId
              ? captureLabels.get(node.captureId)
              : undefined
          }
          active={activeId === node.id}
          dragged={draggedId === node.id}
          reorderable={nodes.length > 1}
          onActivate={() =>
            setActiveId((current) => (current === node.id ? null : node.id))
          }
          onChange={(next) => updateNode(node.id, next)}
          onDragEnd={() => setDraggedId(null)}
          onDragStart={() => setDraggedId(node.id)}
          onDrop={() => {
            if (!draggedId || draggedId === node.id) return;
            onChange(
              moveArrayItemTo(
                nodes,
                nodes.findIndex((entry) => entry.id === draggedId),
                index,
              ),
            );
            setDraggedId(null);
          }}
          onMove={(offset) => onChange(moveArrayItem(nodes, index, offset))}
        />
      ))}
      <AddPatternPart
        disabled={nodes.length >= 32}
        onEditCurrent={
          nodes.length === 1 && nodes[0]?.kind === "literal"
            ? () => setActiveId(nodes[0]?.id ?? null)
            : undefined
        }
        onAdd={(node) => {
          onChange([...nodes, node]);
          setActiveId(node.id);
        }}
      />
    </div>
  );
}

function AddPatternPart({
  disabled,
  onEditCurrent,
  onAdd,
}: {
  disabled: boolean;
  onEditCurrent?: () => void;
  onAdd: (node: ConditionalPatternNodeV3) => void;
}) {
  const { t } = useTranslation("components");
  return (
    <details className={styles.patternAdd}>
      <summary
        aria-label={t("patternEditorCopy.addPatternPart")}
        aria-disabled={disabled}
      >
        <IconPlus size={15} />
      </summary>
      <div className={styles.patternMenu}>
        {onEditCurrent ? (
          <UiButton
            type="button"
            onClick={(event) => {
              onEditCurrent();
              event.currentTarget.closest("details")?.removeAttribute("open");
            }}
            variant="bare"
          >
            {t("patternEditorCopy.repetitionAndCapture")}
          </UiButton>
        ) : null}
        {(
          [
            ["literal", t("patternEditorCopy.literalText")],
            ["number", t("batchEditorCopy.number")],
            ["letter", t("batchEditorCopy.character")],
            ["whitespace", t("batchEditorCopy.whitespace")],
            ["newline", t("patternEditorCopy.lineBreak")],
            ["any", t("batchEditorCopy.anyCharacter")],
            ["choice", t("patternEditorCopy.oneOfSeveralOptions")],
            ["start", t("batchEditorCopy.balloonStart")],
            ["end", t("batchEditorCopy.balloonEnd")],
            ["group", t("patternEditorCopy.groupParts")],
          ] as const
        ).map(([kind, label]) => (
          <UiButton
            key={kind}
            type="button"
            disabled={disabled}
            onClick={(event) => {
              onAdd(createPatternNode(kind));
              event.currentTarget.closest("details")?.removeAttribute("open");
            }}
            variant="bare"
          >
            {label}
          </UiButton>
        ))}
      </div>
    </details>
  );
}
