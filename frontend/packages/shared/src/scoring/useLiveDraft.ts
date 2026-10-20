import { useEffect, useReducer, useRef, useState } from "react";
import { ApiError, apiRequest } from "../api-client";
import type { RealtimeEvent } from "../realtime";
import type { AllianceScore } from "../display";
import type { ScoresheetValue, ScoresheetValues } from "../scoresheet";
import { errorText, isNetworkError, missingDraftAlliance, scoringPaths, submitViolations } from "./api";
import { changedByOthers, teamFlagKey, withPending } from "./mergeDraft";
import {
  FLASH_MS,
  NOT_PLAYED_SCORE_DETAIL,
  RETRY_MS,
  SCORE_ALREADY_SUBMITTED_DETAIL,
  type AllianceDraft,
  type MatchDraft,
  type ScoreDraftChanged,
  type ScoringRequest,
  type ScoringSocket,
  type SkillsRun,
  type SkillsSet,
  type SkillsTimerAction,
  type SubmitViolation,
  type TeamFlag,
  type TeamFlags,
} from "./types";

/** The key `flashing` uses for one alliance's item. */
export function flashKey(allianceId: number, itemKey: string): string {
  return `${allianceId}:${itemKey}`;
}

interface QueueEntry {
  /** The alliance id (0 for a skills run). */
  scope: number;
  changes: Record<string, unknown>;
  teams?: TeamFlags[];
  /** The item keys this entry carries, for releasing them from `pending` once acknowledged. */
  keys: string[];
}

/** ack: applied; drop: refused, forget it; clear: forget everything queued; retry: network failure. */
type Outcome = "ack" | "drop" | "clear" | "retry";

/**
 * Local changes not yet acknowledged, sent one PATCH at a time in the order
 * they were made. A network failure keeps the change at the head of the queue
 * and retries it; `pending` holds the newest local value of each queued item
 * so the page can keep showing it over the server's copy.
 */
class ChangeQueue {
  entries: QueueEntry[] = [];
  pending: Record<number, Record<string, unknown>> = {};
  sending = false;
  failed = false;
  disposed = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly send: (entry: QueueEntry) => Promise<Outcome>,
    private readonly onIdle: () => void,
    private readonly changed: () => void
  ) {}

  push(entry: QueueEntry, values: Record<string, unknown>) {
    this.pending[entry.scope] = { ...(this.pending[entry.scope] ?? {}), ...values };
    this.entries.push(entry);
    this.changed();
    // After a network failure the retry timer or a reconnect sends the queue again.
    if (!this.failed) this.pump();
  }

  pump() {
    if (this.sending || this.disposed) return;
    const head = this.entries[0];
    if (!head) {
      this.onIdle();
      return;
    }
    this.sending = true;
    void this.send(head).then((outcome) => {
      this.sending = false;
      if (this.disposed) return;
      if (outcome === "retry") {
        this.failed = true;
        this.changed();
        this.scheduleRetry();
        return;
      }
      this.failed = false;
      if (outcome === "clear") {
        this.clear();
      } else if (this.entries[0] === head) {
        this.entries.shift();
        this.release(head);
      }
      this.changed();
      this.pump();
    });
  }

  /** Forget a sent entry's keys unless a later queued entry carries them too. */
  private release(entry: QueueEntry) {
    const scoped = this.pending[entry.scope];
    if (!scoped) return;
    for (const key of entry.keys) {
      const stillQueued = this.entries.some((other) => other.scope === entry.scope && other.keys.includes(key));
      if (!stillQueued) delete scoped[key];
    }
    if (Object.keys(scoped).length === 0) delete this.pending[entry.scope];
  }

  scheduleRetry() {
    if (this.retryTimer !== null || this.disposed) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.pump();
    }, RETRY_MS);
  }

  retryNow() {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.pump();
  }

  clear() {
    this.entries = [];
    this.pending = {};
  }

  dispose() {
    this.disposed = true;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
}

/** Highlights for items another device changed, each cleared FLASH_MS after its last change. */
class Flasher {
  current: Record<string, string> = {};
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly changed: () => void) {}

  flash(key: string, device: string) {
    const old = this.timers.get(key);
    if (old !== undefined) clearTimeout(old);
    this.current = { ...this.current, [key]: device };
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        const next = { ...this.current };
        delete next[key];
        this.current = next;
        this.changed();
      }, FLASH_MS)
    );
  }

  dispose() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}

