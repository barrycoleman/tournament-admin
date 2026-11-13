import { afterEach, describe, expect, it, vi } from "vitest";
import { BANNER_SNOOZE_MS, isBannerSnoozed, snoozeBanner } from "../../src/orientation/snooze";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("banner snooze", () => {
  it("is snoozed right after snoozing, and not for another session", () => {
    const now = new Date("2026-10-22T10:00:00Z");
    snoozeBanner(11, now);
    expect(isBannerSnoozed(11, now)).toBe(true);
    expect(isBannerSnoozed(12, now)).toBe(false);
  });

  it("expires after 15 minutes", () => {
    const now = new Date("2026-10-22T10:00:00Z");
    snoozeBanner(21, now);
    expect(BANNER_SNOOZE_MS).toBe(15 * 60 * 1000);
    expect(isBannerSnoozed(21, new Date(now.getTime() + BANNER_SNOOZE_MS - 1))).toBe(true);
    expect(isBannerSnoozed(21, new Date(now.getTime() + BANNER_SNOOZE_MS))).toBe(false);
  });

  it("still works when localStorage throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const now = new Date("2026-10-22T10:00:00Z");
    snoozeBanner(31, now);
    expect(isBannerSnoozed(31, now)).toBe(true);
    expect(isBannerSnoozed(31, new Date(now.getTime() + BANNER_SNOOZE_MS))).toBe(false);
  });
});
