/* eslint-disable max-lines -- persistence, migration-safe YAML exchange, and delayed autosave share one transactional state owner */
import React from "react";
import { parseDocument, stringify } from "yaml";
import type { BlockStylePreset } from "../../../shared/blockStylePresets";
import {
  CONDITIONAL_BATCH_SCHEMA_VERSION,
  ConditionalBatchSchemeDraftV2Schema,
  createBlankBatchSchemeDraft,
  createConditionalBatchClientId,
  createEmptyConditionalBatchSnapshot,
  createConditionalBatchRecipeDraft,
  parseConditionalBatchSnapshot,
  type ConditionalBatchRecipeId,
  type ConditionalBatchSchemeDraftV2,
  type ConditionalBatchSchemeV2,
  type ConditionalBatchSequenceV2,
  type ConditionalBatchSnapshotV2,
} from "../../../shared/conditionalBatchRules";
import { conditionalBatchGateway } from "../api/conditionalBatchGateway";

export type ConditionalBatchApplyNotice = {
  kind: "success" | "warning" | "info";
  message: string;
} | null;

export type ConditionalBatchParsedDraft = ReturnType<
  typeof ConditionalBatchSchemeDraftV2Schema.safeParse
>;

export type ConditionalBatchStorageState = {
  autosaveState: "idle" | "waiting" | "saving" | "saved" | "error";
  storageBusy: boolean;
  storageError: string | null;
};

type ControllerOptions = {
  initialFind?: string;
  initialReplace?: string;
  blockStylePresets?: readonly BlockStylePreset[];
};

export type ConditionalBatchTemporaryScheme = {
  id: string;
  name: string;
  dirty: boolean;
};

type TemporaryDraftSession = {
  id: string;
  draft: ConditionalBatchSchemeDraftV2;
  baseline: string;
};