function isSubmittedError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.detail === SCORE_ALREADY_SUBMITTED_DETAIL;
}

function isGoneError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 404 || (error.status === 409 && error.detail === NOT_PLAYED_SCORE_DETAIL))
  );
}

function emptyDraft(allianceId: number): AllianceDraft {
  return { alliance_id: allianceId, data: {}, teams: [], item_meta: {}, version: 0, score: 0 };
}

/** Runs `controller.start()` on mount, feeds it socket events and reconnects, and stops it on unmount. */
function useController(
  controller: { start: () => void; stop: () => void; onEvent: (event: RealtimeEvent) => void; reconnected: () => void },
  socket: ScoringSocket
) {
  useEffect(() => {
    controller.start();
    return () => controller.stop();
  }, [controller]);
  const { subscribe, connected } = socket;
  useEffect(() => subscribe(controller.onEvent), [controller, subscribe]);
  const wasConnected = useRef(connected);
  useEffect(() => {
    if (connected && !wasConnected.current) controller.reconnected();
    wasConnected.current = connected;
  }, [connected, controller]);
}

// ---------------------------------------------------------------- teamwork

export interface UseLiveDraftOptions {
  matchId: number;
  /** The match's session, for reading the official scores once it is submitted. */
  sessionId: number;
  /** This device's name as the server records it ("Admin" for the admin app). */
  myDeviceName: string;
  socketEvents: ScoringSocket;
  request?: ScoringRequest;
  /** The scoresheet's defaults, which `confirmZeroAndSubmit` saves for each alliance nobody has scored. */
  defaults?: ScoresheetValues;
  /** Cooperative games keep one shared draft on the lowest alliance id; only it can be missing. */
  cooperative?: boolean;
}

export interface LiveDraftState {
  /** The match's drafts with this device's unacknowledged changes on top; null until loaded. */
  draft: MatchDraft | null;
  loading: boolean;
  setItem: (allianceId: number, key: string, value: ScoresheetValue) => void;
  setTeamFlag: (allianceId: number, teamId: number, flag: TeamFlag, value: boolean) => void;
  /** Changes made here and not yet acknowledged by the server. */
  pending: number;
  /** The socket is down or the last PATCH never reached the server. */
  offline: boolean;
  /** `flashKey(allianceId, item)` -> the device that changed it, for FLASH_MS. */
  flashing: Record<string, string>;
  submit: (force?: boolean) => void;
  submitting: boolean;
  submitted: boolean;
  /** The official scores of this match once submitted (null while loading them). */
  saved: AllianceScore[] | null;
  violations: SubmitViolation[] | null;
  /** Alliances with no draft after Submit was refused for one (409), in id order; empty otherwise. */
  missing: number[];
  /** Saves each missing alliance with the scoresheet defaults (zero points), then submits again. */
  confirmZeroAndSubmit: () => void;
  /** Drops the missing-alliance question; nothing is saved. */
  cancelMissing: () => void;
  /** The match was deleted or marked not played. */
  gone: boolean;
  /** A refused request: the server's text, "" when it gave none; null when nothing failed. */
  error: string | null;
}

