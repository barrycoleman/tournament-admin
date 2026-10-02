import { useId, useState } from "react";
import { Modal } from "./Modal";

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
    <Modal
      labelledBy={headingId}
      onCancel={() => {
        if (!isPending) onCancel();
      }}
    >
      <h2 id={headingId}>{heading}</h2>
      <p>{body}</p>
      {requiredPhrase && (
        <label className="field">
          <span className="field__label">{phrasePrompt}</span>
          <input
            className="input"
            value={typed}
            data-autofocus
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
        {/* Destructive dialog: start on the safe choice, so a stray Enter cancels. */}
        <button
          type="button"
          className="btn"
          onClick={onCancel}
          disabled={isPending}
          data-autofocus={requiredPhrase ? undefined : true}
        >
          {cancelLabel}
        </button>
      </div>
    </Modal>
  );
}
