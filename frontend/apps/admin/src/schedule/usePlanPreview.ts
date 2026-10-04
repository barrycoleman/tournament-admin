import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { apiRequest } from "@tournament-admin/shared";
import type { PlanRequest } from "./planDraft";
import type { PlanResponse } from "../types";

export interface PlanPreview {
  data: PlanResponse | undefined;
  error: unknown;
  /** True once the shown result answers the latest draft. */
  settled: boolean;
}

/**
 * Dry-runs the draft 400 ms after the last edit. Keyed by the request body,
 * so only the latest draft's answer is ever shown; the previous answer
 * stays (dimmed by the caller) while the next one is in flight.
 */
export function usePlanPreview(request: PlanRequest | null): PlanPreview {
  const key = request === null ? null : JSON.stringify(request);
  const [debouncedKey, setDebouncedKey] = useState(key);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedKey(key), 400);
    return () => clearTimeout(timer);
  }, [key]);
  const query = useQuery({
    queryKey: ["schedulePlan", debouncedKey],
    queryFn: () => apiRequest<PlanResponse>("/api/schedule", { method: "POST", body: JSON.parse(debouncedKey!) }),
    enabled: debouncedKey !== null,
    placeholderData: keepPreviousData,
    retry: false,
  });
  if (key === null) return { data: undefined, error: null, settled: false };
  return {
    data: query.data,
    error: query.isError ? query.error : null,
    settled: key === debouncedKey && !query.isFetching && !query.isPlaceholderData && query.isSuccess,
  };
}