function createMatchController(get: () => UseLiveDraftOptions, rerender: () => void) {
  const state = {
    alive: false,
    loaded: false,
    server: new Map<number, AllianceDraft>(),
    submitted: false,
    saved: null as AllianceScore[] | null,
    gone: false,
    violations: null as SubmitViolation[] | null,
    missing: [] as number[],
    lastForce: false,
    error: null as string | null,
    submitting: false,
    refetchAfterFlush: false,
    submitAfterFlush: null as boolean | null,
  };
  const notify = () => {
    if (state.alive) rerender();
  };
  const request: ScoringRequest = (path, options) => (get().request ?? apiRequest)(path, options);
  const flasher = new Flasher(notify);
  const queue = new ChangeQueue(send, onIdle, notify);

  function displayed(allianceId: number): AllianceDraft {
    return withPending(state.server.get(allianceId) ?? emptyDraft(allianceId), queue.pending[allianceId] ?? {});
  }

  async function send(entry: QueueEntry): Promise<Outcome> {
    const body = entry.teams ? { changes: entry.changes, teams: entry.teams } : { changes: entry.changes };
    try {
      const draft = await request<AllianceDraft>(scoringPaths.allianceDraft(get().matchId, entry.scope), {
        method: "PATCH",
        body,
      });
      const held = state.server.get(draft.alliance_id);
      if (!held || draft.version > held.version) state.server.set(draft.alliance_id, draft);
      return "ack";
    } catch (error) {
      if (isNetworkError(error)) return "retry";
      if (isSubmittedError(error)) {
        void markSubmitted();
        return "clear";
      }
      if (isGoneError(error)) {
        state.gone = true;
        return "clear";
      }
      // Refused (bad value, wrong role): drop it and show the server's copy again;
      // a waiting Submit is cancelled so the scorer sees that copy first.
      state.submitAfterFlush = null;
      state.submitting = false;
      state.error = errorText(error) ?? "";
      state.refetchAfterFlush = true;
      return "drop";
    }
  }

  function onIdle() {
    if (!state.alive || state.submitted || state.gone) return;
    if (state.submitAfterFlush !== null) {
      const force = state.submitAfterFlush;
      state.submitAfterFlush = null;
      void postSubmit(force);
      return;
    }
    if (state.refetchAfterFlush) {
      state.refetchAfterFlush = false;
      void load();
    }
  }

  async function load() {
    try {
      const draft = await request<MatchDraft>(scoringPaths.matchDraft(get().matchId));
      if (!state.alive) return;
      state.loaded = true;
      queue.failed = false;
      if (draft.submitted) {
        await markSubmitted();
        return;
      }
      // The server's copy wins; this device's still-queued changes stay on top through `pending`.
      state.server = new Map(draft.alliances.map((alliance) => [alliance.alliance_id, alliance]));
      notify();
    } catch (error) {
      if (!state.alive) return;
      if (isGoneError(error)) {
        state.gone = true;
      } else if (isNetworkError(error)) {
        queue.failed = true;
        state.refetchAfterFlush = true;
        queue.scheduleRetry();
      } else {
        state.error = errorText(error) ?? "";
      }
      notify();
    }
  }

  async function markSubmitted() {
    if (state.submitted) return;
    state.submitted = true;
    state.submitting = false;
    state.violations = null;
    state.submitAfterFlush = null;
    queue.clear();
    notify();
    try {
      const scores = await request<AllianceScore[]>(scoringPaths.sessionScores(get().sessionId));
      state.saved = scores.filter((row) => row.match_id === get().matchId);
      notify();
    } catch {
      // "Saved" still shows; only the totals are missing.
    }
  }

  /** The alliance the server named plus every other one still without a draft here (cooperative: the shared one). */
  function missingAlliances(named: number): number[] {
    const ids = [...state.server.keys()].sort((a, b) => a - b);
    if (get().cooperative) return ids.slice(0, 1);
    const unscored = ids.filter((id) => (state.server.get(id)?.version ?? 0) === 0 && !queue.pending[id]);
    return [...new Set([named, ...unscored])].sort((a, b) => a - b);
  }

  async function postSubmit(force: boolean) {
    try {
      await request<MatchDraft>(scoringPaths.submit(get().matchId), { method: "POST", body: { force } });
      await markSubmitted();
    } catch (error) {
      state.submitting = false;
      const violations = submitViolations(error);
      const missing = missingDraftAlliance(error);
      if (violations) state.violations = violations;
      // Nothing is saved while any alliance is unscored (two scorers splitting a match); the page names it.
      else if (missing !== null) state.missing = missingAlliances(missing);
      else if (isSubmittedError(error)) await markSubmitted();
      else if (isGoneError(error)) state.gone = true;
      else state.error = errorText(error) ?? "";
      notify();
    }
  }

  function incoming(event: ScoreDraftChanged) {
    const { match_id: _matchId, ...draft } = event;
    const held = state.server.get(draft.alliance_id);
    if (draft.version === 0) {
      // A whole-match reset cleared this alliance's draft.
      state.server.set(draft.alliance_id, draft);
      notify();
      return;
    }
    if (held && draft.version <= held.version) return;
    const mine = queue.pending[draft.alliance_id] ?? {};
    for (const key of changedByOthers(held ?? emptyDraft(draft.alliance_id), draft, get().myDeviceName)) {
      if (!(key in mine)) flasher.flash(flashKey(draft.alliance_id, key), draft.item_meta[key].device_name);
    }
    state.server.set(draft.alliance_id, draft);
    // Another scorer started an alliance the Save-with-zero question named: leave it alone.
    state.missing = state.missing.filter((id) => id !== draft.alliance_id);
    notify();
  }

  return {
    start() {
      state.alive = true;
      queue.disposed = false;
      void load();
    },
    stop() {
      state.alive = false;
      queue.dispose();
      flasher.dispose();
    },
    onEvent(event: RealtimeEvent) {
      const data = event.data as { match_id?: number } | null;
      if (!state.alive || !data || data.match_id !== get().matchId) return;
      if (event.event === "score_draft_changed") incoming(data as ScoreDraftChanged);
      else if (event.event === "match_submitted") void markSubmitted();
      else if (event.event === "match_reset") void load();
    },
    reconnected() {
      state.refetchAfterFlush = true;
      queue.retryNow();
    },
    setItem(allianceId: number, key: string, value: ScoresheetValue) {
      if (state.submitted || state.gone) return;
      state.error = null;
      queue.push({ scope: allianceId, changes: { [key]: value }, keys: [key] }, { [key]: value });
    },
    setTeamFlag(allianceId: number, teamId: number, flag: TeamFlag, value: boolean) {
      if (state.submitted || state.gone) return;
      state.error = null;
      const current = displayed(allianceId).teams.find((team) => team.team_id === teamId) ?? {
        team_id: teamId,
        no_show: false,
        dq: false,
      };
      const key = teamFlagKey(teamId, flag);
      queue.push(
        { scope: allianceId, changes: {}, teams: [{ ...current, [flag]: value }], keys: [key] },
        { [key]: value }
      );
    },
    submit(force = false) {
      if (state.submitted || state.gone || state.submitting) return;
      state.submitting = true;
      state.violations = null;
      state.missing = [];
      state.lastForce = force;
      state.error = null;
      // Submit only once every change made here has been acknowledged.
      state.submitAfterFlush = force;
      notify();
      queue.pump();
    },
    confirmZeroAndSubmit() {
      const { defaults } = get();
      if (!defaults || state.missing.length === 0 || state.submitted || state.gone) return;
      // Only alliances still without a draft: another scorer may have started one since the question.
      const ids = state.missing.filter((id) => (state.server.get(id)?.version ?? 0) === 0 && !queue.pending[id]);
      state.missing = [];
      state.error = null;
      state.submitting = true;
      if (ids.length === 0) {
        // Nothing to save at zero; still wait for this device's own queued changes before Submit.
        state.submitAfterFlush = state.lastForce;
        notify();
        queue.pump();
        return;
      }
      // Re-post Submit once the zero drafts below are acknowledged.
      state.submitAfterFlush = state.lastForce;
      for (const id of ids) {
        queue.push({ scope: id, changes: { ...defaults }, keys: Object.keys(defaults) }, { ...defaults });
      }
    },
    cancelMissing() {
      state.missing = [];
      notify();
    },
    snapshot(connected: boolean): LiveDraftState {
      const ids = [...state.server.keys()].sort((a, b) => a - b);
      return {
        draft: state.loaded ? { match_id: get().matchId, submitted: state.submitted, alliances: ids.map(displayed) } : null,
        loading: !state.loaded && !state.gone,
        setItem: this.setItem,
        setTeamFlag: this.setTeamFlag,
        pending: queue.entries.length,
        offline: !connected || queue.failed,
        flashing: flasher.current,
        submit: this.submit,
        submitting: state.submitting,
        submitted: state.submitted,
        saved: state.saved,
        violations: state.violations,
        missing: state.missing,
        confirmZeroAndSubmit: this.confirmZeroAndSubmit,
        cancelMissing: this.cancelMissing,
        gone: state.gone,
        error: state.error,
      };
    },
  };
}

