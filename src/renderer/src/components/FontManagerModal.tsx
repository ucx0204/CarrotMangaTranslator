import React from "react";
import { useTranslation } from "react-i18next";
import { closestCenter, DndContext } from "@dnd-kit/core";
import { Button } from "./ui/Button";
import { Modal } from "./ui/Modal";
import { ModalActionBar, ModalActionButtons } from "./ui/ModalActionBar";
import { FontManagerGroup, FontFileList } from "./FontManagerList";
import { Select } from "./ui/Select";
import styles from "./FontManagerModal.module.css";
import {
  useFontManagerModel,
  type FontManagerModel,
} from "./useFontManagerModel";
import { Input } from "./ui/Field";

export function FontManagerModal({
  onClose,
}: {
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const model = useFontManagerModel(onClose);
  const [managingFiles, setManagingFiles] = React.useState(false);
  const closeFiles = () => setManagingFiles(false);

  return (
    <Modal
      title={t(managingFiles ? "fontManager.files" : "fontManager.title")}
      onClose={managingFiles ? closeFiles : onClose}
      // Holds an unsaved font draft: keep the close button visible but inert
      // while saving, and never discard the draft on a stray backdrop click.
      closeDisabled={model.disabled}
      size="lg"
      maxHeight="760px"
      bodyClassName={styles.body}
      footer={
        managingFiles ? (
          <ModalActionBar
            actions={
              <Button disabled={model.disabled} onClick={closeFiles}>
                {t("common.back")}
              </Button>
            }
          />
        ) : (
          <FontManagerFooter model={model} onClose={onClose} />
        )
      }
    >
      {managingFiles ? (
        <FontFileList model={model} />
      ) : (
        <>
          <FontManagerControls
            model={model}
            onManageFiles={() => setManagingFiles(true)}
          />
          <DndContext
            sensors={model.sensors}
            collisionDetection={closestCenter}
            onDragEnd={model.handleDragEnd}
          >
            <FontManagerGroups model={model} />
          </DndContext>
        </>
      )}
    </Modal>
  );
}

function FontManagerFooter({
  model,
  onClose,
}: {
  model: FontManagerModel;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <ModalActionBar
      leading={
        <Button
          variant="ghost"
          className={styles.resetOrder}
          disabled={model.disabled}
          onClick={model.resetOrder}
        >
          {t("fontManager.resetOrder")}
        </Button>
      }
      actions={
        <ModalActionButtons
          cancel={{
            label: t("common.cancel"),
            onClick: onClose,
            disabled: model.disabled,
          }}
          confirm={{
            label: t("common.save"),
            onClick: model.save,
            disabled: model.disabled,
          }}
        />
      }
    />
  );
}

function FontManagerControls({
  onManageFiles,
  model,
}: {
  onManageFiles: () => void;
  model: FontManagerModel;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className={styles.controls}>
      <label className={styles.defaultControl}>
        <span>{t("fontManager.defaultBadge")}</span>
        <Select
          ariaLabel={t("fontManager.defaultBadge")}
          className={styles.defaultSelect}
          value={model.draft.defaultFontId}
          disabled={model.disabled}
          options={model.orderedOptions.map((option) => ({
            value: option.id,
            label: option.label,
          }))}
          searchable="auto"
          onValueChange={model.setDefault}
        />
      </label>
      <Input
        className={styles.search}
        type="search"
        value={model.query}
        disabled={model.disabled}
        aria-label={t("fontManager.searchPlaceholder")}
        placeholder={t("fontManager.searchPlaceholder")}
        onChange={(event) => model.setQuery(event.target.value)}
      />
      <Button disabled={model.disabled} onClick={onManageFiles}>
        {t("fontManager.files")}
      </Button>
    </div>
  );
}

function FontManagerGroups({
  model,
}: {
  model: FontManagerModel;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  if (model.visibleCount === 0) {
    return <p className={styles.empty}>{t("fontManager.noSearchResults")}</p>;
  }
  return (
    <>
      {model.favoriteOptions.length || !model.normalizedQuery ? (
        <FontManagerGroup
          customIds={NO_REMOVABLE_FONTS}
          defaultFontId={model.draft.defaultFontId}
          disabled={model.disabled}
          dragDisabled={model.dragDisabled}
          emptyLabel={t("fontManager.emptyFavorites")}
          favorite
          options={model.favoriteOptions}
          title={t("fontManager.favorites")}
          onToggleFavorite={model.toggleFavorite}
          onToggleHidden={model.toggleHidden}
          onRemove={model.removeFont}
        />
      ) : null}
      {model.otherOptions.length ? (
        <FontManagerGroup
          customIds={NO_REMOVABLE_FONTS}
          defaultFontId={model.draft.defaultFontId}
          disabled={model.disabled}
          dragDisabled={model.dragDisabled}
          favorite={false}
          options={model.otherOptions}
          title={t("fontManager.otherFonts")}
          onToggleFavorite={model.toggleFavorite}
          onToggleHidden={model.toggleHidden}
          onRemove={model.removeFont}
        />
      ) : null}
      {model.hiddenOptions.length ? (
        <FontManagerGroup
          customIds={NO_REMOVABLE_FONTS}
          defaultFontId={model.draft.defaultFontId}
          disabled={model.disabled}
          dragDisabled
          favorite={false}
          hidden
          options={model.hiddenOptions}
          title={t("fontManager.hiddenFonts")}
          onToggleFavorite={model.toggleFavorite}
          onToggleHidden={model.toggleHidden}
          onRemove={model.removeFont}
        />
      ) : null}
    </>
  );
}

const NO_REMOVABLE_FONTS: ReadonlySet<string> = new Set();
