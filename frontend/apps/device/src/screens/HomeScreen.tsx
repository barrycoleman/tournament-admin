import { useTranslation } from "react-i18next";
import type { DeviceSelf } from "../deviceApi";

export function HomeScreen({ device }: { device: DeviceSelf }) {
  const { t } = useTranslation();
  return (
    <section className="home">
      <p className="home__label">{t("home.pairedAs")}</p>
      <h1 className="home__name">{device.name}</h1>
      <p className="home__role">
        {t(`roles.${device.role}`, { defaultValue: device.role })} · {t("home.ready")}
      </p>
    </section>
  );
}
