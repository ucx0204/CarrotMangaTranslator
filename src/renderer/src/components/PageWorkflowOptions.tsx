import { useTranslation } from "react-i18next";
import { appI18n } from "../appI18n";
import React from "react";
import { OcrRecommendation } from "./OcrRecommendation";
import type { TranslationOptionsModalProps } from "./translationOptionsModalTypes";
import type { usePageWorkflowModalState } from "./pageWorkflowModalState";
import {
  pageWorkflowPresets,
  type PageWorkflowPreset,
} from "../../../shared/pageWorkflowTypes";
import { IconTrash } from "@tabler/icons-react";
import { FavoriteToggleButton } from "./ui/FavoriteToggleButton";
import { IconButton } from "./ui/IconButton";
import { ConfirmModal } from "./ConfirmModal";
import { pageWorkflowGateway } from "../api/pageWorkflowGateway";
import { Button } from "./ui/Button";
import { TextField } from "./ui/Field";
import { Select } from "./ui/Select";
import { hashStableValue } from "../../../shared/blockFingerprint";
import styles from "./PageWorkflowModal.module.css";

const t = appI18n.getFixedT(null, "components");
type Props = {
  props: TranslationOptionsModalProps;
  state: ReturnType<typeof usePageWorkflowModalState>;
  changePlan: ReturnType<typeof usePageWorkflowModalState>["setPlan"];
};

export function PageWorkflowOptions({ props, state, changePlan }: Props) {
  useTranslation();
  const selectResume = useWorkflowResumeSelection(props, state);
  return (
    <section
      className={styles.toolbar}
      aria-label={t("batchEditorCopy.workflowConfiguration")}
    >
      <OcrRecommendation
        sourceLanguage={props.sourceLanguage}
        pipeline={props.settings?.ocr.pipeline}
      />
      <WorkflowPresets props={props} state={state} changePlan={changePlan} />
      {!!state.resumeIds.length && (
        <Select
          ariaLabel={t("batchEditorCopy.resumePreviousPageWorkflow")}
          value={state.resume?.resumeRunId ?? ""}
          placeholder={t("batchEditorCopy.resumePreviousRun")}
          options={state.resumeIds.map((id, index) => ({
            value: id,
            label: t("batchEditorMessages.previousTask", {
              p0: index + 1,
              p1: id.slice(0, 8),
            }),
          }))}
          onValueChange={selectResume.select}
        />
      )}
      {state.resume && (
        <p role="status">
          {t("batchEditorCopy.resumeSavedRunChangedSettingsStartANewRun")}
        </p>
      )}
      {selectResume.error && (
        <p className={styles.error} role="alert">
          {selectResume.error}
        </p>
      )}
    </section>
  );
}

function useWorkflowResumeSelection(
  props: Props["props"],
  state: Props["state"],
) {
  const latest = React.useRef(0);
  const [error, setError] = React.useState("");
  React.useEffect(
    () => () => {
      latest.current++;
    },
    [props.chapter.id],
  );
  const select = (id: string) => {
    const requestId = ++latest.current;
    setError("");
    void pageWorkflowGateway.getPageWorkflowRun(id).then(
      (request) => {
        if (requestId !== latest.current) return;
        const target = request.selection.find(
          (item) => item.chapterId === props.chapter.id,
        );
        const receiptPages = props.chapter.pages.filter(
          (page) => page.pageWorkflow?.runId === id,
        );
        if (
          !target ||
          !receiptPages.length ||
          receiptPages.some((page) => !target.pageIds.includes(page.id))
        ) {
          setError(
            t("batchEditorCopy.thisPreviousWorkflowIsNotLinkedToTheCurrent"),
          );
          return;
        }
        state.setPlan(request.plan);
        state.setResume(request);
        state.loadSelection(
          new Map(
            request.selection.map((s) => [
              s.chapterId,
              { kind: "pages", pageIds: new Set(s.pageIds) },
            ]),
          ),
        );
      },
      (error: unknown) => {
        if (requestId === latest.current) setError(String(error));
      },
    );
  };
  return { select, error };
}

