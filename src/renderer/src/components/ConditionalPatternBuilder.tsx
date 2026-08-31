/* eslint-disable max-lines, max-lines-per-function -- the recursive visual matcher and replacement lanes intentionally share one compact editor */
import {
  IconArrowLeft,
  IconArrowRight,
  IconBraces,
  IconGripVertical,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import React from "react";
import {
  collectCaptureIds,
  compileConditionalTextMatcher,
  createConditionalCaptureId,
  createConditionalLiteralMatcher,
  createConditionalPatternId,
  createConditionalPatternRepeat,
  tryConvertConditionalRegexToVisual,
  type ConditionalPatternNodeV3,
  type ConditionalPatternRepeatV3,
  type ConditionalReplacementPartV3,
  type ConditionalReplacementV3,
  type ConditionalTextMatcherV3,
} from "../../../shared/conditionalTextPattern";
import { Button, CheckboxField, Select } from "./ConditionalBatchControls";
import { IconButton } from "./ui/IconButton";
import styles from "./ConditionalBatchEditor.module.css";

type PatternBuilderProps = {
  matcher: ConditionalTextMatcherV3;
  replacement?: ConditionalReplacementV3;
  sampleText?: string;
  onChangeMatcher: (matcher: ConditionalTextMatcherV3) => void;
  onChangeReplacement?: (replacement: ConditionalReplacementV3) => void;
  onSwitchToRaw?: (
    matcher: ConditionalTextMatcherV3,
    replacement?: ConditionalReplacementV3,
  ) => void;
  onSwitchToVisual?: (
    matcher: ConditionalTextMatcherV3,
    replacement?: ConditionalReplacementV3,
  ) => void;
};

const CHARACTER_LABELS: Record<
  Extract<ConditionalPatternNodeV3, { kind: "character" }>["character"],
  string
> = {
  number: "숫자",
  letter: "글자",
  whitespace: "공백",
  newline: "줄바꿈",
  any: "아무 글자",
};

export function ConditionalPatternBuilder({
  matcher,
  replacement,
  sampleText,
  onChangeMatcher,
  onChangeReplacement,
  onSwitchToRaw,
  onSwitchToVisual,
}: PatternBuilderProps): React.JSX.Element {
  if (matcher.mode === "regex") {
    return (
      <RawPatternEditor
        matcher={matcher}
        replacement={replacement}
        onChangeMatcher={onChangeMatcher}
        onChangeReplacement={onChangeReplacement}
        onSwitchToRaw={onSwitchToRaw}
        onSwitchToVisual={onSwitchToVisual}
      />
    );
  }

  const captureIds = [...collectCaptureIds(matcher)];
  const captureLabels = new Map(
    captureIds.map((captureId, index) => [captureId, `기억 ${index + 1}`]),
  );
  return (
    <div className={styles.patternBuilder}>
      <PatternLane
        label="찾기"
        nodes={matcher.nodes}
        captureLabels={captureLabels}
        onChange={(nodes) => onChangeMatcher({ ...matcher, nodes })}
      />
      {replacement && onChangeReplacement ? (
        <ReplacementLane
          replacement={replacement}
          captureIds={captureIds}
          captureLabels={captureLabels}
          onChange={onChangeReplacement}
        />
      ) : null}
      <div className={styles.patternOptions}>
        <CheckboxField
          checked={matcher.caseSensitive}
          label="대소문자 구분"
          onCheckedChange={(caseSensitive) =>
            onChangeMatcher({ ...matcher, caseSensitive })
          }
        />
        {sampleText ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              onChangeMatcher(
                createConditionalLiteralMatcher(
                  sampleText,
                  matcher.caseSensitive,
                ),
              )
            }
          >
            현재 말풍선에서 가져오기
          </Button>
        ) : null}
      </div>
      <AdvancedPatternCode
        matcher={matcher}
        replacement={replacement}
        onChangeMatcher={onChangeMatcher}
        onChangeReplacement={onChangeReplacement}
        onSwitchToRaw={onSwitchToRaw}
      />
    </div>
  );
}

