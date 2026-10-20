import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ApiError, type ApiRequestOptions } from "../src/api-client";
import type { LiveMatch } from "../src/display/types";
import type { RealtimeEvent } from "../src/realtime";
import type { ScoresheetField } from "../src/scoresheet";
import {
  ClockControls,
  LiveScoringPage,
  createScoringHub,
  type AllianceDraft,
  type ScoringAlliance,
  type ScoringMatchFormat,
  type ScoringRequest,
} from "../src/scoring";
import { t } from "./scoringT";

const AT = "2026-10-19T10:00:00Z";
const BALLS: ScoresheetField = {
  name: "balls", label: "Balls", data_type: "integer", widget: "counter", min: 0, max: 10, step: 1,
  options: null, icon: null, scope: "alliance", default: 0,
};
const HEAD_TO_HEAD: ScoringMatchFormat = { game_model: "head_to_head", autonomous_seconds: 15, driver_seconds: 105 };
const ALLIANCES: ScoringAlliance[] = [
  { alliance_id: 11, station: "red", teams: [{ id: 1, number: "101A", name: "Rockets" }] },
  { alliance_id: 12, station: "blue", teams: [{ id: 2, number: "102B", name: "Gears" }] },
];

function liveMatch(overrides: Partial<LiveMatch> = {}): LiveMatch {
  return {
    id: 1, session_id: 5, division_id: null, round_type: "qualification", match_number: 1, label: "Q1",
    field_id: 3, scheduled_time: null, status: "scheduled", phase: "driver",
    phase_deadline: new Date(Date.now() + 60_000).toISOString(), paused: false, remaining_seconds_at_pause: null,
    is_finals: false,
    alliances: [
      { id: 11, station: "red", team_ids: [1] },
      { id: 12, station: "blue", team_ids: [2] },
    ],
    ...overrides,
  };
}

function draft(overrides: Partial<AllianceDraft>): AllianceDraft {
  return { alliance_id: 11, data: {}, teams: [], item_meta: {}, version: 0, score: 0, ...overrides };
}

let drafts: AllianceDraft[];
let scores: unknown[];
let refuse: Record<string, unknown>;
let submitted: boolean;
let request: ReturnType<typeof vi.fn>;
let hub: ReturnType<typeof createScoringHub>;

