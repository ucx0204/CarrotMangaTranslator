import React from "react";
import { CheckboxField } from "./ui/CheckboxField";
import { Modal } from "./ui/Modal";
import { ModalActionBar, ModalActionButtons } from "./ui/ModalActionBar";

export function PagePickerModalShell({
  bodyClassName,
  cardClassName,
  children,
  closeDisabled,
  closeOnEsc,
  footerActions,
  footerLeading,
  onClose,
  size = "lg",
  title,
  width,
}: {
  bodyClassName?: string;
  cardClassName?: string;
  children: React.ReactNode;
  closeDisabled?: boolean;
  closeOnEsc?: boolean;
  footerActions: React.ReactNode;
  footerLeading?: React.ReactNode;
  onClose: () => void;
  size?: "md" | "lg" | "xl";
  title: React.ReactNode;
  width?: string;
}): React.JSX.Element {
  return (
    <Modal
      title={title}
      size={size}
      fillHeight
      onClose={onClose}
      closeDisabled={closeDisabled}
      closeOnEsc={closeOnEsc}
      width={width}
      cardClassName={cardClassName}
      bodyClassName={bodyClassName}
      footer={
        <ModalActionBar leading={footerLeading} actions={footerActions} />
      }
    >
      {children}
    </Modal>
  );
}

export function PagePickerModalActionButtons(
  props: React.ComponentProps<typeof ModalActionButtons>,
): React.JSX.Element {
  return <ModalActionButtons {...props} />;
}

export function PagePickerModalCheckbox(
  props: React.ComponentProps<typeof CheckboxField>,
): React.JSX.Element {
  return <CheckboxField {...props} />;
}
