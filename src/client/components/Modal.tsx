import { X } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef } from 'react';

type ModalProps = {
  title: string;
  subtitle?: string;
  wide?: boolean;
  children: ReactNode;
  onClose: () => void;
};

export function Modal({ title, subtitle, wide = false, children, onClose }: ModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    dialogRef.current?.showModal();
    return () => dialogRef.current?.close();
  }, []);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      className={`modal ${wide ? 'modal--wide' : ''}`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) {
          onClose();
        }
      }}
    >
      <div className="modal__surface">
        <header className="modal__header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          <button className="icon-button" type="button" onClick={onClose} title="关闭" aria-label="关闭">
            <X size={18} />
          </button>
        </header>
        <div className="modal__body">{children}</div>
      </div>
    </dialog>
  );
}
