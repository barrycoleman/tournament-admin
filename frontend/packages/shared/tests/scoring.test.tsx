import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { ApiError, type ApiRequestOptions } from "../src/api-client";
import type { RealtimeEvent } from "../src/realtime";
import {
  FLASH_MS,
  RETRY_MS,
  SCORE_ALREADY_SUBMITTED_DETAIL,
  changedByOthers,
  createScoringHub,
  flashKey,
  mergeIncoming,
  useLiveDraft,
  useSkillsRun,
  type AllianceDraft,
  type MatchDraft,
  type ScoringRequest,
  type SkillsRun,
  type SkillsSet,
} from "../src/scoring";

const AT = "2026-10-19T10:00:00Z";

function draft(overrides: Partial<AllianceDraft>): AllianceDraft {
  return { alliance_id: 11, data: {}, teams: [], item_meta: {}, version: 0, score: 0, ...overrides };
}

interface Call {
  path: string;
  options?: ApiRequestOptions;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

/** GETs answer from `gets` at once; everything else waits in `calls` until the test settles it. */
function fakeServer(gets: Record<string, unknown>) {
  const calls: Call[] = [];
  const request = vi.fn((path: string, options?: ApiRequestOptions) => {
    if ((options?.method ?? "GET") === "GET") {
      const value = gets[path];
      return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
    }
    return new Promise((resolve, reject) => calls.push({ path, options, resolve, reject }));
  });
  return { request: request as unknown as ScoringRequest, mock: request, calls, gets };
}

function fakeSocket() {
  const hub = createScoringHub();
  return { socket: { connected: true, subscribe: hub.subscribe }, emit: (event: RealtimeEvent) => act(() => hub.emit(event)) };
}

const MATCH_DRAFT: MatchDraft = {
  match_id: 1,
  submitted: false,
  alliances: [
    draft({ alliance_id: 11, data: { balls: 2 }, item_meta: { balls: { device_name: "Tablet A", at: AT } }, version: 3, score: 2 }),
    draft({ alliance_id: 12 }),
  ],
};

function renderDraft(server: ReturnType<typeof fakeServer>, socket = fakeSocket().socket) {
  return renderHook(
    (props: { connected: boolean }) =>
      useLiveDraft({
        matchId: 1,
        sessionId: 5,
        myDeviceName: "Admin",
        socketEvents: { ...socket, connected: props.connected },
        request: server.request,
        defaults: { balls: 0, parked: false },
      }),
    { initialProps: { connected: true } }
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("mergeIncoming", () => {
  it("takes the newer version and keeps still-pending local items on top", () => {
    const local = draft({ data: { balls: 1, parked: false }, version: 2 });
    const incoming = draft({ data: { balls: 4, parked: true }, version: 3 });
    expect(mergeIncoming(local, incoming, { balls: 5 }).data).toEqual({ balls: 5, parked: true });
    expect(mergeIncoming(local, incoming, {}).version).toBe(3);
  });

  it("ignores an older incoming version", () => {
    const local = draft({ data: { balls: 4 }, version: 5 });
    expect(mergeIncoming(local, draft({ data: { balls: 1 }, version: 4 }), {}).data).toEqual({ balls: 4 });
  });

  it("lays pending team flags over the teams list", () => {
    const local = draft({ teams: [{ team_id: 7, no_show: true, dq: false }], version: 1 });
    expect(mergeIncoming(local, local, { "team:7:no_show": false, "team:8:dq": true }).teams).toEqual([
      { team_id: 8, no_show: false, dq: true },
    ]);
  });
});

describe("changedByOthers", () => {
  it("lists items another device changed, team flags included, but not this device's", () => {
    const prev = draft({ data: { balls: 1, parked: false } });
    const next = draft({
      data: { balls: 3, parked: true },
      teams: [{ team_id: 7, no_show: false, dq: true }],
      item_meta: {
        balls: { device_name: "Tablet A", at: AT },
        parked: { device_name: "Admin", at: AT },
        "team:7:dq": { device_name: "Tablet B", at: AT },
      },
    });
    expect(changedByOthers(prev, next, "Admin")).toEqual(["balls", "team:7:dq"]);
  });
});

describe("useLiveDraft", () => {
  it("loads the drafts, shows a change at once and sends one PATCH at a time in order", async () => {
    const server = fakeServer({ "/api/matches/1/draft": MATCH_DRAFT });
    const { result } = renderDraft(server);
    await waitFor(() => expect(result.current.draft?.alliances[0].data).toEqual({ balls: 2 }));

    act(() => result.current.setItem(11, "balls", 3));
    act(() => result.current.setItem(11, "parked", true));
    expect(result.current.draft?.alliances[0].data).toEqual({ balls: 3, parked: true });
    expect(result.current.pending).toBe(2);
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0].path).toBe("/api/matches/1/alliances/11/draft");
    expect(server.calls[0].options).toEqual({ method: "PATCH", body: { changes: { balls: 3 } } });

    await act(async () => server.calls[0].resolve(draft({ data: { balls: 3 }, version: 4, score: 3 })));
    await waitFor(() => expect(server.calls).toHaveLength(2));
    expect(server.calls[1].options).toEqual({ method: "PATCH", body: { changes: { parked: true } } });
    expect(result.current.pending).toBe(1);

    await act(async () => server.calls[1].resolve(draft({ data: { balls: 3, parked: true }, version: 5, score: 3 })));
    await waitFor(() => expect(result.current.pending).toBe(0));
    expect(result.current.draft?.alliances[0]).toMatchObject({ data: { balls: 3, parked: true }, version: 5 });
  });

  it("sends a team flag with that team's other flag kept", async () => {
    const server = fakeServer({
      "/api/matches/1/draft": {
        ...MATCH_DRAFT,
        alliances: [draft({ alliance_id: 11, teams: [{ team_id: 7, no_show: true, dq: false }], version: 1 }), draft({ alliance_id: 12 })],
      },
    });
    const { result } = renderDraft(server);
    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => result.current.setTeamFlag(11, 7, "dq", true));
    expect(server.calls[0].options).toEqual({
      method: "PATCH",
      body: { changes: {}, teams: [{ team_id: 7, no_show: true, dq: true }] },
    });
    expect(result.current.draft?.alliances[0].teams).toEqual([{ team_id: 7, no_show: true, dq: true }]);
  });

  it("applies a newer score_draft_changed, ignores an older one, and flashes another device's item for 2 s", async () => {
    const server = fakeServer({ "/api/matches/1/draft": MATCH_DRAFT });
    const { socket, emit } = fakeSocket();
    const { result } = renderDraft(server, socket);
    await waitFor(() => expect(result.current.draft).not.toBeNull());

    vi.useFakeTimers();
    emit({
      event: "score_draft_changed",
      data: {
        match_id: 1,
        ...draft({ data: { balls: 6 }, item_meta: { balls: { device_name: "Tablet B", at: AT } }, version: 4, score: 6 }),
      },
    });
    expect(result.current.draft?.alliances[0].data).toEqual({ balls: 6 });
    expect(result.current.flashing).toEqual({ [flashKey(11, "balls")]: "Tablet B" });

    emit({ event: "score_draft_changed", data: { match_id: 1, ...draft({ data: { balls: 1 }, version: 2 }) } });
    expect(result.current.draft?.alliances[0].data).toEqual({ balls: 6 });

    act(() => vi.advanceTimersByTime(FLASH_MS - 1));
    expect(result.current.flashing).toEqual({ [flashKey(11, "balls")]: "Tablet B" });
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.flashing).toEqual({});
  });

