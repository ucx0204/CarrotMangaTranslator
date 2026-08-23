import React from "react";
import { IconSearch } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { BlockLibraryEntryV1 } from "../../../shared/blockLibrary";
import { blockLibraryGateway } from "../api/blockLibraryGateway";
import { useFonts } from "../fonts/useFonts";
import { BlockLibraryCard } from "./BlockLibraryCard";
import {
  resolveBlockLibraryError,
  useBlockLibraryController,
  type BlockLibrarySortMode,
  type BlockLibrarySource,
} from "./blockLibraryModel";
import { AppModal, ConfirmModal } from "./ConfirmModal";
import { EditBlockLibraryModal } from "./EditBlockLibraryModal";
import { Select } from "./ui/Select";
import styles from "./BlockLibraryModals.module.css";

export function BlockLibraryModal({
  canInsert,
  onClose,
  onInsert,
  source = blockLibraryGateway,
}: {
  canInsert: boolean;
  onClose: () => void;
  onInsert: (entry: BlockLibraryEntryV1) => void;
  source?: BlockLibrarySource;
}): React.JSX.Element {
  const { t, i18n } = useTranslation("components");
  const { catalog, options } = useFonts();
  const model = useBlockLibraryController({
    canInsert,
    locale: i18n.resolvedLanguage ?? i18n.language,
    loadFailedMessage: t("blockLibrary.loadFailed"),
    onClose,
    onInsert,
    source,
    useFailedMessage: t("blockLibrary.useFailed"),
  });
  const availableFonts = React.useMemo(
    () => new Set(options.map((option) => option.id)),
    [options],
  );
  return (
    <>
      <AppModal
        size="xl"
        title={t("blockLibrary.title")}
        onClose={onClose}
        cardClassName={styles.modalCard}
        bodyClassName={styles.modalBody}
      >
        <BlockLibraryToolbar model={model} />
        <BlockLibraryContent
          availableFonts={availableFonts}
          canInsert={canInsert}
          fontCatalog={catalog}
          model={model}
        />
      </AppModal>
      <BlockLibraryNestedModals model={model} source={source} />
    </>
  );
}

type BlockLibraryModel = ReturnType<typeof useBlockLibraryController>;

function BlockLibraryToolbar({ model }: { model: BlockLibraryModel }) {
  const { t } = useTranslation("components");
  return (
    <div className={styles.toolbar}>
      <label className={styles.search}>
        <IconSearch size={17} aria-hidden="true" />
        <input
          aria-label={t("blockLibrary.search")}
          placeholder={t("blockLibrary.searchPlaceholder")}
          value={model.query}
          onChange={(event) => model.setQuery(event.target.value)}
        />
      </label>
      <Select
        ariaLabel={t("blockLibrary.sort")}
        className={styles.sort}
        value={model.sort}
        options={[
          { value: "recent", label: t("blockLibrary.sortRecent") },
          { value: "name", label: t("blockLibrary.sortName") },
        ]}
        onValueChange={(value) => model.setSort(value as BlockLibrarySortMode)}
      />
    </div>
  );
}

function BlockLibraryContent({
  availableFonts,
  canInsert,
  fontCatalog,
  model,
}: {
  availableFonts: ReadonlySet<string>;
  canInsert: boolean;
  fontCatalog: ReturnType<typeof useFonts>["catalog"];
  model: BlockLibraryModel;
}) {
  const { t } = useTranslation("components");
  return (
    <>
      {!canInsert ? (
        <p className={styles.notice}>{t("blockLibrary.noPage")}</p>
      ) : null}
      {model.error ? <p className={styles.error}>{model.error}</p> : null}
      {!model.snapshot && !model.error ? (
        <p className={styles.empty}>{t("blockLibrary.loading")}</p>
      ) : model.visibleEntries.length === 0 ? (
        <p className={styles.empty}>
          {model.query
            ? t("blockLibrary.noSearchResults")
            : t("blockLibrary.empty")}
        </p>
      ) : (
        <div className={styles.grid}>
          {model.visibleEntries.map((entry) => (
            <BlockLibraryCard
              busy={Boolean(model.busyId)}
              canInsert={canInsert}
              entry={entry}
              fontCatalog={fontCatalog}
              key={entry.id}
              missingFont={Boolean(
                entry.block.fontFamily &&
                !availableFonts.has(entry.block.fontFamily),
              )}
              onDelete={() => model.setDeleteEntry(entry)}
              onInsert={() => void model.insert(entry)}
              onEdit={() => model.setEditEntry(entry)}
            />
          ))}
        </div>
      )}
    </>
  );
}

function BlockLibraryNestedModals({
  model,
  source,
}: {
  model: BlockLibraryModel;
  source: BlockLibrarySource;
}) {
  const { t } = useTranslation("components");
  const confirmDelete = (): void => {
    const entry = model.deleteEntry;
    if (!entry) return;
    model.setDeleteEntry(null);
    model.setBusyId(entry.id);
    model.setError("");
    void source
      .deleteBlockLibraryEntry(entry.id)
      .then(model.setSnapshot)
      .catch((error) =>
        model.setError(
          resolveBlockLibraryError(error, t("blockLibrary.deleteFailed")),
        ),
      )
      .finally(() => model.setBusyId(null));
  };
  return (
    <>
      {model.editEntry ? (
        <EditBlockLibraryModal
          entry={model.editEntry}
          source={source}
          onClose={() => model.setEditEntry(null)}
          onUpdated={(next) => {
            model.setSnapshot(next);
            model.setEditEntry(null);
          }}
        />
      ) : null}
      {model.deleteEntry ? (
        <ConfirmModal
          title={t("blockLibrary.deleteTitle")}
          message={t("blockLibrary.deleteMessage", {
            name: model.deleteEntry.name,
          })}
          confirmLabel={t("blockLibrary.delete")}
          confirmVariant="danger"
          onCancel={() => model.setDeleteEntry(null)}
          onConfirm={confirmDelete}
        />
      ) : null}
    </>
  );
}
