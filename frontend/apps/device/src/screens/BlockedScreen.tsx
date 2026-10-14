import { useTranslation } from "react-i18next";

export function BlockedScreen({ name }: { name: string }) {
  const { t } = useTranslation();
  return (
    <section className="blocked">
      <h1>{t("blocked.heading")}</h1>
      <p>{t("blocked.askAdmin", { name })}</p>
    </section>
  );
}
