import { createContext } from "react";
import type { SoundSlot } from "@tournament-admin/shared";

// Stand-in tones per sound slot until the sound files replace them.
const TONES: Record<SoundSlot, { frequency: number; seconds: number; repeat: number }> = {
  beep: { frequency: 880, seconds: 0.15, repeat: 1 },
  start: { frequency: 1320, seconds: 0.4, repeat: 1 },
  buzzer: { frequency: 330, seconds: 0.9, repeat: 1 },
  moment: { frequency: 520, seconds: 0.7, repeat: 2 },
  stop: { frequency: 220, seconds: 0.6, repeat: 1 },
};
const GAP_SECONDS = 0.1;

/** Short tones made by the browser itself, so there are no sound files. */
export class SoundPlayer {
  private context: AudioContext | null = null;

  constructor(private readonly create: () => AudioContext = () => new AudioContext()) {}

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
    void context?.close().catch(() => undefined);
  }

  play(cue: SoundSlot): void {
    const context = this.ensure();
    if (context === null || context.state !== "running") return;
    const tone = TONES[cue];
    for (let i = 0; i < tone.repeat; i += 1) {
      const at = context.currentTime + i * (tone.seconds + GAP_SECONDS);
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = tone.frequency;
      gain.gain.value = 0.2;
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(at);
      oscillator.stop(at + tone.seconds);
    }
  }
}

export const SoundPlayerContext = createContext<SoundPlayer | null>(null);
