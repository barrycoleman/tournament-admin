import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

function Greeting() {
  return <p>toolchain ok</p>;
}

describe("shared package test toolchain", () => {
  it("renders with React Testing Library under jsdom", () => {
    render(<Greeting />);
    expect(screen.getByText("toolchain ok")).toBeInTheDocument();
  });
});
