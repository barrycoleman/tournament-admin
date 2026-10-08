import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { ScoresheetTranslate } from "@tournament-admin/shared";

/** The admin app's translations, in the shape the shared scoresheet wants. */
export function useScoresheetT(): ScoresheetTranslate {
  const { t } = useTranslation();
  return useCallback((key: string, options?: Record<string, unknown>) => String(t(key, options)), [t]);
}
