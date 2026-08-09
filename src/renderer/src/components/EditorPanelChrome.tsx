import React from "react";
import { IconDotsVertical, IconEraserOff } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { TranslationBlock } from "../../../shared/textTypes";
import { IconButton } from "./ui/IconButton";
import { CopyIcon, TrashIcon } from "./ui/icons";
import { handleMenuKeyboardNavigation } from "./ui/menuKeyboard";
import { Tabs } from "./ui/Tabs";

const EDITOR_TABS = ["text", "layout", "format"] as const;
export type EditorTabId = (typeof EDITOR_TABS)[number];

type BlockOverflowMenuProps = {
  block: TranslationBlock;
  disabled: boolean;
  onDelete: () => void;
  onDuplicate: () => void;
  onUpdate: (patch: Partial<TranslationBlock>) => void;
};

export function BlockOverflowMenu({
  block,
  disabled,
  onDelete,
  onDuplicate,
  onUpdate,
}: BlockOverflowMenuProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const [open, setOpen, rootRef, triggerRef, close] = useOverflowMenu(
    block.id,
    disabled,
  );
  const run = (action: () => void): void => {
    close(true);
    action();
  };
  const label = t("editor.moreActions", { defaultValue: "블록 작업 더 보기" });
  return (
    <div className="editor-overflow" ref={rootRef}>
      <IconButton
        ref={triggerRef}
        size="sm"
        label={label}
        aria-expanded={open}
        aria-haspopup="menu"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <IconDotsVertical size={17} stroke={2.1} aria-hidden="true" />
      </IconButton>
      {open && !disabled ? (
        <div
          className="editor-overflow-menu"
          role="menu"
          aria-label={label}
          onKeyDown={(event) => handleMenuKeyDown(event, close)}
        >
          <button
            aria-checked={Boolean(block.inpaintExcluded)}
            role="menuitemcheckbox"
            type="button"
            onClick={() =>
              run(() => onUpdate({ inpaintExcluded: !block.inpaintExcluded }))
            }
          >
            <IconEraserOff size={17} stroke={2.1} aria-hidden="true" />
            <span>{t("editor.inpainting.exclude")}</span>
            <span className="editor-overflow-check" aria-hidden="true">
              {block.inpaintExcluded ? "✓" : ""}
            </span>
          </button>
          <button
            role="menuitem"
            type="button"
            onClick={() => run(onDuplicate)}
          >
            <CopyIcon size={16} />
            <span>{t("common.duplicate")}</span>
          </button>
          <button
            className="danger"
            role="menuitem"
            type="button"
            onClick={() => run(onDelete)}
          >
            <TrashIcon size={16} />
            <span>{t("common.delete")}</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function EditorPanelHeader({
  actions,
  excluded,
}: {
  actions?: React.ReactNode;
  excluded: boolean;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <header className="editor-panel-header">
      <div className="editor-panel-title">
        <h2>{t("common.blocks")}</h2>
        {excluded ? (
          <span className="editor-state-badge">
            {t("editor.inpainting.exclude")}
          </span>
        ) : null}
      </div>
      {actions ? (
        <div className="editor-panel-header-actions">{actions}</div>
      ) : null}
    </header>
  );
}

export function EditorPanelTabs({
  activeTab,
  baseId,
  onSelect,
}: {
  activeTab: EditorTabId;
  baseId: string;
  onSelect: (tab: EditorTabId) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const labels: Record<EditorTabId, string> = {
    text: t("editor.tabs.text", { defaultValue: "텍스트" }),
    layout: t("editor.tabs.layout", { defaultValue: "배치" }),
    format: t("editor.tabs.format", { defaultValue: "서식" }),
  };
  return (
    <Tabs
      className="editor-panel-tabs"
      ariaLabel={t("editor.tabs.label", {
        defaultValue: "블록 편집 영역",
      })}
      items={EDITOR_TABS.map((tab) => ({
        value: tab,
        label: labels[tab],
        id: `${baseId}-tab-${tab}`,
        panelId: `${baseId}-panel-${tab}`,
      }))}
      value={activeTab}
      onChange={onSelect}
    />
  );
}

export function EditorTabPanel({
  activeTab,
  baseId,
  children,
  tab,
}: {
  activeTab: EditorTabId;
  baseId: string;
  children: React.ReactNode;
  tab: EditorTabId;
}): React.JSX.Element {
  return (
    <div
      id={`${baseId}-panel-${tab}`}
      className="editor-tab-panel"
      aria-labelledby={`${baseId}-tab-${tab}`}
      hidden={activeTab !== tab}
      role="tabpanel"
    >
      {children}
    </div>
  );
}

export function EmptyEditorPanel({
  areaTranslateAvailable,
  areaTranslateSelecting,
  disabled,
  headerActions,
  onStartAreaTranslate,
}: {
  areaTranslateAvailable: boolean;
  areaTranslateSelecting: boolean;
  disabled: boolean;
  headerActions?: React.ReactNode;
  onStartAreaTranslate?: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <section className="editor-panel muted">
      <EditorPanelHeader actions={headerActions} excluded={false} />
      <button
        className={`area-translate-button ${areaTranslateSelecting ? "active" : ""}`}
        disabled={disabled || !areaTranslateAvailable}
        onClick={onStartAreaTranslate}
      >
        {t(
          areaTranslateSelecting
            ? "areaTranslation.cancelSelection"
            : "areaTranslation.title",
        )}
      </button>
    </section>
  );
}

type OverflowMenuState = [
  boolean,
  React.Dispatch<React.SetStateAction<boolean>>,
  React.RefObject<HTMLDivElement | null>,
  React.RefObject<HTMLButtonElement | null>,
  (restoreFocus: boolean) => void,
];

function useOverflowMenu(
  blockId: string,
  disabled: boolean,
): OverflowMenuState {
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  React.useEffect(() => setOpen(false), [blockId, disabled]);
  React.useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside, true);
    return () =>
      document.removeEventListener("pointerdown", closeOutside, true);
  }, [open]);
  React.useEffect(() => {
    if (!open) return;
    rootRef.current
      ?.querySelector<HTMLButtonElement>('[role^="menuitem"]')
      ?.focus();
  }, [open]);
  const close = React.useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);
  return [open, setOpen, rootRef, triggerRef, close];
}

function handleMenuKeyDown(
  event: React.KeyboardEvent<HTMLDivElement>,
  close: (restoreFocus: boolean) => void,
): void {
  handleMenuKeyboardNavigation(event, {
    onEscape: () => close(true),
    onTab: () => close(false),
  });
}
