---
name: Tournament Admin
description: The meet-day operations ledger — a plain, dense, laminated-clipboard admin desk for running head-to-head competition events.
colors:
  paper: "#faf7f1"
  paper-elevated: "#ffffff"
  paper-sunken: "#f1ece2"
  hairline: "#e1dacb"
  hairline-strong: "#c9bfa9"
  ink: "#211e19"
  ink-secondary: "#5b5548"
  ink-tertiary: "#8a8372"
  marker-amber: "#a8560a"
  marker-amber-hover: "#8c4708"
  amber-contrast: "#ffffff"
  status-success: "#2f7d4f"
  status-success-bg: "#e7f3ec"
  status-warning: "#8a6300"
  status-warning-bg: "#faf1d9"
  status-danger: "#b23b2e"
  status-danger-bg: "#fbeae7"
  selection: "#f6dcb8"
typography:
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 650
    lineHeight: 1.25
    letterSpacing: "-0.01em"
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "1.375rem"
    fontWeight: 650
    lineHeight: 1.25
    letterSpacing: "-0.01em"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: 1.4
rounded:
  sm: "4px"
  md: "6px"
spacing:
  1: "0.25rem"
  2: "0.5rem"
  3: "0.75rem"
  4: "1rem"
  5: "1.5rem"
  6: "2rem"
  7: "3rem"
components:
  button-primary:
    backgroundColor: "{colors.marker-amber}"
    textColor: "{colors.amber-contrast}"
    rounded: "{rounded.md}"
    padding: "0.5rem 1rem"
  button-primary-hover:
    backgroundColor: "{colors.marker-amber-hover}"
    textColor: "{colors.amber-contrast}"
    rounded: "{rounded.md}"
  button-secondary:
    backgroundColor: "{colors.paper-elevated}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0.5rem 1rem"
  button-danger:
    backgroundColor: "transparent"
    textColor: "{colors.status-danger}"
    rounded: "{rounded.md}"
    padding: "0.5rem 1rem"
  input:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0.5rem 0.75rem"
    height: "40px"
  badge-warning:
    backgroundColor: "{colors.status-warning-bg}"
    textColor: "{colors.status-warning}"
    rounded: "{rounded.sm}"
  badge-danger:
    backgroundColor: "{colors.status-danger-bg}"
    textColor: "{colors.status-danger}"
    rounded: "{rounded.sm}"
---

# Design System: Tournament Admin

## Overview

**Creative North Star: "The Laminated Clipboard"**

This is the meet-day operations desk, not a broadcast scoreboard. It refuses the flashy jumbotron/LED-scoreboard default that most "competition software" briefs reach for, in favor of the one trustworthy laminated clipboard at the check-in table: plain, dense, and legible under gym lighting. Warm off-white paper carries near-black ink text; a single marker/highlighter amber accent is spent only on primary actions and live/active state, never on decoration, links, or secondary buttons. The system-default sans is used throughout — no display face, no serif accent — because the tool's job is to disappear behind the data it holds.

An organizer scans a dense list, finds the one thing needing action, acts, and trusts the result saved. Nothing else competes for attention: no gradients, no drop shadows beyond a 1px hairline lift on the few genuinely floating surfaces (auth card, modal dialog), and radius is small and consistent (4-6px) rather than either sharp-cornered or bubbly.

**Key Characteristics:**
- Warm paper ground + near-black ink + one reserved amber accent
- One system-stack sans, tabular numerals on every numeric/data column
- Hairline (1px) borders and dividers; radius capped at 6px, never 0
- Flat at rest; shadow is reserved for two floating surfaces only (auth card, dialog)
- Left-rail nav on desktop, collapsing to a horizontal scroll strip under 720px

## Colors

A warm, low-saturation paper palette with exactly one chromatic accent; everything else is achromatic ink/paper plus semantic status colors.

### Primary
- **Marker Amber** (`#a8560a` light / `#e8912e` dark): the single accent. Used only for the primary button, the active/live nav-item label, focus rings, text-selection background, and the data grid's row-selection/checkbox accent. Never used for plain links, secondary buttons, or decoration.

