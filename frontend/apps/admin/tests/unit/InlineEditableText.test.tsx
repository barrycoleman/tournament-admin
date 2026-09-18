import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { InlineEditableText } from "../../src/components/InlineEditableText";

const LABELS = {
  editLabel: "Edit name",
  saveLabel: "Save",
  cancelLabel: "Cancel",
  inputLabel: "Name",
};

function Harness({
  initialValue,
  onSave,
  isSaving = false,
  error = null,
}: {
  initialValue: string;
  onSave: (newValue: string) => void;
  isSaving?: boolean;
  error?: string | null;
}) {
  const [value, setValue] = useState(initialValue);
  return (
    <InlineEditableText
      value={value}
      onSave={(newValue) => {
        onSave(newValue);
        setValue(newValue);
      }}
      isSaving={isSaving}
      error={error}
      {...LABELS}
    />
  );
}

describe("InlineEditableText", () => {
  it("shows the value as read-only text with an edit button by default", () => {
    render(<InlineEditableText value="Regional Qualifier" onSave={vi.fn()} isSaving={false} {...LABELS} />);

    expect(screen.getByText("Regional Qualifier")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit name" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
  });

  it("clicking the edit button reveals an input pre-filled with the current value, plus Save and Cancel", () => {
    render(<InlineEditableText value="Regional Qualifier" onSave={vi.fn()} isSaving={false} {...LABELS} />);

    fireEvent.click(screen.getByRole("button", { name: "Edit name" }));

    expect(screen.getByLabelText("Name")).toHaveValue("Regional Qualifier");
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("calls onSave with the trimmed draft when Save is clicked", () => {
    const onSave = vi.fn();
    render(<InlineEditableText value="Regional Qualifier" onSave={onSave} isSaving={false} {...LABELS} />);

    fireEvent.click(screen.getByRole("button", { name: "Edit name" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "  State Championship  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith("State Championship");
  });

  it("pressing Enter in the input saves", () => {
    const onSave = vi.fn();
    render(<InlineEditableText value="Regional Qualifier" onSave={onSave} isSaving={false} {...LABELS} />);

    fireEvent.click(screen.getByRole("button", { name: "Edit name" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "State Championship" } });
    fireEvent.keyDown(screen.getByLabelText("Name"), { key: "Enter" });

    expect(onSave).toHaveBeenCalledWith("State Championship");
  });

  it("pressing Escape cancels without saving and reverts the draft", () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    render(
      <InlineEditableText
        value="Regional Qualifier"
        onSave={onSave}
        onCancel={onCancel}
        isSaving={false}
        {...LABELS}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit name" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Something else entirely" } });
    fireEvent.keyDown(screen.getByLabelText("Name"), { key: "Escape" });

    expect(onSave).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
    expect(screen.getByText("Regional Qualifier")).toBeInTheDocument();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
  });

  it("clicking Cancel reverts to display mode without saving", () => {
    const onSave = vi.fn();
    render(<InlineEditableText value="Regional Qualifier" onSave={onSave} isSaving={false} {...LABELS} />);

    fireEvent.click(screen.getByRole("button", { name: "Edit name" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Something else" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText("Regional Qualifier")).toBeInTheDocument();
  });

  it("saving with an unchanged value exits edit mode without calling onSave", () => {
    const onSave = vi.fn();
    render(<InlineEditableText value="Regional Qualifier" onSave={onSave} isSaving={false} {...LABELS} />);

    fireEvent.click(screen.getByRole("button", { name: "Edit name" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText("Regional Qualifier")).toBeInTheDocument();
  });

  it("shows an inline error and stays in edit mode when the save fails", () => {
    render(
      <InlineEditableText
        value="Regional Qualifier"
        onSave={vi.fn()}
        isSaving={false}
        error="Event name cannot be empty"
        {...LABELS}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit name" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Event name cannot be empty");
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
  });

  it("disables the input and both buttons while isSaving", () => {
    render(<InlineEditableText value="Regional Qualifier" onSave={vi.fn()} isSaving={true} {...LABELS} />);

    fireEvent.click(screen.getByRole("button", { name: "Edit name" }));

    expect(screen.getByLabelText("Name")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });

  it("exits edit mode automatically once the value prop actually changes (a successful save)", () => {
    render(<Harness initialValue="Regional Qualifier" onSave={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Edit name" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "State Championship" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(screen.getByText("State Championship")).toBeInTheDocument();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
  });
});
