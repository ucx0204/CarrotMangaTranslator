import React from "react";

type IconProps = {
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
  </>,
);

export const WarnIcon = createIcon(
  <>
    <path d="M12 9v4" />
    <path d="M12 17h.01" />
    <path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
  </>,
);

export const CheckCircleIcon = createIcon(
  <>
    <path d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
    <path d="m8.5 12 2.5 2.5 4.5-5" />
  </>,
);

export const InfoIcon = createIcon(
  <>
    <path d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
    <path d="M12 11v5" />
    <path d="M12 8h.01" />
  </>,
);

export const UndoIcon = createIcon(
  <>
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h11a5 5 0 0 1 0 10h-3" />
  </>,
);

export const RedoIcon = createIcon(
  <>
    <path d="m15 14 5-5-5-5" />
    <path d="M20 9H9a5 5 0 0 0 0 10h3" />
  </>,
);

export const EyeIcon = createIcon(
  <>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
    <circle cx="12" cy="12" r="3" />
  </>,
);

export const EyeOffIcon = createIcon(
  <>
    <path d="M10.7 5.1A10.8 10.8 0 0 1 12 5c6.5 0 10 7 10 7a18.5 18.5 0 0 1-2.2 3.2" />
    <path d="M6.6 6.6A18.4 18.4 0 0 0 2 12s3.5 7 10 7a10.7 10.7 0 0 0 5.4-1.4" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    <path d="M3 3l18 18" />
  </>,
);

export const RestoreIcon = createIcon(
  <>
    <path d="M7 7h7.5a5.5 5.5 0 1 1-4.7 8.3" />
    <path d="M7 7v5H2" />
    <path d="m6.8 7.2 4.5 4.5" />
  </>,
);

export const RefreshIcon = createIcon(
  <>
    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
    <path d="M21 4v5h-5" />
  </>,
);

export const EditIcon = createIcon(
  <>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" />
  </>,
);

export const BoldIcon = createIcon(
  <>
    <path d="M7 5h6a3.5 3.5 0 0 1 0 7H7z" />
    <path d="M7 12h7a3.5 3.5 0 0 1 0 7H7z" />
  </>,
);

export const ItalicIcon = createIcon(
  <>
    <path d="M19 4h-9" />
    <path d="M14 20H5" />
    <path d="M15 4 9 20" />
  </>,
);

export const AlignLeftIcon = createIcon(
  <>
    <path d="M4 6h16" />
    <path d="M4 12h10" />
    <path d="M4 18h13" />
  </>,
);

export const AlignCenterIcon = createIcon(
  <>
    <path d="M4 6h16" />
    <path d="M7 12h10" />
    <path d="M5 18h14" />
  </>,
);

export const AlignRightIcon = createIcon(
  <>
    <path d="M4 6h16" />
    <path d="M10 12h10" />
    <path d="M7 18h13" />
  </>,
);

export const SortIcon = createIcon(
  <>
    <path d="M5 7h13" />
    <path d="M5 12h9" />
    <path d="M5 17h5" />
  </>,
);

export const PlusIcon = createIcon(
  <>
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </>,
);

export const TrashIcon = createIcon(
  <>
    <path d="M4 7h16" />
    <path d="M10 11v6" />
    <path d="M14 11v6" />
    <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
    <path d="M9 7V4h6v3" />
  </>,
);

export const CopyIcon = createIcon(
  <>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </>,
);

export const FloatIcon = createIcon(
  <>
    <path d="M14 4h6v6" />
    <path d="M20 4l-7 7" />
    <path d="M19 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5" />
  </>,
);

export const DockIcon = createIcon(
  <>
    <path d="M9 9H4V4" />
    <path d="M4 4l6 6" />
    <path d="M19 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-3" />
    <path d="M14 4h3a2 2 0 0 1 2 2v3" />
  </>,
);

export const ExpandIcon = createIcon(
  <>
    <path d="M15 3h6v6" />
    <path d="M9 21H3v-6" />
    <path d="M21 3l-7 7" />
    <path d="M3 21l7-7" />
  </>,
);
