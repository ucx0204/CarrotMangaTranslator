import { useTranslation } from "react-i18next";
import {
  IconArrowLeft,
  IconArrowRight,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";

import React from "react";

import {
  createConditionalPatternId,
  type ConditionalReplacementPartV3,
  type ConditionalReplacementV3,
} from "../../../shared/conditionalTextPattern";

import { IconButton } from "./ui/IconButton";

import styles from "./ConditionalBatchEditor.module.css";

import { Button as UiButton } from "./ui/Button";

import { Input } from "./ui/Field";

import { moveArrayItem } from "./conditionalPatternEditorModel";

export function ReplacementLane({
  replacement,
  captureIds,
  captureLabels,
  onChange,
}: {
  replacement: ConditionalReplacementV3;
  captureIds: string[];
  captureLabels: ReadonlyMap<string, string>;
  onChange: (replacement: ConditionalReplacementV3) => void;
}) {
  const { t } = useTranslation("components");
  const [activeId, setActiveId] = React.useState<string | null>(null);
  if (replacement.mode === "raw") {
    return (
      <label className={styles.rawPatternField}>
        <span>{t("patternEditorCopy.replace")}</span>
        <Input
          value={replacement.source}
          onChange={(event) =>
            onChange({ mode: "raw", source: event.target.value })
          }
        />
      </label>
    );
  }
  const update = (id: string, next: ConditionalReplacementPartV3) =>
    onChange({
      ...replacement,
      parts: replacement.parts.map((part) => (part.id === id ? next : part)),
    });
  const activeIndex = replacement.parts.findIndex(
    (part) => part.id === activeId,
  );
  const addPart = (part: ConditionalReplacementPartV3): void => {
    onChange({ ...replacement, parts: [...replacement.parts, part] });
    setActiveId(part.id);
  };
  return (
    <div className={styles.patternLane}>
      <span className={styles.patternLaneLabel}>
        {t("patternEditorCopy.replace")}
      </span>
      <ReplacementSequence
        replacement={replacement}
        captureIds={captureIds}
        captureLabels={captureLabels}
        activeId={activeId}
        setActiveId={setActiveId}
        onChange={onChange}
        addPart={addPart}
        update={update}
      />
      {activeIndex >= 0 ? (
        <ReplacementOrderingControls
          activeIndex={activeIndex}
          replacement={replacement}
          onChange={onChange}
          setActiveId={setActiveId}
        />
      ) : null}
    </div>
  );
}

function handleReplacementPartKeyDown(
  event: React.KeyboardEvent,
  index: number,
  replacement: Extract<ConditionalReplacementV3, { mode: "visual" }>,
  onChange: (replacement: ConditionalReplacementV3) => void,
): void {
  if (!event.altKey || !["ArrowLeft", "ArrowRight"].includes(event.key)) {
    return;
  }
  event.preventDefault();
  onChange({
    ...replacement,
    parts: moveArrayItem(
      replacement.parts,
      index,
      event.key === "ArrowLeft" ? -1 : 1,
    ),
  });
}

function ReplacementPartPicker({
  captureIds,
  captureLabels,
  addPart,
}: {
  captureIds: string[];
  captureLabels: ReadonlyMap<string, string>;
  addPart: (part: ConditionalReplacementPartV3) => void;
}) {
  const { t } = useTranslation("components");
  return (
    <details className={styles.patternAdd}>
      <summary aria-label={t("patternEditorCopy.addReplacementPart")}>
        <IconPlus size={15} />
      </summary>
      <div className={styles.patternMenu}>
        <UiButton
          type="button"
          onClick={(event) => {
            addPart({
              id: createConditionalPatternId("replacement"),
              kind: "literal",
              text: "",
            });
            event.currentTarget.closest("details")?.removeAttribute("open");
          }}
          variant="bare"
        >
          {t("patternEditorCopy.literalText")}
        </UiButton>
        {captureIds.map((captureId) => (
          <UiButton
            type="button"
            key={captureId}
            onClick={(event) => {
              addPart({
                id: createConditionalPatternId("replacement"),
                kind: "capture",
                captureId,
              });
              event.currentTarget.closest("details")?.removeAttribute("open");
            }}
            variant="bare"
          >
            {captureLabels.get(captureId)}
          </UiButton>
        ))}
      </div>
    </details>
  );
}

function ReplacementOrderingControls({
  activeIndex,
  replacement,
  onChange,
  setActiveId,
}: {
  activeIndex: number;
  replacement: Extract<ConditionalReplacementV3, { mode: "visual" }>;
  onChange: (replacement: ConditionalReplacementV3) => void;
  setActiveId: React.Dispatch<React.SetStateAction<string | null>>;
}) {
  const { t } = useTranslation("components");
  return (
    <div className={styles.patternNodeToolbar}>
      <span className={styles.patternMeta}>
        {t("patternEditorCopy.replacementOrder")}
      </span>
      <span className={styles.patternToolbarActions}>
        <IconButton
          size="sm"
          label={t("patternEditorCopy.moveReplacementPartLeft")}
          disabled={activeIndex === 0}
          onClick={() =>
            onChange({
              ...replacement,
              parts: moveArrayItem(replacement.parts, activeIndex, -1),
            })
          }
        >
          <IconArrowLeft size={14} />
        </IconButton>
        <IconButton
          size="sm"
          label={t("patternEditorCopy.moveReplacementPartRight")}
          disabled={activeIndex === replacement.parts.length - 1}
          onClick={() =>
            onChange({
              ...replacement,
              parts: moveArrayItem(replacement.parts, activeIndex, 1),
            })
          }
        >
          <IconArrowRight size={14} />
        </IconButton>
        <IconButton
          size="sm"
          variant="danger"
          label={t("patternEditorCopy.deleteReplacementPart")}
          onClick={() => {
            const id = replacement.parts[activeIndex]?.id;
            if (!id) return;
            const remaining = replacement.parts.filter(
              (part) => part.id !== id,
            );
            onChange({
              ...replacement,
              parts: remaining.length
                ? remaining
                : [
                    {
                      id: createConditionalPatternId("replacement"),
                      kind: "literal",
                      text: "",
                    },
                  ],
            });
            setActiveId(null);
          }}
        >
          <IconTrash size={14} />
        </IconButton>
      </span>
    </div>
  );
}

function ReplacementSequence({
  replacement,
  captureIds,
  captureLabels,
  activeId,
  setActiveId,
  onChange,
  addPart,
  update,
}: {
  replacement: Extract<ConditionalReplacementV3, { mode: "visual" }>;
  captureIds: string[];
  captureLabels: ReadonlyMap<string, string>;
  activeId: string | null;
  setActiveId: React.Dispatch<React.SetStateAction<string | null>>;
  onChange: (replacement: ConditionalReplacementV3) => void;
  addPart: (part: ConditionalReplacementPartV3) => void;
  update: (id: string, next: ConditionalReplacementPartV3) => void;
}) {
  const { t } = useTranslation("components");
  return (
    <div className={styles.patternSequence}>
      {replacement.parts.length === 0 ? (
        <EmptyReplacementLiteral addPart={addPart} />
      ) : null}
      {replacement.parts.map((part, index) =>
        part.kind === "literal" ? (
          <span
            key={part.id}
            className={styles.patternLiteralPart}
            data-active={part.id === activeId}
          >
            <Input
              className={styles.patternLiteralInput}
              aria-label={t("conditionalBatch.then.replace")}
              placeholder={t("conditionalBatch.then.replace")}
              value={part.text}
              onFocus={() => {
                if (replacement.parts.length > 1) setActiveId(part.id);
              }}
              onKeyDown={(event) =>
                handleReplacementPartKeyDown(
                  event,
                  index,
                  replacement,
                  onChange,
                )
              }
              onChange={(event) =>
                update(part.id, { ...part, text: event.target.value })
              }
            />
          </span>
        ) : (
          <UiButton
            key={part.id}
            type="button"
            className={styles.patternChip}
            data-active={part.id === activeId}
            onClick={() => setActiveId(part.id)}
            onKeyDown={(event) =>
              handleReplacementPartKeyDown(event, index, replacement, onChange)
            }
            variant="bare"
          >
            {captureLabels.get(part.captureId) ??
              t("patternEditorCopy.capture")}
          </UiButton>
        ),
      )}
      <ReplacementPartPicker
        captureIds={captureIds}
        captureLabels={captureLabels}
        addPart={addPart}
      />
    </div>
  );
}

function EmptyReplacementLiteral({
  addPart,
}: {
  addPart: (part: ConditionalReplacementPartV3) => void;
}) {
  const { t } = useTranslation("components");
  return (
    <span className={styles.patternLiteralPart}>
      <Input
        className={styles.patternLiteralInput}
        aria-label={t("conditionalBatch.then.replace")}
        placeholder={t("conditionalBatch.then.replace")}
        value=""
        onChange={(event) =>
          addPart({
            id: createConditionalPatternId("replacement"),
            kind: "literal",
            text: event.target.value,
          })
        }
      />
    </span>
  );
}
