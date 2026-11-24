import { afterEach, describe, expect, it, vi } from "vitest";
import { SoundPlayer, type SoundSlot } from "../src";

/** A stand-in for the browser's AudioContext: decodes any bytes whose first
 * byte is not 0 and records every buffer source it starts. */
class FakeContext {
  state: "suspended" | "running" | "closed" = "suspended";
  currentTime = 5;
  destination = { node: "speakers" };
  sources: { buffer: unknown; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn> }[] = [];
  resume = vi.fn(async () => {
    this.state = "running";
  });
  close = vi.fn(async () => {
    this.state = "closed";
  });
  decodeAudioData = vi.fn(async (data: ArrayBuffer) => {
    const first = new Uint8Array(data)[0];
    if (first === 0) throw new Error("cannot decode");
    return { decodedFrom: first } as unknown as AudioBuffer;
  });
  createBufferSource() {
    const source = { buffer: null as unknown, start: vi.fn(), stop: vi.fn(), connect: vi.fn() };
    this.sources.push(source);
    return source;
  }
}

const bytes = (first: number) => new Uint8Array([first, 1, 2]).buffer;
const BYTE: Record<SoundSlot, number> = { beep: 1, start: 2, buzzer: 3, moment: 4, stop: 5 };

function setUp(load?: (slot: SoundSlot, useDefault: boolean) => Promise<ArrayBuffer>) {
  const context = new FakeContext();
  const loader = vi.fn(load ?? (async (slot: SoundSlot) => bytes(BYTE[slot])));
  const player = new SoundPlayer(loader, () => context as unknown as AudioContext);
  return { context, loader, player };
}

afterEach(() => vi.restoreAllMocks());

describe("SoundPlayer", () => {
  it("is blocked until unlocked", async () => {
    const { player } = setUp();
    expect(player.blocked).toBe(true);
    await player.unlock();
    expect(player.blocked).toBe(false);
  });

  it("preloads all five slots and plays the decoded buffer at once, stopping it at 10 s", async () => {
    const { context, loader, player } = setUp();
    await player.preload();
    expect(loader.mock.calls.map(([slot, useDefault]) => [slot, useDefault])).toEqual([
      ["beep", false],
      ["start", false],
      ["buzzer", false],
      ["moment", false],
      ["stop", false],
    ]);
    await player.unlock();
    player.play("start");
    expect(context.sources).toHaveLength(1);
    const [source] = context.sources;
    expect(source.buffer).toEqual({ decodedFrom: 2 });
    expect(source.connect).toHaveBeenCalledWith(context.destination);
    expect(source.start).toHaveBeenCalledWith(5);
    expect(source.stop).toHaveBeenCalledWith(15);
  });

  it("plays nothing while blocked or not yet decoded", async () => {
    const { context, player } = setUp();
    player.play("beep");
    await player.preload();
    player.play("beep");
    expect(context.sources).toHaveLength(0);
  });

  it("tells the page about every cue it is asked to play", async () => {
    const { player } = setUp();
    const heard: string[] = [];
    const listener = (event: Event) => heard.push((event as CustomEvent<{ slot: string }>).detail.slot);
    window.addEventListener("tv-cue", listener);
    try {
      player.play("moment");
      player.play("buzzer");
    } finally {
      window.removeEventListener("tv-cue", listener);
    }
    expect(heard).toEqual(["moment", "buzzer"]);
  });

  it("re-fetches a slot after reload, and plays the new sound", async () => {
    let version = 2;
    const { context, loader, player } = setUp(async (slot) => bytes(slot === "start" ? version : BYTE[slot]));
    await player.preload();
    await player.unlock();
    version = 9;
    player.reload("start");
    await player.preload();
    expect(loader.mock.calls.filter(([slot]) => slot === "start")).toHaveLength(2);
    expect(loader.mock.calls.filter(([slot]) => slot === "beep")).toHaveLength(1);
    player.play("start");
    expect(context.sources.at(-1)?.buffer).toEqual({ decodedFrom: 9 });
  });

  it("falls back to the default when an upload fails to decode, leaving other slots alone", async () => {
    const { context, loader, player } = setUp(async (slot, useDefault) =>
      slot === "buzzer" && !useDefault ? bytes(0) : bytes(useDefault ? 42 : BYTE[slot])
    );
    await player.preload();
    expect(loader).toHaveBeenCalledWith("buzzer", true);
    expect(loader.mock.calls.filter(([, useDefault]) => useDefault)).toEqual([["buzzer", true]]);
    await player.unlock();
    player.play("buzzer");
    player.play("beep");
    expect(context.sources.map((s) => s.buffer)).toEqual([{ decodedFrom: 42 }, { decodedFrom: 1 }]);
  });

  it("falls back to the default when fetching the upload fails", async () => {
    const { context, loader, player } = setUp(async (slot, useDefault) => {
      if (slot === "stop" && !useDefault) throw new Error("offline");
      return bytes(useDefault ? 42 : BYTE[slot]);
    });
    await player.preload();
    expect(loader).toHaveBeenCalledWith("stop", true);
    await player.unlock();
    player.play("stop");
    expect(context.sources[0].buffer).toEqual({ decodedFrom: 42 });
  });

  it("tries a slot again later when even the default fails", async () => {
    let fail = true;
    const { context, loader, player } = setUp(async (slot) => {
      if (slot === "moment" && fail) throw new Error("offline");
      return bytes(BYTE[slot]);
    });
    await player.preload();
    fail = false;
    await player.preload();
    expect(loader.mock.calls.filter(([slot]) => slot === "moment")).toHaveLength(3);
    await player.unlock();
    player.play("moment");
    expect(context.sources[0].buffer).toEqual({ decodedFrom: 4 });
  });

  it("closes its audio context, and makes a new one when used again", async () => {
    const contexts: FakeContext[] = [];
    const player = new SoundPlayer(
      async (slot) => bytes(BYTE[slot]),
      () => {
        const context = new FakeContext();
        contexts.push(context);
        return context as unknown as AudioContext;
      }
    );
    void player.blocked;
    player.close();
    expect(contexts[0].close).toHaveBeenCalledTimes(1);
    void player.blocked;
    expect(contexts).toHaveLength(2);
  });
});
