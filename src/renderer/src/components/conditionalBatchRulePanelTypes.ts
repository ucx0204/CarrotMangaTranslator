import type { BlockStylePreset } from "../../../shared/blockStylePresets";
import type {
  ConditionalBatchPreviewResult,
  ConditionalBatchRecipeId,
  ConditionalBatchSchemeDraftV2,
  ConditionalBatchSchemeV2,
  ConditionalBatchSequencePreview,
  ConditionalBatchSequenceV2,
} from "../../../shared/conditionalBatchRules";
import type {
  ConditionalBatchApplyNotice,
  ConditionalBatchTemporaryScheme,
} from "./useConditionalBatchSchemeController";

type ConditionalBatchScopeKind = "selection" | "page" | "chapter";

export type ConditionalBatchRulePanelProps = {
  activeSequence: ConditionalBatchSequenceV2 | null;
  applyNotice: ConditionalBatchApplyNotice;
  autosaveState: "idle" | "waiting" | "saving" | "saved" | "error";
  blockStylePresets: readonly BlockStylePreset[];
  canDeleteScheme: boolean;
  currentResult: ConditionalBatchPreviewResult | null;
  draft: ConditionalBatchSchemeDraftV2;
  favoriteSchemeIds: readonly string[];
  recipePickerCanClose: boolean;
  recipePickerOpen: boolean;
  savedSchemes: readonly ConditionalBatchSchemeV2[];
  scopeKind: ConditionalBatchScopeKind;
  selectedBlockCount: number;
  selectedSchemeId: string;
  sequences: readonly ConditionalBatchSequenceV2[];
  sequencePreview: ConditionalBatchSequencePreview | null;
  storageBusy: boolean;
  storageError: string | null;
  temporarySchemes: readonly ConditionalBatchTemporaryScheme[];
  validationMessage: string | null;
  yamlError: string | null;
  yamlOpen: boolean;
  yamlText: string;
  onChangeDraft: (draft: ConditionalBatchSchemeDraftV2) => void;
  onChangeScope: (scope: ConditionalBatchScopeKind) => void;
  onChooseRecipe: (
    recipe: ConditionalBatchRecipeId,
    preset?: BlockStylePreset,
  ) => void;
  onCloseRecipePicker: () => void;
  onDeleteScheme: () => void;
  onDeleteSequence: (id: string) => void;
  onDuplicateScheme: () => void;
  onExportYaml: (all: boolean) => void;
  onImportYaml: (policy?: "duplicate" | "overwrite") => void;
  onExitSequence: () => void;
  onNewScheme: () => void;
  onOpenYaml: () => void;
  onOpenYamlFile: () => void;
  onReflectYaml: () => void;
  onPreviewSequence: (id: string) => void;
  onSaveScheme: () => void;
  onSaveSequence: (sequence: ConditionalBatchSequenceV2) => void;
  onSelectScheme: (id: string) => void;
  onSetYamlOpen: (open: boolean) => void;
  onSetYamlText: (text: string) => void;
  onToggleSchemeFavorite: (id: string) => void;
};