### Neutral
- **Paper** (`#faf7f1` light / `#1b1815` dark): page background.
- **Paper Elevated** (`#ffffff` light / `#242019` dark): cards, panels, inputs' resting surfaces where they sit above the page, header bar.
- **Paper Sunken** (`#f1ece2` light / `#15130f` dark): the side-nav rail, hover state on rows/buttons, code/debug panel body.
- **Hairline** (`#e1dacb` light / `#3a342a` dark): default border/divider color.
- **Hairline Strong** (`#c9bfa9` light / `#4e463a` dark): input and button borders, where a slightly firmer edge is needed.
- **Ink** (`#211e19` light / `#f1ece2` dark): primary text, and — deliberately — the color of ordinary links (an ordinary link reads as underlined ink, not amber).
- **Ink Secondary** (`#5b5548` light / `#c9c2b2` dark): field labels, secondary/meta text.
- **Ink Tertiary** (`#8a8372` light / `#948c7a` dark): placeholder-level text, disabled-adjacent hints.

### Status
- **Success** (`#2f7d4f` light / `#4caf77` dark) on `#e7f3ec` / `#1c2f22` background.
- **Warning** (`#8a6300` light / `#d9a93b` dark) on `#faf1d9` / `#332a13` background. Darkened from an earlier `#b98900` draft, which read at 2.8:1 on its badge background — below the WCAG AA 4.5:1 floor this product requires; the recorded value is the one that ships.
- **Danger** (`#b23b2e` light / `#e2685a` dark) on `#fbeae7` / `#33201c` background.

### Named Rules
**The Reserved Amber Rule.** The accent exists in exactly one place per screen at most: the primary action or the thing that's live/active right now (an active nav item, a selected grid row). It never appears on a link, a secondary or danger button, or as a decorative fill — an earlier draft spent it on plain links and a secondary button and was corrected before ship.

**The AA Floor Rule.** Every text-on-background and control-on-background pairing that carries meaning (accent-on-white button labels, warning-on-badge-background text) clears 4.5:1. Two colors in this palette (`marker-amber`, `status-warning`) were darkened from their first-pass values specifically to clear this floor; the darkened values are the system, not the drafts.

## Typography

**Body Font:** System UI sans (`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`) — one stack, used for every role including headings.
**Mono Font:** System UI monospace (`ui-monospace, "SF Mono", "SFMono-Regular", Menlo, Consolas, monospace`) — timestamps and raw debug/log output only.

**Character:** A single, neutral system sans throughout — deliberately un-branded, so the interface reads as instrumentation rather than as a marketed product. Tabular numerals (`font-variant-numeric: tabular-nums`) are applied wherever numbers appear in a column: grid cells, list-row metadata, timestamps.

### Hierarchy
- **Headline** (650, 1.75rem, 1.25 line-height, -0.01em): page-level `h1`, one per route.
- **Title** (650, 1.375rem, 1.25 line-height, -0.01em): section headings (`h2`) inside a panel or dialog.
- **Body** (400, 1rem, 1.5 line-height): default running text and form values.
- **Label** (600, 0.875rem): field labels, nav-item text, button text.
- **Meta/Small** (400-600, 0.75rem): badges, small buttons, debug-panel timestamps — always paired with `tabular-nums` when the content is numeric.

### Named Rules
**The One Stack Rule.** No second (display or serif) font family exists anywhere in the shipped app. Headings are the same sans as body text, distinguished only by weight (650) and size — the clipboard doesn't get a masthead font.

## Layout

The desktop shell is a fixed 200px left-rail nav plus a flexible content column with generous internal padding (`--space-5`/`--space-6`, i.e. 24-32px) — dense tables and single-column forms both live in that same content column. Below 720px this is a structural collapse, not a fluid shrink: the rail becomes a horizontal, scrollable nav strip above the content, its edges masked with a fading gradient (not a hard clip) as a functional signal that more items exist off-screen in either direction, and content padding steps down to `--space-4` (16px). The spacing scale is a 7-step rem progression (4/8/12/16/24/32/48px) reused consistently for gaps, padding, and margins — no ad hoc pixel values.

## Elevation & Depth

