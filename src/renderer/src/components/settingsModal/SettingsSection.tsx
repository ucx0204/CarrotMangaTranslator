import React from "react";
import { Section } from "../ui/Section";

type SettingsSectionProps = {
  children: React.ReactNode;
  className?: string;
  description?: React.ReactNode;
  title: React.ReactNode;
};

export function SettingsSection({
  children,
  className,
  description,
  title,
}: SettingsSectionProps): React.JSX.Element {
  return (
    <Section
      bodyClassName="settings-section-body"
      className={`settings-section${className ? ` ${className}` : ""}`}
      description={description}
      headerClassName="settings-section-header"
      title={title}
    >
      {children}
    </Section>
  );
}
