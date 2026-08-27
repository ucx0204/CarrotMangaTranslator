import React from "react";
import { createPortal } from "react-dom";
import type { MangaPage } from "../../../../shared/libraryTypes";
import { PageTimingDialog } from "./PageTimingDialog";

export function PageTimingDialogPortal({
  onClose,
  open,
  pages,
}: {
  onClose: () => void;
  open: boolean;
  pages: MangaPage[];
}): React.ReactPortal | null {
  return open
    ? createPortal(
        <PageTimingDialog pages={pages} onClose={onClose} />,
        document.body,
      )
    : null;
}
