import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider, ServerClockContext, useServerClockOffset } from "@tournament-admin/shared";
import "./i18nSetup";
import "./styles/tokens.css";
import "./styles/components.css";
import { router } from "./router";
import { queryClient } from "./queryClient";

/** Gives every page the server's clock offset: measured on load, then every
 * 10 minutes, so operator sounds cue on server time. */
function ServerClock({ children }: { children: React.ReactNode }) {
  const offset = useServerClockOffset(null);
  return <ServerClockContext.Provider value={offset}>{children}</ServerClockContext.Provider>;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ServerClock>
          <RouterProvider router={router} />
        </ServerClock>
      </AuthProvider>
    </QueryClientProvider>
  </React.StrictMode>
);
