import React from "react";
import type { TranslationBlock } from "../../../shared/textTypes";
import type { BlockFormatGroupId } from "../../../shared/blockFormat";
import type { TransformEditorMode } from "../../../shared/panelBridgeTypes";
import type { FormatApplyScope } from "../hooks/blockEditingStatus";
import type { BlockBackgroundApplyScope } from "../hooks/useApplyBlockBackgroundOpacityAction";
import {
  BlockOverflowMenu,
  EditorPanelHeader,
  EditorPanelTabs,
  EditorTabPanel,
  EmptyEditorPanel,
  type EditorTabId,
} from "./EditorPanelChrome";
import { BubbleLayoutOption, TextEditorGroup } from "./EditorPanelSections";
import { TransformEditorGroup } from "./TransformEditorGroup";
import type {
  BlockStylePresetSummary,
  CreateBlockStylePresetInput,
} from "../../../shared/blockStylePresets";
import { EditorFormatGroups } from "./EditorFormatGroups";

type EditorPanelProps = {
  block: TranslationBlock | null;
  disabled: boolean;
  areaTranslateAvailable?: boolean;
  areaTranslateSelecting?: boolean;
  disableChapterApply?: boolean;
  selectedBlockCount?: number;
  pageSize?: { width: number; height: number } | null;
  transformMode?: TransformEditorMode;
  canCreateStylePreset?: boolean;
  stylePresets?: readonly BlockStylePresetSummary[];
  /** Optional actions (e.g. float/dock toggle) rendered in the panel header. */
  headerActions?: React.ReactNode;
  onStartAreaTranslate?: () => void;
  onApplyFormat?: (
    scope: FormatApplyScope,
    groupIds: BlockFormatGroupId[],
  ) => void;
  onApplyStylePreset?: (presetId: string) => void;
  onCreateStylePreset?: (
    input: CreateBlockStylePresetInput,
  ) => boolean | Promise<boolean>;
  onDeleteStylePreset?: (presetId: string) => boolean | Promise<boolean>;
  onApplyBlockBackgroundOpacity?: (scope: BlockBackgroundApplyScope) => void;
  onAdjustFontSize: (adjustment: -1 | 1) => void;
  onUpdate: (patch: Partial<TranslationBlock>) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onEraseOriginal?: () => void;
  onFitBubble?: () => void;
  onRemoveBubbleLayout?: () => void;
  onSelectTransformMode?: (mode: TransformEditorMode) => void;
};

const EDITOR_TABS: EditorTabId[] = ["text", "layout", "format"];
const EDITOR_TAB_STORAGE_KEY = "editor.activeTab.v1";
const EMPTY_STYLE_PRESETS: readonly BlockStylePresetSummary[] = [];
const NOOP_STYLE_PRESET_APPLY = (): void => undefined;
const NOOP_STYLE_PRESET_CREATE = (): boolean => false;
const NOOP_STYLE_PRESET_DELETE = (): boolean => false;
const NOOP_REMOVE_BUBBLE_LAYOUT = (): void => undefined;

export function EditorPanel(props: EditorPanelProps): React.JSX.Element {
  if (props.block) {
    return <SelectedEditorPanel {...props} block={props.block} />;
  }
  return (
    <EmptyEditorPanel
      areaTranslateAvailable={props.areaTranslateAvailable ?? false}
      areaTranslateSelecting={props.areaTranslateSelecting ?? false}
      disabled={props.disabled}
      headerActions={props.headerActions}
      onStartAreaTranslate={props.onStartAreaTranslate}
    />
  );
}

type SelectedEditorPanelProps = EditorPanelProps & { block: TranslationBlock };

function SelectedEditorPanel(
  props: SelectedEditorPanelProps,
): React.JSX.Element {
  const resolvedTransformMode = props.transformMode ?? "select";
  const [activeTab, setActiveTab] = useEditorTab(resolvedTransformMode);
  const panelIdBase = React.useId();
  const presetSelection = useAppliedStylePreset(props);

  return (
    <section className="editor-panel has-block">
      <SelectedBlockHeader
        activeTab={activeTab}
        baseId={panelIdBase}
        block={props.block}
        disabled={props.disabled}
        headerActions={props.headerActions}
        onDelete={props.onDelete}
        onDuplicate={props.onDuplicate}
        onRemoveBubbleLayout={
          props.onRemoveBubbleLayout ?? NOOP_REMOVE_BUBBLE_LAYOUT
        }
        onSelect={setActiveTab}
        onUpdate={props.onUpdate}
      />
      <SelectedEditorPanelBody
        {...props}
        activeTab={activeTab}
        baseId={panelIdBase}
        presetSelection={presetSelection}
        transformMode={resolvedTransformMode}
      />
    </section>
  );
}

