import { describe, expect, it } from "vitest";
import enAdmin from "../../src/i18n/en/admin.json";
import zhAdmin from "../../src/i18n/zh/admin.json";

/** Every key the shared scoring components translate (and the scoresheet's counter buttons). */
const KEYS = [
  ..."loading offline reconnecting error changedBy scoreSoFar sharedSheet alliances noShow dq submit submitting submitAnyway violationsHeading savedHeading gone missingHeading missingOne missingMany saveZero allianceFallback".split(" ").map((k) => `scoring.${k}`),
  ...["red", "blue"].map((k) => `scoring.station.${k}`),
  ...["not_started", "countdown_autonomous", "autonomous", "awaiting_driver", "countdown_driver", "driver", "ended"].map((k) => `scoring.phase.${k}`),
  ..."heading start startDriver pause resume end endHeading endNow reset resetHeading resetSegment resetMatch resetWarning cancel paused".split(" ").map((k) => `scoring.clock.${k}`),
  ..."noRun gone saved fieldTimer setTimer followsSet alone discard discardHeading discardNow endFieldHeading resetFieldHeading endSetHeading resetSetHeading setAffects".split(" ").map((k) => `scoring.skills.${k}`),
  ...["ready", "running", "ended"].map((k) => `scoring.skills.phase.${k}`),
  "scoresheet.increase",
  "scoresheet.decrease",
];

function lookup(tree: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], tree);
}

describe("scoring translations", () => {
  for (const [name, tree] of [["en", enAdmin], ["zh", zhAdmin]] as const) {
    it(`${name} has every key the shared scoring components use`, () => {
      const missing = KEYS.filter((key) => typeof lookup(tree, key) !== "string" || lookup(tree, key) === "");
      expect(missing).toEqual([]);
    });
  }
});
