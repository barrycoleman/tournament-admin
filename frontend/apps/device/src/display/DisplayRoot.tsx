import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMe } from "./api";
import { useLiveEvents } from "./events";
import { GroupView } from "./GroupView";
import { ServerClockContext, useServerClockOffset } from "./serverClock";
import { useLiveRefresh } from "./useLiveRefresh";

export const IDENTIFY_MS = 10_000;

function NameScreen({ name, text }: { name: string; text: string }) {
  return (
    <section className="screen name-screen">
      <h1 className="name-screen__name">{name}</h1>
      <p className="name-screen__text">{text}</p>
    </section>
  );
}

export function DisplayRoot({ deviceName, unreachable }: { deviceName: string; unreachable: boolean }) {
  const { t } = useTranslation();
  const opens = useLiveRefresh();
  const offset = useServerClockOffset(opens);
  const me = useMe();
  const [identifyUntil, setIdentifyUntil] = useState(0);
  useLiveEvents(["display_identify"], () => setIdentifyUntil(Date.now() + IDENTIFY_MS));
  useEffect(() => {
    if (identifyUntil === 0) return undefined;
    const id = setTimeout(() => setIdentifyUntil(0), Math.max(0, identifyUntil - Date.now()));
    return () => clearTimeout(id);
  }, [identifyUntil]);

  const data = me.data;
  let body;
  if (!data) body = <NameScreen name={deviceName} text={t("connecting")} />;
  else if (data.session_id === null) body = <NameScreen name={data.device.name} text={t("display.noSession")} />;
  else if (data.group === null) body = <NameScreen name={data.device.name} text={t("display.notSetUp")} />;
  else body = <GroupView me={{ ...data, session_id: data.session_id, group: data.group }} />;

  return (
    <ServerClockContext.Provider value={offset}>
      <div className="display">
        {body}
        {identifyUntil > 0 && (
          <div className="identify" data-testid="identify">
            {data?.device.name ?? deviceName}
          </div>
        )}
        {unreachable && (
          <p className="display-badge" role="status">
            {t("display.reconnecting")}
          </p>
        )}
      </div>
    </ServerClockContext.Provider>
  );
}
