import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { handleSkillsEvent } from "../../src/skills/liveUpdates";

describe("handleSkillsEvent", () => {
  it("invalidates only the named session's attempts and the rankings on skills_changed", () => {
    const queryClient = new QueryClient();
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    handleSkillsEvent(queryClient, { event: "skills_changed", data: { session_id: 1 } });
    const keys = spy.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey));
    expect(keys).toContain(JSON.stringify(["skillsRankings"]));
    expect(keys).toHaveLength(2);
    expect(keys.some((key) => key.includes("1"))).toBe(true);
  });

  it("invalidates the settings on skills_settings_changed", () => {
    const queryClient = new QueryClient();
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    handleSkillsEvent(queryClient, { event: "skills_settings_changed", data: {} });
    const keys = spy.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey));
    expect(keys).toContain(JSON.stringify(["skillsSettings"]));
  });
});
