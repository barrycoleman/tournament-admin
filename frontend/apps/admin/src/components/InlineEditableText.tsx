import { useEffect, useRef, useState, type CSSProperties } from "react";

function PencilIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 20l1-4.5L15.5 5 19 8.5 8.5 19 4 20Z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
      <path d="M13.5 6.5l4 4" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}

interface InlineEditableTextProps {
  value: string;
  onSave: (newValue: string) => void;
  isSaving: boolean;
  error?: string | null;
  onCancel?: () => void;
  editLabel: string;
  saveLabel: string;
  cancelLabel: string;
  inputLabel: string;
  inputId?: string;
  style?: CSSProperties;
}

/**
 * A read-only value with a pencil-icon button that swaps it for an input
 * plus explicit Save/Cancel actions -- deliberately not save-on-blur, so
 * a click outside the field (or a stray Tab) never commits an edit. Exits
 * edit mode on its own once `value` actually changes to the saved text
 * (the signal a save genuinely landed, driven by the caller's own query
 * cache update on mutation success); a failed save leaves the field open
 * with `error` shown so the user can fix and retry, or Cancel out.
 */
export function InlineEditableText({
  value,
  onSave,
  isSaving,
  error,
  onCancel,
  editLabel,
  saveLabel,
  cancelLabel,
  inputLabel,
  inputId,
  style,
}: InlineEditableTextProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const previousValueRef = useRef(value);

  useEffect(() => {
    if (editing && value !== previousValueRef.current) {
      setEditing(false);
    }
    previousValueRef.current = value;
  }, [value, editing]);

  function startEditing() {
    setDraft(value);
    setEditing(true);
  }

  function handleSave() {
    const trimmed = draft.trim();
    if (trimmed === value) {
      setEditing(false);
      return;
    }
    onSave(trimmed);
  }

  function handleCancel() {
    setDraft(value);
    setEditing(false);
    onCancel?.();
  }

  if (!editing) {
    return (
      <div className="inline-edit" style={style}>
        <span className="inline-edit__value">{value}</span>
        <button
          type="button"
          className="icon-btn"
          onClick={startEditing}
          aria-label={editLabel}
          title={editLabel}
        >
          <PencilIcon />
        </button>
      </div>
    );
  }

  return (
    <div className="inline-edit-editor" style={style}>
      <div className="inline-edit inline-edit--editing">
        <input
          id={inputId}
          className="input"
          style={{ flex: 1 }}
          aria-label={inputLabel}
          value={draft}
          disabled={isSaving}
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") handleSave();
            if (event.key === "Escape") handleCancel();
          }}
        />
        <button
          type="button"
          className="btn btn-primary btn-small"
          onClick={handleSave}
          disabled={isSaving}
        >
          {saveLabel}
        </button>
        <button type="button" className="btn btn-small" onClick={handleCancel} disabled={isSaving}>
          {cancelLabel}
        </button>
      </div>
      {error && (
        <p className="alert alert-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