function SelectedEditorPanelBody({
  activeTab,
  baseId,
  block,
  presetSelection,
  transformMode,
  ...props
}: SelectedEditorPanelProps & {
  activeTab: EditorTabId;
  baseId: string;
  presetSelection: AppliedStylePresetSelection;
  transformMode: TransformEditorMode;
}): React.JSX.Element {
  const [fontFamilyDraft, setFontFamilyDraft] = React.useState(
    block.fontFamily,
  );
  React.useEffect(() => {
    setFontFamilyDraft(block.fontFamily);
  }, [block.id, block.fontFamily]);
  return (
    <div className="editor-panel-body">
      <EditorBlockGroups
        activeTab={activeTab}
        activeStylePresetId={presetSelection.activePresetId}
        baseId={baseId}
        block={block}
        canCreateStylePreset={props.canCreateStylePreset ?? false}
        disabled={props.disabled}
        disableChapterApply={props.disableChapterApply ?? false}
        fontFamilyDraft={fontFamilyDraft}
        onAdjustFontSize={props.onAdjustFontSize}
        onApplyBlockBackgroundOpacity={props.onApplyBlockBackgroundOpacity}
        onApplyFormat={props.onApplyFormat}
        onApplyStylePreset={presetSelection.apply}
        onClearStylePreset={presetSelection.clear}
        onCreateStylePreset={
          props.onCreateStylePreset ?? NOOP_STYLE_PRESET_CREATE
        }
        onDeleteStylePreset={presetSelection.delete}
        onEraseOriginal={props.onEraseOriginal}
        onFitBubble={props.onFitBubble}
        onSelectTransformMode={props.onSelectTransformMode}
        onUpdate={props.onUpdate}
        pageSize={props.pageSize ?? null}
        selectedBlockCount={props.selectedBlockCount ?? 0}
        stylePresets={props.stylePresets ?? EMPTY_STYLE_PRESETS}
        setFontFamilyDraft={setFontFamilyDraft}
        transformMode={transformMode}
      />
    </div>
  );
}

type AppliedStylePresetSelection = {
  activePresetId: string;
  apply: (presetId: string) => void;
  clear: () => void;
  delete: (presetId: string) => Promise<boolean>;
};

function useAppliedStylePreset({
  block,
  onApplyStylePreset = NOOP_STYLE_PRESET_APPLY,
  onDeleteStylePreset = NOOP_STYLE_PRESET_DELETE,
}: SelectedEditorPanelProps): AppliedStylePresetSelection {
  const [applied, setApplied] = React.useState<{
    blockId: string;
    presetId: string;
  } | null>(null);
  return {
    activePresetId: applied?.blockId === block.id ? applied.presetId : "",
    apply: (presetId) => {
      setApplied({ blockId: block.id, presetId });
      onApplyStylePreset(presetId);
    },
    clear: () => setApplied(null),
    delete: async (presetId) => {
      const deleted = await onDeleteStylePreset(presetId);
      if (deleted && applied?.presetId === presetId) setApplied(null);
      return deleted;
    },
  };
}

function SelectedBlockHeader({
  activeTab,
  baseId,
  block,
  disabled,
  headerActions,
  onDelete,
  onDuplicate,
  onRemoveBubbleLayout,
  onSelect,
  onUpdate,
}: {
  activeTab: EditorTabId;
  baseId: string;
  block: TranslationBlock;
  disabled: boolean;
  headerActions?: React.ReactNode;
  onDelete: () => void;
  onDuplicate: () => void;
  onRemoveBubbleLayout: () => void;
  onSelect: (tab: EditorTabId) => void;
  onUpdate: EditorPanelProps["onUpdate"];
}): React.JSX.Element {
  return (
    <div className="editor-panel-sticky">
      <EditorPanelHeader
        excluded={Boolean(block.inpaintExcluded)}
        actions={
          <>
            {headerActions}
            <BlockOverflowMenu
              block={block}
              disabled={disabled}
              onDelete={onDelete}
              onDuplicate={onDuplicate}
              onUpdate={onUpdate}
            />
          </>
        }
      />
      <EditorPanelTabs
        activeTab={activeTab}
        baseId={baseId}
        onSelect={onSelect}
      />
      {block.bubbleLayout ? (
        <BubbleLayoutOption
          disabled={disabled}
          onRemove={onRemoveBubbleLayout}
        />
      ) : null}
    </div>
  );
}

