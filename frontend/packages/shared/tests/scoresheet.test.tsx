import { describe, expect, it } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  ScoresheetForm,
  clampCounter,
  defaultValues,
  type ScoresheetField,
  type ScoresheetTranslate,
  type ScoresheetValues,
} from "../src/scoresheet";

const t: ScoresheetTranslate = (key, options) => {
  const label = String(options?.label ?? "");
  if (key === "scoresheet.decrease") return `Decrease ${label}`;
  if (key === "scoresheet.increase") return `Increase ${label}`;
  return key;
};

function field(overrides: Partial<ScoresheetField>): ScoresheetField {
  return {
    name: "balls",
    label: "Balls",
    data_type: "integer",
    widget: "counter",
    min: 0,
    max: 10,
    step: 2,
    options: null,
    icon: null,
    scope: "team",
    default: 0,
    ...overrides,
  };
}

const BALLS = field({});
const PARKED = field({
  name: "parked", label: "Parked", data_type: "boolean", widget: "toggle", min: null, max: null, step: null, default: false,
});
const ZONE = field({
  name: "zone", label: "Zone", data_type: "enum", widget: "select", min: null, max: null, step: null,
  options: ["near", "far"], default: "near",
});
const LEVEL = field({
  name: "level", label: "Level", data_type: "enum", widget: "radio", min: null, max: null, step: null,
  options: [1, 2, 3], default: 1, icon: "▲",
});
const FIELDS = [BALLS, PARKED, ZONE, LEVEL];

let latest: ScoresheetValues = {};

function Harness({ initial, errors }: { initial?: ScoresheetValues; errors?: Record<string, string> }) {
  const [values, setValues] = useState<ScoresheetValues>(initial ?? defaultValues(FIELDS));
  return (
    <ScoresheetForm
      fields={FIELDS}
      values={values}
      errors={errors}
      t={t}
      idPrefix="sheet"
      onChange={(next) => {
        latest = next;
        setValues(next);
      }}
    />
  );
}

describe("scoresheet helpers", () => {
  it("builds the default values", () => {
    expect(defaultValues(FIELDS)).toEqual({ balls: 0, parked: false, zone: "near", level: 1 });
  });

  it("clamps to min and max, and leaves unset bounds alone", () => {
    expect(clampCounter(BALLS, 12)).toBe(10);
    expect(clampCounter(BALLS, -3)).toBe(0);
    expect(clampCounter(field({ min: null, max: null }), 1000)).toBe(1000);
  });
});

describe("ScoresheetForm", () => {
  it("steps a counter by its step and clamps it at max", () => {
    render(<Harness initial={{ balls: 8, parked: false, zone: "near", level: 1 }} />);
    fireEvent.click(screen.getByRole("button", { name: "Increase Balls" }));
    expect(screen.getByLabelText("Balls")).toHaveValue("10");
    expect(screen.getByRole("button", { name: "Increase Balls" })).toBeDisabled();
  });

  it("clamps a counter at min and disables decrease there", () => {
    render(<Harness initial={{ balls: 1, parked: false, zone: "near", level: 1 }} />);
    fireEvent.click(screen.getByRole("button", { name: "Decrease Balls" }));
    expect(screen.getByLabelText("Balls")).toHaveValue("0");
    expect(screen.getByRole("button", { name: "Decrease Balls" })).toBeDisabled();
  });

  it("passes a typed number through unclamped, and other text as text", () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText("Balls"), { target: { value: "12" } });
    expect(latest.balls).toBe(12);
    fireEvent.change(screen.getByLabelText("Balls"), { target: { value: "abc" } });
    expect(latest.balls).toBe("abc");
  });

  it("toggles a boolean", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("switch", { name: "Parked" }));
    expect(latest.parked).toBe(true);
  });

  it("returns the chosen select option", () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText("Zone"), { target: { value: "far" } });
    expect(latest.zone).toBe("far");
  });

  it("shows a disabled blank choice, not the first option, while a select has no valid value", () => {
    render(<Harness initial={{ balls: 0, parked: false, level: 1 }} />);
    const select = screen.getByLabelText("Zone") as HTMLSelectElement;
    expect(select).toHaveValue("");
    expect(select.selectedOptions[0]).toBeDisabled();
    expect(screen.getAllByRole("option")).toHaveLength(3);
    fireEvent.change(select, { target: { value: "far" } });
    expect(latest.zone).toBe("far");
    expect(screen.getByLabelText("Zone")).toHaveValue("far");
    // The blank choice goes away once the value is one of the options.
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });

  it("also shows the blank choice for a value that is not among the options", () => {
    render(<Harness initial={{ balls: 0, parked: false, zone: "bogus", level: 1 }} />);
    expect(screen.getByLabelText("Zone")).toHaveValue("");
  });

  it("returns numeric radio options as numbers and shows the icon decoratively", () => {
    render(<Harness />);
    expect(screen.getByRole("group", { name: "Level" })).toBeInTheDocument();
    expect(screen.getByText("▲")).toHaveAttribute("aria-hidden", "true");
    fireEvent.click(screen.getByRole("radio", { name: "2" }));
    expect(latest.level).toBe(2);
  });

  it("shows an error beside its field", () => {
    render(<Harness errors={{ balls: "Must be at most 10." }} />);
    const input = screen.getByLabelText("Balls");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("Must be at most 10.");
  });
});
