# Book: Product Specification

Codename **Book**. B2B venue platform plus consumer booking storefront. Revenue comes from commission on every transaction (default 5%, set per contract in basis points).

## 1. Users

| Persona | Surface | Core job |
|---|---|---|
| **Guest** (local or expat, 20–40, plans in LINE groups) | book-web, later book-mobile | Find tonight's plan, lock a table/ticket, split with friends |
| **Venue owner/manager** | venue-dashboard | Fill tables, see revenue, get paid, control promoters |
| **Host / door staff** | door-app (PWA on a cheap Android) | Check guests in fast, in the dark, with bad signal |
| **Promoter** | dashboard (promoter role) + share links | Bring groups, get credited and paid |
| **Our ops team** | admin | Onboard venues, moderate, handle disputes and refunds |

## 2. Venue types and what's bookable

| Type | Bookable inventory | Typical pricing |
|---|---|---|
| Club | Tables/booths (floor plan), entry tickets, guestlist spots, bottle packages | Minimum spend per table, often deposit-prepaid |
| Bar | Tables, reserved areas, packages | Free reservation or deposit |
| Restaurant | Timeslot covers, set menus, private rooms | Free, or deposit for prime slots |
| Rooftop | Timeslot covers, **view tables** (premium), sunset slots, packages | Minimum spend for view tables |
| Event | Tickets (tiers, early bird), table packages | Fixed price |

All are modelled as `inventory_items` + `availability` (see ARCHITECTURE §4), so a new venue type is configuration, not new code.

## 3. Consumer storefront (book-web)

### 3.1 Discover
- Home: tonight's highlights, category tiles, events this week, "Near me".
- Filters: area (Thonglor, Ekkamai, Sukhumvit, Silom, Sathorn, Ari, Riverside…), type, music genre, price band, open now, has availability tonight.
- **Tonight's forecast chip** on every club, bar and rooftop card, e.g. `Busy after 00:30` with a confidence dot. Comes from `signals.forecast`. Hidden when confidence is low. Never shows the word "Pulse" or report counts from Pulse users.

### 3.2 Venue page
- Server-rendered with schema.org JSON-LD (`NightClub`, `BarOrPub`, `Restaurant`, `Event`).
- Gallery, about, music/cuisine tags, hours, dress code, age, VAT/service-charge note.
- **Forecast strip:** hourly predicted-busyness curve for the selected night, with a band showing uncertainty. Copy: "Usually packed by 01:00 on Fridays."
- Booking widget (see 3.3).
- Menus, map, similar venues.

### 3.3 Booking flow
1. Choose night (a "night" runs 18:00–06:00) and party size.
2. Choose inventory: timeslot, table on a floor plan (tap a table to see min spend and capacity), ticket tier, or package.
3. **Hold** for 10 minutes (visible countdown). Inventory is reserved server-side.
4. Guest details: name, phone, LINE (optional), special requests.
5. Price breakdown: subtotal, service charge 10%, VAT 7%, total, plus how much is due now (deposit vs. full) and the cancellation policy in one sentence.
6. Pay: PromptPay QR, card, TrueMoney, Rabbit LINE Pay.
7. Confirmation: QR pass, add to calendar, "Share to LINE group", invite friends to the booking.

Guest can add friends to a booking (names on the list) and **split payment** (phase 2: each friend pays their share via link; booking confirms when the deposit threshold is met).

### 3.4 Account
- LINE / Apple / Google / phone OTP login. Guest checkout allowed with phone verification.
- Upcoming and past bookings, passes, receipts, saved venues.
- Cancellation and refund requests self-serve within the venue's policy.

## 4. Venue dashboard (B2B)

| Module | Features |
|---|---|
| **Onboarding** | Self-serve signup, KYC via payments provider, tax ID, upload logo/photos, hours, policies. Ops approves before going live. |
| **Inventory** | Floor-plan editor (drag tables, set capacity and min spend per night or per weekday), ticket tiers, guestlist caps, timeslot rules, blackout dates, alcohol-ban days pre-loaded |
| **Tonight** | Live list of bookings, arrivals, no-shows, revenue so far, a table map coloured by status |
| **Bookings** | Search, filter, edit, manual bookings (walk-ins and phone bookings so the venue uses us as its system of record), notes, VIP tags |
| **Promoters** | Invite promoters, issue tracking links/codes, set commission terms, see leaderboard, approve payouts |
| **Events** | Create event with lineup, tickets, packages; publishes to storefront |
| **Payouts** | Balance, payout schedule, statements, commission invoices (downloadable tax invoices) |
| **Insights** | Bookings by source, conversion, repeat guests, no-show rate. Phase 3: **demand forecast** for their own venue (shown as "expected demand", never "Pulse data") |
| **Team** | Invite staff with roles; 2FA enforced for owner and manager |
| **Widget** | Copy-paste embed and link-in-bio booking page ("Book with [brand]") |
| **Notifications** | LINE OA and email for new booking, cancellation, large party, payout sent |

### Door app (PWA)
- Login by staff PIN on a device registered to the venue.
- Scan the QR pass, or search by name or phone. One tap to check in, which shows party size, table, prepaid amount and notes.
- **Works offline**: caches tonight's list and syncs when back online. Conflict rule: the first check-in wins.
- Big targets, dark UI, readable at arm's length.

## 5. Business rules

- Commission is charged on the **pre-tax subtotal actually paid through us**. Configurable per org (`commission_bps`), with an optional per-item override.
- Deposits: venue chooses none, fixed amount, % of minimum spend, or full prepay.
- Cancellation: venue picks a policy template (flexible / moderate / strict), shown before payment.
- No-show: deposit is retained per policy. Commission on retained deposits applies.
- Refunds go back to the original payment method only. A refund issued after the venue has been paid out creates a negative venue balance, which is deducted from the next payout.
- A promoter is attributed by link, code, or manual assignment by the venue. Last valid touch within 7 days wins.
- Age: venues set a minimum age (20+ legal drinking age in Thailand). Guests confirm their age at booking, and the venue checks ID at the door.
- Alcohol-ban days: bookings disabled by default for clubs and bars. The venue can override, e.g. if it serves food only.

## 6. Non-functional requirements

| Area | Target |
|---|---|
| Storefront performance | LCP < 2.0s on 4G mid-range Android; venue pages statically regenerated |
| Availability | 99.9% for booking and payments APIs; degraded mode shows "call venue" if inventory service fails |
| Consistency | Zero double-bookings: inventory holds are transactional |
| Locale | Thai and English at launch; THB formatting `฿10,000`; Bangkok timezone; Buddhist-era year optional in Thai locale |
| Accessibility | WCAG 2.2 AA |
| Privacy | PDPA consent for marketing separate from transactional messaging; data export and delete self-serve |

## 7. Analytics (tracking plan excerpt)

`venue_viewed`, `availability_checked`, `hold_created`, `checkout_started`, `payment_succeeded`, `booking_cancelled`, `checked_in`, `forecast_chip_seen`, `forecast_strip_interacted`.

North-star metric: **GMV through the platform per week.** Guardrail metrics: no-show rate and refund rate.

## 8. Out of scope for MVP

Native app, split payments, the venue insights product, loyalty, in-venue ordering.
