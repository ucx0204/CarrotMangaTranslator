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

function SelectedEditorPanel({
  block,
  disabled,
  disableChapterApply,
  selectedBlockCount,
  pageSize,
  transformMode,
  canCreateStylePreset,
  stylePresets,
  headerActions,
  onApplyFormat,
  onApplyStylePreset,
  onCreateStylePreset,
  onApplyBlockBackgroundOpacity,
  onAdjustFontSize,
  onUpdate,
  onDelete,
  onDuplicate,
  onEraseOriginal,
  onFitBubble,
  onRemoveBubbleLayout,
  onSelectTransformMode,
}: EditorPanelProps & { block: TranslationBlock }): React.JSX.Element {
  const fontFamilyDraftState = React.useState(block.fontFamily);
  const [fontFamilyDraft, setFontFamilyDraft] = fontFamilyDraftState;
  const resolvedTransformMode = transformMode ?? "select";
  const [activeTab, setActiveTab] = useEditorTab(resolvedTransformMode);
  const panelIdBase = React.useId();

  React.useEffect(() => {
    setFontFamilyDraft(block.fontFamily);
  }, [block.id, block.fontFamily, setFontFamilyDraft]);

  return (
    <section className="editor-panel has-block">
      <SelectedBlockHeader
        {...{
          activeTab,
          baseId: panelIdBase,
          block,
          disabled,
          headerActions,
          onDelete,
          onDuplicate,
          onRemoveBubbleLayout:
            onRemoveBubbleLayout ?? NOOP_REMOVE_BUBBLE_LAYOUT,
          onSelect: setActiveTab,
          onUpdate,
        }}
      />
      <EditorBlockGroups
        {...{
          activeTab,
          baseId: panelIdBase,
          block,
          canCreateStylePreset: canCreateStylePreset ?? false,
          disabled,
          disableChapterApply: disableChapterApply ?? false,
          fontFamilyDraft,
          onAdjustFontSize,
          onApplyBlockBackgroundOpacity,
          onApplyFormat,
          onApplyStylePreset: onApplyStylePreset ?? NOOP_STYLE_PRESET_APPLY,
          onCreateStylePreset: onCreateStylePreset ?? NOOP_STYLE_PRESET_CREATE,
          onEraseOriginal,
          onFitBubble,
          onSelectTransformMode,
          onUpdate,
          pageSize: pageSize ?? null,
          selectedBlockCount: selectedBlockCount ?? 0,
          stylePresets: stylePresets ?? EMPTY_STYLE_PRESETS,
          setFontFamilyDraft,
          transformMode: resolvedTransformMode,
        }}
      />
    </section>
  );
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
  onCreateStylePreset: NonNullable<EditorPanelProps["onCreateStylePreset"]>;
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
  baseId,
  block,
  disabled,
  disableChapterApply,
  onEraseOriginal,
  onFitBubble,
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
          block={block}
          disabled={disabled}
          disableChapterApply={disableChapterApply}
          onUpdate={onUpdate}
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
