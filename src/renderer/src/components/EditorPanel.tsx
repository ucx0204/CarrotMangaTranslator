import React from "react";
import type { TranslationBlock } from "../../../shared/textTypes";
import type { BlockFormatGroupId } from "../../../shared/blockFormat";
import type {
  PanelFormatSelection,
  TransformEditorMode,
} from "../../../shared/panelBridgeTypes";
import type { FormatApplyScope } from "../hooks/blockEditingStatus";
import type { BlockBackgroundApplyScope } from "../hooks/useApplyBlockBackgroundOpacityAction";
import {
  SelectedBlockHeader,
  EditorPanelTabs,
  EditorTabPanel,
  EmptyEditorPanel,
  type EditorTabId,
} from "./EditorPanelChrome";
import { TextEditorGroup } from "./EditorPanelSections";
import { TransformEditorGroup } from "./TransformEditorGroup";
import type {
  BlockStylePresetSummary,
  CreateBlockStylePresetInput,
} from "../../../shared/blockStylePresets";
import { EditorFormatGroups } from "./EditorFormatGroups";
import { useEditorPanelTab } from "./useEditorPanelTab";

type EditorPanelProps = {
  generatedLetteringControls?: React.ReactNode;
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
  selectionKey?: string;
  formatSelection?: PanelFormatSelection;
  editorTextTabRequestToken?: number;
  pageSize?: { width: number; height: number } | null;
  /** Actual base size currently rendered on the source page, in page pixels. */
  resolvedFontSizePx?: number | null;
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
  aiUnavailable?: boolean;
  onEraseOriginal?: () => void;
  onFitBubble?: () => void;
  onRemoveBubbleLayout?: () => void;
  onSelectTransformMode?: (mode: TransformEditorMode) => void;
};

const EMPTY_STYLE_PRESETS: readonly BlockStylePresetSummary[] = [];
const EMPTY_FORMAT_SELECTION: PanelFormatSelection = {
  common: {},
  mixedFields: [],
};
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
    (props.selectedBlockCount ?? 0) > 1
      ? (props.selectionKey ?? String(props.selectedBlockCount))
      : "",
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
      {props.generatedLetteringControls}
      <EditorBlockGroups
        activeTab={activeTab}
        activeStylePresetId={presetSelection.activePresetId}
        baseId={baseId}
        block={block}
        canCreateStylePreset={props.canCreateStylePreset ?? false}
        disabled={props.disabled}
        disableChapterApply={props.disableChapterApply ?? false}
        fontFamilyDraft={fontFamilyDraft}
        formatSelection={resolveFormatSelection(props.formatSelection)}
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
        aiUnavailable={props.aiUnavailable}
        onEraseOriginal={props.onEraseOriginal}
        onFitBubble={props.onFitBubble}
        onSelectTransformMode={props.onSelectTransformMode}
        onUpdate={props.onUpdate}
        onUpdateFormat={props.onUpdateFormat ?? props.onUpdate}
        pageSize={props.pageSize ?? null}
        resolvedFontSizePx={nullableFontSizePx(props.resolvedFontSizePx)}
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

function nullableFontSizePx(value: number | null | undefined): number | null {
  return value ?? null;
}

function resolveFormatSelection(
  value: PanelFormatSelection | undefined,
): PanelFormatSelection {
  return value ?? EMPTY_FORMAT_SELECTION;
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

type EditorBlockGroupsProps = {
  activeTab: EditorTabId;
  activeStylePresetId: string;
  baseId: string;
  block: TranslationBlock;
  disabled: boolean;
  disableChapterApply: boolean;
  canCreateStylePreset: boolean;
  fontFamilyDraft: string | undefined;
  formatSelection: PanelFormatSelection;
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
  aiUnavailable?: boolean;
  onEraseOriginal?: EditorPanelProps["onEraseOriginal"];
  onFitBubble?: EditorPanelProps["onFitBubble"];
  onSuggestConsistentEdit?: EditorPanelProps["onSuggestConsistentEdit"];
  onSelectTransformMode?: EditorPanelProps["onSelectTransformMode"];
  onUpdate: EditorPanelProps["onUpdate"];
  onUpdateFormat: EditorPanelProps["onUpdate"];
  pageSize: NonNullable<EditorPanelProps["pageSize"]> | null;
  resolvedFontSizePx: number | null;
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
  aiUnavailable,
  onEraseOriginal,
  onFitBubble,
  onSuggestConsistentEdit,
  onClearStylePreset,
  onSelectTransformMode,
  onUpdate,
  onUpdateFormat,
  pageSize,
  resolvedFontSizePx,
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
          aiUnavailable={aiUnavailable}
          onEraseOriginal={onEraseOriginal}
          onFitBubble={onFitBubble}
          onSuggestConsistentEdit={onSuggestConsistentEdit}
          onUpdate={onUpdate}
        />
      </EditorTabPanel>
      <EditorTabPanel activeTab={activeTab} baseId={baseId} tab="layout">
        <TransformEditorGroup
          key={block.id}
          block={block}
          disabled={disabled}
          mode={transformMode}
          pageSize={pageSize}
          templateMode={templateMode}
          onSelectMode={onSelectTransformMode ?? NOOP_ACTION}
          onUpdate={onUpdate}
        />
      </EditorTabPanel>
      <EditorTabPanel activeTab={activeTab} baseId={baseId} tab="format">
        <EditorFormatGroups
          {...formatProps}
          activeStylePresetId={activeStylePresetId}
          block={block}
          disabled={disabled}
          disableChapterApply={disableChapterApply}
          resolvedFontSizePx={resolvedFontSizePx}
          onUpdate={(patch) => {
            onClearStylePreset();
            onUpdateFormat(patch);
          }}
        />
      </EditorTabPanel>
    </>
  );
}
