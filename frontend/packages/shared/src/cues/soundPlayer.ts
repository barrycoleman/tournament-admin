import { SOUND_SLOTS, type SoundSlot } from "./cues";

/** No cue plays longer than this, whatever file an organiser uploaded. */
export const MAX_CUE_SECONDS = 10;

/** The window event every cue raises, so tests and tools can see what played. */
export const TV_CUE_EVENT = "tv-cue";

/** Fetches one slot's audio; `useDefault` asks for the bundled default. */
export type SoundLoader = (slot: SoundSlot, useDefault: boolean) => Promise<ArrayBuffer>;

/** Plays the five cue sounds through Web Audio from decoded buffers, so a cue
 * starts on time and two cues can overlap. A slot whose sound cannot be
 * fetched or decoded falls back to the bundled default. */
export class SoundPlayer {
  private context: AudioContext | null = null;
  private readonly decoded = new Map<SoundSlot, AudioBuffer>();
  private readonly loading = new Map<SoundSlot, Promise<void>>();

  constructor(
    private readonly load: SoundLoader,
    private readonly create: () => AudioContext = () => new AudioContext()
  ) {}

  private ensure(): AudioContext | null {
    if (this.context === null) {
      try {
        this.context = this.create();
      } catch {
        return null;
      }
    }
    return this.context;
  }

  /** True while the browser holds sound until someone clicks the page. */
  get blocked(): boolean {
    return this.ensure()?.state === "suspended";
  }

  async unlock(): Promise<void> {
    await this.ensure()?.resume();
  }

  /** Releases the browser's audio context; a later use makes a new one. */
  close(): void {
    const context = this.context;
    this.context = null;
    this.decoded.clear();
    this.loading.clear();
    void context?.close().catch(() => undefined);
  }

  /** Drops a slot's sound; the next preload or play fetches it again. */
  reload(slot: SoundSlot): void {
    this.decoded.delete(slot);
    this.loading.delete(slot);
  }

  /** Fetches and decodes every slot not already held. */
  async preload(): Promise<void> {
    await Promise.all(SOUND_SLOTS.map((slot) => this.fetchSlot(slot)));
  }

  private fetchSlot(slot: SoundSlot): Promise<void> {
    if (this.decoded.has(slot)) return Promise.resolve();
    const inFlight = this.loading.get(slot);
    if (inFlight) return inFlight;
    const context = this.ensure();
    if (context === null) return Promise.resolve();
    const settle = async (pending: Promise<AudioBuffer | null>) => {
      const buffer = await pending;
      // A reload or close while this was loading makes its result stale.
      if (this.loading.get(slot) !== attempt) return;
      this.loading.delete(slot);
      if (buffer !== null) this.decoded.set(slot, buffer);
    };
    const pending = (async () =>
      (await this.decode(context, slot, false)) ?? (await this.decode(context, slot, true)))();
    const attempt: Promise<void> = settle(pending);
    this.loading.set(slot, attempt);
    return attempt;
  }

  private async decode(context: AudioContext, slot: SoundSlot, useDefault: boolean): Promise<AudioBuffer | null> {
    try {
      return await context.decodeAudioData(await this.load(slot, useDefault));
    } catch {
      return null;
    }
  }

  /** Plays a slot at once if its sound is ready (a late cue would be off
   * time, so one still loading is skipped), cut off at 10 s. */
  play(slot: SoundSlot): void {
    window.dispatchEvent(new CustomEvent(TV_CUE_EVENT, { detail: { slot } }));
    const buffer = this.decoded.get(slot);
    if (buffer === undefined) {
      void this.fetchSlot(slot);
      return;
    }
    const context = this.ensure();
    if (context === null || context.state !== "running") return;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const at = context.currentTime;
    source.start(at);
    source.stop(at + MAX_CUE_SECONDS);
  }
}
