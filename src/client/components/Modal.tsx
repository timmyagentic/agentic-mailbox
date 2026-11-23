import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { type ReactNode, useRef } from 'react';

type ModalProps = {
  title: string;
  subtitle?: string;
  wide?: boolean;
  children: ReactNode;
  onClose: () => void;
};

export function Modal({ title, subtitle, wide = false, children, onClose }: ModalProps) {
  const opener = useRef<HTMLElement | null>(null);
  return (
    <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="mail-dialog-overlay" />
        <Dialog.Content className={wide ? 'modal mail-dialog modal--wide' : 'modal mail-dialog'}
          {...(!subtitle && { 'aria-describedby': undefined })}
          onOpenAutoFocus={() => { opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
          onCloseAutoFocus={event => {
            if (opener.current?.isConnected) { event.preventDefault(); opener.current.focus(); }
          }}>
          <div className="modal__surface">
            <header className="modal__header">
              <div><Dialog.Title>{title}</Dialog.Title>{subtitle && <Dialog.Description>{subtitle}</Dialog.Description>}</div>
              <Dialog.Close asChild>
                <button className="icon-button" type="button" title="关闭" aria-label="关闭"><X size={18} /></button>
              </Dialog.Close>
            </header>
            <div className="modal__body">{children}</div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
