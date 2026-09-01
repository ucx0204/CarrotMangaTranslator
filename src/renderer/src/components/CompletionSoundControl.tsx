import React from "react";
import { createPortal } from "react-dom";
import { IconVolume2, IconVolumeOff } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type {
  CompletionSoundPreferences,
  ResolvedCompletionSoundPreferences,
} from "../hooks/useCompletionSound";
import { IconButton } from "./ui/IconButton";
import { usePopupController } from "./ui/usePopupController";

const SOUND_POPOVER_WIDTH_PX = 216;
const SOUND_POPOVER_HEIGHT_PX = 177;
const SOUND_POPOVER_EDGE_PX = 8;

type SoundPopoverPosition = {
  left: number;
  top: number;
  arrowLeft: number;
};

export function CompletionSoundControl({
  preferences,
  onChange,
}: {
  preferences: ResolvedCompletionSoundPreferences;
  onChange: (preferences: CompletionSoundPreferences) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const [open, setOpen] = React.useState(false);
  const [position, setPosition] = React.useState<SoundPopoverPosition | null>(
    null,
  );
  const panelId = React.useId();
  const { rootRef, toggle, triggerRef } = usePopupController({
    initialFocus: false,
    isInsidePopup: isSoundPopoverTarget,
    open,
    onOpenChange: setOpen,
  });
  React.useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const host = triggerRef.current.closest<HTMLElement>(".status-popover");
    const updatePosition = (): void => {
      if (!triggerRef.current) return;
      resetSoundPopoverHost(host);
      liftSoundPopoverHost(host, triggerRef.current);
      setPosition(resolveSoundPopoverPosition(triggerRef.current));
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    return () => {
      window.removeEventListener("resize", updatePosition);
      resetSoundPopoverHost(host);
    };
  }, [open, triggerRef]);
  const TriggerIcon = preferences.muted ? IconVolumeOff : IconVolume2;
  return (
    <div className="status-sound-control" ref={rootRef}>
      <IconButton
        ref={triggerRef}
        className="status-sound-trigger"
        size="sm"
        label={t("statusDock.soundSettings.open")}
        title=""
        aria-controls={panelId}
        aria-expanded={open}
        onClick={toggle}
      >
        <TriggerIcon size={16} aria-hidden="true" />
      </IconButton>
      {open && position
        ? createPortal(
            <CompletionSoundPopover
              id={panelId}
              position={position}
              preferences={preferences}
              onChange={onChange}
            />,
            document.body,
          )
        : null}
    </div>
  );
}

function liftSoundPopoverHost(
  host: HTMLElement | null,
  trigger: HTMLButtonElement,
): void {
  if (!host) return;
  const triggerBounds = trigger.getBoundingClientRect();
  const desiredBottom =
    triggerBounds.bottom + 6 + SOUND_POPOVER_HEIGHT_PX + SOUND_POPOVER_EDGE_PX;
  const overflow = Math.max(0, desiredBottom - window.innerHeight);
  const availableLift = Math.max(
    0,
    host.getBoundingClientRect().top - SOUND_POPOVER_EDGE_PX,
  );
  const lift = Math.min(overflow, availableLift);
  if (lift <= 0) return;
  host.style.setProperty("--status-sound-host-lift", `${lift}px`);
  host.classList.add("sound-settings-open");
}

function resetSoundPopoverHost(host: HTMLElement | null): void {
  host?.classList.remove("sound-settings-open");
  host?.style.removeProperty("--status-sound-host-lift");
}

function isSoundPopoverTarget(target: Node): boolean {
  const element = target instanceof Element ? target : target.parentElement;
  return Boolean(element?.closest(".status-sound-popover"));
}

function resolveSoundPopoverPosition(
  trigger: HTMLButtonElement,
): SoundPopoverPosition {
  const bounds = trigger.getBoundingClientRect();
  const preferredLeft = bounds.right - SOUND_POPOVER_WIDTH_PX;
  const maxLeft =
    window.innerWidth - SOUND_POPOVER_WIDTH_PX - SOUND_POPOVER_EDGE_PX;
  const left = Math.max(
    SOUND_POPOVER_EDGE_PX,
    Math.min(preferredLeft, maxLeft),
  );
  const preferredTop = bounds.bottom + 6;
  const maxTop =
    window.innerHeight - SOUND_POPOVER_HEIGHT_PX - SOUND_POPOVER_EDGE_PX;
  const top = Math.max(SOUND_POPOVER_EDGE_PX, Math.min(preferredTop, maxTop));
  const triggerCenter = bounds.left + bounds.width / 2;
  const arrowLeft = Math.max(
    10,
    Math.min(triggerCenter - left - 4, SOUND_POPOVER_WIDTH_PX - 18),
  );
  return { left, top, arrowLeft };
}

