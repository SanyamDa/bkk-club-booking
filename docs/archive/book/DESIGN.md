# Book: Design System

**Personality:** a good concierge. Calm, precise and warm. Editorial rather than nightclub flyer. It has to feel trustworthy enough to pay ฿10,000 on, and venue owners should be proud to put their logo next to it.

**Screen mockups:** https://claude.ai/artifact/4LN3Vx31L5axwtQ8Dh35pu (Discover → Venue → Table → Checkout → Pass, clickable). The pass screen deliberately switches to the dark theme: it's the one ceremonial moment, and it's shown at a dark door.

**Must not resemble:** Tabu (dark brown + gold + serif hero), or Pulse (see `apps/pulse/DESIGN.md`). Book is **light-first** with a single sharp accent.

## 1. Principles

1. **Venues are the colour.** Photography carries the mood. The UI chrome stays quiet: paper, ink, one accent.
2. **Prices are never ambiguous.** Every number shows what it includes. Tabular figures, right-aligned, totals in bold.
3. **One primary action per screen.** If two buttons fight for attention, one of them becomes a link.
4. **Show uncertainty honestly.** Forecasts always carry a confidence indicator.
5. **Thai is a first-class script.** Every type choice is checked in Thai at the same sizes. Thai needs more line height.

## 2. Color tokens

Light theme (default):

| Token | Hex | Use |
|---|---|---|
| `--paper` | `#F6F3EC` | App background (warm off-white, not pure white) |
| `--surface` | `#FFFFFF` | Cards, sheets, inputs |
| `--ink` | `#16150F` | Primary text, primary button background |
| `--ink-2` | `#55524A` | Secondary text |
| `--ink-3` | `#6F6B61` | Tertiary text, placeholders (darkened from #8C887D to pass 4.5:1 on paper) |
| `--line` | `#E3DED2` | Borders, dividers |
| `--accent` | `#C8361D` | "Chili" vermilion. Selected states, key highlights, focus ring. Max ~5% of any screen |
| `--accent-ink` | `#FFFFFF` | Text on accent |
| `--success` | `#2F7A4B` | Confirmed, checked in |
| `--warning` | `#B7791F` | Hold expiring, low availability |
| `--danger` | `#B42318` | Errors, cancellations |
| `--forecast-1..5` | `#E9E4D8` `#D8C9A8` `#C79A5B` `#B5652F` `#8E2F17` | Busyness ramp (quiet → packed), always paired with a text label |

Dark theme (dashboard night mode, door app):

| Token | Hex |
|---|---|
| `--paper` | `#121110` |
| `--surface` | `#1C1A17` |
| `--ink` | `#F3EFE6` |
| `--ink-2` | `#B3AEA3` |
| `--line` | `#2E2B26` |
| `--accent` | `#E2563B` |

Contrast: every text/background pair ≥ 4.5:1. `--accent` on `--paper` is used for large text and icons only.

**Banned:** gradients on UI chrome, glassmorphism, drop shadows bigger than `0 1px 2px` + `0 4px 16px rgba(22,21,15,.06)`, purple anywhere.

## 3. Typography

| Role | Latin | Thai | Notes |
|---|---|---|---|
| Display (venue names, hero) | **Fraunces** (opsz 72, wght 500, SOFT 50) | **Noto Serif Thai** 500 | Used sparingly; never for UI labels |
| UI and body | **IBM Plex Sans** | **IBM Plex Sans Thai** | Matched families, so Thai and Latin sit on the same rhythm |
| Numbers / prices | IBM Plex Sans with `font-variant-numeric: tabular-nums` | same | |
| Code / ids (dashboard only) | IBM Plex Mono | — | Booking refs, payout ids |

Scale (rem, 16px base, 1.25 ratio): `0.75 / 0.875 / 1 / 1.25 / 1.563 / 1.953 / 2.441 / 3.052`.
Line height: Latin body 1.5, **Thai body 1.7**, display 1.1.
Letter-spacing: display −0.02em; all-caps labels +0.08em at 0.75rem (Latin only; never all-caps Thai).

## 4. Spacing, radius, elevation

- Spacing: 4px base. Tokens `space-1…12` = 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96.
- Radius: `--r-sm 6px` (inputs, chips), `--r-md 10px` (cards), `--r-lg 16px` (sheets, images). Buttons 10px, **not pills**.
- Elevation: 0 (flat with border), 1 (cards on hover), 2 (sheets/modals). Nothing higher.
- Grid: 12-col, max content width 1200px; venue page uses 7/5 split (media/booking) on desktop, single column under 900px.

## 5. Core components

| Component | Spec |
|---|---|
| **Button** | Primary: ink bg, paper text, 48px tall on mobile / 40px desktop. Secondary: surface bg + line border. Tertiary: text with underline on hover. Loading state keeps width. |
| **Venue card** | 4:5 image, name in Fraunces 1.25rem, meta line (area · type · price band) in ink-2, forecast chip bottom-left on image |
| **Forecast chip** | Pill on image: dot in ramp colour + label ("Busy after 00:30"). Low confidence means no chip at all, not a grey one |
| **Forecast strip** | 18:00–04:00 hourly bars in the ramp, P10–P90 shown as a lighter band, "now" marker, caption with sample basis |
| **Floor plan** | SVG. Tables are shapes with capacity and min spend. States: available (surface + ink border), selected (accent fill), held by others (hatched), sold (ink-3 fill). Pinch zoom on mobile. Also has a list view for accessibility |
| **Price breakdown** | Two-column table, tabular numerals, total row bold with top rule; "Due now" highlighted in a bordered box |
| **Hold timer** | Inline bar under the header, turns `--warning` under 2 minutes |
| **QR pass** | Full-bleed white card, max brightness hint, venue name, night, party, table, booking ref in mono |
| **Dashboard table** | Dense (40px rows), sticky header, row status as a left 3px colour bar, not as background fills |

Icons: **Phosphor** (regular weight, 1.5px look), 20/24px. No emoji in UI.

## 6. Motion

- Durations: 120ms (hover/press), 200ms (sheets, chips), 320ms (page transitions).
- Easing: `cubic-bezier(.2,.8,.2,1)`.
- Respect `prefers-reduced-motion`: no parallax, fades only.
- No confetti. Confirmation gets a single check-mark draw and a haptic on mobile.

## 7. Voice

- Short and specific: "Table for 6 · min spend ฿10,000", not "Amazing VIP experience!"
- Thai copy is written natively, not machine-translated. A native copywriter reviews every release.
- Numbers over adjectives: "Usually packed by 01:00", not "Super lit!!"

## 8. How to keep it from looking vibe-coded

- Tokens live in `packages/tokens-book` and are the **only** source of colours, spacing and type. Lint fails on raw hex values or arbitrary Tailwind values in app code.
- Components live in `packages/ui-book` with Storybook. Visual regression (Chromatic or Playwright screenshots) runs on every PR.
- Real photography only. No AI-generated venue imagery, no stock "party crowd" photos.
- Every screen is designed in Figma before it's built. The Figma variables mirror the token names 1:1.
- Default shadcn/Tailwind styles are a starting point to restyle, never the finished look.