  it("does not flash or overwrite an item this device still has queued", async () => {
    const server = fakeServer({ "/api/matches/1/draft": MATCH_DRAFT });
    const { socket, emit } = fakeSocket();
    const { result } = renderDraft(server, socket);
    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => result.current.setItem(11, "balls", 9));
    emit({
      event: "score_draft_changed",
      data: { match_id: 1, ...draft({ data: { balls: 6 }, item_meta: { balls: { device_name: "Tablet B", at: AT } }, version: 4 }) },
    });
    expect(result.current.draft?.alliances[0].data).toEqual({ balls: 9 });
    expect(result.current.flashing).toEqual({});
  });

  it("keeps changes queued while offline, then sends them and refetches on reconnect", async () => {
    const server = fakeServer({ "/api/matches/1/draft": MATCH_DRAFT });
    const { result, rerender } = renderDraft(server);
    await waitFor(() => expect(result.current.draft).not.toBeNull());

    act(() => result.current.setItem(11, "balls", 3));
    await act(async () => server.calls[0].reject(new TypeError("Failed to fetch")));
    expect(result.current.offline).toBe(true);
    expect(result.current.pending).toBe(1);
    expect(result.current.draft?.alliances[0].data).toEqual({ balls: 3 });

    rerender({ connected: false });
    act(() => result.current.setItem(11, "parked", true));
    expect(result.current.pending).toBe(2);

    server.mock.mockClear();
    rerender({ connected: true });
    await waitFor(() => expect(server.calls).toHaveLength(2));
    expect(server.calls[1].options).toEqual({ method: "PATCH", body: { changes: { balls: 3 } } });
    await act(async () => server.calls[1].resolve(draft({ data: { balls: 3 }, version: 4 })));
    await waitFor(() => expect(server.calls).toHaveLength(3));
    expect(server.calls[2].options).toEqual({ method: "PATCH", body: { changes: { parked: true } } });

    server.gets["/api/matches/1/draft"] = {
      ...MATCH_DRAFT,
      alliances: [draft({ data: { balls: 3, parked: true, zone: "far" }, version: 6 }), draft({ alliance_id: 12 })],
    };
    await act(async () => server.calls[2].resolve(draft({ data: { balls: 3, parked: true }, version: 5 })));
    await waitFor(() => expect(result.current.draft?.alliances[0].data).toEqual({ balls: 3, parked: true, zone: "far" }));
    expect(server.mock.mock.calls.map(([path, options]) => `${options?.method ?? "GET"} ${path}`)).toEqual([
      "PATCH /api/matches/1/alliances/11/draft",
      "PATCH /api/matches/1/alliances/11/draft",
      "GET /api/matches/1/draft",
    ]);
    expect(result.current.offline).toBe(false);
    expect(result.current.pending).toBe(0);
  });

  it("reads offline while the socket is down even with nothing queued", async () => {
    const server = fakeServer({ "/api/matches/1/draft": MATCH_DRAFT });
    const { result, rerender } = renderDraft(server);
    await waitFor(() => expect(result.current.draft).not.toBeNull());
    rerender({ connected: false });
    expect(result.current.offline).toBe(true);
  });

  it("switches to submitted on a 409 already submitted and reads the official scores", async () => {
    const server = fakeServer({
      "/api/matches/1/draft": MATCH_DRAFT,
      "/api/scores?session_id=5": [
        { match_id: 1, alliance_id: 11, score: 8, data: {}, teams: [], saved_at: AT },
        { match_id: 2, alliance_id: 21, score: 1, data: {}, teams: [], saved_at: AT },
      ],
    });
    const { result } = renderDraft(server);
    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => result.current.setItem(11, "balls", 3));
    await act(async () =>
      server.calls[0].reject(new ApiError(409, SCORE_ALREADY_SUBMITTED_DETAIL, { detail: SCORE_ALREADY_SUBMITTED_DETAIL }))
    );
    await waitFor(() => expect(result.current.saved).toEqual([expect.objectContaining({ alliance_id: 11, score: 8 })]));
    expect(result.current.submitted).toBe(true);
    expect(result.current.pending).toBe(0);
  });

  it("marks the match gone on a 404", async () => {
    const server = fakeServer({ "/api/matches/1/draft": MATCH_DRAFT });
    const { result } = renderDraft(server);
    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => result.current.setItem(11, "balls", 3));
    await act(async () => server.calls[0].reject(new ApiError(404, "Match not found")));
    expect(result.current.gone).toBe(true);
  });

  it("drops a refused change, shows why and restores the server's copy", async () => {
    const server = fakeServer({ "/api/matches/1/draft": MATCH_DRAFT });
    const { result } = renderDraft(server);
    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => result.current.setItem(11, "balls", 99));
    await act(async () =>
      server.calls[0].reject(new ApiError(422, "", { detail: { violations: ["balls must be at most 10"] } }))
    );
    await waitFor(() => expect(result.current.draft?.alliances[0].data).toEqual({ balls: 2 }));
    expect(result.current.error).toBe("balls must be at most 10");
    expect(result.current.pending).toBe(0);
  });

  it("goes to Saved when another device submits", async () => {
    const server = fakeServer({
      "/api/matches/1/draft": MATCH_DRAFT,
      "/api/scores?session_id=5": [{ match_id: 1, alliance_id: 11, score: 4, data: {}, teams: [], saved_at: AT }],
    });
    const { socket, emit } = fakeSocket();
    const { result } = renderDraft(server, socket);
    await waitFor(() => expect(result.current.draft).not.toBeNull());
    emit({ event: "match_submitted", data: { match_id: 2 } });
    expect(result.current.submitted).toBe(false);
    emit({ event: "match_submitted", data: { match_id: 1 } });
    expect(result.current.submitted).toBe(true);
    await waitFor(() => expect(result.current.saved).toHaveLength(1));
  });

  it("lists the alliances without a draft on a 409 and, when confirmed, saves them at zero and submits again", async () => {
    const server = fakeServer({ "/api/matches/1/draft": MATCH_DRAFT });
    const { result } = renderDraft(server);
    await waitFor(() => expect(result.current.draft).not.toBeNull());

    act(() => result.current.submit());
    expect(result.current.submitting).toBe(true);
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]).toMatchObject({ path: "/api/matches/1/submit", options: { method: "POST", body: { force: false } } });
    await act(async () => server.calls[0].reject(new ApiError(409, "Alliance 12 has no draft score.")));
    expect(result.current.missing).toEqual([12]);
    expect(result.current.error).toBeNull();
    expect(result.current.submitting).toBe(false);
    expect(result.current.submitted).toBe(false);

    act(() => result.current.confirmZeroAndSubmit());
    expect(result.current.missing).toEqual([]);
    expect(server.calls[1]).toMatchObject({
      path: "/api/matches/1/alliances/12/draft",
      options: { method: "PATCH", body: { changes: { balls: 0, parked: false } } },
    });
    await act(async () => server.calls[1].resolve(draft({ alliance_id: 12, data: { balls: 0, parked: false }, version: 1 })));
    await waitFor(() => expect(server.calls).toHaveLength(3));
    expect(server.calls[2]).toMatchObject({ path: "/api/matches/1/submit", options: { body: { force: false } } });
    await act(async () => server.calls[2].resolve({ match_id: 1, submitted: true, alliances: [] }));
    await waitFor(() => expect(result.current.submitted).toBe(true));
  });

  it("lists every alliance still without a draft, and Cancel saves nothing", async () => {
    const server = fakeServer({
      "/api/matches/1/draft": { ...MATCH_DRAFT, alliances: [draft({ alliance_id: 11 }), draft({ alliance_id: 12 })] },
    });
    const { result } = renderDraft(server);
    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => result.current.submit());
    await act(async () => server.calls[0].reject(new ApiError(409, "Alliance 11 has no draft score.")));
    expect(result.current.missing).toEqual([11, 12]);
    act(() => result.current.cancelMissing());
    expect(result.current.missing).toEqual([]);
    expect(server.calls).toHaveLength(1);
    expect(result.current.pending).toBe(0);
  });

  it("shows the plugin's violations per alliance and submits anyway", async () => {
    const server = fakeServer({ "/api/matches/1/draft": MATCH_DRAFT });
    const { result } = renderDraft(server);
    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => result.current.submit());
    await act(async () =>
      server.calls[0].reject(
        new ApiError(422, "", { detail: { violations: [{ alliance_id: 11, messages: ["Too many balls"] }] } })
      )
    );
    expect(result.current.violations).toEqual([{ alliance_id: 11, messages: ["Too many balls"] }]);
    expect(result.current.submitting).toBe(false);

    act(() => result.current.submit(true));
    await waitFor(() => expect(server.calls).toHaveLength(2));
    expect(server.calls[1]).toMatchObject({ path: "/api/matches/1/submit", options: { method: "POST", body: { force: true } } });
  });

  it("replaces a draft that a whole-match reset cleared (version 0)", async () => {
    const server = fakeServer({ "/api/matches/1/draft": MATCH_DRAFT });
    const { socket, emit } = fakeSocket();
    const { result } = renderDraft(server, socket);
    await waitFor(() => expect(result.current.draft?.alliances[0].version).toBe(3));
    emit({ event: "score_draft_changed", data: { match_id: 1, ...draft({ version: 0 }) } });
    expect(result.current.draft?.alliances[0]).toMatchObject({ data: {}, version: 0 });
    expect(result.current.flashing).toEqual({});
  });
});

