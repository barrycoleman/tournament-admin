# P5fix report
Rule: wait only while sessions are loading; loaded session with timezone null formats in UTC labeled " UTC".
Changes: useSessionTimeZone returns undefined (loading) / null (no zone) / zone; guards in schedule, upcomingMatches, MatchSchedulePanel, eliminationBracket use `=== undefined`; shared formatTime uses `timeZone ?? "UTC"` and appends " UTC" when null (only device callers).
RED: `npx vitest run tests/unit/listScreens.test.tsx` -> 2 new null-zone tests failed (Schedule, Upcoming Matches stuck waiting); loading-wait test passed already (kept as guard).
GREEN: device vitest 93 passed; shared vitest 55 passed; `npx tsc -b` clean; displays.spec.ts 8 passed (its reload workaround left as is).
