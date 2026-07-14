import React from "react";

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
    <section className={`settings-section${className ? ` ${className}` : ""}`}>
      <header className="settings-section-header">
        <h3>{title}</h3>
        {description ? <p>{description}</p> : null}
      </header>
      <div className="settings-section-body">{children}</div>
    </section>
  );
}
