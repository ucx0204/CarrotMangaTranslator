import React from "react";
import styles from "./Section.module.css";

type SectionDensity = "compact" | "comfortable";
type SectionHeadingLevel = 2 | 3 | 4;

export type SectionHeaderProps = {
  actions?: React.ReactNode;
  className?: string;
  description?: React.ReactNode;
  descriptionClassName?: string;
  headingLevel?: SectionHeadingLevel;
  title: React.ReactNode;
  titleClassName?: string;
  titleId?: string;
};

export function SectionHeader({
  actions,
  className,
  description,
  descriptionClassName,
  headingLevel = 3,
  title,
  titleClassName,
  titleId,
}: SectionHeaderProps): React.JSX.Element {
  const generatedTitleId = React.useId();
  const resolvedTitleId = titleId ?? generatedTitleId;
  return (
    <header className={joinClasses(styles.header, className)}>
      <div className={styles.headerCopy}>
        <SectionHeading
          className={joinClasses(styles.title, titleClassName)}
          id={resolvedTitleId}
          level={headingLevel}
        >
          {title}
        </SectionHeading>
        {description ? (
          <p className={joinClasses(styles.description, descriptionClassName)}>
            {description}
          </p>
        ) : null}
      </div>
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </header>
  );
}

export type SectionProps = Omit<SectionHeaderProps, "className" | "titleId"> & {
  bodyClassName?: string;
  children: React.ReactNode;
  className?: string;
  density?: SectionDensity;
  divided?: boolean;
  headerClassName?: string;
};

export function Section({
  actions,
  bodyClassName,
  children,
  className,
  density = "comfortable",
  description,
  descriptionClassName,
  divided = false,
  headerClassName,
  headingLevel = 3,
  title,
  titleClassName,
}: SectionProps): React.JSX.Element {
  const titleId = React.useId();
  return (
    <section
      className={joinClasses(
        styles.section,
        density === "compact" ? styles.compact : "",
        divided ? styles.divided : "",
        className,
      )}
      aria-labelledby={titleId}
    >
      <SectionHeader
        actions={actions}
        className={headerClassName}
        description={description}
        descriptionClassName={descriptionClassName}
        headingLevel={headingLevel}
        title={title}
        titleClassName={titleClassName}
        titleId={titleId}
      />
      <div className={joinClasses(styles.body, bodyClassName)}>{children}</div>
    </section>
  );
}

export type CollapsibleSectionProps = Omit<
  SectionProps,
  "bodyClassName" | "children"
> & {
  bodyClassName?: string;
  children: React.ReactNode;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
};

export function CollapsibleSection({
  actions,
  bodyClassName,
  children,
  className,
  density = "comfortable",
  description,
  descriptionClassName,
  divided = false,
  expanded,
  headerClassName,
  headingLevel = 3,
  onExpandedChange,
  title,
  titleClassName,
}: CollapsibleSectionProps): React.JSX.Element {
  const contentId = React.useId();
  const descriptionId = React.useId();
  const titleId = React.useId();
  return (
    <section
      className={joinClasses(
        styles.section,
        density === "compact" ? styles.compact : "",
        divided ? styles.divided : "",
        className,
      )}
      aria-labelledby={titleId}
    >
      <header className={joinClasses(styles.header, headerClassName)}>
        <div className={styles.headerCopy}>
          <SectionHeading
            className={joinClasses(styles.title, titleClassName)}
            level={headingLevel}
          >
            <button
              className={styles.collapseButton}
              type="button"
              aria-controls={contentId}
              aria-describedby={description ? descriptionId : undefined}
              aria-expanded={expanded}
              aria-labelledby={titleId}
              onClick={() => onExpandedChange(!expanded)}
            >
              <span
                className={styles.chevron}
                data-expanded={expanded || undefined}
                aria-hidden="true"
              >
                ›
              </span>
              <span id={titleId}>{title}</span>
            </button>
          </SectionHeading>
          {description ? (
            <p
              className={joinClasses(styles.description, descriptionClassName)}
              id={descriptionId}
            >
              {description}
            </p>
          ) : null}
        </div>
        {actions ? <div className={styles.actions}>{actions}</div> : null}
      </header>
      <div
        className={joinClasses(styles.body, bodyClassName)}
        id={contentId}
        hidden={!expanded}
      >
        {children}
      </div>
    </section>
  );
}

function SectionHeading({
  children,
  className,
  id,
  level,
}: {
  children: React.ReactNode;
  className: string;
  id?: string;
  level: SectionHeadingLevel;
}): React.JSX.Element {
  if (level === 2)
    return (
      <h2 className={className} id={id}>
        {children}
      </h2>
    );
  if (level === 4)
    return (
      <h4 className={className} id={id}>
        {children}
      </h4>
    );
  return (
    <h3 className={className} id={id}>
      {children}
    </h3>
  );
}

function joinClasses(...classNames: (string | undefined)[]): string {
  return classNames.filter(Boolean).join(" ");
}
