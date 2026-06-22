import { useState, type Dispatch, type SetStateAction } from "react";
import type { ImportPreviewSession } from "../../../shared/importTypes";
import type { WorkShareImportPreview } from "../../../shared/shareTypes";

export function useImportShareModalController(): {
  translationSourceOpen: boolean;
  setTranslationSourceOpen: Dispatch<SetStateAction<boolean>>;
  importPreview: ImportPreviewSession | null;
  setImportPreview: Dispatch<SetStateAction<ImportPreviewSession | null>>;
  importBusy: boolean;
  setImportBusy: Dispatch<SetStateAction<boolean>>;
  shareExportOpen: boolean;
  setShareExportOpen: Dispatch<SetStateAction<boolean>>;
  shareExportBusy: boolean;
  setShareExportBusy: Dispatch<SetStateAction<boolean>>;
  shareImportPreview: WorkShareImportPreview | null;
  setShareImportPreview: Dispatch<
    SetStateAction<WorkShareImportPreview | null>
  >;
  shareImportBusy: boolean;
  setShareImportBusy: Dispatch<SetStateAction<boolean>>;
} {
  const [translationSourceOpen, setTranslationSourceOpen] = useState(false);
  const [importPreview, setImportPreview] =
    useState<ImportPreviewSession | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [shareExportOpen, setShareExportOpen] = useState(false);
  const [shareExportBusy, setShareExportBusy] = useState(false);
  const [shareImportPreview, setShareImportPreview] =
    useState<WorkShareImportPreview | null>(null);
  const [shareImportBusy, setShareImportBusy] = useState(false);

  return {
    translationSourceOpen,
    setTranslationSourceOpen,
    importPreview,
    setImportPreview,
    importBusy,
    setImportBusy,
    shareExportOpen,
    setShareExportOpen,
    shareExportBusy,
    setShareExportBusy,
    shareImportPreview,
    setShareImportPreview,
    shareImportBusy,
    setShareImportBusy,
  };
}
