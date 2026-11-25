# Finals: set-up, alliance selection and running — Design

**Status:** draft for owner review, 2026-11-24.
**Builds on:** `2026-08-31-finals-and-elimination-brackets-design.md` (the finals engine: brackets, byes, series, walkovers, score-chase runs, auto-advance on scoring), `2026-10-07-finalize-qualification-design.md` (finals need finalized qualification), the display screens and device pairing specs.

## 0. Project constraint

Never name any real-world competition brand or product anywhere in the repo, this document included. Describe behaviour in neutral terms ("partner picking", "head-to-head games").

## 1. Why

The server can already run finals, but the admin app has no way in. After qualification is finalized the Matches page says "Finals can now be generated", and there is nowhere to do it. Organisers need to go from the final rankings to finals match 1 on the day, quickly and without mistakes, and the audience needs to follow along.

The engine was also built ahead of the owner's real rules, and three of them differ (§3): teams get excluded before finals, partner picking has invite/accept/decline, and score-chase finals take an odd number of teams.

**Success:** the organiser reviews rankings, excludes teams, sets the finals up, runs partner picking with the teams tapping ACCEPT / DECLINE themselves while the audience watches, and starts finals match 1 in Match Control, with no API calls by hand.

## 2. The organiser's flow (owner's words, condensed)

1. Qualification ends and is finalized. The administrator reviews the rankings.
2. They exclude teams that won't take part in finals. Two reasons: **disqualified** (broke rules) or **left early**.
3. They choose how many teams go to finals (decided before the event or on the day). Examples: 16 of 31 (8 alliances), or all teams.
4. They choose how alliances form (head-to-head games only): **partner picking** (default for head-to-head) or **automatic pairs** (neighbours: 1+2, 3+4 …). Score-chase games always use automatic pairs.
5. They choose which fields finals use. Default: all the teamwork fields; they may untick some (e.g. a field was removed to make room).
6. Head-to-head: they choose games per round, each round single match or best X of Y. Commonly single matches throughout with a best-2-of-3 final; occasionally best 2 of 3 semis and best 3 of 5 final.
7. Partner picking runs (§5), or automatic pairs form at once.
8. The finals matches are created and finals match 1 starts in Match Control. Matches run exactly like any other match; winners advance, losers are out, through to the final.
9. Organisers may hand out awards between finals matches or all at the end, then thank everyone. **Awards on the TVs are a separate later piece**; finals just leaves the gaps.

## 3. Rules that change the existing engine

### 3.1 Exclusions
- Per finals set-up (session + division), the administrator can exclude any team with a reason: `disqualified` or `left_early`. Undo is allowed until finals start (alliances begin forming).
- Excluded teams are skipped everywhere: they can't be captains, can't be invited, and every team below moves up.
- Exclusion is separate from the existing per-match `dq`/`no_show` flags and does not change qualification rankings.

### 3.2 How many teams, and odd counts
The administrator enters a **team count** (with an "All teams" shortcut = every non-excluded ranked team). The page shows what it means in alliances.

