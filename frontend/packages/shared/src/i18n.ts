import i18next, { type Resource } from "i18next";
import { initReactI18next } from "react-i18next";

export function initI18n(
  resources: Resource,
  options?: { lng?: string }
): typeof i18next {
  if (!i18next.isInitialized) {
    void i18next.use(initReactI18next).init({
      resources,
      lng: options?.lng ?? "en",
      fallbackLng: "en",
      interpolation: { escapeValue: false },
    });
  }
  return i18next;
}