type EditorBlockGroupsProps = {
  activeTab: EditorTabId;
  activeStylePresetId: string;
  baseId: string;
  block: TranslationBlock;
  disabled: boolean;
  disableChapterApply: boolean;
  canCreateStylePreset: boolean;
  fontFamilyDraft: string | undefined;
  onAdjustFontSize: EditorPanelProps["onAdjustFontSize"];
  onApplyBlockBackgroundOpacity?: EditorPanelProps["onApplyBlockBackgroundOpacity"];
  onApplyFormat: EditorPanelProps["onApplyFormat"];
  onApplyStylePreset: NonNullable<EditorPanelProps["onApplyStylePreset"]>;
  onClearStylePreset: () => void;
  onCreateStylePreset: NonNullable<EditorPanelProps["onCreateStylePreset"]>;
  onDeleteStylePreset: NonNullable<EditorPanelProps["onDeleteStylePreset"]>;
  onEraseOriginal?: EditorPanelProps["onEraseOriginal"];
  onFitBubble?: EditorPanelProps["onFitBubble"];
  onSelectTransformMode?: EditorPanelProps["onSelectTransformMode"];
  onUpdate: EditorPanelProps["onUpdate"];
  pageSize: NonNullable<EditorPanelProps["pageSize"]> | null;
  selectedBlockCount: number;
  stylePresets: readonly BlockStylePresetSummary[];
  setFontFamilyDraft: React.Dispatch<React.SetStateAction<string | undefined>>;
  transformMode: TransformEditorMode;
};

function EditorBlockGroups({
  activeTab,
  activeStylePresetId,
  baseId,
  block,
  disabled,
  disableChapterApply,
  onEraseOriginal,
  onFitBubble,
  onClearStylePreset,
  onSelectTransformMode,
  onUpdate,
  pageSize,
  transformMode,
  ...formatProps
}: EditorBlockGroupsProps): React.JSX.Element {
  return (
    <>
      <EditorTabPanel activeTab={activeTab} baseId={baseId} tab="text">
        <TextEditorGroup
          block={block}
          disabled={disabled}
          onEraseOriginal={onEraseOriginal}
          onFitBubble={onFitBubble}
          onUpdate={onUpdate}
        />
      </EditorTabPanel>
      <EditorTabPanel activeTab={activeTab} baseId={baseId} tab="layout">
        <BlockTransformEditor
          key={block.id}
          {...{
            block,
            disabled,
            onSelectTransformMode,
            onUpdate,
            pageSize,
            transformMode,
          }}
        />
      </EditorTabPanel>
      <EditorTabPanel activeTab={activeTab} baseId={baseId} tab="format">
        <EditorFormatGroups
          {...formatProps}
          activeStylePresetId={activeStylePresetId}
          block={block}
          disabled={disabled}
          disableChapterApply={disableChapterApply}
          onUpdate={(patch) => {
            onClearStylePreset();
            onUpdate(patch);
          }}
        />
      </EditorTabPanel>
    </>
  );
}

function BlockTransformEditor({
  block,
  disabled,
  onSelectTransformMode,
  onUpdate,
  pageSize,
  transformMode,
}: {
  block: TranslationBlock;
  disabled: boolean;
  onSelectTransformMode?: (mode: TransformEditorMode) => void;
  onUpdate: EditorPanelProps["onUpdate"];
  pageSize: NonNullable<EditorPanelProps["pageSize"]> | null;
  transformMode: TransformEditorMode;
}): React.JSX.Element {
  return (
    <TransformEditorGroup
      block={block}
      disabled={disabled}
      mode={transformMode}
      pageSize={pageSize}
      onSelectMode={onSelectTransformMode ?? (() => undefined)}
      onUpdate={onUpdate}
    />
  );
}

function useEditorTab(
  transformMode: TransformEditorMode,
): [EditorTabId, (tab: EditorTabId) => void] {
  const [activeTab, setActiveTab] = React.useState<EditorTabId>(() =>
    transformMode === "select" ? readStoredEditorTab() : "layout",
  );
  const previousMode = React.useRef(transformMode);
  React.useEffect(() => {
    const shouldRevealLayout =
      previousMode.current === "select" && transformMode !== "select";
    previousMode.current = transformMode;
    if (shouldRevealLayout) setActiveTab("layout");
  }, [transformMode]);
  React.useEffect(() => {
    try {
      window.localStorage.setItem(EDITOR_TAB_STORAGE_KEY, activeTab);
    } catch (error) {
      console.warn("Editor tab state write failed", error);
    }
  }, [activeTab]);
  return [activeTab, setActiveTab];
}

function readStoredEditorTab(): EditorTabId {
  try {
    const stored = window.localStorage.getItem(EDITOR_TAB_STORAGE_KEY);
    return EDITOR_TABS.find((tab) => tab === stored) ?? "text";
  } catch (error) {
    console.warn("Editor tab state read failed", error);
    return "text";
  }
}
