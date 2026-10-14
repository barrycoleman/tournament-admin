import { describe, expect, it } from "vitest";
import { normalizeCode, relativeTime } from "../../src/devices/format";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

describe("relativeTime", () => {
  it("is null under a minute, even at 45 seconds", () => {
    expect(relativeTime(ago(0), NOW, "en")).toBeNull();
    expect(relativeTime(ago(45), NOW, "en")).toBeNull();
    expect(relativeTime(ago(59), NOW, "en")).toBeNull();
  });

  it("counts whole minutes, then hours, then days", () => {
    expect(relativeTime(ago(60), NOW, "en")).toMatch(/1 min/);
    expect(relativeTime(ago(3 * 60 + 50), NOW, "en")).toMatch(/3 min/);
    expect(relativeTime(ago(2 * 3600), NOW, "en")).toMatch(/2 hr/);
    expect(relativeTime(ago(3 * 86400), NOW, "en")).toMatch(/3 days/);
  });
});

describe("normalizeCode", () => {
  it("drops spaces and hyphens and upper-cases", () => {
    expect(normalizeCode("kx4-9tm")).toBe("KX49TM");
    expect(normalizeCode(" KX4 9tm ")).toBe("KX49TM");
  });
});
