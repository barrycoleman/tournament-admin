import { useTranslation } from "react-i18next";
import { useEventInfo } from "../api";
import type { ScreenModule } from "../screenTypes";

function LogoScreen() {
  const { t } = useTranslation();
  const event = useEventInfo();
  return (
    <section className="screen logo-screen">
      <h1 className="logo-screen__name">{event.data ? event.data.name : t("display.waiting")}</h1>
    </section>
  );
}

export const logoScreen: ScreenModule = { key: "logo", scrolls: false, Component: LogoScreen };
