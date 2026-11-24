import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, getStoredTokens, refreshTokens, type SoundSlot } from "@tournament-admin/shared";

export interface EventSoundRow {
  slot: SoundSlot;
  replaced: boolean;
  filename: string | null;
  uploaded_at: string | null;
}

/** Same key the operator-sound player reads, so one refetch serves both. */
export const SOUNDS_KEY = ["sounds"];

export const MAX_SOUND_BYTES = 1_048_576;
export const MAX_SOUND_SECONDS = 10;

export function useEventSounds() {
  return useQuery({ queryKey: SOUNDS_KEY, queryFn: () => apiRequest<EventSoundRow[]>("/api/sounds") });
}

export function useSoundMutations() {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: SOUNDS_KEY });
  return {
    upload: useMutation({
      mutationFn: ({ slot, file }: { slot: SoundSlot; file: File }) => {
        const form = new FormData();
        form.append("file", file);
        return apiRequest<EventSoundRow>(`/api/sounds/${slot}`, { method: "PUT", body: form, isFormData: true });
      },
      onSuccess: refresh,
    }),
    restore: useMutation({
      mutationFn: (slot: SoundSlot) => apiRequest<void>(`/api/sounds/${slot}`, { method: "DELETE" }),
      onSuccess: refresh,
    }),
  };
}

function readBytes(file: Blob): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === "function") return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

/** How long a file plays, in seconds, by decoding it in the browser. */
export async function soundSeconds(file: Blob): Promise<number> {
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await readBytes(file));
    return decoded.duration;
  } finally {
    void context.close?.();
  }
}

async function fetchAudio(slot: SoundSlot, token: string | undefined): Promise<Response> {
  return fetch(`/api/sounds/${slot}/audio`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
}

/** The slot's current sound as bytes; refreshes the sign-in once on a 401. */
export async function fetchSoundBytes(slot: SoundSlot): Promise<ArrayBuffer> {
  let response = await fetchAudio(slot, getStoredTokens()?.accessToken);
  if (response.status === 401) {
    const tokens = await refreshTokens();
    response = await fetchAudio(slot, tokens.accessToken);
  }
  if (!response.ok) throw new Error(`sound ${slot} answered ${response.status}`);
  return response.arrayBuffer();
}

/** Plays the slot's current sound once. */
export async function playSound(slot: SoundSlot): Promise<void> {
  const context = new AudioContext();
  const decoded = await context.decodeAudioData(await fetchSoundBytes(slot));
  const source = context.createBufferSource();
  source.buffer = decoded;
  source.connect(context.destination);
  source.onended = () => void context.close?.();
  source.start();
}
