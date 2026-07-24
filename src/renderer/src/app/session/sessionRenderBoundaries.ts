import React from "react";

export function memoWhileInactive<Props extends object>(
  Component: React.ComponentType<Props>,
  isActive: (props: Props) => boolean,
) {
  return React.memo(
    Component,
    (previous, next) => !isActive(previous) && !isActive(next),
  );
}

export function isAppModalSubtreeActive(props: {
  confirmDialog: unknown;
  importPreview: unknown;
  inpaintingGuideOpen: boolean;
  renameTarget: unknown;
  settingsOpen: boolean;
  shareExportOpen: boolean;
  shareImportPreview: unknown;
  translationSourceOpen: boolean;
}): boolean {
  return Boolean(
    props.translationSourceOpen ||
    props.importPreview ||
    props.shareExportOpen ||
    props.shareImportPreview ||
    props.renameTarget ||
    props.settingsOpen ||
    props.confirmDialog ||
    props.inpaintingGuideOpen,
  );
}

export function isFloatingOverlaySubtreeActive(props: {
  autoInpaintingOptionsProps: unknown;
  commandPaletteProps: { open: boolean };
  exportOptionsProps: unknown;
  gatherTextProps: unknown;
  pageRetranslateProps: unknown;
  shortcutHelpProps: { open: boolean };
  styleGuideProps: unknown;
  translationOptionsProps: unknown;
}): boolean {
  return Boolean(
    props.autoInpaintingOptionsProps ||
    props.commandPaletteProps.open ||
    props.exportOptionsProps ||
    props.gatherTextProps ||
    props.pageRetranslateProps ||
    props.shortcutHelpProps.open ||
    props.styleGuideProps ||
    props.translationOptionsProps,
  );
}
