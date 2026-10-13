import { describe, expect, it } from "vitest";
import { formatSize, reasonKey } from "../../src/backups/format";

describe("formatSize", () => {
  it("uses bytes, KB and MB", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(2048)).toBe("2 KB");
    expect(formatSize(1_572_864)).toBe("1.5 MB");
  });
});

describe("reasonKey", () => {
  it("maps a reason to its translation key", () => {
    expect(reasonKey("before-clear-schedule")).toBe("backups.reasons.before-clear-schedule");
  });
});
