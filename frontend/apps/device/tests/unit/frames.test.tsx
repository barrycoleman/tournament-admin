import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import "../../src/i18nSetup";
import type { Team } from "../../src/display/api";
import { MatchFrame, BottomBar } from "../../src/display/components/MatchFrame";
import { TeamBand } from "../../src/display/components/TeamBand";

const teams = new Map<number, Team>([
  [1, { id: 1, number: "101A", name: "One" } as Team],
  [2, { id: 2, number: "2002B" , name: "Two" } as Team],
]);

describe("TeamBand", () => {
  it("renders each team number in its own cell inside a side-coloured band", () => {
    render(<TeamBand side="red" teamIds={[1, 2]} teams={teams} orientation="row" />);
    const band = screen.getByTestId("band-red");
    expect(band).toHaveClass("team-band--red", "team-band--row");
    expect(within(band).getByTestId("band-number-1")).toHaveTextContent("101A");
    expect(within(band).getByTestId("band-number-2")).toHaveTextContent("2002B");
  });
  it("uses the blue testid and fill orientation", () => {
    render(<TeamBand side="blue" teamIds={[1]} teams={teams} orientation="fill" />);
    expect(screen.getByTestId("band-blue")).toHaveClass("team-band--fill");
  });
});

describe("MatchFrame", () => {
  it("renders the body and the bottom slot with no heading", () => {
    render(<MatchFrame bottom={<BottomBar prefix="Qualification" title="Q7" field="Field 1" end={<b>end</b>} />}><p>body</p></MatchFrame>);
    expect(screen.getByText("body")).toBeInTheDocument();
    expect(screen.queryByRole("heading")).toBeNull();
    const bar = screen.getByTestId("bottom-bar");
    expect(bar).toHaveTextContent("Qualification · Q7");
    expect(bar).toHaveTextContent("Field 1");
    expect(bar).toHaveTextContent("end");
  });
  it("omits prefix and field when absent", () => {
    render(<BottomBar title="Q7" />);
    expect(screen.getByTestId("bottom-bar")).toHaveTextContent(/^Q7$/);
  });
});