- **Automatic pairs, knockout:** pairs form from the top: 1+2, 3+4, … over the first *count* non-excluded teams. An odd count drops the lowest-ranked of them (e.g. 31 → 30 teams, 15 alliances). The bracket rounds up to a power of two and top alliances get byes (existing engine: 15 alliances → 1 bye, 14 → 2).
- **Score-chase:** nobody is dropped. Pairs form from the **bottom** of the list: lowest + second-lowest, then upward. With an odd count the second-lowest team plays twice. 31 teams → runs 31+30, 30+29, 28+27, … , 2+1 (16 runs). With an even count it's plain pairs (30 → 30+29, … , 2+1). Runs go worst pair first, best pair last (existing engine order). A team may therefore belong to two finals alliances; the data model must allow that for score-chase.
- **Partner picking:** count ÷ 2 = number of alliances (captains). An odd count is rejected with a message ("partner picking needs an even number of teams"). *(Builder's call how to say it; the owner has not ruled on odd picking counts.)*

### 3.3 Partner picking with invite / accept / decline
Replaces the engine's strict "top-N captains pick in seed order" (which had no decline).

- **Captain:** the next captain is always the **highest-ranked non-excluded team not yet in an alliance**. There are no pre-assigned captain slots: if Captain 1 invites the team ranked 2 and it accepts, the next captain is rank 3.
- **Invite:** the captain may invite **any non-excluded team not yet in an alliance and that hasn't declined**, ranked anywhere (rank 29 can be invited when 16 teams go through). This includes teams that would be captains later.
- **One invite at a time.** While an invite is open nothing else can be invited.
- **Accept:** the pair becomes the next alliance. The alliance number is the order in which alliances form (first formed = Alliance 1), and that is its finals seed (Alliance 1 plays the lowest alliance).
- **Decline:** the team is marked declined. It can never be invited again by anyone. It **can** still become a captain when its turn comes and then invite whoever it likes. The same captain invites again.
- A team that declined and never reaches a captain turn is out of finals ("shot themselves in the foot"; the owner has seen it happen). No warning is needed.
- **Cancel invite:** the referee or admin can withdraw an open invite before it's answered (e.g. wrong team tapped). Nothing is recorded against either team.
- **Undo last step:** admin only. Reverses the most recent accept or decline (a cancelled invite leaves nothing to undo). Can be repeated step by step back to the start of picking. *(My call that cancel isn't an undoable step.)*
- Picking ends when the planned number of alliances exists. Then finals matches are created (bracket goes in progress).
- If there aren't enough teams left to fill the planned alliances (everyone declined), the admin is told and can end picking with fewer alliances. *(My call: offer "Finish with N alliances"; owner hasn't ruled.)*

### 3.4 Fields
- Finals use a chosen **subset of the fields in one teamwork field set**. Default: the division's teamwork field set with every field ticked. If the division has more than one teamwork field set, the admin picks the set first, then the fields. *(My call: Match Control, time-outs and TV groups all work per field set, so finals stay inside one set.)* The engine's round-robin runs over the ticked fields only.

### 3.5 Games per round
- Head-to-head only. One setting per round, named for the round (Round of 16, Quarter-finals, Semi-finals, Final). Choices: single match, best 2 of 3, best 3 of 5. Default: single matches, best 2 of 3 final. *(Defaults are my call from the owner's "most frequent" case.)*
- Maps to the engine's existing per-round `wins_to_advance` list.

## 4. Screens

Mockups (agreed): `.superpowers/brainstorm/2005043-1795566449/content/finals-setup-v2.html` and `picking.html`.

### 4.1 Admin: Finals page (one page, no wizard)
Reached from the session menu and from the "Finals can now be generated" message on the Matches page (which becomes a link). If qualification isn't finalized, the page says so and links to the Matches page (per the 10-07 spec §4.3).

- **Left — rankings** in rank order (rank, team, record) with an **Exclude…** action per team (choose reason) and Undo on excluded rows (struck through, reason in red).
  - The "Finals" column depends on the pairing style:
    - **Partner picking:** the first *n* non-excluded teams read **Captain 1 … Captain n**; every other non-excluded team reads **Can be invited**. No cut line.
    - **Automatic pairs / score-chase:** a green **cut line** after the last finalist; finalists show their alliance number; teams below read **Not in finals**; a team that moved up because of an exclusion says so.
- **Right — settings**, top to bottom: team count (+ All teams), pairing style (head-to-head only; default partner picking), fields (checkboxes), games per round (head-to-head only), then the button: **Start alliance selection** (partner picking) or **Create finals matches** / **Create finals runs**.
- Multi-division session: a division switcher at the top; each division's finals are set up separately. *(My call.)*
- Once finals exist, the page shows their state (selecting / in progress / complete) and a **Start over** (deletes the bracket; confirm; not allowed once complete — engine rule). While in progress, each alliance has **Can't play** (the engine's walkover; whole alliance forfeits).

### 4.2 Admin: alliance selection
- **Left:** alliances table (#, captain, partner). The current alliance is highlighted; an open invite reads "invited, waiting…". Under it: green **Accept**, red **Decline** (entered on the team's behalf), grey **Cancel invite**, and **↶ Undo last step** with "last: …".
- **Right:** teams that can be invited, in rank order, each with **Invite**. Declined teams are greyed and struck through. Invite is disabled while an invite is open.
- Live: the admin page, tablets and TV stay in step via the existing realtime channel.

### 4.3 Tablet: alliance selection mode
For a referee's or scorer's tablet. Two states:
- **(a) Captain chooses:** "Alliance 2 · Captain" with the captain's number large, "Who do you invite?", and a grid of invitable teams (rank order, declined struck through). Tapping one sends the invite.
- **(b) Invite pending:** "5521B invites" / the invited team's number very large / a huge green **ACCEPT** and a huge red **DECLINE** side by side, and a small **Cancel invite** for the referee. The invited team comes forward and taps.
- Tablets cannot undo.
- **In scope (owner, 2026-11-24).** There is no scorer/referee app yet (paired scorer devices show a placeholder home page); this is its first screen, kept simple because the full scorer app is the next piece of work after finals:
  - When picking starts, **every paired scorer or referee tablet switches to the picking screen on its own**, and returns to its home page when picking ends (or finals are started over).
  - **Any** of those tablets can invite, accept, decline or cancel. They all show the same live state.
  - Build the routing/shell so the coming scorer app can grow from it rather than replace it.

### 4.4 Audience TV: alliance selection screen
A new display screen type, assignable to TVs like the others.
- Title **ALLIANCE SELECTION**; the open invite at top right in amber ("5521B invites 6410A…").
- **Left:** alliances filling in (number, captain, partner); the pending one in amber with "?".
- **Right:** **AVAILABLE** teams **in rank order with their rank number** next to each (owner: students whose first choice declines use this to find a highly ranked team fast). Declined teams struck through.
- Sized by the TV readability rules (fit to screen, readable from the back of the room).

### 4.5 During finals
- Matches run in Match Control exactly as usual (timer, scoring, cues, TVs). The existing elimination bracket TV screen already shows both knockout brackets (with series wins) and score-chase standings.
- Engine behaviours kept: the next game is created the moment it's known; a tied knockout game doesn't count and another game is played; an alliance marked can't-play forfeits.
- **Order of best-of games across matchups (owner, 2026-11-24):** series in the same round **take turns** — semi 1 game 1, semi 2 game 1, semi 1 game 2, semi 2 game 2 … — so robots get recovery time. A decided series plays no more games; when only one series in a round is still going, its games run back to back. This changes the engine: it currently creates a series' next game as soon as the previous one is scored, so a series plays straight through. The next game must be created (or ordered) so Match Control's next match follows the turn order.

## 5. Non-goals
- Awards on TVs / award reveals (separate later piece).
- Double elimination; replacing a team inside a formed alliance; per-team unavailability within an alliance (engine §9 stays).
- Multi-division finals running concurrently on the same fields (engine §9).
- Any change to how qualification ranks are computed.

## 6. Anti-goals
- A wizard or multi-step flow for set-up.
- The TV or tablet ever disagreeing with the admin about whose turn it is or whether an invite is open.
- An exclusion or decline silently lost after a reload or a second admin tab.
- Any screen hiding the rank number of available teams during picking.

## 7. Left to the builder
- **Plugin contract** *(my call)*: `finals_format` stays fixed by the plugin. `alliance_selection` becomes the plugin's **default**: the admin may switch a head-to-head game between partner picking and automatic pairs; score-chase is always automatic pairs. Finals alliances stay exactly two teams (engine decision), whatever `teams_per_alliance` is.
- **Score-chase results** *(my call)*: ranked per run (per alliance), so a team that runs twice appears twice; no per-team rollup.
- **Start over** *(my call)*: exclusions belong to the session + division finals set-up and survive Start over (editable again once no bracket exists); the picking log, alliances and matches belong to the bracket and are deleted with it.
- API shape for exclusions, the new picking actions (invite, accept, decline, cancel, undo) and the field subset; data-model changes (captains no longer pre-created; a picking event log for undo; a team in two score-chase alliances). Update the plugin conformance tool if `match_format()` changes (e.g. `alliance_selection` becomes the default rather than fixed).
- Migration: edit the baseline migration in place (pre-release project convention).
- The en and zh strings for every new user-facing text.
- Tests per the repo policy: pytest unit + API integration for every rule in §3 (including the 31-team score-chase example, decline-then-captain, invite a lower captain, cancel, undo chains, exclusions moving teams up), and Playwright e2e for the set-up page, admin picking, the tablet flow (if in scope) and the audience TV.

## 8. Owner decisions from review (2026-11-24)
- Tablet picking mode is in this build (§4.3); the scorer app follows finals.
- Best-of series take turns across matchups in a round (§4.5).