Flat by default: panels, cards, list rows, and badges carry a 1px hairline border and no shadow at all. Shadow exists in exactly one form, reserved for the two surfaces that are genuinely floating above the page rather than sitting in the normal document flow: the auth-screen card and the modal dialog overlay.

### Shadow Vocabulary
- **Hairline lift** (`box-shadow: 0 1px 2px rgba(33, 30, 25, 0.08)`): the auth card and the dialog only. An earlier build used a heavier drop shadow here; it was capped to this hairline value before ship to match the contract's "no shadows beyond a 1px hairline lift" commitment.

### Named Rules
**The Hairline-Only Rule.** If a surface needs to read as "above" the page, the border gets a 1px hairline shadow — nothing softer, nothing larger, and nothing on a surface that's just sitting in-flow (ordinary panels and list rows get a border, never a shadow).

## Shapes

Radius is small and constant: 6px (`--radius`) on every panel, card, dialog, button, input, list row, and the data-grid frame; 4px (`--radius-sm`) on the smaller elements nested inside those (badges, the scrollbar thumb, focus-ring corner rounding). Radius is never 0 (the contract explicitly rules out sharp-cornered state marks) and never larger than 6px (rules out a bubbly, soft-app feel) — one step down from the panel it sits inside is the only variation permitted. Borders are always 1px hairline; there is no double-border or heavy-stroke treatment anywhere.

## Components

### Buttons
- **Shape:** 6px radius, 1px border, 40px min-height (32px for `.btn-small`).
- **Primary:** amber background (`#a8560a`/`#e8912e`), white/near-black contrast text depending on theme, amber-hover on hover. Reserved for the one primary action per view.
- **Secondary (default `.btn`):** paper-elevated background, ink text, hairline-strong border; hovers to paper-sunken. This is the button used everywhere a primary action isn't called for — never amber.
- **Danger:** transparent background, danger-colored border and text; fills with the danger-tinted background on hover. Used for destructive actions (e.g. the Divisions screen's Delete button).
- **Link (`.btn-link`):** no border/background, underlined ink text — a secondary inline action, deliberately not amber.

### Inputs / Fields
- **Style:** hairline-strong 1px border, 6px radius, paper background, 40px min-height.
- **Focus:** border shifts to amber; a global `:focus-visible` outline (2px amber, 2px offset) applies everywhere else that isn't a text input.
- **Hover:** border darkens to ink-tertiary.

### Badges
- **Style:** 4px radius, tinted background + matching text color (warning/danger/neutral roles), no border.

### Cards / Panels
- **Corner Style:** 6px radius.
- **Background:** paper-elevated.
- **Shadow Strategy:** none at rest (see Elevation & Depth) — only border.
- **Border:** 1px hairline.
- **Internal Padding:** `--space-5` (24px).

### Navigation
- **Style:** left rail (200px, paper-sunken background) on desktop; each item is label-weight (600) text at 14px, 6px-radius hit target.
- **Active state:** amber text + an inset 1px hairline box-shadow — the accent marks "where you are," not a filled background.
- **Mobile (≤720px):** the rail becomes a horizontal scrollable strip above the content, edge-masked to signal scrollability; the active item is guaranteed to scroll into view rather than being hideable off-strip.

### Data Grid (react-data-grid theme)
A themed instance of the shared grid component, not a custom-built table: header uses paper-sunken, rows use paper-elevated with paper-sunken hover, selection uses the selection-amber tint, and every cell inherits `tabular-nums`.

## Do's and Don'ts

### Do:
- **Do** reserve marker amber for the primary action and live/active state only (The Reserved Amber Rule).
- **Do** apply `tabular-nums` to every numeric column, badge, or timestamp.
- **Do** cap radius at 6px on containers and 4px on small elements nested inside them; never 0.
- **Do** confirm any new color pairing clears 4.5:1 contrast before shipping (The AA Floor Rule) — this system has already had to correct two colors for this once.

### Don't:
- **Don't** use a gradient anywhere in the UI.
- **Don't** add a shadow to a panel, card, list row, or badge sitting in normal document flow — shadow is reserved for the auth card and the dialog only.
- **Don't** spend the amber accent on a plain link or a secondary/tertiary button; links and secondary buttons stay ink-colored.
- **Don't** introduce a second font family (display or serif) for headings or any other role.