function WorkflowPresets({ props, state, changePlan }: Props) {
  useTranslation();
  const [saving, setSaving] = React.useState(false);
  const custom = props.uiSettings?.pageWorkflowPresets ?? [];
  const presets = [...pageWorkflowPresets(), ...custom];
  const [selectedId, setSelectedId] = React.useState(
    () =>
      presets.find(
        (p) => hashStableValue(p.plan) === hashStableValue(state.plan),
      )?.id ?? "",
  );
  const selected = presets.find((p) => p.id === selectedId);
  const dirty =
    !!selected &&
    hashStableValue(selected.plan) !== hashStableValue(state.plan);
  const editable = custom.some((p) => p.id === selectedId);
  return (
    <div className={styles.presets}>
      <div className={styles.presetBar}>
        <span className={styles.toolbarLabel}>
          {t("transform.warp.preset")}
        </span>
        <WorkflowPresetPicker
          props={props}
          state={state}
          changePlan={changePlan}
          presets={presets}
          selected={selected}
          dirty={dirty}
          onSelect={setSelectedId}
        />
        {editable && (
          <Button
            size="sm"
            disabled={!dirty || !state.request}
            onClick={() =>
              props.onPersistDefaults({
                pageWorkflowPresets: custom.map((p) =>
                  p.id === selectedId ? { ...p, plan: state.plan } : p,
                ),
              })
            }
          >
            {t("batchEditorCopy.saveChanges")}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={saving}
          onClick={() => setSaving(!saving)}
        >
          {editable
            ? t("batchEditorCopy.saveAsNew")
            : t("manualRedaction.savePreset")}
        </Button>
      </div>
      {saving && (
        <WorkflowPresetSave
          props={props}
          state={state}
          onSaved={(id) => {
            setSelectedId(id);
            setSaving(false);
          }}
        />
      )}
    </div>
  );
}

function WorkflowPresetSave({
  props,
  state,
  onSaved,
}: Pick<Props, "props" | "state"> & { onSaved: (id: string) => void }) {
  useTranslation();
  const [name, setName] = React.useState("");
  const custom = props.uiSettings?.pageWorkflowPresets ?? [];
  return (
    <div className={styles.presetSave}>
      <TextField
        aria-label={t("batchEditorCopy.customPresetName")}
        placeholder={t("stylePresets.name")}
        value={name}
        maxLength={80}
        onChange={(event) => setName(event.target.value)}
      />
      <Button
        disabled={!name.trim() || !state.request || custom.length >= 50}
        onClick={() => {
          const id = crypto.randomUUID();
          props.onPersistDefaults({
            pageWorkflowPresets: [
              ...custom,
              { id, name: name.trim(), plan: state.plan },
            ],
          });
          onSaved(id);
        }}
      >
        {t("common.save")}
      </Button>
    </div>
  );
}

function WorkflowPresetPicker({
  props,
  changePlan,
  presets,
  selected,
  dirty,
  onSelect,
}: Props & {
  presets: PageWorkflowPreset[];
  selected: PageWorkflowPreset | undefined;
  dirty: boolean;
  onSelect: (id: string) => void;
}) {
  useTranslation();
  const [deleting, setDeleting] = React.useState<PageWorkflowPreset | null>(
    null,
  );
  const favorites = new Set(
    props.uiSettings?.pageWorkflowFavoritePresetIds ?? [],
  );
  const ordered = [...presets].sort(
    (a, b) => Number(favorites.has(b.id)) - Number(favorites.has(a.id)),
  );
  const custom = props.uiSettings?.pageWorkflowPresets ?? [];
  const toggleFavorite = (id: string) => {
    if (favorites.has(id)) favorites.delete(id);
    else favorites.add(id);
    props.onPersistDefaults({ pageWorkflowFavoritePresetIds: [...favorites] });
  };
  return (
    <>
      <Select
        ariaLabel={t("batchEditorCopy.workflowPreset")}
        className={styles.presetSelect}
        value={selected?.id ?? ""}
        placeholder={t("batchEditorCopy.customConfiguration")}
        options={ordered.map((p) => ({
          value: p.id,
          label: `${p.name}${p.id === selected?.id && dirty ? " •" : ""}`,
          group: favorites.has(p.id)
            ? t("fontManager.favorites")
            : t("transform.warp.preset"),
          actions: (
            <WorkflowPresetActions
              preset={p}
              favorite={favorites.has(p.id)}
              canDelete={custom.some((entry) => entry.id === p.id)}
              onFavorite={() => toggleFavorite(p.id)}
              onDelete={() => setDeleting(p)}
            />
          ),
        }))}
        onValueChange={(id) => {
          const preset = presets.find((p) => p.id === id);
          if (preset) {
            onSelect(id);
            changePlan(structuredClone(preset.plan));
          }
        }}
      />
      {deleting && (
        <WorkflowPresetDeleteConfirm
          name={deleting.name}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            props.onPersistDefaults({
              pageWorkflowPresets: custom.filter((p) => p.id !== deleting.id),
              pageWorkflowFavoritePresetIds: [...favorites].filter(
                (id) => id !== deleting.id,
              ),
            });
            setDeleting(null);
          }}
        />
      )}
    </>
  );
}

function WorkflowPresetActions({
  preset,
  favorite,
  canDelete,
  onFavorite,
  onDelete,
}: {
  preset: PageWorkflowPreset;
  favorite: boolean;
  canDelete: boolean;
  onFavorite: () => void;
  onDelete: () => void;
}) {
  useTranslation();
  return (
    <>
      <FavoriteToggleButton
        favorite={favorite}
        label={t("batchEditorMessages.favorite", {
          p0: preset.name,
          p1: favorite
            ? appI18n.t("settings.api.vertexServiceAccountClear", {
                ns: "components",
              })
            : appI18n.t("common.add", { ns: "components" }),
        })}
        onToggle={onFavorite}
      />
      {canDelete && (
        <IconButton
          size="sm"
          variant="danger"
          label={t("batchEditorMessages.delete", {
            p0: preset.name,
          })}
          onClick={onDelete}
        >
          <IconTrash size={15} />
        </IconButton>
      )}
    </>
  );
}

function WorkflowPresetDeleteConfirm({
  name,
  onCancel,
  onConfirm,
}: {
  name: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useTranslation();
  return (
    <ConfirmModal
      title={t("codexFonts.deletePreset")}
      message={t("batchEditorMessages.deletePreset", { p0: name })}
      confirmLabel={t("common.delete")}
      confirmVariant="danger"
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}
