import { describe, expect, it } from "vitest";
import { initI18n } from "../src/i18n";

describe("initI18n", () => {
  it("initializes react-i18next with the given resources and translates by key", async () => {
    const i18n = initI18n({
      en: { translation: { greeting: "Hello" } },
      zh: { translation: { greeting: "你好" } },
    });

    expect(i18n.t("greeting")).toBe("Hello");

    await i18n.changeLanguage("zh");
    expect(i18n.t("greeting")).toBe("你好");
  });
});
