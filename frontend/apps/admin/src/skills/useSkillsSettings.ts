import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@tournament-admin/shared";
import type { SkillsSettingsRead } from "../types";

export const SKILLS_SETTINGS_KEY = ["skillsSettings"];

/** Whether skills run, each type's allowed attempts, and the plugin's types (in priority order). */
export function useSkillsSettings() {
  return useQuery({
    queryKey: SKILLS_SETTINGS_KEY,
    queryFn: () => apiRequest<SkillsSettingsRead>("/api/skills/settings"),
  });
}
