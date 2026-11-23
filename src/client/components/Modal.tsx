import { type ReactNode } from "react";
import { Modal as Overlay } from "@heroui/react/modal";
import { Button } from "@heroui/react/button";
import { X } from "lucide-react";
type Props = {
  title: string;
  subtitle?: string;
  wide?: boolean;
  children: ReactNode;
  onClose: () => void;
};
export function Modal({
  title,
  subtitle,
  wide = false,
  children,
  onClose,
}: Props) {
  return (
    <Overlay.Backdrop
      isOpen
      isDismissable
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      className="mail-dialog-overlay"
    >
      <Overlay.Container className="mail-overlay-container">
        <Overlay.Dialog
          className={"modal mail-dialog" + (wide ? " modal--wide" : "")}
          aria-label={title}
        >
          <div className="modal__surface">
            <header className="modal__header">
              <div>
                <Overlay.Heading>{title}</Overlay.Heading>
                {subtitle && <p>{subtitle}</p>}
              </div>
              <Button
                className="mail-icon"
                type="button"
                aria-label="关闭"
                onPress={onClose}
              >
                <X size={18} />
              </Button>
            </header>
            <div className="modal__body">{children}</div>
          </div>
        </Overlay.Dialog>
      </Overlay.Container>
    </Overlay.Backdrop>
  );
}
