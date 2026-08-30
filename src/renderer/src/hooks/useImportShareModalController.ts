import { useEffect, useState } from "react";
import type { ImportPreviewSession } from "../../../shared/importTypes";
import type {
  WorkShareExportRequest,
  WorkShareImportPreview,
} from "../../../shared/shareTypes";
import type { ShareImportModalSubmit } from "../lib/shareImportTypes";
import type {
  ImportModalFeedback,
  ImportModalSubmit,
} from "../lib/importFlowTypes";

export function useImportShareModalController() {
  return {
    ...useImportModalState(),
    ...useShareModalState(),
  };
}

function useImportModalState() {
  const [translationSourceOpen, setTranslationSourceOpen] = useState(false);
  const [webImportOpen, setWebImportOpen] = useState(false);
  const [webImportBackgrounded, setWebImportBackgrounded] = useState(false);
  const [importPreview, setImportPreview] =
    useState<ImportPreviewSession | null>(null);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [importDraft, setImportDraft] = useState<ImportModalSubmit | null>(
    null,
  );
  const [importFeedback, setImportFeedback] =
    useState<ImportModalFeedback | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  useEffect(() => {
    if (importPreview) {
      setImportDraft(null);
      setImportFeedback(null);
      setImportModalOpen(true);
    } else {
      setImportModalOpen(false);
      setImportDraft(null);
      setImportFeedback(null);
    }
  }, [importPreview]);

  return {
    translationSourceOpen,
    setTranslationSourceOpen,
    webImportOpen,
    setWebImportOpen,
    webImportBackgrounded,
    setWebImportBackgrounded,
    importPreview,
    setImportPreview,
    importModalOpen,
    setImportModalOpen,
    importDraft,
    setImportDraft,
    importFeedback,
    setImportFeedback,
    importBusy,
    setImportBusy,
  };
}

function useShareModalState() {
  const [shareExportOpen, setShareExportOpen] = useState(false);
  const [shareExportDraft, setShareExportDraft] =
    useState<WorkShareExportRequest | null>(null);
  const [shareExportBusy, setShareExportBusy] = useState(false);
  const [shareImportPreview, setShareImportPreview] =
    useState<WorkShareImportPreview | null>(null);
  const [shareImportDraft, setShareImportDraft] =
    useState<ShareImportModalSubmit | null>(null);
  const [shareImportBusy, setShareImportBusy] = useState(false);
  return {
    shareExportOpen,
    setShareExportOpen,
    shareExportDraft,
    setShareExportDraft,
    shareExportBusy,
    setShareExportBusy,
    shareImportPreview,
    setShareImportPreview,
    shareImportDraft,
    setShareImportDraft,
    shareImportBusy,
    setShareImportBusy,
  };
}
