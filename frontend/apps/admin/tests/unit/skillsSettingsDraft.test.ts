import { describe, expect, it } from "vitest";
import { attemptsErrors, parseAttempts, toSkillsDraft } from "../../src/skills/skillsSettingsDraft";

describe("skillsSettingsDraft", () => {
  it("starts from the saved settings, one text per type", () => {
    const draft = toSkillsDraft({
      enabled: true,
      attempts: { autonomous: 3, driver: 5 },
      types: [{ key: "autonomous", label: "Autonomous" }, { key: "driver", label: "Driver" }],
    });
    expect(draft).toEqual({ enabled: true, attempts: { autonomous: "3", driver: "5" } });
  });

  it("flags anything but a whole number from 1 to 20", () => {
    const errors = attemptsErrors({ a: "", b: "0", c: "21", d: "2.5", e: "abc", f: " 3 ", g: "20", h: "1" });
    expect([...errors].sort()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("parses a valid draft and refuses an invalid one", () => {
    expect(parseAttempts({ autonomous: " 2 ", driver: "20" })).toEqual({ autonomous: 2, driver: 20 });
    expect(parseAttempts({ autonomous: "0" })).toBeNull();
    expect(parseAttempts({})).toEqual({});
  });
});