// Rule selection, explicit first-save, delayed autosave and YAML exchange share
// one state owner so an IPC failure cannot partially replace the active draft.
// eslint-disable-next-line max-lines-per-function
export function useConditionalBatchSchemeController(
  options: ControllerOptions = {},
) {
  const initialDraft = React.useMemo(
    () =>
      createConditionalBatchRecipeDraft(
        options.initialFind ? "findReplace" : "blank",
        { find: options.initialFind, replace: options.initialReplace },
      ),
    [options.initialFind, options.initialReplace],
  );
  const initialTemporaryId = React.useMemo(() => createTemporarySchemeId(), []);
  const [draft, setDraft] =
    React.useState<ConditionalBatchSchemeDraftV2>(initialDraft);
  const [temporaryDrafts, setTemporaryDrafts] = React.useState<
    TemporaryDraftSession[]
  >(() => [
    {
      id: initialTemporaryId,
      draft: initialDraft,
      baseline: stableDraftString(initialDraft),
    },
  ]);
  const [snapshot, setSnapshot] =
    React.useState<ConditionalBatchSnapshotV2 | null>(null);
  const [selectedSchemeId, setSelectedSchemeId] =
    React.useState(initialTemporaryId);
  const [storageBusy, setStorageBusy] = React.useState(false);
  const [storageError, setStorageError] = React.useState<string | null>(null);
  const [autosaveState, setAutosaveState] =
    React.useState<ConditionalBatchStorageState["autosaveState"]>("idle");
  const [applyNotice, setApplyNotice] =
    React.useState<ConditionalBatchApplyNotice>(null);
  const [recipePickerOpen, setRecipePickerOpen] = React.useState(
    !options.initialFind,
  );
  const [recipePickerCanClose, setRecipePickerCanClose] = React.useState(false);
  const [yamlOpen, setYamlOpen] = React.useState(false);
  const [yamlText, setYamlText] = React.useState("");
  const [yamlError, setYamlError] = React.useState<string | null>(null);
  const lastSavedDraftRef = React.useRef("");
  const saveGenerationRef = React.useRef(0);

  React.useEffect(() => {
    let active = true;
    setStorageBusy(true);
    conditionalBatchGateway
      .listConditionalBatchSchemes()
      .then((loaded) => {
        if (!active) return;
        setSnapshot(loaded);
        setStorageError(null);
      })
      .catch((error: unknown) => {
        if (active) setStorageError(readErrorMessage(error));
      })
      .finally(() => {
        if (active) setStorageBusy(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const parsedDraft = React.useMemo(
    () => ConditionalBatchSchemeDraftV2Schema.safeParse(draft),
    [draft],
  );
  const stored = isStoredSchemeId(selectedSchemeId);
  const serializedDraft = parsedDraft.success
    ? stableDraftString(parsedDraft.data)
    : "";

  React.useEffect(() => {
    if (
      !stored ||
      !parsedDraft.success ||
      serializedDraft === lastSavedDraftRef.current
    ) {
      return;
    }
    setAutosaveState("waiting");
    const generation = ++saveGenerationRef.current;
    const timer = window.setTimeout(() => {
      setAutosaveState("saving");
      void conditionalBatchGateway
        .saveConditionalBatchScheme({
          id: selectedSchemeId,
          scheme: parsedDraft.data,
        })
        .then((next) => {
          if (generation !== saveGenerationRef.current) return;
          setSnapshot(next);
          lastSavedDraftRef.current = serializedDraft;
          setAutosaveState("saved");
          setStorageError(null);
        })
        .catch((error: unknown) => {
          if (generation !== saveGenerationRef.current) return;
          setAutosaveState("error");
          setStorageError(readErrorMessage(error));
        });
    }, 600);
    return () => window.clearTimeout(timer);
  }, [parsedDraft, selectedSchemeId, serializedDraft, stored]);

  const changeDraft = React.useCallback(
    (next: ConditionalBatchSchemeDraftV2): void => {
      setDraft(next);
      setTemporaryDrafts((current) =>
        current.map((session) =>
          session.id === selectedSchemeId
            ? { ...session, draft: next }
            : session,
        ),
      );
      setApplyNotice(null);
      setYamlError(null);
    },
    [selectedSchemeId],
  );

  const saveScheme = async (): Promise<void> => {
    if (!parsedDraft.success) return;
    setStorageBusy(true);
    setStorageError(null);
    setAutosaveState("saving");
    const generation = ++saveGenerationRef.current;
    try {
      const existingId = stored ? selectedSchemeId : undefined;
      const next = await conditionalBatchGateway.saveConditionalBatchScheme({
        id: existingId,
        scheme: parsedDraft.data,
      });
      if (generation !== saveGenerationRef.current) return;
      setSnapshot(next);
      const savedId = existingId ?? next.schemes[0]?.id;
      if (savedId) {
        setSelectedSchemeId(savedId);
        if (!stored) {
          setTemporaryDrafts((current) =>
            current.filter((session) => session.id !== selectedSchemeId),
          );
        }
      }
      lastSavedDraftRef.current = serializedDraft;
      setAutosaveState("saved");
    } catch (error) {
      if (generation !== saveGenerationRef.current) return;
      setAutosaveState("error");
      setStorageError(readErrorMessage(error));
    } finally {
      setStorageBusy(false);
    }
  };

  const removeTemporaryScheme = (): void => {
    ++saveGenerationRef.current;
    const remaining = temporaryDrafts.filter(
      (session) => session.id !== selectedSchemeId,
    );
    const fallbackTemporary = remaining.at(-1);
    setTemporaryDrafts(remaining);
    if (fallbackTemporary) {
      setSelectedSchemeId(fallbackTemporary.id);
      setDraft(structuredClone(fallbackTemporary.draft));
      lastSavedDraftRef.current = "";
      setRecipePickerOpen(false);
      setRecipePickerCanClose(false);
    } else {
      const fallbackStored = snapshot?.schemes[0];
      if (fallbackStored) {
        switchToSavedScheme(fallbackStored);
      } else {
        const next = createBlankBatchSchemeDraft();
        const id = createTemporarySchemeId();
        setSelectedSchemeId(id);
        setDraft(next);
        setTemporaryDrafts([
          { id, draft: next, baseline: stableDraftString(next) },
        ]);
        lastSavedDraftRef.current = "";
        setRecipePickerOpen(true);
        setRecipePickerCanClose(false);
      }
    }
    setStorageError(null);
    setApplyNotice(null);
    setAutosaveState("idle");
  };

  const deleteScheme = async (): Promise<void> => {
    if (!stored) {
      removeTemporaryScheme();
      return;
    }
    setStorageBusy(true);
    setStorageError(null);
    try {
      const next =
        await conditionalBatchGateway.deleteConditionalBatchScheme(
          selectedSchemeId,
        );
      setSnapshot(next);
      const fallback = next.schemes[0];
      if (fallback) {
        switchToSavedScheme(fallback);
      } else {
        resetToRecipe("ellipsis");
      }
    } catch (error) {
      setStorageError(readErrorMessage(error));
    } finally {
      setStorageBusy(false);
    }
  };

  const flushStoredDraft = async (): Promise<void> => {
    if (
      !stored ||
      !parsedDraft.success ||
      serializedDraft === lastSavedDraftRef.current
    ) {
      return;
    }
    const generation = ++saveGenerationRef.current;
    setAutosaveState("saving");
    try {
      const next = await conditionalBatchGateway.saveConditionalBatchScheme({
        id: selectedSchemeId,
        scheme: parsedDraft.data,
      });
      if (generation !== saveGenerationRef.current) return;
      setSnapshot(next);
      lastSavedDraftRef.current = serializedDraft;
      setAutosaveState("saved");
      setStorageError(null);
    } catch (error) {
      if (generation !== saveGenerationRef.current) return;
      setAutosaveState("error");
      setStorageError(readErrorMessage(error));
      throw error;
    }
  };

  const switchToSavedScheme = (selected: ConditionalBatchSchemeV2): void => {
    setSelectedSchemeId(selected.id);
    const nextDraft = copySavedSchemeAsDraft(selected);
    setDraft(nextDraft);
    lastSavedDraftRef.current = stableDraftString(nextDraft);
    setStorageError(null);
    setApplyNotice(null);
    setAutosaveState("idle");
    setRecipePickerOpen(false);
    setRecipePickerCanClose(false);
  };

  const selectScheme = async (id: string): Promise<void> => {
    if (id === selectedSchemeId) return;
    if (stored) {
      try {
        await flushStoredDraft();
      } catch (error) {
        setStorageError(readErrorMessage(error));
        return;
      }
    }
    const temporary = temporaryDrafts.find((entry) => entry.id === id);
    if (temporary) {
      ++saveGenerationRef.current;
      setSelectedSchemeId(id);
      setDraft(structuredClone(temporary.draft));
      lastSavedDraftRef.current = "";
      setStorageError(null);
      setApplyNotice(null);
      setAutosaveState("idle");
      setRecipePickerOpen(false);
      setRecipePickerCanClose(false);
      return;
    }
    const selected = snapshot?.schemes.find((entry) => entry.id === id);
    if (!selected) return;
    switchToSavedScheme(selected);
  };

  const resetToRecipe = (
    recipeId: ConditionalBatchRecipeId,
    preset?: BlockStylePreset,
  ): void => {
    const next = createConditionalBatchRecipeDraft(recipeId, {
      find: options.initialFind,
      replace: options.initialReplace,
      stylePreset: preset
        ? {
            id: preset.id,
            name: preset.name,
            groupIds: preset.groupIds,
            format: preset.format,
          }
        : undefined,
    });
    const id = createTemporarySchemeId();
    setSelectedSchemeId(id);
    setDraft(next);
    setTemporaryDrafts((current) => [
      ...current,
      { id, draft: next, baseline: stableDraftString(next) },
    ]);
    lastSavedDraftRef.current = "";
    setStorageError(null);
    setApplyNotice(null);
    setAutosaveState("idle");
    setRecipePickerOpen(false);
    setRecipePickerCanClose(false);
  };

  const createNewScheme = (): void => {
    setRecipePickerOpen(true);
    setRecipePickerCanClose(true);
    setStorageError(null);
    setApplyNotice(null);
  };

  const duplicateScheme = (): void => {
    const duplicate = regenerateDraftIds(structuredClone(draft));
    duplicate.name = createCopyName(draft.name);
    const id = createTemporarySchemeId();
    setDraft(duplicate);
    setSelectedSchemeId(id);
    setTemporaryDrafts((current) => [
      ...current,
      { id, draft: duplicate, baseline: stableDraftString(duplicate) },
    ]);
    lastSavedDraftRef.current = "";
    setAutosaveState("idle");
    setApplyNotice(null);
  };

  const openYamlEditor = async (): Promise<void> => {
    setYamlOpen(true);
    setYamlError(null);
    if (!parsedDraft.success) {
      setYamlText("");
      setYamlError(
        parsedDraft.error.issues[0]?.message ?? "규칙을 확인하세요.",
      );
      return;
    }
    setYamlText(
      stringify(
        {
          schemaVersion: CONDITIONAL_BATCH_SCHEMA_VERSION,
          schemes: [
            {
              id: stored ? selectedSchemeId : "draft:yaml",
              ...parsedDraft.data,
            },
          ],
          sequences: [],
        },
        { indent: 2, lineWidth: 100 },
      ),
    );
  };

  const reflectYamlInDraft = (): void => {
    try {
      const document = parseDocument(yamlText, {
        customTags: [],
        merge: false,
        prettyErrors: true,
        schema: "core",
        strict: true,
        uniqueKeys: true,
      });
      if (document.errors.length > 0) {
        throw new Error(
          document.errors.map((error) => error.message).join("; "),
        );
      }
      const parsed = parseConditionalBatchSnapshot(
        document.toJS({ maxAliasCount: 0 }),
      ).snapshot;
      const first = parsed.schemes[0];
      if (!first) throw new Error("YAML에 규칙이 없습니다.");
      changeDraft(copySavedSchemeAsDraft(first));
      setYamlError(null);
    } catch (error) {
      setYamlError(readErrorMessage(error));
    }
  };

  const exportYaml = async (all: boolean): Promise<void> => {
    setStorageBusy(true);
    try {
      const value =
        !all && !stored && parsedDraft.success
          ? serializeDraftYaml(parsedDraft.data)
          : await conditionalBatchGateway.exportConditionalBatchYaml(
              all ? {} : { ids: [selectedSchemeId] },
            );
      setYamlText(value);
      await conditionalBatchGateway.saveConditionalBatchYamlFile({
        yaml: value,
        defaultName: all ? "batch-edit-schemes.yaml" : `${draft.name}.yaml`,
      });
      setYamlError(null);
    } catch (error) {
      setStorageError(readErrorMessage(error));
    } finally {
      setStorageBusy(false);
    }
  };

  const openYamlFile = async (): Promise<void> => {
    setStorageBusy(true);
    setYamlError(null);
    try {
      const result =
        await conditionalBatchGateway.openConditionalBatchYamlFile();
      if (!result) return;
      setYamlText(result.yaml);
      setYamlOpen(true);
    } catch (error) {
      setYamlError(readErrorMessage(error));
      setYamlOpen(true);
    } finally {
      setStorageBusy(false);
    }
  };

  const importYaml = async (
    conflictPolicy: "duplicate" | "overwrite" = "duplicate",
  ): Promise<void> => {
    setStorageBusy(true);
    setYamlError(null);
    try {
      const next = await conditionalBatchGateway.importConditionalBatchYaml({
        yaml: yamlText,
        conflictPolicy,
      });
      setSnapshot(next);
      setYamlOpen(false);
    } catch (error) {
      setYamlError(readErrorMessage(error));
    } finally {
      setStorageBusy(false);
    }
  };

  const saveSequence = async (
    sequence: ConditionalBatchSequenceV2,
  ): Promise<void> => {
    setStorageBusy(true);
    try {
      setSnapshot(
        await conditionalBatchGateway.saveConditionalBatchSequence(sequence),
      );
      setStorageError(null);
    } catch (error) {
      setStorageError(readErrorMessage(error));
    } finally {
      setStorageBusy(false);
    }
  };

  const deleteSequence = async (id: string): Promise<void> => {
    setStorageBusy(true);
    try {
      setSnapshot(
        await conditionalBatchGateway.deleteConditionalBatchSequence(id),
      );
      setStorageError(null);
    } catch (error) {
      setStorageError(readErrorMessage(error));
    } finally {
      setStorageBusy(false);
    }
  };

  return {
    applyNotice,
    autosaveState,
    blockStylePresets: options.blockStylePresets ?? [],
    canDeleteScheme: true,
    changeDraft,
    chooseRecipe: resetToRecipe,
    createNewScheme,
    deleteScheme: () => void deleteScheme(),
    deleteSequence: (id: string) => void deleteSequence(id),
    draft,
    duplicateScheme,
    exportYaml: (all: boolean) => void exportYaml(all),
    importYaml: (policy?: "duplicate" | "overwrite") => void importYaml(policy),
    openYamlEditor: () => void openYamlEditor(),
    openYamlFile: () => void openYamlFile(),
    parsedDraft,
    recipePickerOpen,
    recipePickerCanClose,
    reflectYamlInDraft,
    savedSchemes: snapshot?.schemes ?? [],
    saveScheme: () => void saveScheme(),
    saveSequence: (sequence: ConditionalBatchSequenceV2) =>
      void saveSequence(sequence),
    selectedSchemeId,
    selectScheme: (id: string) => void selectScheme(id),
    sequences: snapshot?.sequences ?? [],
    snapshot: snapshot ?? createEmptyConditionalBatchSnapshot(),
    setApplyNotice,
    setRecipePickerOpen,
    setYamlOpen,
    setYamlText,
    storageBusy,
    storageError,
    temporarySchemes: temporaryDrafts.map((session) => ({
      id: session.id,
      name: session.draft.name,
      dirty: stableDraftString(session.draft) !== session.baseline,
    })),
    hasDirtyTemporaryDrafts: temporaryDrafts.some(
      (session) => stableDraftString(session.draft) !== session.baseline,
    ),
    validationMessage: parsedDraft.success
      ? null
      : (parsedDraft.error.issues[0]?.message ?? null),
    yamlError,
    yamlOpen,
    yamlText,
  };
}

function serializeDraftYaml(draft: ConditionalBatchSchemeDraftV2): string {
  return stringify(
    {
      schemaVersion: CONDITIONAL_BATCH_SCHEMA_VERSION,
      schemes: [{ id: "draft:export", ...draft }],
      sequences: [],
    },
    { indent: 2, lineWidth: 100 },
  );
}

function copySavedSchemeAsDraft(
  scheme: ConditionalBatchSchemeV2,
): ConditionalBatchSchemeDraftV2 {
  return structuredClone({
    name: scheme.name,
    description: scheme.description,
    match: scheme.match,
    actions: scheme.actions,
  });
}

function regenerateDraftIds(
  draft: ConditionalBatchSchemeDraftV2,
): ConditionalBatchSchemeDraftV2 {
  return {
    ...draft,
    match: {
      ...draft.match,
      conditions: draft.match.conditions.map((condition) => ({
        ...condition,
        id: createConditionalBatchClientId("condition"),
      })),
      groups: draft.match.groups.map((group) => ({
        ...group,
        id: createConditionalBatchClientId("group"),
        conditions: group.conditions.map((condition) => ({
          ...condition,
          id: createConditionalBatchClientId("condition"),
        })),
      })),
    },
    actions: draft.actions.map((action) => ({
      ...action,
      id: createConditionalBatchClientId("action"),
    })),
  };
}

function stableDraftString(draft: ConditionalBatchSchemeDraftV2): string {
  return JSON.stringify(draft);
}

function createCopyName(name: string): string {
  const suffix = " 복사본";
  return name.slice(0, Math.max(1, 80 - suffix.length)) + suffix;
}

function isStoredSchemeId(id: string): boolean {
  return !id.startsWith("draft:");
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createTemporarySchemeId(): string {
  return `draft:${createConditionalBatchClientId("session")}`;
}
