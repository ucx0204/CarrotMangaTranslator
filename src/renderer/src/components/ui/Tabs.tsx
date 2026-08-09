import React from "react";

export type TabDefinition<T extends string> = {
  value: T;
  label: string;
  id: string;
  panelId: string;
};

export function Tabs<T extends string>({
  ariaLabel,
  className,
  items,
  tabClassName,
  value,
  onChange,
}: {
  ariaLabel: string;
  className?: string;
  items: readonly TabDefinition<T>[];
  tabClassName?: string;
  value: T;
  onChange: (value: T) => void;
}): React.JSX.Element {
  const refs = React.useRef<Array<HTMLButtonElement | null>>([]);

  const activateAt = (index: number): void => {
    const item = items[index];
    if (!item) return;
    onChange(item.value);
    refs.current[index]?.focus();
  };

  const handleKeyDown = (
    index: number,
    event: React.KeyboardEvent<HTMLButtonElement>,
  ): void => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (index + 1) % items.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (index - 1 + items.length) % items.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = items.length - 1;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    activateAt(nextIndex);
  };

  return (
    <div className={className} role="tablist" aria-label={ariaLabel}>
      {items.map((item, index) => {
        const selected = value === item.value;
        return (
          <button
            key={item.value}
            ref={(element) => {
              refs.current[index] = element;
            }}
            type="button"
            role="tab"
            id={item.id}
            aria-selected={selected}
            aria-controls={item.panelId}
            tabIndex={selected ? 0 : -1}
            className={[tabClassName ?? "", selected ? "active" : ""]
              .filter(Boolean)
              .join(" ")}
            onClick={() => onChange(item.value)}
            onKeyDown={(event) => handleKeyDown(index, event)}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
