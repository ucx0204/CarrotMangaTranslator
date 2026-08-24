import React from "react";
import { WarnIcon } from "./ui/icons";

export type TranslationOverwriteWarningProps = {
  title: React.ReactNode;
  description: React.ReactNode;
};

export function TranslationOverwriteWarning({
  title,
  description,
}: TranslationOverwriteWarningProps): React.JSX.Element {
  return (
    <div className="translation-overwrite-warning" role="note">
      <WarnIcon size={16} aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        <span>{description}</span>
      </div>
    </div>
  );
}
