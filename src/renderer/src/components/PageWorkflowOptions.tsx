import React from "react";
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
type Props = {
  props: TranslationOptionsModalProps;
  state: ReturnType<typeof usePageWorkflowModalState>;
  changePlan: ReturnType<typeof usePageWorkflowModalState>["setPlan"];
};

export function PageWorkflowOptions({ props, state, changePlan }: Props) {
  return (
    <section className={styles.toolbar} aria-label="작업 구성">
      <WorkflowPresets props={props} state={state} changePlan={changePlan} />
      {!!state.resumeIds.length && (
        <Select
          ariaLabel="이전 페이지 작업 이어하기"
          value={state.resume?.resumeRunId ?? ""}
          placeholder="이전 실행 이어하기"
          options={state.resumeIds.map((id, index) => ({
            value: id,
            label: `이전 작업 ${index + 1} · ${id.slice(0, 8)}`,
          }))}
          onValueChange={(id) => {
            void pageWorkflowGateway.getPageWorkflowRun(id).then(
              (request) => {
                state.setPlan(request.plan);
                state.setResume(request);
                state.setSelection(
                  new Map(
                    request.selection.map((s) => [
                      s.chapterId,
                      { kind: "pages", pageIds: new Set(s.pageIds) },
                    ]),
                  ),
                );
              },
              (error: unknown) => state.setError(String(error)),
            );
          }}
        />
      )}
      {state.resume && (
        <p role="status">저장된 실행 이어하기 · 설정 변경 시 새 실행</p>
      )}
    </section>
  );
}

function WorkflowPresets({ props, state, changePlan }: Props) {
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
        <span className={styles.toolbarLabel}>프리셋</span>
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
            변경 저장
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={saving}
          onClick={() => setSaving(!saving)}
        >
          {editable ? "새로 저장" : "프리셋 저장"}
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
  const [name, setName] = React.useState("");
  const custom = props.uiSettings?.pageWorkflowPresets ?? [];
  return (
    <div className={styles.presetSave}>
      <TextField
        aria-label="사용자 프리셋 이름"
        placeholder="프리셋 이름"
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
        저장
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
        ariaLabel="작업 프리셋"
        className={styles.presetSelect}
        value={selected?.id ?? ""}
        placeholder="사용자 설정"
        options={ordered.map((p) => ({
          value: p.id,
          label: `${p.name}${p.id === selected?.id && dirty ? " •" : ""}`,
          group: favorites.has(p.id) ? "즐겨찾기" : "프리셋",
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
        <ConfirmModal
          title="프리셋 삭제"
          message={`“${deleting.name}” 프리셋을 삭제할까요?`}
          confirmLabel="삭제"
          confirmVariant="danger"
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
  return (
    <>
      <FavoriteToggleButton
        favorite={favorite}
        label={`${preset.name} 즐겨찾기 ${favorite ? "해제" : "추가"}`}
        onToggle={onFavorite}
      />
      {canDelete && (
        <IconButton
          size="sm"
          variant="danger"
          label={`${preset.name} 삭제`}
          onClick={onDelete}
        >
          <IconTrash size={15} />
        </IconButton>
      )}
    </>
  );
}
