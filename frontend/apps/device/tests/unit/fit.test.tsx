import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fitScale } from "../../src/display/logic/fit";
import { FitText } from "../../src/display/components/FitText";

describe("fitScale", () => {
  it("shrinks to the tighter of width and height, never grows", () => {
    expect(fitScale(200, 50, 100, 100)).toBe(0.5);
    expect(fitScale(50, 50, 100, 100)).toBe(1);
    expect(fitScale(100, 200, 100, 100)).toBe(0.5);
  });
  it("is 1 when the content has no size", () => {
    expect(fitScale(0, 0, 100, 100)).toBe(1);
    expect(fitScale(0, 50, 100, 100)).toBe(1);
    expect(fitScale(50, 0, 100, 100)).toBe(1);
  });
});

describe("FitText", () => {
  it("renders its children unchanged without ResizeObserver", () => {
    render(<FitText testId="fit" className="x">1234A</FitText>);
    const box = screen.getByTestId("fit");
    expect(box).toHaveClass("fit-text", "x");
    expect(box).toHaveTextContent("1234A");
  });
});
