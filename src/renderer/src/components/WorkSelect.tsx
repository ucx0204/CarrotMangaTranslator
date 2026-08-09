import React from "react";
import { useTranslation } from "react-i18next";
import type {
  LibraryIndex,
  LibraryWorkSummary,
} from "../../../shared/libraryTypes";
import { Select } from "./ui/Select";
import type { SelectOption } from "./ui/selectTypes";
import styles from "./WorkSelect.module.css";

type WorkSortMode = "library" | "title" | "recent";

export type WorkSelectProps = {
  ariaLabel: string;
  library: LibraryIndex;
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
};

/** A searchable work picker with stable, user-controlled ordering. */
export function WorkSelect({
  ariaLabel,
  library,
  value,
  onValueChange,
  disabled = false,
  className,
}: WorkSelectProps): React.JSX.Element {
  const { i18n, t } = useTranslation("components");
  const [sortMode, setSortMode] = React.useState<WorkSortMode>("library");
  const works = React.useMemo(
    () => sortWorks(library, sortMode, i18n.resolvedLanguage ?? i18n.language),
    [i18n.language, i18n.resolvedLanguage, library, sortMode],
  );
  const options = React.useMemo<SelectOption[]>(
    () =>
      works.map((work) => ({
        value: work.id,
        label: work.title,
        searchText: work.title,
        description: t("workSelect.chapterCount", {
          count: work.chapters.length,
        }),
      })),
    [t, works],
  );
  return (
    <Select
      ariaLabel={ariaLabel}
      className={className}
      value={value}
      options={options}
      disabled={disabled}
      searchable
      searchPlaceholder={t("workSelect.search")}
      onValueChange={onValueChange}
      menuHeader={
        library.works.length > 1 ? (
          <WorkSortToolbar value={sortMode} onChange={setSortMode} />
        ) : null
      }
    />
  );
}

function WorkSortToolbar({
  value,
  onChange,
}: {
  value: WorkSortMode;
  onChange: (value: WorkSortMode) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const options: Array<{ value: WorkSortMode; label: string }> = [
    { value: "library", label: t("workSelect.sort.library") },
    { value: "title", label: t("workSelect.sort.title") },
    { value: "recent", label: t("workSelect.sort.recent") },
  ];
  return (
    <div className={styles.sortToolbar} aria-label={t("workSelect.sort.label")}>
      <span className={styles.sortLabel}>{t("workSelect.sort.label")}</span>
      <div className={styles.sortOptions}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={styles.sortButton}
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function sortWorks(
  library: LibraryIndex,
  mode: WorkSortMode,
  locale: string,
): LibraryWorkSummary[] {
  const collator = new Intl.Collator(locale, {
    numeric: true,
    sensitivity: "base",
  });
  const libraryOrder = new Map(
    library.workOrder.map((workId, index) => [workId, index]),
  );
  return [...library.works].sort((left, right) => {
    if (mode === "title") {
      return collator.compare(left.title, right.title);
    }
    if (mode === "recent") {
      return (
        right.updatedAt.localeCompare(left.updatedAt) ||
        collator.compare(left.title, right.title)
      );
    }
    return (
      (libraryOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
        (libraryOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER) ||
      collator.compare(left.title, right.title)
    );
  });
}
