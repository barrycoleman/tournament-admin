/**
 * All E2E specs run against ONE backend process holding ONE event:
 * POST /api/event succeeds exactly once per run and 409s thereafter, so
 * whichever spec file happens to run first is the one that actually sets
 * the password. Every file must therefore agree on these values.
 * bootstrap.spec.ts is the intended creator (it tests the fresh-install
 * flow through the UI and runs first alphabetically); the other files
 * create-or-tolerate-409 purely so they can run standalone.
 */
export const E2E_EVENT_NAME = "Regional Qualifier";
export const E2E_EVENT_PASSWORD = "e2e-admin-pw";
