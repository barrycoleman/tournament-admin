import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError, initI18n } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import zhAdmin from "../../src/i18n/zh/admin.json";
import { SoundsSection } from "../../src/devices/SoundsSection";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn() };
});

import { apiRequest } from "@tournament-admin/shared";

const SLOTS = ["beep", "start", "buzzer", "moment", "stop"];
let rows: Record<string, unknown>[];
let duration: number;
const decode = vi.fn();

function stub(overrides: Record<string, unknown> = {}) {
  vi.mocked(apiRequest).mockImplementation(async (path: string, options?: { method?: string }) => {
    const key = `${options?.method ?? "GET"} ${path}`;
    if (key in overrides) {
      const value = overrides[key];
      if (value instanceof Error) throw value;
      return value as never;
    }
    if (key === "GET /api/sounds") return rows as never;
    if (options?.method === "PUT") {
      const slot = path.split("/").pop();
      rows = rows.map((r) => (r.slot === slot ? { slot, replaced: true, filename: "ding.wav", uploaded_at: "x" } : r));
    }
    if (options?.method === "PUT") return { slot: path.split("/").pop(), replaced: true, filename: "ding.wav", uploaded_at: "x" } as never;
    if (options?.method === "DELETE") return undefined as never;
    throw new Error(`unexpected request: ${key}`);
  });
}

function renderSection(lng: "en" | "zh" = "en") {
  const i18n = initI18n({ en: { translation: enAdmin }, zh: { translation: zhAdmin } });
  void i18n.changeLanguage(lng);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <SoundsSection />
      </I18nextProvider>
    </QueryClientProvider>
  );
}

const file = (name: string, bytes = 100) => new File([new Uint8Array(bytes)], name, { type: "audio/wav" });
const uploadsCalled = () => vi.mocked(apiRequest).mock.calls.filter(([, o]) => o?.method === "PUT");

beforeEach(() => {
  vi.mocked(apiRequest).mockReset();
  rows = SLOTS.map((slot) => ({ slot, replaced: false, filename: null, uploaded_at: null }));
  duration = 2;
  decode.mockReset();
  decode.mockImplementation(async () => ({ duration }));
  vi.stubGlobal(
    "AudioContext",
    class {
      decodeAudioData = decode;
      close = vi.fn();
      destination = {};
      createBufferSource = () => ({ connect: vi.fn(), start: vi.fn(), buffer: null, onended: null });
    }
  );
  stub();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Sounds panel", () => {
  it("lists the five sounds with what they are for, all on Default", async () => {
    renderSection();
    expect(await screen.findByRole("heading", { name: "Sounds" })).toBeInTheDocument();
    expect(screen.getByText("Count-in and last 3 seconds")).toBeInTheDocument();
    expect(screen.getByText("Match start and driver start")).toBeInTheDocument();
    expect(screen.getByText("Time runs out")).toBeInTheDocument();
    expect(screen.getByText("Game moments and time-out end")).toBeInTheDocument();
    expect(screen.getByText("Ended early or reset")).toBeInTheDocument();
    for (const name of ["Beep", "Start", "Buzzer", "Ding", "Stop"]) expect(screen.getByText(name)).toBeInTheDocument();
    expect(screen.getAllByText("Default")).toHaveLength(5);
    expect(screen.queryByRole("button", { name: "Restore default" })).toBeNull();
    expect(screen.getByText("Only upload sounds you have the rights to use.")).toBeInTheDocument();
    expect(screen.getByLabelText("Upload a Beep sound file")).toHaveAttribute("accept", "audio/mpeg,audio/ogg,audio/wav,.mp3,.ogg,.wav");
  });

  it("uploads a file and shows its name", async () => {
    renderSection();
    const input = await screen.findByLabelText("Upload a Ding sound file");
    fireEvent.change(input, { target: { files: [file("ding.wav")] } });
    await waitFor(() => expect(uploadsCalled()).toHaveLength(1));
    const [path, options] = uploadsCalled()[0];
    expect(path).toBe("/api/sounds/moment");
    expect(options?.isFormData).toBe(true);
    expect((options?.body as FormData).get("file")).toBeInstanceOf(File);
    await waitFor(() => expect(screen.getByText("ding.wav")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Restore default" })).toBeInTheDocument();
  });

  it("refuses a sound longer than 10 seconds without a request", async () => {
    duration = 10.5;
    renderSection();
    fireEvent.change(await screen.findByLabelText("Upload a Beep sound file"), { target: { files: [file("long.wav")] } });
    expect(await screen.findByText("This sound is longer than 10 seconds.")).toBeInTheDocument();
    expect(uploadsCalled()).toHaveLength(0);
  });

  it("refuses a file over 1 MB without a request", async () => {
    renderSection();
    fireEvent.change(await screen.findByLabelText("Upload a Beep sound file"), { target: { files: [file("big.wav", 1_048_577)] } });
    expect(await screen.findByText("This file is larger than 1 MB.")).toBeInTheDocument();
    expect(uploadsCalled()).toHaveLength(0);
  });

  it("accepts a file of exactly 1 MB and exactly 10 seconds", async () => {
    duration = 10;
    renderSection();
    fireEvent.change(await screen.findByLabelText("Upload a Beep sound file"), { target: { files: [file("edge.wav", 1_048_576)] } });
    await waitFor(() => expect(uploadsCalled()).toHaveLength(1));
  });

  it("shows the server's message when it refuses a file", async () => {
    stub({ "PUT /api/sounds/stop": new ApiError(422, "Not an MP3, OGG or WAV file.") });
    renderSection();
    fireEvent.change(await screen.findByLabelText("Upload a Stop sound file"), { target: { files: [file("x.wav")] } });
    expect(await screen.findByText("Not an MP3, OGG or WAV file.")).toBeInTheDocument();
  });

  it("restores the default of a replaced sound", async () => {
    rows = rows.map((r) => (r.slot === "buzzer" ? { slot: "buzzer", replaced: true, filename: "horn.mp3", uploaded_at: "x" } : r));
    stub();
    renderSection();
    expect(await screen.findByText("horn.mp3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Restore default" }));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("/api/sounds/buzzer", { method: "DELETE" }));
  });

  it("plays a sound by fetching its audio with the sign-in", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) }));
    vi.stubGlobal("fetch", fetchMock);
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Play the Start sound" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe("/api/sounds/start/audio");
    await waitFor(() => expect(decode).toHaveBeenCalled());
  });

  it("shows Chinese labels", async () => {
    renderSection("zh");
    expect(await screen.findByRole("heading", { name: "声音" })).toBeInTheDocument();
    for (const text of ["提示音", "倒数和最后3秒", "开始", "比赛开始和手动阶段开始", "蜂鸣器", "时间用完", "叮", "比赛时刻和暂停结束", "停止", "提前结束或重置", "请只上传您有权使用的声音。"])
      expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.getAllByText("默认")).toHaveLength(5);
    expect(within(screen.getAllByRole("listitem")[0]).getByRole("button", { name: "上传" })).toBeInTheDocument();
  });
});
