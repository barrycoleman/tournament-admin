import { useEffect, useRef, type ReactNode } from "react";

interface ModalProps {
  /** id of the element that names the dialog (usually its heading). */
  labelledBy: string;
  /** Escape, or any other browser-initiated cancel. The caller unmounts the modal. */
  onCancel: () => void;
  children: ReactNode;
}

/**
 * A modal dialog on the native `<dialog>` element opened with
 * `showModal()`, so the browser does the hard parts: the rest of the page
 * becomes inert (no clicking or tabbing behind it), Tab stays inside, and
 * Escape cancels.
 *
 * On open, focus moves to the element marked `data-autofocus` (React's
 * `autoFocus` prop doesn't render the attribute `showModal()` looks for),
 * falling back to the browser's choice: the first focusable element. On
 * close, focus goes back to whatever had it before -- usually the button
 * that opened the dialog -- if that element is still on the page.
 *
 * Mount it to open it and unmount it to close it; there is no `open` prop.
 */
export function Modal({ labelledBy, onCancel, children }: ModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    dialog.showModal();
    dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus();

    function handleCancel(event: Event) {
      // Keep the dialog open until the caller unmounts it, so React state
      // stays the one source of truth for whether it's showing.
      event.preventDefault();
      onCancelRef.current();
    }
    dialog.addEventListener("cancel", handleCancel);

    return () => {
      dialog.removeEventListener("cancel", handleCancel);
      if (dialog.open) dialog.close();
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, []);

  return (
    <dialog ref={dialogRef} className="dialog" role="alertdialog" aria-labelledby={labelledBy}>
      {children}
    </dialog>
  );
}
