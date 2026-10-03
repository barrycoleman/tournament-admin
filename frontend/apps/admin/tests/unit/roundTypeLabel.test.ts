import { describe, expect, it } from "vitest";
import { initI18n } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import zhAdmin from "../../src/i18n/zh/admin.json";
import { roundTypeLabel } from "../../src/roundTypeLabel";

const i18n = initI18n({ en: { translation: enAdmin }, zh: { translation: zhAdmin } });

describe("roundTypeLabel", () => {
  it("translates the standard round types", async () => {
    await i18n.changeLanguage("en");
    expect(roundTypeLabel(i18n.t, "practice")).toBe("Practice");
    expect(roundTypeLabel(i18n.t, "qualification")).toBe("Qualification");
    expect(roundTypeLabel(i18n.t, "elimination")).toBe("Elimination");
  });

  it("uses the Chinese labels when the language is Chinese", async () => {
    await i18n.changeLanguage("zh");
    expect(roundTypeLabel(i18n.t, "qualification")).toBe("资格赛");
    await i18n.changeLanguage("en");
  });

  it("capitalizes a round type a plugin invents", async () => {
    await i18n.changeLanguage("en");
    expect(roundTypeLabel(i18n.t, "seeding")).toBe("Seeding");
    expect(roundTypeLabel(i18n.t, "round_robin")).toBe("Round robin");
  });
});
