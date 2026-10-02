import { useId, useState } from "react";

interface ConfirmDialogProps {
  heading: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  /** When set, the confirm button stays disabled until this exact text is typed. */
  requiredPhrase?: string | null;
  phrasePrompt?: string;
  isPending?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  heading,
  body,
  confirmLabel,
  cancelLabel,
  requiredPhrase,
  phrasePrompt,
  isPending = false,
  error,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const headingId = useId();
  const [typed, setTyped] = useState("");
  const phraseSatisfied = !requiredPhrase || typed.trim() === requiredPhrase;

  return (
    <div className="dialog-overlay">
      <div className="dialog" role="alertdialog" aria-labelledby={headingId}>
        <h2 id={headingId}>{heading}</h2>
        <p>{body}</p>
        {requiredPhrase && (
          <label className="field">
            <span className="field__label">{phrasePrompt}</span>
            <input
              className="input"
              value={typed}
              autoFocus
              onChange={(event) => setTyped(event.target.value)}
            />
          </label>
        )}
        {error && (
          <p className="alert alert-danger" role="alert">
            {error}
          </p>
        )}
        <div className="dialog__actions">
          <button
            type="button"
            className="btn btn-danger"
            onClick={onConfirm}
            disabled={!phraseSatisfied || isPending}
          >
            {confirmLabel}
          </button>
          <button type="button" className="btn" onClick={onCancel} disabled={isPending}>
            {cancelLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