const RUN: SkillsRun = {
  id: 40, field_id: 3, field_set_id: 9, team_id: 7, team_number: "101A", team_name: "Rockets", skills_type: "driver",
  data: { balls: 1 }, item_meta: { balls: { device_name: "Admin", at: AT } }, version: 1, score: 1,
  follows_set: true, phase: "running", deadline: null, paused: true, remaining_seconds: 30,
};

function skillsSet(run: SkillsRun | null): SkillsSet {
  return {
    timer: { field_set_id: 9, skills_type: "driver", phase: "running", deadline: null, paused: true, remaining_seconds: 30, run_seconds: 60 },
    fields: [{ field_id: 3, name: "Skills 1", run }],
  };
}

describe("useSkillsRun", () => {
  function renderRun(server: ReturnType<typeof fakeServer>, socket = fakeSocket().socket) {
    return renderHook(() =>
      useSkillsRun({
        fieldId: 3,
        fieldSetId: 9,
        myDeviceName: "Admin",
        socketEvents: socket,
        request: server.request,
        defaults: { balls: 0, parked: false },
      })
    );
  }

  it("sends changes to the run's draft and flashes another device's change after skills_run_changed", async () => {
    const server = fakeServer({ "/api/field-sets/9/skills": skillsSet(RUN) });
    const { socket, emit } = fakeSocket();
    const { result } = renderRun(server, socket);
    await waitFor(() => expect(result.current.run?.data).toEqual({ balls: 1 }));

    act(() => result.current.setItem("balls", 2));
    expect(server.calls[0]).toMatchObject({
      path: "/api/fields/3/skills-run/draft",
      options: { method: "PATCH", body: { changes: { balls: 2 } } },
    });
    await act(async () => server.calls[0].resolve({ ...RUN, data: { balls: 2 }, version: 2, score: 2 }));

    server.gets["/api/field-sets/9/skills"] = skillsSet({
      ...RUN, data: { balls: 5 }, item_meta: { balls: { device_name: "Tablet C", at: AT } }, version: 3, score: 5,
    });
    emit({ event: "skills_run_changed", data: { field_set_id: 9, field_id: 3 } });
    await waitFor(() => expect(result.current.run?.data).toEqual({ balls: 5 }));
    expect(result.current.flashing).toEqual({ balls: "Tablet C" });
  });

  it("submits with untouched defaults filled in, shows violations, submits anyway and shows Saved", async () => {
    const server = fakeServer({ "/api/field-sets/9/skills": skillsSet(RUN) });
    const { result } = renderRun(server);
    await waitFor(() => expect(result.current.run).not.toBeNull());

    act(() => result.current.submit());
    expect(server.calls[0].options).toEqual({ method: "PATCH", body: { changes: { parked: false } } });
    await act(async () => server.calls[0].resolve({ ...RUN, data: { balls: 1, parked: false }, version: 2 }));
    await waitFor(() => expect(server.calls).toHaveLength(2));
    expect(server.calls[1]).toMatchObject({ path: "/api/fields/3/skills-run/submit", options: { body: { force: false } } });
    await act(async () =>
      server.calls[1].reject(new ApiError(422, "", { violations: [{ field: "balls", message: "Too many." }] }))
    );
    expect(result.current.violations).toEqual([{ alliance_id: null, messages: ["balls: Too many."] }]);

    server.gets["/api/field-sets/9/skills"] = skillsSet(null);
    act(() => result.current.submit(true));
    await waitFor(() => expect(server.calls).toHaveLength(3));
    expect(server.calls[2].options).toEqual({ method: "POST", body: { force: true } });
    await act(async () => server.calls[2].resolve({}));
    await waitFor(() => expect(result.current.saved).toEqual({ team_number: "101A", team_name: "Rockets", skills_type: "driver", score: 1 }));
    expect(result.current.run).toBeNull();
  });

  it("discards the run", async () => {
    const server = fakeServer({ "/api/field-sets/9/skills": skillsSet(RUN) });
    const { result } = renderRun(server);
    await waitFor(() => expect(result.current.run).not.toBeNull());
    server.gets["/api/field-sets/9/skills"] = skillsSet(null);
    act(() => result.current.discard());
    expect(server.calls[0]).toMatchObject({ path: "/api/fields/3/skills-run", options: { method: "DELETE" } });
    await act(async () => server.calls[0].resolve(undefined));
    await waitFor(() => expect(result.current.run).toBeNull());
    expect(result.current.saved).toBeNull();
  });

  it("posts field and set timer actions", async () => {
    const server = fakeServer({ "/api/field-sets/9/skills": skillsSet(RUN) });
    const { result } = renderRun(server);
    await waitFor(() => expect(result.current.run).not.toBeNull());
    act(() => result.current.timerAction("field", "resume"));
    act(() => result.current.timerAction("set", "end"));
    expect(server.calls.map((call) => `${call.options?.method} ${call.path}`)).toEqual([
      "POST /api/fields/3/skills-run/resume",
      "POST /api/field-sets/9/skills-timer/end",
    ]);
  });
});

