/**
 * Where an admin lands after signing in: "/" shows the setup checklist until
 * the event has a game, teams and a session, and then redirects to a
 * session's Today tab. Which one a spec sees depends on what earlier specs
 * (or its own setup) created, so login helpers accept either.
 */
export const ADMIN_LANDING = /\/(sessions\/\d+\/today)?$/;
