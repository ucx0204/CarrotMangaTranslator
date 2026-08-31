import React from "react";
import { useTranslation } from "react-i18next";

const LINKED_WORKSPACE_FOLDERS = [
  "result",
  "originals",
  "inpainted",
  "mask",
] as const;

export function LinkedWorkspaceFolderRoles(): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <dl
      className="linked-workspace-folder-roles"
      aria-label={t("linkedWorkspaceFolders.label")}
    >
      {LINKED_WORKSPACE_FOLDERS.map((folder) => (
        <div key={folder}>
          <dt>{folder}</dt>
          <dd>{t(`linkedWorkspaceFolders.${folder}`)}</dd>
        </div>
      ))}
    </dl>
  );
}
