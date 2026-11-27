# Pulse: Design System

**Personality:** a live instrument for the night. Fast, honest, a little playful. It reads like a weather radar for nightlife, not a party flyer.

**Screen mockups:** https://claude.ai/artifact/4LN3Vx31L5axwtQ8Dh35pu (Tonight → Live venue → Report, clickable; the report flow works end to end).

**Must not resemble:** Book (light, editorial, serif, vermilion) or Tabu (brown/gold luxury). Pulse is **dark-first**, sans-only, and its colour comes from **data**, not decoration.

## 1. Principles

1. **The meter is the brand.** The heat scale is the only strong colour in the app. When everything is calm, the UI is near-monochrome.
2. **Glanceable in a dark room at arm's length.** Huge numbers and labels, high contrast, no thin type.
3. **Thumb first.** All primary actions sit in the bottom 40% of the screen.
4. **Freshness is always visible.** Every live value shows how old it is.
5. **Honest about thin data.** Few reports means a visibly "faded" state, never a confident colour.

## 2. Color tokens

Base (dark default):

| Token | Hex | Use |
|---|---|---|
| `--bg` | `#0A0B0F` | App background (blue-black, not pure black, to avoid OLED smear) |
| `--surface` | `#14161C` | Cards, sheets |
| `--surface-2` | `#1D2029` | Raised elements, inputs |
| `--text` | `#F2F3F5` | Primary text |
| `--text-2` | `#A2A7B3` | Secondary |
| `--text-3` | `#858B9A` | Tertiary, timestamps (lightened from #6A7080 to pass 4.5:1 on bg) |
| `--line` | `#262A35` | Dividers |
| `--signal` | `#C6F432` | "Acid lime" brand accent: report button, active tab, verification tick. Nothing else |
| `--signal-ink` | `#0A0B0F` | Text on signal |
| `--danger` | `#FF5A52` | |

**Heat scale** (5 steps, derived from the perceptually uniform *inferno* colormap, so it stays readable for colour-vision deficiencies because lightness increases monotonically):

| Level | Club label | Token | Hex |
|---|---|---|---|
| 1 | Dead | `--heat-1` | `#2A2F45` |
| 2 | Warming up | `--heat-2` | `#6B2C6E` |
| 3 | Good | `--heat-3` | `#C13A54` |
| 4 | Lit | `--heat-4` | `#F2702B` |
| 5 | Peak | `--heat-5` | `#FBD24A` |

- Low-confidence state: the same hue at 35% opacity with a dashed outline, plus the label "Few reports".
- Labels per venue type map onto the same 5 steps (e.g. Restaurant crowd: Empty → Rammed).
- Light theme exists for daytime and accessibility; heat values remain identical, only base tokens invert (`--bg #F5F6F8`, `--text #0A0B0F`).

**Banned:** gradient backgrounds, neon glow on text, glassmorphism, purple-to-pink hero gradients. The heat scale only appears where it encodes a value.

## 3. Typography

| Role | Font (Thai + Latin in one family) | Weight |
|---|---|---|
| Display / meter numbers | **Bai Jamjuree** (Cadson Demak) | 600–700 |
| UI / body | **Anuphan** (Cadson Demak) | 400 / 500 / 600 |
| Numerals | Bai Jamjuree with tabular figures | 600 |

Both families are Thai-designed and cover Latin, so the app has one consistent voice across languages. Both are on Google Fonts.

Scale (px, mobile): `12 / 14 / 16 / 18 / 22 / 28 / 36 / 56 / 88`. The meter label on the venue screen is 56px; the hero number is 88px.
Line height: Latin 1.35, Thai 1.6. Minimum body size 16px (night use).

## 4. Layout and shape

- 4px grid. Screen padding 20px. Bottom safe-area aware.
- Radius: 14px cards, 24px bottom sheets, report button is a 60px-tall **pill labelled "I'm here"** in `--signal` (a labelled pill beat a bare icon circle: first-time users know what it does).
- No elevation shadows on dark. Use surface steps and 1px `--line` borders.
- Map: custom dark style (Mapbox) with roads at `--line`, labels `--text-3`, and venues as heat-coloured dots sized by report count.

## 5. Signature components

| Component | Spec |
|---|---|
| **Live Meter** | Half-ring gauge, 5 segments in heat colours. Filled up to the current level, label underneath in display type, "Updated 6 min ago · 10+ people" in `--text-3`. Animates on new data (240ms, segment-by-segment) |
| **Tonight curve** | Hourly area chart 20:00–04:00. Solid line for live past, dotted for forecast, faint band for uncertainty, "Now" vertical line in `--signal` |
| **Report sheet** | Step 1: big 5-option energy/crowd row (72px tiles, colour + label). Step 2: 1–2 type-specific questions. Step 3: optional photo, then submit. Progress dots on top. Every option is one tap with no confirm buttons until the end |
| **Venue row** | Left: 44px heat square showing the level number. Middle: name / area · type. Right: freshness ("6m") |
| **Share card** | 1080×1920 story card: venue name, meter, time, area, small brand mark. Built to be posted |
| **Verified tick** | Lime check beside reports filed on-site |

Icons: **Lucide** at stroke 2 (heavier for dark rooms), 24px. No emoji in system UI. Emoji are allowed only in user-chosen music chips.

## 6. Motion and haptics

- 160ms for taps, 240ms for meter changes, spring (`damping 18, stiffness 220`) for sheets.
- Haptics: light on option select, success notification on submit.
- Live pulse: the venue dot on the map breathes slowly (2s) only if a report arrived within 10 min. Respects reduced motion.

## 7. Voice

- Night-out-friend tone, short: "Peak. Line's ~15 min." / "Dead right now, usually picks up after 00:30."
- Never hype a venue. The app reports, it doesn't sell. No "You HAVE to go here!"
- Thai copy uses natural spoken register, reviewed by native speakers in the target crowd.

## 8. Anti-vibe-code guardrails

- Tokens only, from `packages/tokens-pulse`. Raw hex values in app code fail lint.
- Component library in `packages/ui-pulse` with Storybook (React Native Web) and screenshot tests.
- Designs are tested in a dark room on a real mid-range Android at 30% brightness before sign-off.
- The heat scale is checked with a colour-blindness simulator every time it changes.
