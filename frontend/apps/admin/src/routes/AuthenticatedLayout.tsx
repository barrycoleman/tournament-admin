import { Navigate } from "react-router-dom";
import { hasValidTokens, useAuth } from "@tournament-admin/shared";
import { AppShell } from "../components/AppShell";

export function AuthenticatedLayout() {
  // `isAuthenticated` comes from context so this guard re-evaluates when
  // auth state changes *while the shell is mounted* — an explicit logout,
  // or a silent refresh that failed. `hasValidTokens()` alone is a
  // context-free snapshot (it exists for router loaders, outside the React
  // tree); reading it without subscribing to the provider would leave a
  // logged-out user sitting on the dashboard until they navigated by hand.
  // Both are checked: storage can also be cleared out of band, e.g. by a
  // logout in another tab.
  const { isAuthenticated } = useAuth();

  if (!isAuthenticated || !hasValidTokens()) {
    return <Navigate to="/login" replace />;
  }
  return <AppShell />;
}
