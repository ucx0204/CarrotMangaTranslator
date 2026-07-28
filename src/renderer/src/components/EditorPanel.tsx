import React from "react";
import type { TranslationBlock } from "../../../shared/textTypes";
import type { BlockFormatGroupId } from "../../../shared/blockFormat";
import type { TransformEditorMode } from "../../../shared/panelBridgeTypes";
import { normalizeRenderDirection } from "../../../shared/geometry";
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
import { BlockDisplayGroup, EditorColorGroup } from "./EditorColorGroup";
import { FormatEditorGroup } from "./EditorFormatControls";
import {
  clampFontSize,
  resolveColor,
  type EditorPanelModel,
} from "./editorPanelUtils";
import { TransformEditorGroup } from "./TransformEditorGroup";

type EditorPanelProps = {
  block: TranslationBlock | null;
  disabled: boolean;
  areaTranslateAvailable?: boolean;
  areaTranslateSelecting?: boolean;
  disableChapterApply?: boolean;
  selectedBlockCount?: number;
  pageSize?: { width: number; height: number } | null;
  transformMode?: TransformEditorMode;
  /** Optional actions (e.g. float/dock toggle) rendered in the panel header. */
  headerActions?: React.ReactNode;
  onStartAreaTranslate?: () => void;
  onApplyFormat?: (
    scope: FormatApplyScope,
    groupIds: BlockFormatGroupId[],
  ) => void;
  onApplyBlockBackgroundOpacity?: (scope: BlockBackgroundApplyScope) => void;
  onAdjustFontSize: (adjustment: -1 | 1) => void;
  onUpdate: (patch: Partial<TranslationBlock>) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onRemoveBubbleLayout?: () => void;
  onSelectTransformMode?: (mode: TransformEditorMode) => void;
};

const EDITOR_TABS: EditorTabId[] = ["text", "layout", "format"];
const EDITOR_TAB_STORAGE_KEY = "editor.activeTab.v1";

export function EditorPanel({
  block,
  disabled,
  areaTranslateAvailable = false,
  areaTranslateSelecting = false,
  disableChapterApply = false,
  selectedBlockCount = 0,
  pageSize = null,
  transformMode = "select",
  headerActions,
  onStartAreaTranslate,
  onApplyFormat,
  onApplyBlockBackgroundOpacity,
  onAdjustFontSize,
  onUpdate,
  onDelete,
  onDuplicate,
  onRemoveBubbleLayout = () => undefined,
  onSelectTransformMode,
}: EditorPanelProps): React.JSX.Element {
  const [fontFamilyDraft, setFontFamilyDraft] = React.useState<
    string | undefined
  >(block?.fontFamily);
  const [activeTab, setActiveTab] = useEditorTab(transformMode);
  const panelIdBase = React.useId();

  React.useEffect(() => {
    setFontFamilyDraft(block?.fontFamily);
  }, [block?.id, block?.fontFamily]);

  if (!block) {
    return (
      <EmptyEditorPanel
        areaTranslateAvailable={areaTranslateAvailable}
        areaTranslateSelecting={areaTranslateSelecting}
        disabled={disabled}
        headerActions={headerActions}
        onStartAreaTranslate={onStartAreaTranslate}
      />
    );
  }

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
          onRemoveBubbleLayout,
          onSelect: setActiveTab,
          onUpdate,
        }}
      />
      <EditorBlockGroups
        {...{
          activeTab,
          baseId: panelIdBase,
          block,
          disabled,
          disableChapterApply,
          fontFamilyDraft,
          onAdjustFontSize,
          onApplyBlockBackgroundOpacity,
          onApplyFormat,
          onSelectTransformMode,
          onUpdate,
          pageSize,
          selectedBlockCount,
          setFontFamilyDraft,
          transformMode,
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
  fontFamilyDraft: string | undefined;
  onAdjustFontSize: EditorPanelProps["onAdjustFontSize"];
  onApplyBlockBackgroundOpacity?: EditorPanelProps["onApplyBlockBackgroundOpacity"];
  onApplyFormat: EditorPanelProps["onApplyFormat"];
  onSelectTransformMode?: EditorPanelProps["onSelectTransformMode"];
  onUpdate: EditorPanelProps["onUpdate"];
  pageSize: NonNullable<EditorPanelProps["pageSize"]> | null;
  selectedBlockCount: number;
  setFontFamilyDraft: React.Dispatch<React.SetStateAction<string | undefined>>;
  transformMode: TransformEditorMode;
};

function EditorBlockGroups({
  activeTab,
  baseId,
  block,
  disabled,
  disableChapterApply,
  fontFamilyDraft,
  onAdjustFontSize,
  onApplyBlockBackgroundOpacity,
  onApplyFormat,
  onSelectTransformMode,
  onUpdate,
  pageSize,
  selectedBlockCount,
  setFontFamilyDraft,
  transformMode,
}: EditorBlockGroupsProps): React.JSX.Element {
  const model = resolveEditorPanelModel(block);
  return (
    <>
      <EditorTabPanel activeTab={activeTab} baseId={baseId} tab="text">
        <TextEditorGroup
          block={block}
          disabled={disabled}
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
        <FormatEditorGroup
          block={block}
          disabled={disabled}
          disableChapterApply={disableChapterApply}
          fontFamilyDraft={fontFamilyDraft}
          model={model}
          onApplyFormat={onApplyFormat}
          onAdjustFontSize={onAdjustFontSize}
          onFontFamilyDraftChange={setFontFamilyDraft}
          onUpdate={onUpdate}
          selectedBlockCount={selectedBlockCount}
        />
        <EditorColorGroup
          block={block}
          disabled={disabled}
          model={model}
          onUpdate={onUpdate}
        />
        <BlockDisplayGroup
          block={block}
          disabled={disabled}
          disableChapterApply={disableChapterApply}
          onApply={onApplyBlockBackgroundOpacity}
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

function resolveEditorPanelModel(block: TranslationBlock): EditorPanelModel {
  return {
    autoFitText: block.autoFitText ?? true,
    fontSizePx: clampFontSize(block.fontSizePx),
    outlineColor: resolveColor(block.outlineColor, "#ffffff"),
    renderDirection: normalizeRenderDirection(
      block.renderDirection,
      "horizontal",
    ),
  };
}
