import React from "react";
import { useRovingFocus } from "./useRovingFocus";

export type TabDefinition<T extends string> = {
  value: T;
  label: string;
  id: string;
  panelId: string;
};

/**
 * A tablist whose buttons switch tab panels. For mode pickers and filters that
 * do not own a panel, use `SegmentedControl` instead.
 */
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
  const roving = useRovingFocus({
    count: items.length,
    onActivate: (index) => {
      const item = items[index];
      if (item) onChange(item.value);
    },
  });

  return (
    <div className={className} role="tablist" aria-label={ariaLabel}>
      {items.map((item, index) => {
        const selected = value === item.value;
        return (
          <button
            key={item.value}
            ref={roving.register(index)}
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
            onKeyDown={(event) => roving.handleKeyDown(index, event)}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
