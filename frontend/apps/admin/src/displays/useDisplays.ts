import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, useRealtimeChannel, type RotationEntry, type ScreenSettings } from "@tournament-admin/shared";
import type { DisplaysRead } from "./types";

export function useDisplays(sessionId: number | null) {
  const queryClient = useQueryClient();
  useRealtimeChannel({
    path: "/ws/active-session",
    onEvent: (event) => {
      if (event.event === "display_changed" || event.event === "devices_changed") {
        void queryClient.invalidateQueries({ queryKey: ["displays"] });
      }
    },
  });
  return useQuery({
    queryKey: ["displays", sessionId],
    queryFn: () => apiRequest<DisplaysRead>(`/api/displays?session_id=${sessionId}`),
    enabled: sessionId !== null,
  });
}

export interface UnplacedDisplay {
  device_id: number;
  device_name: string;
  source_group_name: string;
}

export function useDisplayMutations(sessionId: number | null) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["displays"] });
  return {
    createPit: useMutation({
      mutationFn: (body: { name: string; division_id: number | null }) =>
        apiRequest("/api/displays/pit-groups", {
          method: "POST",
          body: { session_id: sessionId, ...body },
        }),
      onSuccess: refresh,
    }),
    updateGroup: useMutation({
      mutationFn: ({
        groupId,
        ...body
      }: {
        groupId: number;
        screen?: string;
        screen_settings?: ScreenSettings;
        rotation?: RotationEntry[] | null;
        division_id?: number | null;
        play_sounds?: boolean;
      }) =>
        apiRequest(`/api/displays/groups/${groupId}`, {
          method: "PATCH",
          body,
        }),
      onSuccess: refresh,
    }),
    deleteGroup: useMutation({
      mutationFn: (groupId: number) => apiRequest(`/api/displays/groups/${groupId}`, { method: "DELETE" }),
      onSuccess: refresh,
    }),
    assign: useMutation({
      mutationFn: ({ deviceId, groupId }: { deviceId: number; groupId: number | null }) =>
        apiRequest<DisplaysRead>("/api/displays/assignments", {
          method: "PUT",
          body: {
            session_id: sessionId,
            device_id: deviceId,
            group_id: groupId,
          },
        }),
      onSuccess: refresh,
    }),
    identify: useMutation({
      mutationFn: (deviceId: number) => apiRequest(`/api/displays/${deviceId}/identify`, { method: "POST" }),
    }),
    copy: useMutation({
      mutationFn: (sourceSessionId: number) =>
        apiRequest<{ unplaced: UnplacedDisplay[] }>(`/api/sessions/${sessionId}/copy-displays`, {
          method: "POST",
          body: { source_session_id: sourceSessionId },
        }),
      onSuccess: refresh,
    }),
  };
}