beforeEach(() => {
  drafts = [draft({ data: { balls: 2 }, version: 2, score: 2 }), draft({ alliance_id: 12 })];
  scores = [];
  refuse = {};
  submitted = false;
  hub = createScoringHub();
  request = vi.fn(async (path: string, options?: ApiRequestOptions) => {
    const key = `${options?.method ?? "GET"} ${path}`;
    if (key in refuse) throw refuse[key];
    if (key === "GET /api/matches/1/draft") return { match_id: 1, submitted: false, alliances: drafts };
    if (key === "GET /api/scores?session_id=5") return scores;
    if (key === "POST /api/matches/1/submit") {
      if (drafts.some((entry) => entry.version === 0)) {
        const missing = drafts.find((entry) => entry.version === 0)?.alliance_id;
        throw new ApiError(409, `Alliance ${missing} has no draft score.`);
      }
      submitted = true;
      return { match_id: 1, submitted: true, alliances: [] };
    }
    const patch = /^PATCH \/api\/matches\/1\/alliances\/(\d+)\/draft$/.exec(key);
    if (patch) {
      const id = Number(patch[1]);
      const held = drafts.find((entry) => entry.alliance_id === id) ?? draft({ alliance_id: id });
      const body = options?.body as { changes: Record<string, number> };
      const next = { ...held, data: { ...held.data, ...body.changes }, version: held.version + 1 };
      drafts = drafts.map((entry) => (entry.alliance_id === id ? next : entry));
      return next;
    }
    return {};
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderPage(overrides: { match?: LiveMatch; format?: ScoringMatchFormat; alliances?: ScoringAlliance[] } = {}) {
  return render(
    <LiveScoringPage
      matchId={1}
      sessionId={5}
      t={t}
      myDeviceName="Admin"
      match={overrides.match ?? liveMatch()}
      alliances={overrides.alliances ?? ALLIANCES}
      schema={[BALLS]}
      matchFormat={overrides.format ?? HEAD_TO_HEAD}
      socketEvents={{ connected: true, subscribe: hub.subscribe }}
      request={request as unknown as ScoringRequest}
    />
  );
}

const emit = (event: RealtimeEvent) => act(() => hub.emit(event));

describe("LiveScoringPage", () => {
  it("shows a column per alliance with its teams and score so far, and sends each change at once", async () => {
    renderPage();
    const red = await screen.findByRole("region", { name: "Red" });
    expect(within(red).getByText("101A Rockets")).toBeInTheDocument();
    expect(within(red).getByText("Score so far: 2")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Blue" })).getByText("102B Gears")).toBeInTheDocument();

    fireEvent.click(within(red).getByRole("button", { name: "Increase Balls" }));
    expect(within(red).getByLabelText("Balls")).toHaveValue("3");
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith("/api/matches/1/alliances/11/draft", { method: "PATCH", body: { changes: { balls: 3 } } })
    );

    fireEvent.click(within(red).getByLabelText("DQ 101A"));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith("/api/matches/1/alliances/11/draft", {
        method: "PATCH",
        body: { changes: {}, teams: [{ team_id: 1, no_show: false, dq: true }] },
      })
    );
  });

  it("shows another device's change with Changed by", async () => {
    renderPage();
    const blue = await screen.findByRole("region", { name: "Blue" });
    emit({
      event: "score_draft_changed",
      data: {
        match_id: 1,
        ...draft({ alliance_id: 12, data: { balls: 4 }, item_meta: { balls: { device_name: "Tablet B", at: AT } }, version: 1, score: 4 }),
      },
    });
    expect(within(blue).getByLabelText("Balls")).toHaveValue("4");
    expect(within(blue).getByText("Changed by Tablet B")).toBeInTheDocument();
    expect(within(blue).getByText("Score so far: 4")).toBeInTheDocument();
  });

  it("shows the offline banner while a change can't reach the server and blocks Submit", async () => {
    refuse["PATCH /api/matches/1/alliances/11/draft"] = new TypeError("Failed to fetch");
    renderPage();
    const red = await screen.findByRole("region", { name: "Red" });
    fireEvent.click(within(red).getByRole("button", { name: "Increase Balls" }));
    expect(await screen.findByText("Offline, changes not saved yet")).toBeInTheDocument();
    expect(within(red).getByLabelText("Balls")).toHaveValue("3");
    expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();
  });

  it("lists the plugin's problems per alliance and submits anyway", async () => {
    drafts = [draft({ data: { balls: 2 }, version: 2 }), draft({ alliance_id: 12, data: { balls: 1 }, version: 1 })];
    refuse["POST /api/matches/1/submit"] = new ApiError(422, "", {
      detail: { violations: [{ alliance_id: 12, messages: ["Too many balls"] }] },
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Submit" }));
    const problems = await screen.findByRole("alert");
    expect(problems).toHaveTextContent("Blue: Too many balls");
    delete refuse["POST /api/matches/1/submit"];
    scores = [
      { match_id: 1, alliance_id: 11, score: 2, data: {}, teams: [], saved_at: AT },
      { match_id: 1, alliance_id: 12, score: 1, data: {}, teams: [], saved_at: AT },
    ];
    fireEvent.click(within(problems).getByRole("button", { name: "Submit anyway" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("/api/matches/1/submit", { method: "POST", body: { force: true } }));
    const saved = await screen.findByRole("region", { name: "Saved" });
    await waitFor(() => expect(saved).toHaveTextContent("Red 101A: 2"));
    expect(saved).toHaveTextContent("Blue 102B: 1");
  });

  it("asks before saving an unscored alliance at zero; Cancel saves nothing, confirming submits", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Submit" }));
    const question = await screen.findByRole("alertdialog", { name: "Missing scores" });
    expect(question).toHaveTextContent("Blue 102B has no score. Save it with zero points?");

    fireEvent.click(within(question).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(request).not.toHaveBeenCalledWith("/api/matches/1/alliances/12/draft", expect.anything());
    expect(submitted).toBe(false);
    expect(screen.getByRole("region", { name: "Blue" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog", { name: "Missing scores" })).getByRole("button", {
        name: "Save with zero points and submit",
      })
    );
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith("/api/matches/1/alliances/12/draft", { method: "PATCH", body: { changes: { balls: 0 } } })
    );
    expect(await screen.findByRole("region", { name: "Saved" })).toBeInTheDocument();
    expect(submitted).toBe(true);
  });

  it("names every unscored alliance in one question", async () => {
    drafts = [draft({ alliance_id: 11 }), draft({ alliance_id: 12 })];
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Submit" }));
    expect(await screen.findByRole("alertdialog", { name: "Missing scores" })).toHaveTextContent(
      "Red 101A, Blue 102B have no score. Save them with zero points?"
    );
  });

  it("shows Saved with the official scores when another device submits", async () => {
    scores = [
      { match_id: 1, alliance_id: 11, score: 7, data: {}, teams: [], saved_at: AT },
      { match_id: 1, alliance_id: 12, score: 5, data: {}, teams: [], saved_at: AT },
    ];
    renderPage();
    await screen.findByRole("region", { name: "Red" });
    emit({ event: "match_submitted", data: { match_id: 1 } });
    const saved = await screen.findByRole("region", { name: "Saved" });
    await waitFor(() => expect(saved).toHaveTextContent("Red 101A: 7"));
    expect(screen.queryByRole("button", { name: "Submit" })).not.toBeInTheDocument();
  });

  it("says the match is no longer available when it was marked not played", async () => {
    renderPage({ match: liveMatch({ status: "not_played" }) });
    expect(await screen.findByText("This match is no longer available.")).toBeInTheDocument();
  });

  it("scores one shared sheet for a cooperative game, with every team's flags", async () => {
    renderPage({ format: { game_model: "cooperative_score", autonomous_seconds: 0, driver_seconds: 60 } });
    const shared = await screen.findByRole("region", { name: "Shared score" });
    expect(within(shared).getByLabelText("No-show 101A")).toBeInTheDocument();
    expect(within(shared).getByLabelText("No-show 102B")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Red" })).not.toBeInTheDocument();
    fireEvent.click(within(shared).getByLabelText("No-show 102B"));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith("/api/matches/1/alliances/12/draft", {
        method: "PATCH",
        body: { changes: {}, teams: [{ team_id: 2, no_show: true, dq: false }] },
      })
    );
  });

  it("shows the alliances as tabs on a narrow screen", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: true, media: query, addEventListener: () => {}, removeEventListener: () => {},
    }));
    renderPage();
    expect(await screen.findByRole("region", { name: "Red" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Blue" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Blue" }));
    expect(screen.getByRole("region", { name: "Blue" })).toBeInTheDocument();
  });

  it("names an unknown station readably", async () => {
    renderPage({ alliances: [{ alliance_id: 11, station: "green_team", teams: [{ id: 1, number: "101A", name: "Rockets" }] }] });
    expect(await screen.findByRole("region", { name: "Green team" })).toBeInTheDocument();
  });

  it("posts clock actions for the match", async () => {
    renderPage({ match: liveMatch({ phase: "awaiting_driver", phase_deadline: null }) });
    const clock = await screen.findByRole("region", { name: "Timer" });
    fireEvent.click(within(clock).getByRole("button", { name: "Start driver" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("/api/matches/1/start-driver", { method: "POST" }));
  });
});

describe("ClockControls", () => {
  function renderClock(match: LiveMatch, format: ScoringMatchFormat) {
    const onAction = vi.fn();
    render(<ClockControls match={match} matchFormat={format} t={t} onAction={onAction} />);
    return onAction;
  }

  it("offers both resets on a two-part match and warns that the whole-match reset clears drafts", () => {
    const onAction = renderClock(liveMatch({ phase: "autonomous" }), HEAD_TO_HEAD);
    fireEvent.click(screen.getByRole("button", { name: "Reset timer" }));
    const choice = screen.getByRole("group", { name: "Reset the timer?" });
    expect(choice).toHaveTextContent("Resetting the entire match timer also clears the draft scores.");
    fireEvent.click(within(choice).getByRole("button", { name: "Reset current segment" }));
    expect(onAction).toHaveBeenLastCalledWith("reset", { scope: "section" });
    fireEvent.click(screen.getByRole("button", { name: "Reset timer" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset entire match timer" }));
    expect(onAction).toHaveBeenLastCalledWith("reset", { scope: "full" });
  });

  it("offers only the whole-match reset on a one-part match", () => {
    renderClock(liveMatch({ phase: "driver" }), { game_model: "cooperative_score", autonomous_seconds: 0, driver_seconds: 60 });
    fireEvent.click(screen.getByRole("button", { name: "Reset timer" }));
    expect(screen.queryByRole("button", { name: "Reset current segment" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset entire match timer" })).toBeInTheDocument();
  });

  it("pauses a running match, resumes a paused one and ends after asking", () => {
    const onAction = renderClock(liveMatch({ phase: "driver" }), HEAD_TO_HEAD);
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(onAction).toHaveBeenLastCalledWith("pause", undefined);
    fireEvent.click(screen.getByRole("button", { name: "End" }));
    fireEvent.click(within(screen.getByRole("group", { name: "End the match now?" })).getByRole("button", { name: "End now" }));
    expect(onAction).toHaveBeenLastCalledWith("end", undefined);
  });

  it("shows Resume and the frozen time while paused", () => {
    renderClock(liveMatch({ phase: "driver", paused: true, phase_deadline: null, remaining_seconds_at_pause: 42 }), HEAD_TO_HEAD);
    expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
    expect(screen.getByTestId("scoring-clock")).toHaveTextContent("0:42");
    expect(screen.getByText("Paused")).toBeInTheDocument();
  });

  it.each([
    ["countdown_autonomous", "Starting autonomous"],
    ["countdown_driver", "Starting driver control"],
  ])("shows readable text for the %s phase", (phase, text) => {
    renderClock(liveMatch({ phase }), HEAD_TO_HEAD);
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.queryByText(/_/)).not.toBeInTheDocument();
  });

  it("starts a match that has not started", () => {
    const onAction = renderClock(liveMatch({ phase: "not_started", phase_deadline: null }), HEAD_TO_HEAD);
    expect(screen.getByTestId("scoring-clock")).toHaveTextContent("0:15");
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(onAction).toHaveBeenLastCalledWith("start", undefined);
    expect(screen.queryByRole("button", { name: "Reset timer" })).not.toBeInTheDocument();
  });
});
