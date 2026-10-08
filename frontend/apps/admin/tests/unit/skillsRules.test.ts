import { describe, expect, it } from "vitest";
import { initI18n } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { skillsRuleSentence } from "../../src/skills/skillsRules";

const t = initI18n({ en: { translation: enAdmin } }).t;
const TYPES = [
  { key: "autonomous", label: "Autonomous" },
  { key: "driver", label: "Driver" },
];

describe("skillsRuleSentence", () => {
  it("explains Overall with the types in priority order", () => {
    expect(skillsRuleSentence(t, "overall", TYPES, false)).toBe(
      "Sum of each team's best attempt in each type in one session. Ties go to the higher Autonomous best, then Driver best, then the higher second-best attempts, and so on."
    );
  });

  it("explains a type tab", () => {
    expect(skillsRuleSentence(t, "driver", TYPES, false)).toBe(
      "Each team's best Driver attempt. Ties go to the higher second-best attempt, and so on."
    );
  });

  it("adds the season sentence on the season page", () => {
    expect(skillsRuleSentence(t, "driver", TYPES, true)).toBe(
      "Each team's best Driver attempt. Ties go to the higher second-best attempt, and so on. Season scores come from the team's best session."
    );
  });
});