describe("review fixes", () => {
  it("stops retrying and notifying after unmount", async () => {
    const server = fakeServer({ "/api/matches/1/draft": MATCH_DRAFT });
    const { result, unmount } = renderDraft(server);
    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => result.current.setItem(11, "balls", 3));
    unmount();
    vi.useFakeTimers();
    await act(async () => server.calls[0].reject(new TypeError("Failed to fetch")));
    server.mock.mockClear();
    act(() => vi.advanceTimersByTime(RETRY_MS * 3));
    expect(server.mock).not.toHaveBeenCalled();
    expect(server.calls).toHaveLength(1);
  });

  it("keeps a change queued on a 503 instead of dropping it", async () => {
    const server = fakeServer({ "/api/matches/1/draft": MATCH_DRAFT });
    const { result } = renderDraft(server);
    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => result.current.setItem(11, "balls", 3));
    await act(async () => server.calls[0].reject(new ApiError(503, "Service Unavailable")));
    expect(result.current.offline).toBe(true);
    expect(result.current.pending).toBe(1);
    expect(result.current.draft?.alliances[0].data).toEqual({ balls: 3 });
  });

  it("keeps a skills change queued on a 502", async () => {
    const server = fakeServer({ "/api/field-sets/9/skills": skillsSet(RUN) });
    const { result } = renderHook(() =>
      useSkillsRun({ fieldId: 3, fieldSetId: 9, myDeviceName: "Admin", socketEvents: fakeSocket().socket, request: server.request })
    );
    await waitFor(() => expect(result.current.run).not.toBeNull());
    act(() => result.current.setItem("balls", 4));
    await act(async () => server.calls[0].reject(new ApiError(502, "Bad Gateway")));
    expect(result.current.offline).toBe(true);
    expect(result.current.pending).toBe(1);
    expect(result.current.run?.data).toEqual({ balls: 4 });
  });

  it("does not save a missing alliance at zero once another scorer has started it", async () => {
    const server = fakeServer({
      "/api/matches/1/draft": { ...MATCH_DRAFT, alliances: [draft({ alliance_id: 11 }), draft({ alliance_id: 12 })] },
    });
    const { socket, emit } = fakeSocket();
    const { result } = renderDraft(server, socket);
    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => result.current.submit());
    await act(async () => server.calls[0].reject(new ApiError(409, "Alliance 11 has no draft score.")));
    expect(result.current.missing).toEqual([11, 12]);
    emit({ event: "score_draft_changed", data: { match_id: 1, ...draft({ alliance_id: 12, data: { balls: 5 }, version: 1 }) } });
    expect(result.current.missing).toEqual([11]);
    act(() => result.current.confirmZeroAndSubmit());
    expect(server.calls.map((call) => call.path)).toEqual(["/api/matches/1/submit", "/api/matches/1/alliances/11/draft"]);
  });

  it("waits for this device's queued change before re-posting Submit when no alliance needs zero", async () => {
    const server = fakeServer({ "/api/matches/1/draft": MATCH_DRAFT });
    const { result } = renderDraft(server);
    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => result.current.submit());
    await act(async () => server.calls[0].reject(new ApiError(409, "Alliance 12 has no draft score.")));
    expect(result.current.missing).toEqual([12]);
    act(() => result.current.setItem(12, "balls", 4));
    expect(server.calls).toHaveLength(2);
    act(() => result.current.confirmZeroAndSubmit());
    expect(server.calls).toHaveLength(2);
    await act(async () => server.calls[1].resolve(draft({ alliance_id: 12, data: { balls: 4 }, version: 1 })));
    await waitFor(() => expect(server.calls).toHaveLength(3));
    expect(server.calls.map((call) => call.path)).toEqual([
      "/api/matches/1/submit",
      "/api/matches/1/alliances/12/draft",
      "/api/matches/1/submit",
    ]);
  });

  it("cancels a waiting Submit when one of this device's changes is refused", async () => {
    const server = fakeServer({ "/api/matches/1/draft": MATCH_DRAFT });
    const { result } = renderDraft(server);
    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => result.current.setItem(11, "balls", 99));
    act(() => result.current.submit());
    await act(async () => server.calls[0].reject(new ApiError(422, "", { detail: { violations: ["balls must be at most 10"] } })));
    await waitFor(() => expect(result.current.draft?.alliances[0].data).toEqual({ balls: 2 }));
    expect(server.calls).toHaveLength(1);
    expect(result.current.submitting).toBe(false);
    expect(result.current.error).toBe("balls must be at most 10");
  });

  it("cancels a waiting skills Submit when a change is refused", async () => {
    const server = fakeServer({ "/api/field-sets/9/skills": skillsSet(RUN) });
    const { result } = renderHook(() =>
      useSkillsRun({ fieldId: 3, fieldSetId: 9, myDeviceName: "Admin", socketEvents: fakeSocket().socket, request: server.request })
    );
    await waitFor(() => expect(result.current.run).not.toBeNull());
    act(() => result.current.setItem("balls", 99));
    act(() => result.current.submit());
    await act(async () => server.calls[0].reject(new ApiError(422, "", { detail: { violations: ["too many"] } })));
    expect(server.calls).toHaveLength(1);
    expect(result.current.submitting).toBe(false);
  });
});
