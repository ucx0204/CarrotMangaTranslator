import React from "react";
import { IconSearch } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { LibraryIndex } from "../../../../shared/libraryTypes";
import type { LinkedWorkspaceStatus } from "../../../../shared/linkedWorkspaceTypes";
import { LibrarySortMenu } from "../LibrarySortMenu";
import { filterLibraryIndex } from "../../lib/libraryFilter";
import { sortLibraryIndex, type LibrarySort } from "../../lib/librarySort";
import { useLinkedWorkspaceSettingsOperations } from "../../hooks/useLinkedWorkspaceSettingsOperations";
import { useLinkedWorkspaceStatuses } from "../../hooks/useLinkedWorkspaceStatuses";
import { LinkedWorkspaceChapterRow } from "./LinkedWorkspaceChapterRow";

export function LinkedWorkspaceSettingsPanel({
  library,
}: {
  library: LibraryIndex;
}): React.JSX.Element {
  const { i18n, t } = useTranslation("components");
  const [searchQuery, setSearchQuery] = React.useState("");
  const deferredSearchQuery = React.useDeferredValue(searchQuery);
  const [sort, setSort] = React.useState<LibrarySort>({
    key: "updated",
    direction: "desc",
  });
  const chapterIds = React.useMemo(
    () => library.works.flatMap((work) => work.chapterOrder),
    [library.works],
  );
  const visibleLibrary = React.useMemo(
    () =>
      sortLibraryIndex(
        filterLibraryIndex(library, deferredSearchQuery),
        sort,
        i18n.resolvedLanguage ?? i18n.language,
      ),
    [deferredSearchQuery, i18n.language, i18n.resolvedLanguage, library, sort],
  );
  const { loading, refresh, statuses } = useLinkedWorkspaceStatuses(chapterIds);
  const { busyChapterIds, errors, run } =
    useLinkedWorkspaceSettingsOperations(refresh);
  return (
    <div className="linked-workspace-settings" aria-busy={loading}>
      <div className="linked-workspace-settings-intro">
        <p>{t("settings.results.description")}</p>
      </div>
      <div className="linked-workspace-settings-toolbar">
        <label
          className="library-search-shell linked-workspace-settings-search"
          aria-label={t("settings.results.searchLabel")}
        >
          <IconSearch className="library-search-icon" aria-hidden="true" />
          <input
            className="library-search-input"
            value={searchQuery}
            placeholder={t("settings.results.searchPlaceholder")}
            onChange={(event) => setSearchQuery(event.currentTarget.value)}
          />
        </label>
        <LibrarySortMenu value={sort} onChange={setSort} />
      </div>
      <div className="linked-workspace-settings-list">
        <LinkedWorkspaceWorkList
          busyChapterIds={busyChapterIds}
          errors={errors}
          emptyMessageKey={
            deferredSearchQuery.trim()
              ? "settings.results.noSearchResults"
              : "settings.results.empty"
          }
          library={visibleLibrary}
          onRun={run}
          statuses={statuses}
        />
      </div>
    </div>
  );
}

function LinkedWorkspaceWorkList({
  busyChapterIds,
  emptyMessageKey,
  errors,
  library,
  onRun,
  statuses,
}: {
  busyChapterIds: ReadonlySet<string>;
  emptyMessageKey:
    | "settings.results.empty"
    | "settings.results.noSearchResults";
  errors: ReadonlyMap<string, string>;
  library: LibraryIndex;
  onRun: (
    chapterId: string,
    operation: () => Promise<unknown>,
  ) => Promise<void>;
  statuses: ReadonlyMap<string, LinkedWorkspaceStatus>;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  if (library.works.length === 0) {
    return <p className="linked-workspace-empty">{t(emptyMessageKey)}</p>;
  }
  return (
    <>
      {library.works.map((work) => (
        <section className="linked-workspace-work" key={work.id}>
          <header className="linked-workspace-work-header">
            <strong>{work.title}</strong>
            <span>
              {t("settings.results.chapterCount", {
                count: work.chapters.length,
              })}
            </span>
          </header>
          <div className="linked-workspace-chapter-list">
            {work.chapterOrder.map((chapterId) => {
              const chapter = work.chapters.find(
                (candidate) => candidate.id === chapterId,
              );
              return chapter ? (
                <LinkedWorkspaceChapterRow
                  key={chapter.id}
                  busy={busyChapterIds.has(chapter.id)}
                  chapterId={chapter.id}
                  chapterTitle={chapter.title}
                  error={errors.get(chapter.id)}
                  onRun={onRun}
                  status={statuses.get(chapter.id) ?? null}
                  workId={work.id}
                />
              ) : null;
            })}
          </div>
        </section>
      ))}
    </>
  );
}