/**
 * One match's live drafts: every change is sent at once as a PATCH of that
 * item (one in flight, in order), incoming `score_draft_changed` events with
 * a newer version replace an alliance's copy, and items another device
 * changed flash for FLASH_MS. Key the calling component by match id.
 */
export function useLiveDraft(options: UseLiveDraftOptions): LiveDraftState {
  const latest = useRef(options);
  latest.current = options;
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [controller] = useState(() => createMatchController(() => latest.current, rerender));
  useController(controller, options.socketEvents);
  return controller.snapshot(options.socketEvents.connected);
}

// ---------------------------------------------------------------- skills

export interface UseSkillsRunOptions {
  fieldId: number;
  fieldSetId: number;
  myDeviceName: string;
  socketEvents: ScoringSocket;
  request?: ScoringRequest;
  /** The run type's scoresheet defaults, sent for items never touched when Submit is pressed. */
  defaults?: ScoresheetValues;
}

export interface SkillsSaved {
  team_number: string;
  team_name: string;
  skills_type: string;
  score: number;
}

export interface SkillsRunState {
  /** The field set's timer and fields; null until loaded. */
  set: SkillsSet | null;
  /** This field's run with this device's unacknowledged changes on top; null when there is none. */
  run: SkillsRun | null;
  loading: boolean;
  setItem: (key: string, value: ScoresheetValue) => void;
  pending: number;
  offline: boolean;
  /** Item key -> the device that changed it, for FLASH_MS. */
  flashing: Record<string, string>;
  submit: (force?: boolean) => void;
  submitting: boolean;
  /** The run this device submitted last, until the field's next run. */
  saved: SkillsSaved | null;
  violations: SubmitViolation[] | null;
  discard: () => void;
  timerAction: (target: "field" | "set", action: SkillsTimerAction) => void;
  /** The field is no longer a skills field of this set. */
  gone: boolean;
  error: string | null;
}

