import React from "react";
import {
  IconLayoutSidebarRightCollapse,
  IconLayoutSidebarRightExpand,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import {
  UnifiedRightRail,
  type UnifiedRightRailProps,
} from "./rightRailPanels";
import { useEventCallback } from "../hooks/useEventCallback";
import { IconButton } from "./ui/IconButton";

type AppRightRailProps = UnifiedRightRailProps;

// The text-block editor is rendered by EditorPanelContainer, which reads the
// selected block and edit actions from the panel session context rather than
// from these rail props.
export function AppRightRail(props: AppRightRailProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const stableActions = useStableRightRailActions(props);
  const panelOpen = Boolean(props.currentChapter);
  const [contextExpanded, setContextExpanded] = React.useState(false);
  const toggleRef = React.useRef<HTMLButtonElement | null>(null);

  React.useEffect(() => {
    setContextExpanded(false);
  }, [props.currentChapter?.id]);

  React.useEffect(() => {
    if (!contextExpanded) return;
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setContextExpanded(false);
      toggleRef.current?.focus();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [contextExpanded]);

  const toggleLabel = t(
    contextExpanded ? "runPanel.hideInspector" : "runPanel.showInspector",
  );
  const ToggleIcon = contextExpanded
    ? IconLayoutSidebarRightCollapse
    : IconLayoutSidebarRightExpand;
  return (
    <aside
      className={`right-rail ${panelOpen ? "is-open" : "is-hidden"} ${contextExpanded ? "is-context-expanded" : ""}`.trim()}
      aria-hidden={panelOpen ? undefined : true}
    >
      {panelOpen ? (
        <IconButton
          ref={toggleRef}
          className="right-rail-context-toggle"
          label={toggleLabel}
          title={toggleLabel}
          aria-expanded={contextExpanded}
          onClick={() => setContextExpanded((expanded) => !expanded)}
        >
          <ToggleIcon size={19} stroke={2} aria-hidden="true" />
        </IconButton>
      ) : null}
      <UnifiedRightRail {...props} {...stableActions} />
    </aside>
  );
}

function useStableRightRailActions(
  props: AppRightRailProps,
): Pick<
  AppRightRailProps,
  | "onBrushColorChange"
  | "onBrushRadiusChange"
  | "onAdjustPatternMask"
  | "onCancelJob"
  | "onClearStatusLines"
  | "onClearPatternMask"
  | "onChangeBlockSelection"
  | "onOpenBlockEditor"
  | "onOpenAutoInpaintingOptions"
  | "onOpenExport"
  | "onOpenPsdExport"
  | "onViewLinkedResults"
  | "onOpenStyleGuide"
  | "onOpenTextView"
  | "onOpenTranslateOptions"
  | "onMoveBlockInReadingOrder"
  | "onPeekToggle"
  | "onRedo"
  | "onResetPage"
  | "onRunBubbleLayout"
  | "onRunDrawnPattern"
  | "onSelectBlock"
  | "onSortReadingOrder"
  | "onToggleBlocks"
  | "onToggleChrome"
  | "onUndo"
  | "onUpdateBlock"
> {
  return {
    onBrushColorChange: useEventCallback(props.onBrushColorChange),
    onBrushRadiusChange: useEventCallback(props.onBrushRadiusChange),
    onAdjustPatternMask: useEventCallback(
      props.onAdjustPatternMask ?? NOOP_ADJUST_MASK,
    ),
    onCancelJob: useEventCallback(props.onCancelJob),
    onClearStatusLines: useEventCallback(props.onClearStatusLines),
    onClearPatternMask: useEventCallback(props.onClearPatternMask),
    onChangeBlockSelection: useEventCallback(
      props.onChangeBlockSelection ?? NOOP_SELECTION_CHANGE,
    ),
    onOpenBlockEditor: useEventCallback(props.onOpenBlockEditor),
    onOpenAutoInpaintingOptions: useEventCallback(
      props.onOpenAutoInpaintingOptions,
    ),
    onOpenExport: useEventCallback(props.onOpenExport),
    onOpenPsdExport: useEventCallback(props.onOpenPsdExport ?? NOOP),
    onViewLinkedResults: useEventCallback(props.onViewLinkedResults ?? NOOP),
    onOpenStyleGuide: useEventCallback(props.onOpenStyleGuide),
    onOpenTextView: useEventCallback(props.onOpenTextView),
    onOpenTranslateOptions: useEventCallback(props.onOpenTranslateOptions),
    onMoveBlockInReadingOrder: useEventCallback(
      props.onMoveBlockInReadingOrder ?? NOOP_MOVE_BLOCK,
    ),
    onPeekToggle: useEventCallback(props.onPeekToggle),
    onRedo: useEventCallback(props.onRedo),
    onResetPage: useEventCallback(props.onResetPage),
    onRunBubbleLayout: useEventCallback(props.onRunBubbleLayout),
    onRunDrawnPattern: useEventCallback(props.onRunDrawnPattern),
    onSelectBlock: useEventCallback(props.onSelectBlock),
    onSortReadingOrder: useEventCallback(props.onSortReadingOrder ?? NOOP),
    onToggleBlocks: useEventCallback(props.onToggleBlocks),
    onToggleChrome: useEventCallback(props.onToggleChrome),
    onUndo: useEventCallback(props.onUndo),
    onUpdateBlock: useEventCallback(props.onUpdateBlock),
  };
}

const NOOP = (): void => undefined;
const NOOP_ADJUST_MASK = (): void => undefined;
const NOOP_MOVE_BLOCK = (): void => undefined;
const NOOP_SELECTION_CHANGE = (): void => undefined;
