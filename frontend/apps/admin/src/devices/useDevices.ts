import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@tournament-admin/shared";

export type DeviceStatus = "active" | "idle" | "disabled";

export interface DeviceRead {
  id: number;
  name: string;
  role: string;
  status: DeviceStatus;
  paired_at: string;
  paired_by: string;
  last_seen_at: string;
  disabled_at: string | null;
}

export interface PairingCodeCheck {
  code: string;
  suggested_name: string;
  expires_at: string;
}

export const PAIRABLE_ROLES = ["scorer", "referee", "judge", "front_desk", "display_device"] as const;
export const DEVICES_KEY = ["devices"];
export const DEVICE_SETTINGS_KEY = ["devices", "settings"];

export function useDevices() {
  return useQuery({
    queryKey: DEVICES_KEY,
    queryFn: () => apiRequest<DeviceRead[]>("/api/devices"),
    refetchOnWindowFocus: true,
  });
}

export function useDeviceSettings() {
  return useQuery({
    queryKey: DEVICE_SETTINGS_KEY,
    queryFn: () => apiRequest<{ idle_minutes: number }>("/api/devices/settings"),
  });
}

export function useDeviceMutations() {
  const queryClient = useQueryClient();
  // Also refetches the settings (same ["devices", ...] prefix), so another
  // admin's idle change shows up too.
  const refresh = () => queryClient.invalidateQueries({ queryKey: DEVICES_KEY });
  return {
    pair: useMutation({
      mutationFn: (body: { code: string; role: string; name: string }) =>
        apiRequest<DeviceRead>("/api/devices/pair", { method: "POST", body }),
      onSuccess: refresh,
    }),
    update: useMutation({
      mutationFn: ({ id, ...body }: { id: number; name: string; role: string }) =>
        apiRequest<DeviceRead>(`/api/devices/${id}`, { method: "PATCH", body }),
      onSuccess: refresh,
    }),
    setEnabled: useMutation({
      mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
        apiRequest<DeviceRead>(`/api/devices/${id}/${enabled ? "enable" : "disable"}`, { method: "POST" }),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: (id: number) => apiRequest<void>(`/api/devices/${id}`, { method: "DELETE" }),
      onSuccess: refresh,
    }),
    saveSettings: useMutation({
      mutationFn: (idle_minutes: number) =>
        apiRequest<{ idle_minutes: number }>("/api/devices/settings", { method: "PUT", body: { idle_minutes } }),
      onSuccess: (data) => {
        queryClient.setQueryData(DEVICE_SETTINGS_KEY, data);
        // A new timeout can move devices between Active and Idle.
        return refresh();
      },
    }),
  };
}

export function checkPairingCode(code: string) {
  return apiRequest<PairingCodeCheck>(`/api/pairing/codes/${encodeURIComponent(code)}`);
}
