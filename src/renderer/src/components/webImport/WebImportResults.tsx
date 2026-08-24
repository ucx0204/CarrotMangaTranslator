import React from "react";
import {
  IconAlertTriangle,
  IconCheck,
  IconDownload,
  IconLoader2,
  IconPhotoOff,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type {
  WebImportCandidate,
  WebImportProgressEvent,
  WebImportScanResult,
  WebImportSizeFilter,
} from "../../../../shared/webImportTypes";
import { CheckboxField } from "../ui/CheckboxField";
import { SegmentedControl } from "../ui/SegmentedControl";

export function WebImportProgress({
  progress,
}: {
  progress: WebImportProgressEvent | null;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const ratio =
    progress && progress.total > 0
      ? Math.min(100, (progress.completed / progress.total) * 100)
      : 8;
  return (
    <div className="web-import-progress" role="status" aria-live="polite">
      <div className="web-import-progress-copy">
        <IconLoader2 className="web-import-spin" size={17} aria-hidden="true" />
        <span>
          {progress
            ? t(`webImport.progress.${progress.stage}`, {
                completed: progress.completed,
                total: progress.total,
              })
            : t("webImport.progress.starting")}
        </span>
      </div>
      <div className="web-import-progress-track" aria-hidden="true">
        <span style={{ width: `${ratio}%` }} />
      </div>
    </div>
  );
}

export function WebImportResultNotice({
  result,
}: {
  result: WebImportScanResult;
}): React.JSX.Element | null {
  const { t } = useTranslation("components");
  const skipped = Object.values(result.skipped).reduce(
    (sum, count) => sum + count,
    0,
  );
  const reasonSummary = (
    ["unsupported", "failed", "duplicate", "blocked"] as const
  )
    .flatMap((reason) =>
      result.skipped[reason] > 0
        ? [
            t(`webImport.skipReasons.${reason}`, {
              count: result.skipped[reason],
            }),
          ]
        : [],
    )
    .join(" · ");
  if (skipped === 0 && !result.truncated) return null;
  return (
    <div className="web-import-message" role="status">
      <IconAlertTriangle size={18} aria-hidden="true" />
      <span>
        {result.truncated
          ? t("webImport.partialResult", { skipped })
          : t("webImport.skippedResult", { skipped })}
        {reasonSummary ? ` ${reasonSummary}` : null}
      </span>
    </div>
  );
}

export function WebImportToolbar({
  busy,
  filter,
  visibleCount,
  onFilterChange,
  onSelectAll,
  onClearAll,
}: {
  busy: boolean;
  filter: WebImportSizeFilter;
  visibleCount: number;
  onFilterChange: (filter: WebImportSizeFilter) => void;
  onSelectAll: () => void;
  onClearAll: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="web-import-toolbar">
      <SegmentedControl
        className="web-import-filter-group"
        ariaLabel={t("webImport.sizeFilter")}
        disabled={busy}
        options={(["all", "medium-or-larger", "large"] as const).map(
          (value) => ({ id: value, label: t(`webImport.filters.${value}`) }),
        )}
        value={filter}
        onChange={onFilterChange}
      />
      <div className="web-import-select-actions">
        <button
          type="button"
          onClick={onSelectAll}
          disabled={busy || visibleCount === 0}
        >
          {t("webImport.selectAll")}
        </button>
        <button
          type="button"
          onClick={onClearAll}
          disabled={busy || visibleCount === 0}
        >
          {t("webImport.clearAll")}
        </button>
      </div>
    </div>
  );
}

export function WebImportCandidateGrid({
  candidates,
  excluded,
  disabled,
  onSelectedChange,
}: {
  candidates: readonly WebImportCandidate[];
  excluded: ReadonlySet<string>;
  disabled: boolean;
  onSelectedChange: (id: string, selected: boolean) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  if (candidates.length === 0) {
    return (
      <div className="web-import-empty">
        <IconPhotoOff size={30} aria-hidden="true" />
        <strong>{t("webImport.noMatchingImages")}</strong>
        <span>{t("webImport.tryAnotherFilter")}</span>
      </div>
    );
  }
  return (
    <div className="web-import-grid" role="list">
      {candidates.map((candidate, index) => (
        <WebImportCandidateCard
          key={candidate.id}
          candidate={candidate}
          displayIndex={index + 1}
          selected={!excluded.has(candidate.id)}
          disabled={disabled}
          onSelectedChange={(selected) =>
            onSelectedChange(candidate.id, selected)
          }
        />
      ))}
    </div>
  );
}

export function WebImportInitialState(): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="web-import-empty web-import-empty--initial">
      <IconDownload size={32} aria-hidden="true" />
      <strong>{t("webImport.initialTitle")}</strong>
      <span>{t("webImport.initialHint")}</span>
    </div>
  );
}

function WebImportCandidateCard({
  candidate,
  displayIndex,
  selected,
  disabled,
  onSelectedChange,
}: {
  candidate: WebImportCandidate;
  displayIndex: number;
  selected: boolean;
  disabled: boolean;
  onSelectedChange: (selected: boolean) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <CheckboxField
      variant="bare"
      hideInput
      className="web-import-card"
      dataSelected={selected}
      role="listitem"
      checked={selected}
      disabled={disabled}
      onCheckedChange={onSelectedChange}
      ariaLabel={t("webImport.imageSelectionLabel", {
        index: displayIndex,
        width: candidate.width,
        height: candidate.height,
      })}
    >
      <span className="web-import-card-image">
        <img
          src={candidate.previewUrl}
          alt=""
          loading="lazy"
          decoding="async"
        />
        <span className="web-import-card-index">{displayIndex}</span>
        <span className="web-import-card-check" aria-hidden="true">
          {selected ? <IconCheck size={15} stroke={2.5} /> : null}
        </span>
      </span>
      <span className="web-import-card-meta">
        <strong>{`${displayIndex}${candidate.storedExtension}`}</strong>
        <small>
          {candidate.width}×{candidate.height} ·{" "}
          {formatWebImportImage(candidate)} · {formatBytes(candidate.byteSize)}
        </small>
      </span>
    </CheckboxField>
  );
}

function formatWebImportImage(candidate: WebImportCandidate): string {
  if (candidate.format === "webp") return "WEBP → PNG";
  return candidate.format === "jpeg" ? "JPG" : "PNG";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
