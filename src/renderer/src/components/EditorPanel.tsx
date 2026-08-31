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
import { useEditorPanelTab } from "./useEditorPanelTab";

type EditorPanelProps = {
  block: TranslationBlock | null;
  disabled: boolean;
  /** Embeds the production editor controls without page-level panel chrome. */
  embedded?: boolean;
  /** Hides page-position controls that are not persisted by a template. */
  templateMode?: boolean;
  showStylePresets?: boolean;
  areaTranslateAvailable?: boolean;
  areaTranslateSelecting?: boolean;
  disableChapterApply?: boolean;
  selectedBlockCount?: number;
  editorTextTabRequestToken?: number;
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
  onOpenStylePresetManager?: () => void;
  onOpenFontManager?: () => void;
  onOverwriteStylePreset?: (presetId: string) => boolean | Promise<boolean>;
  onRenameStylePreset?: (
    presetId: string,
    name: string,
  ) => boolean | Promise<boolean>;
  onApplyBlockBackgroundOpacity?: (scope: BlockBackgroundApplyScope) => void;
  onAdjustFontSize: (adjustment: -1 | 1) => void;
  onUpdate: (patch: Partial<TranslationBlock>) => void;
  onUpdateFormat?: (patch: Partial<TranslationBlock>) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onSaveToLibrary?: () => void;
  onSuggestConsistentEdit?: (find: string, replace: string) => void;
  onEraseOriginal?: () => void;
  onFitBubble?: () => void;
  onRemoveBubbleLayout?: () => void;
  onSelectTransformMode?: (mode: TransformEditorMode) => void;
};

const EMPTY_STYLE_PRESETS: readonly BlockStylePresetSummary[] = [];
const NOOP_ACTION = (): void => undefined;
const NOOP_RESULT = (): boolean => false;

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
  const [activeTab, setActiveTab] = useEditorPanelTab(
    resolvedTransformMode,
    props.editorTextTabRequestToken ?? 0,
    props.block.sourceText.trim().length === 0 &&
      props.block.translatedText.trim().length === 0,
  );
  const panelIdBase = React.useId();
  const presetSelection = useAppliedStylePreset(props);

  return (
    <section className="editor-panel has-block">
      {props.embedded ? (
        <div className="editor-panel-sticky">
          <EditorPanelTabs
            activeTab={activeTab}
            baseId={panelIdBase}
            onSelect={setActiveTab}
          />
        </div>
      ) : (
        <SelectedBlockHeader
          activeTab={activeTab}
          baseId={panelIdBase}
          block={props.block}
          disabled={props.disabled}
          headerActions={props.headerActions}
          onDelete={props.onDelete}
          onDuplicate={props.onDuplicate}
          onSaveToLibrary={props.onSaveToLibrary ?? NOOP_ACTION}
          onRemoveBubbleLayout={props.onRemoveBubbleLayout ?? NOOP_ACTION}
          onSelect={setActiveTab}
          onUpdate={props.onUpdate}
        />
      )}
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
        onCreateStylePreset={props.onCreateStylePreset ?? NOOP_RESULT}
        onDeleteStylePreset={presetSelection.delete}
        onOpenStylePresetManager={props.onOpenStylePresetManager}
        onOpenFontManager={props.onOpenFontManager}
        onOverwriteStylePreset={props.onOverwriteStylePreset ?? NOOP_RESULT}
        onRenameStylePreset={props.onRenameStylePreset ?? NOOP_RESULT}
        onEraseOriginal={props.onEraseOriginal}
        onFitBubble={props.onFitBubble}
        onSelectTransformMode={props.onSelectTransformMode}
        onUpdate={props.onUpdate}
        onUpdateFormat={props.onUpdateFormat ?? props.onUpdate}
        pageSize={props.pageSize ?? null}
        selectedBlockCount={props.selectedBlockCount ?? 0}
        showStylePresets={props.showStylePresets ?? true}
        stylePresets={props.stylePresets ?? EMPTY_STYLE_PRESETS}
        setFontFamilyDraft={setFontFamilyDraft}
        templateMode={props.templateMode ?? false}
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
  onApplyStylePreset = NOOP_ACTION,
  onDeleteStylePreset = NOOP_RESULT,
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
  onSaveToLibrary,
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
  onSaveToLibrary: () => void;
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
              onSaveToLibrary={onSaveToLibrary}
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
  onOpenStylePresetManager?: EditorPanelProps["onOpenStylePresetManager"];
  onOpenFontManager?: EditorPanelProps["onOpenFontManager"];
  onOverwriteStylePreset: NonNullable<
    EditorPanelProps["onOverwriteStylePreset"]
  >;
  onRenameStylePreset: NonNullable<EditorPanelProps["onRenameStylePreset"]>;
  onEraseOriginal?: EditorPanelProps["onEraseOriginal"];
  onFitBubble?: EditorPanelProps["onFitBubble"];
  onSuggestConsistentEdit?: EditorPanelProps["onSuggestConsistentEdit"];
  onSelectTransformMode?: EditorPanelProps["onSelectTransformMode"];
  onUpdate: EditorPanelProps["onUpdate"];
  onUpdateFormat: EditorPanelProps["onUpdate"];
  pageSize: NonNullable<EditorPanelProps["pageSize"]> | null;
  selectedBlockCount: number;
  showStylePresets: boolean;
  stylePresets: readonly BlockStylePresetSummary[];
  setFontFamilyDraft: React.Dispatch<React.SetStateAction<string | undefined>>;
  templateMode: boolean;
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
  onSuggestConsistentEdit,
  onClearStylePreset,
  onSelectTransformMode,
  onUpdate,
  onUpdateFormat,
  pageSize,
  templateMode,
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
          onSuggestConsistentEdit={onSuggestConsistentEdit}
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
            templateMode,
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
            onUpdateFormat(patch);
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
  templateMode,
  transformMode,
}: {
  block: TranslationBlock;
  disabled: boolean;
  onSelectTransformMode?: (mode: TransformEditorMode) => void;
  onUpdate: EditorPanelProps["onUpdate"];
  pageSize: NonNullable<EditorPanelProps["pageSize"]> | null;
  templateMode: boolean;
  transformMode: TransformEditorMode;
}): React.JSX.Element {
  return (
    <TransformEditorGroup
      block={block}
      disabled={disabled}
      mode={transformMode}
      pageSize={pageSize}
      templateMode={templateMode}
      onSelectMode={onSelectTransformMode ?? (() => undefined)}
      onUpdate={onUpdate}
    />
  );
}
