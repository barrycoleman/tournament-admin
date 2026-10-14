import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDeviceSession } from "./useDeviceSession";
import { useDeviceSocket } from "./useDeviceSocket";
import { PairingScreen } from "./screens/PairingScreen";
import { HomeScreen } from "./screens/HomeScreen";
import { BlockedScreen } from "./screens/BlockedScreen";

export function App() {
  const { t } = useTranslation();
  const session = useDeviceSession();
  const [pairingReachable, setPairingReachable] = useState(true);
  const onReachability = useCallback((reachable: boolean) => setPairingReachable(reachable), []);
  useDeviceSocket(session.screen.kind === "home" ? session.accessToken : null, session.recheck);

  const unreachable = session.screen.kind === "pairing" ? !pairingReachable : session.unreachable;
  const { screen } = session;

  return (
    <main className="device-screen">
      {unreachable && (
        <p className="device-banner" role="status">
          {t("unreachable")}
        </p>
      )}
      {screen.kind === "loading" && <p className="device-connecting">{t("connecting")}</p>}
      {screen.kind === "pairing" && <PairingScreen onPaired={session.paired} onReachability={onReachability} />}
      {screen.kind === "home" && <HomeScreen device={screen.device} />}
      {screen.kind === "blocked" && <BlockedScreen name={screen.name} />}
    </main>
  );
}
