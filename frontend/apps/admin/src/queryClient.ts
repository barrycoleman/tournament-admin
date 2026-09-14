import { QueryCache, QueryClient } from "@tanstack/react-query";
import i18next from "i18next";
import { ApiError } from "@tournament-admin/shared";
import { showTransientError } from "./errorBanner";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
    },
  },
  queryCache: new QueryCache({
    onError: (error) => {
      showTransientError(
        error instanceof ApiError ? error.detail : i18next.t("errors.network")
      );
    },
  }),
});
