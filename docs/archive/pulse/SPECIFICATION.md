# Pulse: Product Specification

Codename **Pulse**. A free, independent consumer app: *how is it right now, and how will it be tonight?* Data is self-reported by people physically at the venue.

Public positioning: an independent, crowd-powered guide. No booking, no venue payments, no sponsored ratings. That independence is why anyone trusts it.

## 1. Core loop

```
Open app → see live map/list → go somewhere → get a nudge on arrival (geofence)
  → report in 3 taps (<10s) → unlock full live detail + earn points → share a venue card to LINE/IG
```

**Give-to-get:** everyone sees the summary (meter + label). Detailed breakdowns (wait time, door strictness, music now, hourly curve) unlock for 24 hours after you file a verified report, or with a streak.

## 2. What people report, by venue type

Every report has the same core plus type-specific questions. Each question is **one tap** on a 3–5 option scale with plain labels. No sliders and no free text in the core flow.

### Core (all venues)
| Field | Options |
|---|---|
| Crowd | Empty · Quiet · Comfortable · Busy · Rammed |
| Wait to get in / seated | None · <10 min · 10–30 · 30+ |

### Club
| Field | Options |
|---|---|
| **Energy (the "lit" meter)** | Dead · Warming up · Good · Lit · Peak |
| Door | Walk in · Some checks · Strict · Turning people away |
| Music now | Tag chips (house, techno, hip hop, EDM, Thai pop, open format, live act) |
| Cover tonight | Free · Paid (amount optional) |
| Crowd mix | Mostly locals · Mixed · Mostly tourists |

### Bar
| Energy | Chill · Social · Lively · Loud |
| Seats | Easy · Some · Standing only |
| Music | chips |

### Restaurant
| Wait for table | (core) |
| Noise | Quiet · Conversational · Loud |
| Service speed | Fast · Normal · Slow |
| Walk-in friendly | Yes · Bar seats only · Reservation only |

### Rooftop (more than just "crowded")
| Field | Options | Why it matters |
|---|---|---|
| View tables free? | Many · A few · None | The whole point of a rooftop is the edge seat |
| Visibility | Clear · Hazy · Smoggy | PM2.5 season (Jan–Apr) can wipe out the skyline |
| Weather on deck | Fine · Windy · Raining · Closed for weather | Open decks shut in the rainy season (May–Oct) |
| Lift/queue to go up | None · Short · Long | Rooftop lines are usually at the lobby lift |
| Dress code enforced | Relaxed · Checked · Strict | Shorts and sandals get turned away at many rooftops |
| Vibe | Sunset chill · Dinner · Party/DJ | |
| Crowd mix | Locals · Mixed · Tourists | |

**Auto-filled, not crowdsourced** (shown on rooftop pages): sunset time, current weather and rain radar, AQI/PM2.5 from a public air-quality API, min-spend and drink price band from the venue catalog.

## 3. Trust and anti-gaming

Bad data kills this product, so trust is a core feature, not a backlog item.

| Mechanism | Rule |
|---|---|
| **On-site verification** | A report counts at full weight only if foreground location is within the venue geofence (default 80m; tall buildings use the building footprint). Off-site reports are rejected, not down-weighted |
| **Rate limits** | 1 report per venue per 30 min per user; max 6 venues per night |
| **Recency decay** | Weight halves every ~20 min; reports older than 90 min don't count toward "live" |
| **Trust score** | New accounts start at 0.5. Agreement with the consensus raises it, persistent outliers lower it. Phone or LINE verification required to report |
| **Device integrity** | App Attest / Play Integrity token on every report submission. Emulator and rooted-device reports are flagged |
| **Collusion detection** | Clusters of new accounts reporting the same venue from the same device or network are flagged and down-weighted |
| **Venue staff** | Self-declared staff can't report on their own venue. Accounts whose location pattern matches a venue every night are flagged |
| **Integrity policy (public)** | Venues cannot pay to change ratings. Published on the website and enforced in code: Pulse has no access to booking or commercial data |

## 4. Screens

1. **Tonight (home):** map + list toggle. Sorted by "best right now" for the selected type. Each row shows name, area, meter, "updated 6 min ago", and the number of recent reporters shown as a range ("10+").
2. **Venue:** big live meter, then type-specific breakdown (gated), tonight's curve (live so far + forecast for the rest of the night), usual pattern by weekday, recent photos (24h, moderated), "Share" card.
3. **Report:** bottom sheet, 3 steps maximum, big thumb targets, works one-handed in the dark. Optional photo or 5-second clip. Haptic on submit, then a "Thanks, here's the detail" unlock.
4. **Arrival nudge:** local notification when the user dwells 10+ min inside a geofence (only with "Always/background" location consent; otherwise there's a manual "I'm here" button).
5. **Plans:** save venues, follow friends (phase 2), "Who's out" for opt-in friends only.
6. **Profile:** points, streaks, trust tier badge (Newcomer → Regular → Insider), settings, privacy controls, delete account.

## 5. Cold start (the hardest problem)

- **Pick a tiny map.** Launch with 40 venues in Thonglor/Ekkamai + Sukhumvit 11 + 3 rooftops in Silom/Sathorn. Dense coverage beats a thin citywide map.
- **Paid scouts.** Weeks 1–8: 15–25 paid scouts (students, nightlife creators) file verified reports on a schedule. Their reports are flagged internally so we can measure organic vs. paid data.
- **Creator partnerships.** Bangkok nightlife IG/TikTok accounts share "live meter" cards.
- **Forecast before live.** Even when no one is reporting, the venue page shows the weekday pattern built from scouts, so the app never looks empty.
- **Rewards.** Points redeemable for perks such as a free drink or skipping the line, funded through venue partnerships. These partnerships must never touch ratings (see integrity policy).

## 6. Privacy

- Location is used to verify a report, then discarded. Only `verified_on_site` and a coarse distance bucket are stored.
- Background location is optional, with a clear explanation screen. The app works fully without it.
- Photos: EXIF stripped, faces blurred automatically before public display, auto-expire after 24h.
- Handles, not real names. Account deletion removes reports' link to the user (reports are retained as anonymous aggregates).
- The privacy policy discloses that anonymised, venue-level statistics may be used by the company's affiliated services (see ARCHITECTURE §1).

## 7. Non-functional

| Area | Target |
|---|---|
| Report flow | ≤ 3 taps, ≤ 10 s, works on flaky 4G (queued offline, sent with original timestamp if < 15 min old) |
| Live updates | Meter refreshes within 30s of a new report (realtime channel) |
| App size | < 40 MB install |
| Battery | No continuous GPS. Geofencing uses OS region monitoring only |
| Locale | Thai + English, auto by device |
| Accessibility | Meter values always have a text label; colour is never the only signal |

## 8. Analytics

`report_started`, `report_submitted` (with `verified`, `duration_ms`), `report_rejected_offsite`, `venue_viewed`, `detail_unlocked`, `share_card_created`, `nudge_shown`, `nudge_converted`.

North-star metric: **verified reports per venue per peak hour** (target ≥ 3 for covered venues on Fri/Sat 23:00–02:00).

## 9. Out of scope for MVP

Social graph, chat, venue-claimed pages, web reporting.
