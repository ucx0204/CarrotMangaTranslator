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
  fontManagerOpen: boolean;
  importPreview: unknown;
  inpaintingGuideOpen: boolean;
  renameTarget: unknown;
  settingsOpen: boolean;
  shareExportOpen: boolean;
  shareImportPreview: unknown;
  translationSourceOpen: boolean;
  webImportOpen: boolean;
}): boolean {
  // AppModals receives the complete prop object at runtime. Recognize every
  // conventional boolean `*Open` flag automatically so a newly added modal
  // cannot be stranded behind this inactive render boundary.
  const hasOpenFlag = Object.entries(props).some(
    ([key, value]) => key.endsWith("Open") && value === true,
  );
  return (
    hasOpenFlag ||
    Boolean(
      props.importPreview ||
      props.shareImportPreview ||
      props.renameTarget ||
      props.confirmDialog,
    )
  );
}

export function isFloatingOverlaySubtreeActive(props: {
  autoInpaintingOptionsProps: unknown;
  blockLibraryProps: unknown;
  commandPaletteProps: { open: boolean };
  exportOptionsProps: unknown;
  gatherTextProps: unknown;
  pageRetranslateProps: unknown;
  shortcutHelpProps: { open: boolean };
  styleGuideProps: unknown;
  translationOptionsProps: unknown;
}): boolean {
  return Boolean(
    props.blockLibraryProps ||
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