const RUN_SCOPE = 0;

function createSkillsController(get: () => UseSkillsRunOptions, rerender: () => void) {
  const state = {
    alive: false,
    loaded: false,
    set: null as SkillsSet | null,
    run: null as SkillsRun | null,
    saved: null as SkillsSaved | null,
    gone: false,
    violations: null as SubmitViolation[] | null,
    error: null as string | null,
    submitting: false,
    refetchAfterFlush: false,
    submitAfterFlush: null as boolean | null,
  };
  const notify = () => {
    if (state.alive) rerender();
  };
  const request: ScoringRequest = (path, options) => (get().request ?? apiRequest)(path, options);
  const flasher = new Flasher(notify);
  const queue = new ChangeQueue(send, onIdle, notify);

  function takeRun(run: SkillsRun | null, fromEvent: boolean) {
    const held = state.run;
    if (run === null || held === null || run.id !== held.id) {
      // A different run (or none): nothing queued belongs to it, and a new run replaces the last "Saved".
      if (run !== null) state.saved = null;
      queue.clear();
      state.run = run;
      return;
    }
    if (run.version < held.version) {
      // An older draft than ours: keep our items, take the timer.
      state.run = { ...run, data: held.data, item_meta: held.item_meta, version: held.version, score: held.score };
      return;
    }
    if (fromEvent && run.version > held.version) {
      const mine = queue.pending[RUN_SCOPE] ?? {};
      for (const key of changedByOthers(held, run, get().myDeviceName)) {
        if (!(key in mine)) flasher.flash(key, run.item_meta[key].device_name);
      }
    }
    state.run = run;
  }

  async function load(fromEvent = false) {
    try {
      const set = await request<SkillsSet>(scoringPaths.skillsSet(get().fieldSetId));
      if (!state.alive) return;
      state.loaded = true;
      queue.failed = false;
      state.set = set;
      const field = set.fields.find((entry) => entry.field_id === get().fieldId);
      if (!field) state.gone = true;
      else takeRun(field.run, fromEvent);
      notify();
    } catch (error) {
      if (!state.alive) return;
      if (error instanceof ApiError && (error.status === 404 || error.status === 409)) {
        state.gone = true;
      } else if (isNetworkError(error)) {
        queue.failed = true;
        state.refetchAfterFlush = true;
        queue.scheduleRetry();
      } else {
        state.error = errorText(error) ?? "";
      }
      notify();
    }
  }

  async function send(entry: QueueEntry): Promise<Outcome> {
    try {
      const run = await request<SkillsRun>(scoringPaths.skillsRunDraft(get().fieldId), {
        method: "PATCH",
        body: { changes: entry.changes },
      });
      if (state.run && run.id === state.run.id && run.version > state.run.version) state.run = run;
      return "ack";
    } catch (error) {
      if (isNetworkError(error)) return "retry";
      state.error = errorText(error) ?? "";
      state.refetchAfterFlush = true;
      state.submitAfterFlush = null;
      state.submitting = false;
      // 422: just this change was refused. Anything else: the run is gone (submitted or discarded elsewhere).
      return error instanceof ApiError && error.status === 422 ? "drop" : "clear";
    }
  }

  function onIdle() {
    if (!state.alive || state.gone) return;
    if (state.submitAfterFlush !== null) {
      const force = state.submitAfterFlush;
      state.submitAfterFlush = null;
      void postSubmit(force);
      return;
    }
    if (state.refetchAfterFlush) {
      state.refetchAfterFlush = false;
      void load();
    }
  }

  async function postSubmit(force: boolean) {
    const run = state.run ? withPending(state.run, queue.pending[RUN_SCOPE] ?? {}) : null;
    try {
      await request<unknown>(scoringPaths.skillsRunSubmit(get().fieldId), { method: "POST", body: { force } });
      state.submitting = false;
      if (run) {
        state.saved = {
          team_number: run.team_number,
          team_name: run.team_name,
          skills_type: run.skills_type,
          score: run.score,
        };
      }
      state.run = null;
      notify();
      void load();
    } catch (error) {
      state.submitting = false;
      const violations = submitViolations(error);
      if (violations) state.violations = violations;
      else if (isNetworkError(error)) state.error = "";
      else {
        state.error = errorText(error) ?? "";
        void load();
      }
      notify();
    }
  }

  function displayedRun(): SkillsRun | null {
    return state.run ? withPending(state.run, queue.pending[RUN_SCOPE] ?? {}) : null;
  }

  return {
    start() {
      state.alive = true;
      queue.disposed = false;
      void load();
    },
    stop() {
      state.alive = false;
      queue.dispose();
      flasher.dispose();
    },
    onEvent(event: RealtimeEvent) {
      const data = event.data as { field_set_id?: number } | null;
      if (!state.alive || event.event !== "skills_run_changed" || !data || data.field_set_id !== get().fieldSetId) return;
      void load(true);
    },
    reconnected() {
      state.refetchAfterFlush = true;
      queue.retryNow();
    },
    setItem(key: string, value: ScoresheetValue) {
      if (!state.run || state.gone) return;
      state.error = null;
      queue.push({ scope: RUN_SCOPE, changes: { [key]: value }, keys: [key] }, { [key]: value });
    },
    submit(force = false) {
      if (!state.run || state.submitting) return;
      state.submitting = true;
      state.violations = null;
      state.error = null;
      const { defaults } = get();
      const shown = displayedRun();
      if (defaults && shown) {
        const missing = Object.fromEntries(Object.entries(defaults).filter(([key]) => !(key in shown.data)));
        const keys = Object.keys(missing);
        if (keys.length > 0) queue.push({ scope: RUN_SCOPE, changes: missing, keys }, missing);
      }
      state.submitAfterFlush = force;
      notify();
      queue.pump();
    },
    discard() {
      void (async () => {
        try {
          await request<void>(scoringPaths.skillsRun(get().fieldId), { method: "DELETE" });
          queue.clear();
          state.run = null;
          state.violations = null;
        } catch (error) {
          state.error = errorText(error) ?? "";
        }
        notify();
        void load();
      })();
    },
    timerAction(target: "field" | "set", action: SkillsTimerAction) {
      const path =
        target === "field"
          ? scoringPaths.skillsRunAction(get().fieldId, action)
          : scoringPaths.setTimer(get().fieldSetId, action);
      void (async () => {
        try {
          await request<unknown>(path, { method: "POST" });
        } catch (error) {
          state.error = errorText(error) ?? "";
          notify();
        }
        void load();
      })();
    },
    snapshot(connected: boolean): SkillsRunState {
      return {
        set: state.set,
        run: displayedRun(),
        loading: !state.loaded && !state.gone,
        setItem: this.setItem,
        pending: queue.entries.length,
        offline: !connected || queue.failed,
        flashing: flasher.current,
        submit: this.submit,
        submitting: state.submitting,
        saved: state.saved,
        violations: state.violations,
        discard: this.discard,
        timerAction: this.timerAction,
        gone: state.gone,
        error: state.error,
      };
    },
  };
}

/** One skills field's run, synced like `useLiveDraft`; refetches its set on `skills_run_changed`. Key the caller by field id. */
export function useSkillsRun(options: UseSkillsRunOptions): SkillsRunState {
  const latest = useRef(options);
  latest.current = options;
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [controller] = useState(() => createSkillsController(() => latest.current, rerender));
  useController(controller, options.socketEvents);
  return controller.snapshot(options.socketEvents.connected);
}