function CompletionSoundPopover({
  id,
  position,
  preferences,
  onChange,
}: {
  id: string;
  position: SoundPopoverPosition;
  preferences: ResolvedCompletionSoundPreferences;
  onChange: (preferences: CompletionSoundPreferences) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const volumeId = `${id}-volume`;
  const percent = Math.round(
    Math.min(1, Math.max(0, preferences.volume)) * 100,
  );
  const update = (patch: Partial<ResolvedCompletionSoundPreferences>): void =>
    onChange({ ...preferences, ...patch });
  return (
    <div
      id={id}
      className={`status-sound-popover${preferences.muted ? " muted" : ""}`}
      role="group"
      aria-label={t("statusDock.soundSettings.open")}
      style={
        {
          left: position.left,
          top: position.top,
          "--status-sound-arrow-left": `${position.arrowLeft}px`,
        } as React.CSSProperties
      }
    >
      <div className="status-sound-master-row">
        <SoundMuteButton
          muted={preferences.muted}
          item={t("statusDock.soundSettings.all")}
          onToggle={() => update({ muted: !preferences.muted })}
        />
        <input
          id={volumeId}
          type="range"
          min={0}
          max={100}
          step={1}
          value={percent}
          aria-label={t("statusDock.completionSoundVolume")}
          aria-valuetext={`${percent}%`}
          style={
            {
              "--status-sound-progress": `${percent}%`,
            } as React.CSSProperties
          }
          onChange={(event) =>
            update({ volume: Number(event.currentTarget.value) / 100 })
          }
        />
        <output htmlFor={volumeId}>{percent}%</output>
      </div>
      <SoundCategoryList preferences={preferences} update={update} />
    </div>
  );
}

function SoundCategoryList({
  preferences,
  update,
}: {
  preferences: ResolvedCompletionSoundPreferences;
  update: (patch: Partial<ResolvedCompletionSoundPreferences>) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="status-sound-category-list">
      <SoundMuteRow
        muted={preferences.translationMuted}
        label={t("statusDock.soundSettings.translation")}
        onToggle={() =>
          update({ translationMuted: !preferences.translationMuted })
        }
      />
      <SoundMuteRow
        muted={preferences.soundEffectMuted}
        label={t("statusDock.soundSettings.soundEffect")}
        onToggle={() =>
          update({ soundEffectMuted: !preferences.soundEffectMuted })
        }
      />
      <SoundMuteRow
        muted={preferences.sourceErasingMuted}
        label={t("statusDock.soundSettings.sourceErasing")}
        onToggle={() =>
          update({ sourceErasingMuted: !preferences.sourceErasingMuted })
        }
      />
      <SoundMuteRow
        muted={preferences.researchMuted}
        label={t("statusDock.soundSettings.research")}
        onToggle={() => update({ researchMuted: !preferences.researchMuted })}
      />
    </div>
  );
}

function SoundMuteRow({
  muted,
  label,
  onToggle,
}: {
  muted: boolean;
  label: string;
  onToggle: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const Icon = muted ? IconVolumeOff : IconVolume2;
  const actionLabel = t(
    muted ? "statusDock.soundSettings.unmute" : "statusDock.soundSettings.mute",
    { item: label },
  );
  return (
    <button
      type="button"
      className="status-sound-category-row"
      aria-label={actionLabel}
      aria-pressed={muted}
      onClick={onToggle}
    >
      <span className="status-sound-category-icon" aria-hidden="true">
        <Icon size={15} />
      </span>
      <span>{label}</span>
    </button>
  );
}

function SoundMuteButton({
  muted,
  item,
  onToggle,
}: {
  muted: boolean;
  item: string;
  onToggle: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const Icon = muted ? IconVolumeOff : IconVolume2;
  const label = t(
    muted ? "statusDock.soundSettings.unmute" : "statusDock.soundSettings.mute",
    { item },
  );
  return (
    <IconButton
      className="status-sound-mute-button"
      size="sm"
      aria-pressed={muted}
      label={label}
      title=""
      onClick={onToggle}
    >
      <Icon size={15} aria-hidden="true" />
    </IconButton>
  );
}
