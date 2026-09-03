import React from "react";
import { IconAlertTriangle, IconDownload, IconLink } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { ImportPreviewSession } from "../../../shared/importTypes";
import { Modal } from "./ui/Modal";
import { ModalActionBar, ModalActionButtons } from "./ui/ModalActionBar";
import {
  WebImportCandidateGrid,
  WebImportResultNotice,
  WebImportToolbar,
} from "./webImport/WebImportResults";
import { useWebImportModalState } from "./webImport/useWebImportModalState";

export function WebImportModal({
  onCancel,
  onBackgroundStateChange,
  onEntered,
  onPrepared,
}: {
  onCancel: () => void;
  onBackgroundStateChange?: (backgrounded: boolean) => void;
  onEntered?: () => void;
  onPrepared: (preview: ImportPreviewSession) => void;
}): React.JSX.Element | null {
  const { t } = useTranslation("components");
  const state = useWebImportModalState({ onCancel, onPrepared });
  const backgrounded = state.scanning || state.preparing;
  React.useEffect(
    () => onBackgroundStateChange?.(backgrounded),
    [backgrounded, onBackgroundStateChange],
  );
  React.useEffect(
    () => () => onBackgroundStateChange?.(false),
    [onBackgroundStateChange],
  );
  if (backgrounded) return null;
  return (
    <Modal
      size="xl"
      title={t("webImport.title")}
      onEntered={onEntered}
      onClose={state.cancel}
      // Results stream in; a growing card would move the grid under the pointer.
      fillHeight={Boolean(state.result)}
      maxHeight="850px"
      bodyLayout={state.result ? "flex" : "grid"}
      footer={
        <ModalActionBar
          leading={
            state.result ? (
              <span className="web-import-selection-summary">
                {t("webImport.selectedSummary", {
                  selected: state.selectedCount,
                  visible: state.visibleCandidates.length,
                })}
              </span>
            ) : undefined
          }
          actions={
            <ModalActionButtons
              cancel={{
                label: t("common.cancel"),
                onClick: state.cancel,
              }}
              confirm={
                state.result
                  ? {
                      label: t("webImport.continue"),
                      onClick: () => void state.prepare(),
                      disabled: state.busy || state.selectedCount === 0,
                    }
                  : undefined
              }
            />
          }
        />
      }
    >
      <WebImportUrlForm state={state} />
      {state.error ? (
        <div
          className="web-import-message web-import-message--error"
          role="alert"
        >
          <IconAlertTriangle size={18} aria-hidden="true" />
          <span>{state.error}</span>
        </div>
      ) : null}
      {state.result ? <WebImportLoadedContent state={state} /> : null}
    </Modal>
  );
}

function WebImportUrlForm({
  state,
}: {
  state: ReturnType<typeof useWebImportModalState>;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <form
      className="web-import-url-form"
      onSubmit={(event) => {
        event.preventDefault();
        void state.scan();
      }}
    >
      <label className="web-import-url-field">
        <span>{t("webImport.urlLabel")}</span>
        <span className="web-import-url-input-wrap">
          <IconLink size={18} aria-hidden="true" />
          <input
            type="url"
            data-ui-framed-input=""
            value={state.url}
            placeholder={t("webImport.urlPlaceholder")}
            onChange={(event) => state.setUrl(event.target.value)}
            disabled={state.busy}
            autoComplete="url"
            spellCheck={false}
          />
        </span>
      </label>
      <button
        type="submit"
        className="web-import-load-button primary"
        disabled={state.busy || !state.url.trim()}
      >
        <IconDownload size={17} aria-hidden="true" />
        <span>{t("webImport.load")}</span>
      </button>
    </form>
  );
}

function WebImportLoadedContent({
  state,
}: {
  state: ReturnType<typeof useWebImportModalState>;
}): React.JSX.Element {
  if (!state.result) throw new Error("Web import result is required.");
  return (
    <>
      <WebImportResultNotice result={state.result} />
      <WebImportToolbar
        busy={state.preparing}
        filter={state.filter}
        visibleCount={state.visibleCandidates.length}
        onFilterChange={state.setFilter}
        onSelectAll={() => state.setVisibleSelected(true)}
        onClearAll={() => state.setVisibleSelected(false)}
      />
      <WebImportCandidateGrid
        candidates={state.visibleCandidates}
        excluded={state.excluded}
        disabled={state.preparing}
        onSelectedChange={state.setCandidateSelected}
      />
    </>
  );
}