function PatternLane({
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
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [draggedId, setDraggedId] = React.useState<string | null>(null);
  const activeNode = nodes.find((node) => node.id === activeId);
  const activeCaptureLabel = patternCaptureLabel(activeNode, captureLabels);
  const updateNode = (id: string, next: ConditionalPatternNodeV3) =>
    onChange(nodes.map((node) => (node.id === id ? next : node)));
  return (
    <div className={styles.patternLane} data-depth={depth}>
      <span className={styles.patternLaneLabel}>{label}</span>
      <div className={styles.patternSequence}>
        {nodes.length === 0 ? (
          <span className={styles.patternLiteralPart}>
            <input
              className={styles.patternLiteralInput}
              aria-label="글자 그대로"
              placeholder="찾을 글자"
              value=""
              onChange={(event) => {
                const node: Extract<
                  ConditionalPatternNodeV3,
                  { kind: "literal" }
                > = {
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
          label="묶음"
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

function PatternChip({
  node,
  captureLabel,
  active,
  dragged,
  reorderable,
  onActivate,
  onChange,
  onDragEnd,
  onDragStart,
  onDrop,
  onMove,
}: {
  node: ConditionalPatternNodeV3;
  captureLabel?: string;
  active: boolean;
  dragged: boolean;
  reorderable: boolean;
  onActivate: () => void;
  onChange: (node: ConditionalPatternNodeV3) => void;
  onDragEnd: () => void;
  onDragStart: () => void;
  onDrop: () => void;
  onMove: (offset: -1 | 1) => void;
}) {
  if (node.kind === "literal") {
    return (
      <>
        <span
          className={styles.patternLiteralPart}
          data-dragged={dragged}
          onDragOver={(event) => event.preventDefault()}
          onDrop={onDrop}
        >
          {reorderable ? (
            <button
              type="button"
              className={styles.patternDragHandle}
              aria-label="패턴 조각 끌기"
              draggable
              onDragEnd={onDragEnd}
              onDragStart={onDragStart}
            >
              <IconGripVertical size={12} />
            </button>
          ) : null}
          <input
            className={styles.patternLiteralInput}
            aria-label="글자 그대로"
            placeholder="찾을 글자"
            value={node.text}
            onFocus={reorderable ? onActivate : undefined}
            onKeyDown={(event) => handlePatternMoveKeyDown(event, onMove)}
            onChange={(event) =>
              onChange({ ...node, text: event.target.value })
            }
          />
          {captureLabel ? <em>{captureLabel}</em> : null}
        </span>
      </>
    );
  }
  return (
    <span
      className={styles.patternChip}
      data-active={active}
      data-dragged={dragged}
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
    >
      {reorderable ? (
        <button
          type="button"
          className={styles.patternDragHandle}
          aria-label="패턴 조각 끌기"
          draggable
          onDragEnd={onDragEnd}
          onDragStart={onDragStart}
        >
          <IconGripVertical size={12} />
        </button>
      ) : null}
      <button
        type="button"
        className={styles.patternChipMain}
        onClick={onActivate}
        onKeyDown={(event) => handlePatternMoveKeyDown(event, onMove)}
      >
        <span>{patternNodeLabel(node)}</span>
        {"repeat" in node && !isOnce(node.repeat) ? (
          <small>{repeatLabel(node.repeat)}</small>
        ) : null}
        {captureLabel ? <em>{captureLabel}</em> : null}
      </button>
    </span>
  );
}

function handlePatternMoveKeyDown(
  event: React.KeyboardEvent,
  onMove: (offset: -1 | 1) => void,
): void {
  if (!event.altKey || !["ArrowLeft", "ArrowRight"].includes(event.key)) {
    return;
  }
  event.preventDefault();
  onMove(event.key === "ArrowLeft" ? -1 : 1);
}

function PatternNodeToolbar({
  node,
  captureLabel,
  canMoveLeft,
  canMoveRight,
  onChange,
  onMove,
  onRemove,
}: {
  node: ConditionalPatternNodeV3;
  captureLabel?: string;
  canMoveLeft: boolean;
  canMoveRight: boolean;
  onChange: (node: ConditionalPatternNodeV3) => void;
  onMove: (offset: -1 | 1) => void;
  onRemove: () => void;
}) {
  const matchable = node.kind !== "boundary" ? node : null;
  return (
    <div className={styles.patternNodeToolbar}>
      {matchable ? (
        <RepeatEditor
          repeat={matchable.repeat}
          onChange={(repeat) => onChange({ ...matchable, repeat })}
        />
      ) : (
        <span className={styles.patternMeta}>위치 조건</span>
      )}
      {node.kind === "choice" ? (
        <input
          aria-label="후보 목록"
          value={node.options.join(" / ")}
          onChange={(event) => {
            const options = event.target.value
              .split("/")
              .map((value) => value.trim());
            onChange({ ...node, options });
          }}
        />
      ) : null}
      {matchable ? (
        <CheckboxField
          checked={Boolean(matchable.captureId)}
          label={captureLabel ?? "바꿀 때 기억"}
          onCheckedChange={(checked) =>
            onChange({
              ...matchable,
              captureId: checked
                ? (matchable.captureId ?? createConditionalCaptureId())
                : undefined,
            })
          }
        />
      ) : null}
      <span className={styles.patternToolbarActions}>
        <IconButton
          size="sm"
          label="왼쪽으로 이동"
          disabled={!canMoveLeft}
          onClick={() => onMove(-1)}
        >
          <IconArrowLeft size={14} />
        </IconButton>
        <IconButton
          size="sm"
          label="오른쪽으로 이동"
          disabled={!canMoveRight}
          onClick={() => onMove(1)}
        >
          <IconArrowRight size={14} />
        </IconButton>
        <IconButton
          size="sm"
          variant="danger"
          label="조각 삭제"
          onClick={onRemove}
        >
          <IconTrash size={14} />
        </IconButton>
      </span>
    </div>
  );
}

function RepeatEditor({
  repeat,
  onChange,
}: {
  repeat: ConditionalPatternRepeatV3;
  onChange: (repeat: ConditionalPatternRepeatV3) => void;
}) {
  const preset = repeatPreset(repeat);
  return (
    <>
      <Select
        ariaLabel="반복 횟수"
        value={preset}
        options={[
          { value: "once", label: "한 번" },
          { value: "optional", label: "있어도 됨" },
          { value: "oneOrMore", label: "한 개 이상" },
          { value: "zeroOrMore", label: "없거나 여러 개" },
          { value: "exact", label: "정확히 N개" },
          { value: "range", label: "N~M개" },
        ]}
        onValueChange={(value) => onChange(repeatFromPreset(value, repeat))}
      />
      {preset === "exact" || preset === "range" ? (
        <span className={styles.repeatNumbers}>
          <input
            aria-label="최소 반복"
            type="number"
            min={0}
            max={999}
            value={repeat.min}
            onChange={(event) =>
              onChange({
                ...repeat,
                min: Math.max(0, Number(event.target.value)),
                max:
                  preset === "exact"
                    ? Math.max(0, Number(event.target.value))
                    : repeat.max,
              })
            }
          />
          {preset === "range" ? (
            <>
              <span>~</span>
              <input
                aria-label="최대 반복"
                type="number"
                min={repeat.min}
                max={999}
                value={repeat.max ?? repeat.min}
                onChange={(event) =>
                  onChange({
                    ...repeat,
                    max: Math.max(repeat.min, Number(event.target.value)),
                  })
                }
              />
            </>
          ) : null}
        </span>
      ) : null}
    </>
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
  return (
    <details className={styles.patternAdd}>
      <summary aria-label="패턴 조각 추가" aria-disabled={disabled}>
        <IconPlus size={15} />
      </summary>
      <div className={styles.patternMenu}>
        {onEditCurrent ? (
          <button
            type="button"
            onClick={(event) => {
              onEditCurrent();
              event.currentTarget.closest("details")?.removeAttribute("open");
            }}
          >
            반복·기억 설정
          </button>
        ) : null}
        {(
          [
            ["literal", "글자 그대로"],
            ["number", "숫자"],
            ["letter", "글자"],
            ["whitespace", "공백"],
            ["newline", "줄바꿈"],
            ["any", "아무 글자"],
            ["choice", "여러 후보 중 하나"],
            ["start", "말풍선 처음"],
            ["end", "말풍선 끝"],
            ["group", "여러 조각 묶기"],
          ] as const
        ).map(([kind, label]) => (
          <button
            key={kind}
            type="button"
            disabled={disabled}
            onClick={(event) => {
              onAdd(createPatternNode(kind));
              event.currentTarget.closest("details")?.removeAttribute("open");
            }}
          >
            {label}
          </button>
        ))}
      </div>
    </details>
  );
}

function ReplacementLane({
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
  const [activeId, setActiveId] = React.useState<string | null>(null);
  if (replacement.mode === "raw") {
    return (
      <label className={styles.rawPatternField}>
        <span>바꾸기</span>
        <input
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
      <span className={styles.patternLaneLabel}>바꾸기</span>
      <div className={styles.patternSequence}>
        {replacement.parts.length === 0 ? (
          <span className={styles.patternLiteralPart}>
            <input
              className={styles.patternLiteralInput}
              aria-label="바꿀 글자"
              placeholder="바꿀 글자"
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
        ) : null}
        {replacement.parts.map((part, index) =>
          part.kind === "literal" ? (
            <span
              key={part.id}
              className={styles.patternLiteralPart}
              data-active={part.id === activeId}
            >
              <input
                className={styles.patternLiteralInput}
                aria-label="바꿀 글자"
                placeholder="바꿀 글자"
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
            <button
              key={part.id}
              type="button"
              className={styles.patternChip}
              data-active={part.id === activeId}
              onClick={() => setActiveId(part.id)}
              onKeyDown={(event) =>
                handleReplacementPartKeyDown(
                  event,
                  index,
                  replacement,
                  onChange,
                )
              }
            >
              {captureLabels.get(part.captureId) ?? "기억"}
            </button>
          ),
        )}
        <details className={styles.patternAdd}>
          <summary aria-label="바꿀 조각 추가">
            <IconPlus size={15} />
          </summary>
          <div className={styles.patternMenu}>
            <button
              type="button"
              onClick={(event) => {
                addPart({
                  id: createConditionalPatternId("replacement"),
                  kind: "literal",
                  text: "",
                });
                event.currentTarget.closest("details")?.removeAttribute("open");
              }}
            >
              글자 그대로
            </button>
            {captureIds.map((captureId) => (
              <button
                type="button"
                key={captureId}
                onClick={(event) => {
                  addPart({
                    id: createConditionalPatternId("replacement"),
                    kind: "capture",
                    captureId,
                  });
                  event.currentTarget
                    .closest("details")
                    ?.removeAttribute("open");
                }}
              >
                {captureLabels.get(captureId)}
              </button>
            ))}
          </div>
        </details>
      </div>
      {activeIndex >= 0 ? (
        <div className={styles.patternNodeToolbar}>
          <span className={styles.patternMeta}>바꿀 순서</span>
          <span className={styles.patternToolbarActions}>
            <IconButton
              size="sm"
              label="바꿀 조각 왼쪽으로 이동"
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
              label="바꿀 조각 오른쪽으로 이동"
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
              label="바꿀 조각 삭제"
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

function AdvancedPatternCode({
  matcher,
  replacement,
  onChangeMatcher,
  onChangeReplacement,
  onSwitchToRaw,
}: PatternBuilderProps) {
  let compiled;
  try {
    compiled = compileConditionalTextMatcher(matcher);
  } catch (error) {
    void error;
    compiled = null;
  }
  return (
    <details className={styles.patternAdvanced}>
      <summary>
        <IconBraces size={14} /> 정규식 코드 보기
      </summary>
      <div>
        <code>
          {compiled ? `/${compiled.source}/${compiled.flags}` : "패턴 오류"}
        </code>
        {compiled ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              const rawMatcher: ConditionalTextMatcherV3 = {
                mode: "regex",
                source: compiled.source,
                caseSensitive: matcher.caseSensitive,
              };
              const rawReplacement =
                replacement?.mode === "visual"
                  ? ({
                      mode: "raw",
                      source: replacement.parts
                        .map((part) => {
                          if (part.kind === "literal") return part.text;
                          const name = compiled.captureNames.get(
                            part.captureId,
                          );
                          return name ? `$<${name}>` : "";
                        })
                        .join(""),
                    } satisfies ConditionalReplacementV3)
                  : replacement;
              if (onSwitchToRaw) {
                onSwitchToRaw(rawMatcher, rawReplacement);
              } else {
                onChangeMatcher(rawMatcher);
                if (rawReplacement && onChangeReplacement) {
                  onChangeReplacement(rawReplacement);
                }
              }
            }}
          >
            직접 수정
          </Button>
        ) : null}
      </div>
    </details>
  );
}

function RawPatternEditor({
  matcher,
  replacement,
  onChangeMatcher,
  onChangeReplacement,
  onSwitchToVisual,
}: PatternBuilderProps & {
  matcher: Extract<ConditionalTextMatcherV3, { mode: "regex" }>;
}) {
  const visual = tryConvertConditionalRegexToVisual(matcher, replacement);
  let error: string | null = null;
  try {
    compileConditionalTextMatcher(matcher);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  return (
    <details className={styles.rawPatternEditor} open>
      <summary>고급 패턴</summary>
      <label className={styles.rawPatternField}>
        <span>정규식</span>
        <input
          aria-label="정규식 코드"
          value={matcher.source}
          aria-invalid={Boolean(error)}
          onChange={(event) =>
            onChangeMatcher({ ...matcher, source: event.target.value })
          }
        />
      </label>
      {replacement && onChangeReplacement ? (
        <label className={styles.rawPatternField}>
          <span>바꾸기</span>
          <input
            value={
              replacement.mode === "raw"
                ? replacement.source
                : replacement.parts
                    .map((part) => (part.kind === "literal" ? part.text : ""))
                    .join("")
            }
            onChange={(event) =>
              onChangeReplacement({ mode: "raw", source: event.target.value })
            }
          />
        </label>
      ) : null}
      <div className={styles.patternOptions}>
        <CheckboxField
          checked={matcher.caseSensitive}
          label="대소문자 구분"
          onCheckedChange={(caseSensitive) =>
            onChangeMatcher({ ...matcher, caseSensitive })
          }
        />
        <CheckboxField
          checked={Boolean(matcher.multiline)}
          label="여러 줄"
          onCheckedChange={(multiline) =>
            onChangeMatcher({ ...matcher, multiline: multiline || undefined })
          }
        />
        <CheckboxField
          checked={Boolean(matcher.dotAll)}
          label="줄바꿈 포함"
          onCheckedChange={(dotAll) =>
            onChangeMatcher({ ...matcher, dotAll: dotAll || undefined })
          }
        />
        {visual ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (onSwitchToVisual) {
                onSwitchToVisual(visual.matcher, visual.replacement);
                return;
              }
              onChangeMatcher(visual.matcher);
              if (visual.replacement && onChangeReplacement) {
                onChangeReplacement(visual.replacement);
              }
            }}
          >
            조립식으로 돌아가기
          </Button>
        ) : null}
      </div>
      {error ? <div className={styles.patternError}>{error}</div> : null}
    </details>
  );
}

function createPatternNode(
  kind:
    | "literal"
    | "number"
    | "letter"
    | "whitespace"
    | "newline"
    | "any"
    | "choice"
    | "start"
    | "end"
    | "group",
): ConditionalPatternNodeV3 {
  const id = createConditionalPatternId(kind);
  if (kind === "start" || kind === "end") {
    return { id, kind: "boundary", boundary: kind };
  }
  const repeat = createConditionalPatternRepeat({
    ...(kind === "any" ? { min: 1, max: null, greedy: false } : {}),
  });
  if (kind === "literal") return { id, kind, text: "", repeat };
  if (kind === "choice") {
    return { id, kind, options: ["후보 1", "후보 2"], repeat };
  }
  if (kind === "group") {
    return {
      id,
      kind,
      repeat,
      nodes: [
        {
          id: createConditionalPatternId("literal"),
          kind: "literal",
          text: "",
          repeat: createConditionalPatternRepeat(),
        },
      ],
    };
  }
  return { id, kind: "character", character: kind, repeat };
}

function patternNodeLabel(node: ConditionalPatternNodeV3): string {
  if (node.kind === "boundary") {
    return node.boundary === "start" ? "말풍선 처음" : "말풍선 끝";
  }
  if (node.kind === "character") return CHARACTER_LABELS[node.character];
  if (node.kind === "choice") return node.options.join(" 또는 ");
  if (node.kind === "group") return `묶음 ${node.nodes.length}개`;
  return node.text;
}

function repeatPreset(repeat: ConditionalPatternRepeatV3): string {
  if (repeat.min === 1 && repeat.max === 1) return "once";
  if (repeat.min === 0 && repeat.max === 1) return "optional";
  if (repeat.min === 1 && repeat.max === null) return "oneOrMore";
  if (repeat.min === 0 && repeat.max === null) return "zeroOrMore";
  if (repeat.min === repeat.max) return "exact";
  return "range";
}

function repeatFromPreset(
  preset: string,
  previous: ConditionalPatternRepeatV3,
): ConditionalPatternRepeatV3 {
  if (preset === "once") return { min: 1, max: 1, greedy: true };
  if (preset === "optional") return { min: 0, max: 1, greedy: true };
  if (preset === "oneOrMore") return { min: 1, max: null, greedy: true };
  if (preset === "zeroOrMore") return { min: 0, max: null, greedy: true };
  if (preset === "exact") {
    const count = Math.max(1, previous.min);
    return { min: count, max: count, greedy: true };
  }
  return {
    min: previous.min,
    max: previous.max === null ? Math.max(previous.min + 1, 2) : previous.max,
    greedy: true,
  };
}

function repeatLabel(repeat: ConditionalPatternRepeatV3): string {
  const preset = repeatPreset(repeat);
  if (preset === "once") return "한 번";
  if (preset === "optional") return "있어도 됨";
  if (preset === "oneOrMore") return "1개 이상";
  if (preset === "zeroOrMore") return "여러 개";
  if (preset === "exact") return `${repeat.min}개`;
  return `${repeat.min}~${repeat.max ?? "∞"}개`;
}

function isOnce(repeat: ConditionalPatternRepeatV3): boolean {
  return repeat.min === 1 && repeat.max === 1;
}

function moveArrayItem<T>(items: T[], index: number, offset: -1 | 1): T[] {
  const target = index + offset;
  if (index < 0 || target < 0 || target >= items.length) return items;
  const next = [...items];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

function moveArrayItemTo<T>(items: T[], from: number, to: number): T[] {
  if (from < 0 || to < 0 || from >= items.length || to >= items.length) {
    return items;
  }
  const next = [...items];
  const [item] = next.splice(from, 1);
  if (item !== undefined) next.splice(to, 0, item);
  return next;
}
