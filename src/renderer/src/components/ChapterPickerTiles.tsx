import React from "react";
import { useTranslation } from "react-i18next";
import type { MangaPage } from "../../../shared/libraryTypes";
import { mangaGateway } from "../api/mangaGateway";
import type { TriState } from "../lib/translationSelection";

export function PageThumb({
  page,
  index,
  checked,
  onToggle,
}: {
  page: MangaPage;
  index: number;
  checked: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const [url, setUrl] = React.useState<string | undefined>();
  React.useEffect(() => {
    let cancelled = false;
    void mangaGateway
      .getPageImageDataUrl(page.imagePath)
      .then((resolved) => {
        if (!cancelled) {
          setUrl(resolved);
        }
      })
      .catch((error) => console.error(error));
    return () => {
      cancelled = true;
    };
  }, [page.imagePath]);

  const done = page.analysisStatus === "completed";
  return (
    <label
      className={[
        "translate-page-thumb",
        checked ? "selected" : "",
        done ? "done" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <input
        type="checkbox"
        className="translate-page-thumb-check"
        checked={checked}
        onChange={onToggle}
      />
      <span className="translate-page-thumb-img">
        {url ? (
          <img src={url} alt={page.name} loading="lazy" draggable={false} />
        ) : (
          <span className="translate-page-thumb-skeleton" />
        )}
        {done ? (
          <span
            className="translate-page-thumb-badge"
            aria-label={t("chapterPicker.translated")}
          >
            ✓
          </span>
        ) : null}
      </span>
      <span className="translate-page-thumb-cap" title={page.name}>
        <span className="translate-page-thumb-no">{index + 1}</span>
        <span className="translate-page-thumb-name">{page.name}</span>
      </span>
    </label>
  );
}

export function TriCheckbox({
  state,
  label,
  onChange,
}: {
  state: TriState;
  label: string;
  onChange: () => void;
}): React.JSX.Element {
  const ref = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (ref.current) {
      ref.current.indeterminate = state === "some";
    }
  }, [state]);
  return (
    <input
      ref={ref}
      type="checkbox"
      className="translate-chapter-check"
      aria-label={label}
      checked={state === "all"}
      onChange={onChange}
    />
  );
}
