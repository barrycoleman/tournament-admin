import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fitScale } from "../../src/display/logic/fit";
import { FitLine, FitText } from "../../src/display/components/FitText";

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

describe("FitLine", () => {
  it("keeps its children on one line at the chosen side without ResizeObserver", () => {
    render(<FitLine testId="line" align="end">12345AB 67890CD</FitLine>);
    const box = screen.getByTestId("line");
    expect(box).toHaveClass("fit-line", "fit-line--end");
    expect(box.querySelector(".fit-line__inner")).toHaveTextContent("12345AB 67890CD");
  });
});
