import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { Modal } from "../../src/components/Modal";

function Harness({ onCancel = () => {} }: { onCancel?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button onClick={() => setOpen(true)}>Open</button>
      {open && (
        <Modal
          labelledBy="modal-heading"
          onCancel={() => {
            onCancel();
            setOpen(false);
          }}
        >
          <h2 id="modal-heading">Delete it?</h2>
          <button>Delete</button>
          <button data-autofocus onClick={() => setOpen(false)}>
            Cancel
          </button>
        </Modal>
      )}
    </div>
  );
}

describe("Modal", () => {
  it("opens as a named modal dialog and focuses the data-autofocus element", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    const dialog = screen.getByRole("alertdialog", { name: "Delete it?" });
    expect(dialog).toHaveAttribute("open");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("routes the browser's cancel (Escape) to onCancel instead of closing itself", () => {
    const onCancel = vi.fn();
    render(<Harness onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    const dialog = screen.getByRole("alertdialog");
    const cancelEvent = new Event("cancel", { cancelable: true });
    act(() => {
      dialog.dispatchEvent(cancelEvent);
    });

    expect(cancelEvent.defaultPrevented).toBe(true);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("returns focus to the element that opened it once it closes", () => {
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open" });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });
});
