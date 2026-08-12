import React from "react";
import { useTranslation } from "react-i18next";
import type { ChapterSnapshot, MangaPage } from "../../../shared/libraryTypes";
import {
  compileSearchPattern,
  findSearchReplaceMatches,
  type SearchReplaceField,
  type SearchReplaceRequest,
  type SearchReplaceScope,
} from "../lib/searchReplace";
import { CheckboxField } from "./ui/CheckboxField";
import { Modal } from "./ui/Modal";
import { Select } from "./ui/Select";

export type SearchReplaceModalProps = {
  chapter: ChapterSnapshot;
  disabled?: boolean;
  onApply: (request: SearchReplaceRequest) => void;
  onClose: () => void;
  onNavigateToBlock: (pageId: string, blockId: string) => void;
  page: MangaPage | null;
};

export function SearchReplaceModal({
  chapter,
  disabled = false,
  onApply,
  onClose,
  onNavigateToBlock,
  page,
}: SearchReplaceModalProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const model = useSearchReplaceModel(chapter, page?.id ?? null);
  return (
    <Modal
      ariaLabel={t("searchReplace.title")}
      bodyClassName="search-replace-body"
      closeOnBackdrop
      onClose={onClose}
      size="lg"
      title={t("searchReplace.title")}
      footer={
        <SearchReplaceFooter
          disabled={disabled}
          model={model}
          onApply={onApply}
          onClose={onClose}
        />
      }
    >
      <SearchReplaceInputs model={model} />
      {model.result.error ? (
        <p className="search-replace-error">
          {t("searchReplace.invalidRegex", { message: model.result.error })}
        </p>
      ) : null}
      <SearchReplaceResults model={model} onNavigate={onNavigateToBlock} />
    </Modal>
  );
}

type SearchReplaceModel = {
  matchCount: number;
  request: SearchReplaceRequest;
  result: ReturnType<typeof resolveSearchReplaceResult>;
  setCaseSensitive: (value: boolean) => void;
  setField: (value: SearchReplaceField) => void;
  setQuery: (value: string) => void;
  setReplacement: (value: string) => void;
  setScope: (value: SearchReplaceScope) => void;
  setUseRegex: (value: boolean) => void;
};

function useSearchReplaceModel(
  chapter: ChapterSnapshot,
  pageId: string | null,
): SearchReplaceModel {
  const [query, setQuery] = React.useState("");
  const [replacement, setReplacement] = React.useState("");
  const [scope, setScope] = React.useState<SearchReplaceScope>("page");
  const [field, setField] = React.useState<SearchReplaceField>("translated");
  const [caseSensitive, setCaseSensitive] = React.useState(false);
  const [useRegex, setUseRegex] = React.useState(false);
  const request = React.useMemo<SearchReplaceRequest>(
    () => ({ caseSensitive, field, query, replacement, scope, useRegex }),
    [caseSensitive, field, query, replacement, scope, useRegex],
  );
  const result = React.useMemo(
    () => resolveSearchReplaceResult(chapter, pageId, request),
    [chapter, pageId, request],
  );
  const matchCount = result.matches.reduce(
    (sum, match) => sum + match.count,
    0,
  );
  return {
    matchCount,
    request,
    result,
    setCaseSensitive,
    setField,
    setQuery,
    setReplacement,
    setScope,
    setUseRegex,
  };
}

function resolveSearchReplaceResult(
  chapter: ChapterSnapshot,
  pageId: string | null,
  request: SearchReplaceRequest,
) {
  try {
    compileSearchPattern(request);
    return {
      error: "",
      matches: findSearchReplaceMatches(chapter, pageId, request),
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      matches: [] as ReturnType<typeof findSearchReplaceMatches>,
    };
  }
}

function SearchReplaceInputs({
  model,
}: {
  model: SearchReplaceModel;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <>
      <div className="search-replace-inputs">
        <label>
          <span>{t("searchReplace.find")}</span>
          <input
            autoFocus
            value={model.request.query}
            onChange={(event) => model.setQuery(event.target.value)}
          />
        </label>
        <label>
          <span>{t("searchReplace.replaceWith")}</span>
          <input
            value={model.request.replacement}
            onChange={(event) => model.setReplacement(event.target.value)}
          />
        </label>
      </div>
      <SearchReplaceOptions model={model} />
    </>
  );
}

function SearchReplaceOptions({
  model,
}: {
  model: SearchReplaceModel;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="search-replace-options">
      <div className="search-replace-select-field">
        <span>{t("searchReplace.scope")}</span>
        <Select
          ariaLabel={t("searchReplace.scope")}
          value={model.request.scope}
          options={[
            { value: "page", label: t("searchReplace.scopes.page") },
            { value: "chapter", label: t("searchReplace.scopes.chapter") },
          ]}
          onValueChange={(value) => model.setScope(value as SearchReplaceScope)}
        />
      </div>
      <div className="search-replace-select-field">
        <span>{t("searchReplace.field")}</span>
        <Select
          ariaLabel={t("searchReplace.field")}
          value={model.request.field}
          options={[
            {
              value: "translated",
              label: t("searchReplace.fields.translated"),
            },
            { value: "source", label: t("searchReplace.fields.source") },
            { value: "both", label: t("searchReplace.fields.both") },
          ]}
          onValueChange={(value) => model.setField(value as SearchReplaceField)}
        />
      </div>
      <CheckboxField
        className="search-replace-checkbox"
        checked={model.request.caseSensitive}
        label={t("searchReplace.caseSensitive")}
        onCheckedChange={model.setCaseSensitive}
      />
      <CheckboxField
        className="search-replace-checkbox"
        checked={model.request.useRegex}
        label={t("searchReplace.regex")}
        onCheckedChange={model.setUseRegex}
      />
    </div>
  );
}

function SearchReplaceResults({
  model,
  onNavigate,
}: {
  model: SearchReplaceModel;
  onNavigate: SearchReplaceModalProps["onNavigateToBlock"];
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="search-replace-results">
      {model.result.matches.map((match) => (
        <button
          type="button"
          key={`${match.pageId}:${match.blockId}:${match.field}`}
          onClick={() => onNavigate(match.pageId, match.blockId)}
        >
          <strong>{match.pageName}</strong>
          <span>
            {t(`searchReplace.fields.${match.field}`)} · {match.count}
          </span>
          <small>{match.preview || t("searchReplace.emptyText")}</small>
        </button>
      ))}
      {!model.request.query ? <p>{t("searchReplace.enterQuery")}</p> : null}
      {model.request.query &&
      !model.result.error &&
      model.result.matches.length === 0 ? (
        <p>{t("searchReplace.noMatches")}</p>
      ) : null}
    </div>
  );
}

function SearchReplaceFooter({
  disabled,
  model,
  onApply,
  onClose,
}: {
  disabled: boolean;
  model: SearchReplaceModel;
  onApply: SearchReplaceModalProps["onApply"];
  onClose: SearchReplaceModalProps["onClose"];
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const replaceDisabled =
    disabled ||
    !model.request.query ||
    Boolean(model.result.error) ||
    model.matchCount === 0;
  return (
    <div className="search-replace-footer">
      <span>{t("searchReplace.matchCount", { count: model.matchCount })}</span>
      <button type="button" className="secondary" onClick={onClose}>
        {t("common.cancel")}
      </button>
      <button
        type="button"
        className="primary"
        disabled={replaceDisabled}
        onClick={() => onApply(model.request)}
      >
        {t("searchReplace.replaceAll", { count: model.matchCount })}
      </button>
    </div>
  );
}
