import React from "react";

export type IconProps = {
  size?: number;
  className?: string;
};

function createIcon(paths: React.ReactNode, viewBox = "0 0 24 24") {
  return function Icon({ size = 18, className }: IconProps): React.JSX.Element {
    return (
      <svg
        width={size}
        height={size}
        viewBox={viewBox}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        className={className}
      >
        {paths}
      </svg>
    );
  };
}

export const CloseIcon = createIcon(
  <>
    <path d="M6 6l12 12" />
    <path d="M18 6 6 18" />
  </>
);

export const WarnIcon = createIcon(
  <>
    <path d="M12 9v4" />
    <path d="M12 17h.01" />
    <path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
  </>
);

export const UndoIcon = createIcon(
  <>
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h11a5 5 0 0 1 0 10h-3" />
  </>
);

export const RedoIcon = createIcon(
  <>
    <path d="m15 14 5-5-5-5" />
    <path d="M20 9H9a5 5 0 0 0 0 10h3" />
  </>
);

export const EyeIcon = createIcon(
  <>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
    <circle cx="12" cy="12" r="3" />
  </>
);

export const BrushIcon = createIcon(
  <>
    <path d="M4 16.5c2.6-.3 4.4.2 5.6 1.4 1.2 1.2 1.7 3 1.4 5.6-2.7.2-5-.4-6.3-1.8-1.1-1.2-1.4-3-.7-5.2Z" />
    <path d="M10.4 16.1 20.7 5.8c.8-.8.8-2 0-2.8-.8-.8-2-.8-2.8 0L7.6 13.3" />
  </>
);

export const MaskIcon = createIcon(
  <>
    <path d="M4 18c3.4-6.4 7.1-10.7 11-13" />
    <path d="M9 19c2.9-4.3 6.1-7.2 9.5-8.8" />
    <path d="M5.5 13.5c3.8.4 7.6 1.8 11.4 4.3" />
    <path d="M4 20h16" />
  </>
);

export const RestoreIcon = createIcon(
  <>
    <path d="M7 7h7.5a5.5 5.5 0 1 1-4.7 8.3" />
    <path d="M7 7v5H2" />
    <path d="m6.8 7.2 4.5 4.5" />
  </>
);

export const PickerIcon = createIcon(
  <>
    <path d="m14.5 4.5 5 5" />
    <path d="m5 19 4.4-1.1 8.9-8.9-3.3-3.3-8.9 8.9L5 19Z" />
    <path d="M7.2 14.8 9.2 16.8" />
  </>
);

export const RefreshIcon = createIcon(
  <>
    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
    <path d="M21 4v5h-5" />
  </>
);

export const EditIcon = createIcon(
  <>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" />
  </>
);

export const BoldIcon = createIcon(
  <>
    <path d="M7 5h6a3.5 3.5 0 0 1 0 7H7z" />
    <path d="M7 12h7a3.5 3.5 0 0 1 0 7H7z" />
  </>
);

export const ItalicIcon = createIcon(
  <>
    <path d="M19 4h-9" />
    <path d="M14 20H5" />
    <path d="M15 4 9 20" />
  </>
);

export const AlignLeftIcon = createIcon(
  <>
    <path d="M4 6h16" />
    <path d="M4 12h10" />
    <path d="M4 18h13" />
  </>
);

export const AlignCenterIcon = createIcon(
  <>
    <path d="M4 6h16" />
    <path d="M7 12h10" />
    <path d="M5 18h14" />
  </>
);

export const AlignRightIcon = createIcon(
  <>
    <path d="M4 6h16" />
    <path d="M10 12h10" />
    <path d="M7 18h13" />
  </>
);
