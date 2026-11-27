# SPEC — LINE Booking Automation for Clubs

| | |
|---|---|
| **Working name** | Club Booking Automation (product name TBD) |
| **Status** | Draft v1 · 26 Nov 2026 |
| **First client** | House of Savoy, Bangkok (pilot) |
| **Owner** | Product: _[name]_ · Engineering: _[name]_ |
| **Replaces** | The earlier Book/Pulse marketplace plan (on hold) |

---

## 1. Summary

Bangkok clubs take table bookings through their own **LINE Official Account (OA)**. Today only the greeting and one canned "send us your details" reply are automated. Everything after that is done by hand: reading the guest's details, checking which tables are free, quoting minimum spend, collecting a deposit by bank transfer, checking the slip, confirming, and writing the booking down somewhere.

We plug into the club's **existing** LINE OA and automate that whole flow end to end: availability, table choice, guest details, rules acceptance, deposit, confirmation, reminders and door check-in. Staff get a live dashboard and LINE group alerts. The guest never downloads anything and never leaves the club's LINE chat. The club keeps its brand, its LINE account and its customer relationships.

Later phases add AI understanding of free-text messages, promoter tracking, and **POS integration** (Wongnai POS / FoodStory first), so a booking opens a bill and the actual spend flows back.

---

## 2. Problem

### 2.1 Observed at House of Savoy (20–26 Nov 2026, tested from a personal LINE account)

1. Adding the OA triggers a **greeting message**: RSVP recommended, deposit non-refundable, house rules (no drugs), location.
2. A **rich menu** offers 6 options (e.g. "Meet me at 24", drinks menu, floor plan), most of them links to the club's website.
3. Typing *"I want to book a table"* triggered an **instant canned reply** asking the guest to type their name, party size, date, nationality and phone number in one message.
4. Sending the same message again got **no reply**. *"I want to talk to a person"* stayed **unread**.
5. **Conclusion:** keyword auto-reply or a pasted saved reply. There's no AI and no availability check. Every step after the first reply is manual.

### 2.2 Pain points

| Who | Pain |
|---|---|
| **Guest** | Has to type a structured form into a chat. Doesn't know which tables are free or what they cost until a human answers. Gets silence at peak times and late at night. Has to send a bank slip and wait for someone to confirm. |
| **Host / reservations staff** | Answers the same questions hundreds of times. Reads free-text details and retypes them. Checks slips one by one in banking apps. Keeps availability in their head, on paper or in a spreadsheet. Risks double-booking. Can't keep up on Friday and Saturday nights. |
| **Manager / owner** | No single view of tonight. Can't tell which promoter brought which table. No-shows hurt revenue. Has no guest history or spend data, and nothing connects the booking to what was actually spent at the POS. |

---

## 3. Goals

### 3.1 Product goals (what success looks like)

| # | Goal | Measure | Pilot target (4 weeks) |
|---|---|---|---|
| **G1** | Guests can book a table **without any human** | % of completed bookings with zero staff messages | **≥ 70%** |
| **G2** | **Every** guest message gets an answer | Median time to first response · count of messages with no response | **< 5 s** median · **0** unanswered |
| **G3** | **No double bookings** | Tables confirmed to two parties for the same night | **0**, ever |
| **G4** | Deposits are **verified without staff** | % of deposits auto-verified (slip or gateway) | **≥ 90%** |
| **G5** | Booking is **fast** for the guest | Median time from first message to confirmed booking | **< 3 min** |
| **G6** | Fewer **no-shows** | No-show rate vs. the club's baseline (measured in week 0) | **−30%** relative |
| **G7** | Staff see **all of tonight in one place** | Host-reported time spent on LINE booking admin | **−50%** (survey at weeks 0 and 4) |
| **G8** | Asking for a human **always works** | Median time from handoff request to staff alert · to first human reply | **< 5 s** alert · **< 10 min** reply during opening hours |

### 3.2 Business goals

| # | Goal | Measure |
|---|---|---|
| **B1** | House of Savoy keeps using it after the pilot and pays for it | Signed paid contract by end of pilot |
| **B2** | Prove the product works beyond one club | 3 paying clubs within 3 months of pilot end |
| **B3** | A new club can be onboarded quickly | **≤ 1 working day** from signed contract to live (no code changes) |
| **B4** | Unit economics work | LINE message costs + infrastructure + slip verification < **15%** of revenue per club |

### 3.3 Non-goals (explicitly out of scope)

- A consumer app or marketplace. Guests only ever talk to the **club's** OA.
- Holding or moving guest money. Deposits go **directly to the club's account** (see §11.2).
- Replacing the club's POS, accounting or payroll.
- Guestlist / free-entry management in Phase 1 (tables only).
- Card payments in Phase 1 (PromptPay transfer only).
- Cross-club guest profiles or sharing guest data between clubs.
- Live crowd ratings ("Pulse"). Parked.

---

## 4. Users and roles

| Role | Where they work | Can do |
|---|---|---|
| **Guest** | The club's LINE OA (chat + in-LINE booking pages) | Book, pay deposit, view/change/cancel own booking, ask for a human |
| **Host** (reservations staff) | Dashboard (phone/tablet/laptop) + staff LINE group | See and manage bookings, take over chats, approve slips, create manual bookings, check guests in |
| **Door staff** | Door check-in screen on a phone | Scan the guest's QR code, check guests in, see table and party size |
| **Promoter** (Phase 3) | Personal booking link/QR + limited dashboard | Share their link, see their bookings and commission |
| **Manager / owner** | Dashboard | Everything a host can do, plus: tables, pricing, rules, deposit policy, staff accounts, reports, integrations |
| **Our ops/admin** | Internal admin | Onboard clubs, connect LINE channels, support, view audit logs (with club consent) |

---

## 5. Guest experience

### 5.1 Ways a booking starts

| Entry point | What happens |
|---|---|
| Guest adds the OA | Club's greeting (we take over sending it) + **[Book a table]** button |
| Rich menu **Book a table** | Starts the flow at step 1 |
| Typed message containing a booking keyword (EN/TH: *book, table, reserve, จอง, โต๊ะ, ...*) | Starts the flow at step 1. In Phase 2, the AI pre-fills whatever the message already contains |
| Promoter link or QR (Phase 3) | Starts the flow with the promoter attached to the booking |
| Club's Instagram / website link | Opens the booking page inside LINE directly |

### 5.2 Main flow

> **Design rule:** buttons first, typing optional. Every step can be completed with taps. Never ask for something we already know.

**Step 1: Night**
> *Which night would you like to book?*
> [Tonight] [Fri 28 Nov] [Sat 29 Nov] [Pick a date]

- Only nights the club is open and taking bookings are shown. "Pick a date" uses LINE's native date picker, limited to the booking window (default 30 days ahead).
- Closed or fully booked nights say so and offer: [Join waitlist] [Talk to a host].
- Event nights show the event name: *"Sat 29 — Guest DJ: [name]"*.

**Step 2: Party size**
> *How many guests?*
> [2–4] [5–8] [9–12] [13+]

- 13+ or above the club's maximum goes to a host (large groups often need custom arrangements).

**Step 3: Choose a table**
- A swipeable set of LINE cards shows **only tables that are free that night and fit the party size**, sorted by club priority. Each card shows:
  - table code (e.g. **17A**), zone (VIP / DJ side / Standard / Bar), capacity
  - **minimum spend** and **deposit** for that night
  - a photo or zone image (optional)
  - **[Choose 17A]**
- **[See floor plan]** opens the club's floor plan inside LINE. Free tables can be tapped, and taken ones are greyed out.
- No suitable tables: [Join waitlist] [See other nights] [Talk to a host].
- **The table is held for 10 minutes once chosen** (configurable). The hold is visible: *"Held for you until 22:41"*.

**Step 4: Guest details**
- An in-LINE form (LIFF):
  - **name**, pre-filled from the LINE profile and editable
  - **phone number**
  - **nationality** (dropdown)
  - optional: occasion (birthday, etc.) and a special request (free text, max 200 characters)
- Returning guests: pre-filled, one tap to confirm.
- Fields are configurable per club (e.g. House of Savoy currently asks for nationality).

**Step 5: Review and rules**
> **Table 17A · Sat 29 Nov · 6 guests**
> Minimum spend **฿15,000** · Deposit **฿5,000** (counts towards spend)
> Arrive by **23:30** or the table may be released
> ☐ I understand the deposit is **non-refundable** · 20+ with ID · dress code · zero-tolerance drug policy
> [Confirm & pay deposit] [Change]

- The rules text comes from club settings. The checkbox is required, and accepted rules are saved with the booking (version + timestamp) in case of a dispute.

**Step 6: Pay deposit**
- **Phase 1 (PromptPay + slip):**
  1. The bot sends a **PromptPay QR** for the exact deposit amount, payable to the **club's own PromptPay account**, plus the reference *"Booking HS-7K2Q"* and the hold expiry time.
  2. The guest pays in their banking app and **sends the slip image in the chat**.
  3. The system verifies the slip automatically (§11.2): amount, receiving account, transfer time inside the hold window, and that the slip hasn't been used before.
  4. **Pass:** booking confirmed (step 7). **Fail or unreadable:** the booking goes to **Payment review** and a host is alerted. The guest sees *"Thanks, we're checking your payment. You'll get confirmation here shortly."*
- **No deposit policy** (if the club allows it for some tables or nights): skip straight to step 7.
- **Hold expires before payment:** the table is released and the guest gets *"Your hold on 17A expired. [Try again]"*. A slip that arrives after expiry goes to Payment review, never auto-rejected.
- **Phase 3 option:** a payment-gateway checkout (PromptPay/card) that confirms automatically with no slip.

**Step 7: Confirmation**
- The guest gets a confirmation card: club, table, night, arrival time, party size, deposit paid, minimum spend remaining, **QR code for the door**, location button, and [My booking].
- The staff LINE group gets: *"✅ New booking · 17A · Sat 29 · 6 pax · ฿5,000 paid · Ari (TH) · 08x-xxx-1234"*.
- The dashboard table map updates in real time.

**Step 8: Before the night**
- **Day-of reminder** at a time the club sets (default 18:00): *"See you tonight. Table 17A, please arrive by 23:30."* [Running late] [Need to cancel] [Location]
- **Running late:** the guest picks [15 min] [30 min] [1 hr]. The host is alerted, and the table's "release at" time is pushed back if the club's rules allow.
- **Need to cancel:** the cancellation policy is shown (e.g. deposit non-refundable), then the guest confirms, the table is released and the host is alerted.

**Step 9: Arrival**
- Door staff scan the QR → **Checked in**, with party size, table and notes shown.
- If not checked in by the release time + grace period: host alert *"17A not arrived — release table?"* [Release] [Keep 30 min]. Releasing marks the booking **No-show**.

**Step 10: After**
- Next day: *"Thanks for coming to House of Savoy."* [Book again]. The message is optional per club and counts against the club's LINE message quota (§11.1.4).

### 5.3 Always-available behaviours

| Situation | Behaviour |
|---|---|
| **"Talk to a person"** (button, rich menu, or keywords like *person, staff, human, คน, แอดมิน*) | Instant reply: *"Got it, a host will reply here shortly."* Staff get an alert in the LINE group and on the dashboard, **with a summary** (what the guest asked, any booking in progress). The bot **stops replying in that chat** until a host marks it resolved, or after a timeout set per club (default 30 min with no staff activity, which re-alerts first). |
| **Same message sent twice** | Never silence. If a booking is in progress: *"You were booking 17A for Saturday. [Continue] [Start over]"*. |
| **Unrecognised message** (Phase 1) | *"I can help with: [Book a table] [My booking] [Drinks menu] [Location] [Talk to a host]"*. |
| **Unrecognised message** (Phase 2) | The AI works out what the guest wants (§8). If it isn't confident, it shows the menu above. |
| **Sticker / image that isn't a slip** | Polite menu reply. Images during the payment step are treated as possible slips. |
| **Guest already has a booking** | *"My booking"* shows it with [Change party size] [Running late] [Cancel] [Talk to a host]. Changing table or night goes to a host in Phase 1. |
| **Outside booking hours / club closed** | The bot still works 24/7. Handoff replies say when a host will be available: *"Our hosts are online from 18:00."* |
| **Guest blocks the OA** | Upcoming bookings stay. The host is flagged that the guest can't be messaged. |
| **Language** | Thai or English, matched to the guest's LINE language setting, with a switch available in the menu. Chinese can be added per club later. |

### 5.4 Tone

- Short, warm and confident, written in the club's voice, which is configurable per club (e.g. formal *ค่ะ/ครับ* vs. casual).
- Never invent anything. Prices, availability and rules always come from the system, not from wording templates or the AI.

---

## 6. Staff experience

### 6.1 Staff LINE group (notifications)

Each club links one or more staff LINE groups. These messages go out:

| Event | Message |
|---|---|
| New confirmed booking | Table, night, pax, deposit, name, nationality, phone, special request |
| Payment needs review | Slip image + reason + [Open in dashboard] |
| Guest wants a human | Guest name + summary + [Open chat] |
| Running late / cancellation | Booking + new arrival time / cancellation |
| Not arrived at release time | [Release] [Keep 30 min] (actioned in the dashboard) |
| Daily 17:00 summary | Tonight's bookings by zone, deposits collected, expected minimum spend |

### 6.2 Dashboard (web, works well on phone and tablet)

**Tonight** (the home screen)
- **Table map** with each table's state: Free · Held · Awaiting payment · Payment review · Confirmed · Arrived · No-show. Tap a table to see its booking.
- **List view:** arrivals sorted by time, with search by name or phone.
- Totals: tables booked / total, guests expected, deposits collected, minimum spend booked.

**Bookings**
- Search and filter by night, status, zone, promoter (Phase 3) and source.
- Booking detail: guest, history, payments (slip images), rules accepted, chat summary and audit trail.
- Actions: confirm, change table or night, change party size, cancel (with or without forfeiting the deposit, giving a reason), mark arrived or no-show, add notes and VIP tags.
- **Manual booking:** for phone calls, walk-ins, promoter and VIP bookings. It blocks availability exactly like a LINE booking. Optional: send the guest a LINE confirmation if they're linked.

**Inbox (handoffs)**
- Chats waiting for a human, oldest first, with summaries.
- A host can **reply from the dashboard** (we send it through the API) or reply in LINE OA Manager on their phone (see §11.1.3), then hand the chat back to the bot with [Mark resolved].

**Payments**
- Slips waiting for review: image, amount read from the slip, expected amount, the problem, and [Approve] [Reject with reason].
- Deposit report by night, exportable to CSV.

**Door** (simplified mode for door staff)
- A camera QR scanner, plus name search as a fallback. One tap to check in. Large text, dark UI.

**Settings** (manager only)
- **Tables:** code, zone, capacity (min/max pax), position on the floor plan, photo, active/inactive.
- **Nights:** opening days, booking window, closed dates (including alcohol-ban days, pre-loaded), event nights with names.
- **Pricing:** minimum spend and deposit per table or zone, with overrides per weekday and per event night.
- **Rules:** hold duration, arrival cut-off, grace period, cancellation policy text, required guest fields, rules text (TH/EN), reminder times.
- **Bot content:** greeting, menu replies, tone, FAQ answers (dress code, parking, location, age), rich menu buttons and links.
- **Staff:** invite by phone or email, assign roles, 2FA for managers.
- **Integrations:** LINE channel status, PromptPay ID, slip-verification service, POS (Phase 3).

---

## 7. Booking rules and state machine

### 7.1 States

```
               ┌──────────── expired (hold timed out, no payment)
               │
draft ──▶ held ──▶ awaiting_payment ──▶ payment_review ──▶ confirmed ──▶ arrived ──▶ completed
  │        │             │                     │              │            
  │        │             │                     └──▶ rejected  ├──▶ cancelled (by guest / by club)
  └────────┴─────────────┴──▶ abandoned                       └──▶ no_show
```

- **draft:** guest is choosing night, size and table. No inventory is held.
- **held:** the table is reserved for `hold_minutes`. No one else can book it.
- **awaiting_payment:** QR sent, hold still running.
- **payment_review:** slip received but not auto-verified, or received late. **The table stays blocked** until a host decides.
- **confirmed:** deposit verified, or no deposit required.
- **arrived:** checked in at the door.
- **completed:** the night has ended (auto at the club's closing time + 2h). If the POS is connected, actual spend is attached.
- **cancelled / no_show / expired / abandoned / rejected:** final states. Each records who, when and why.

### 7.2 Rules

| Rule | Default | Configurable |
|---|---|---|
| One active booking per table per night | Always | No |
| Hold duration | 10 min | Yes (5–30) |
| Booking window | 30 days ahead | Yes |
| Same-night booking cut-off | Until 01:00 | Yes |
| A "night" | 18:00 → 06:00, belongs to the start date (02:00 Sunday = Saturday night) | Start/end hour |
| Max active bookings per guest per night | 1 | Yes |
| Deposit | Fixed amount per table/zone/night | Yes; can be 0 |
| Deposit counts towards minimum spend | Yes | Yes |
| Cancellation | Deposit non-refundable (House of Savoy's current policy) | Policy text + whether refunds are ever allowed (refunds are done manually by the club) |
| Arrival cut-off | Club-set (e.g. 23:30) | Yes, with grace period |
| Age | 20+ (Thai legal drinking age). Guest confirms; door checks ID | Minimum age |
| Alcohol-ban days | Bookings closed by default | Override per date |

### 7.3 Concurrency (no double bookings)

- Inventory is checked and held in **one database transaction**, with a uniqueness rule on (table, night) for active bookings.
- Two guests tapping the same table at once: exactly one gets the hold. The other sees *"Someone just took 17A, here are other tables"*.
- Manual bookings from the dashboard use the same path.

---

## 8. AI layer (Phase 2)

**Purpose:** understand free-text messages in Thai and English, pre-fill the booking flow, and answer FAQs. **The AI never confirms a booking, sets a price or promises a table.**

| Capability | Example | Output |
|---|---|---|
| Extract booking details | *"โต๊ะ 6 คน เสาร์นี้ ใกล้ดีเจ"* (table, 6 people, this Saturday, near the DJ) · *"17A sat 6ppl"* | `{date, pax, table_code?, zone_pref?}` → jumps to the right step with the values filled in |
| Intent detection | *"can i bring my cake"*, *"what time do you close"*, *"I'm running late"* | Routes to FAQ / my booking / handoff |
| FAQ answers | Dress code, parking, age, location, music tonight | Answered **only from the club's FAQ settings**. If the answer isn't there, it goes to a host |
| Handoff summary | Long, messy chat | 2-line summary for the host |

**Guardrails**
- The model works with a fixed set of tools (`check_availability`, `start_booking`, `get_booking`, `get_faq`, `request_handoff`). Prices and availability come only from tool results.
- Confidence threshold: low confidence means show the button menu, not a guess.
- Guest text is treated as data. Instructions inside guest messages are ignored.
- All AI replies are logged. In week 1 of each new club, a host reviews a sample every day.
- Cost cap per club per month, with alerts.

---

## 9. Data model (core)

```
clubs(id, name, slug, timezone='Asia/Bangkok', default_lang, tone, status, created_at)
line_channels(id, club_id, channel_id, channel_secret_ref, access_token_ref,
              liff_id, rich_menu_id, webhook_path, status)            -- secrets in secret manager
staff_users(id, club_id, name, phone, email, role[owner|manager|host|door|promoter], 2fa_enabled)
staff_groups(id, club_id, line_group_id, purpose[bookings|payments|handoff|all])

zones(id, club_id, name_en, name_th, sort)
tables(id, club_id, zone_id, code, min_pax, max_pax, floor_x, floor_y, shape, photo_url, active)
nights(id, club_id, date, status[open|closed|sold_out], event_name, notes)
price_rules(id, club_id, scope[club|zone|table], scope_id, weekday NULL, night_id NULL,
            min_spend_satang, deposit_satang, priority)

guests(id, club_id, line_user_id, display_name, name, phone, nationality, lang,
       first_seen_at, last_booking_at, tags[], blocked_bot bool, consent_at)
       -- line_user_id is unique PER LINE provider, so the same person can have different ids at different clubs

bookings(id, club_id, ref_code, guest_id, table_id, night_id, pax, status, source[line|manual|promoter|web],
         promoter_id NULL, hold_expires_at, arrival_by, rules_version, rules_accepted_at,
         special_request, notes, created_by, created_at, updated_at,
         UNIQUE (table_id, night_id) WHERE status IN (held, awaiting_payment, payment_review, confirmed, arrived))

deposits(id, booking_id, amount_satang, method[promptpay_slip|gateway|cash|waived],
         status[pending|verified|review|rejected|forfeited|refunded_manual],
         slip_image_ref, slip_trans_ref UNIQUE, slip_amount_satang, slip_receiver, slip_time,
         verified_by[auto|staff_id], verified_at)

conversations(id, club_id, guest_id, mode[bot|human], handoff_requested_at, assigned_staff_id,
              resolved_at, summary)
messages(id, conversation_id, direction[in|out], kind[text|image|sticker|postback|flex],
         payload jsonb, line_message_id, sent_via[reply|push], created_at)      -- retention: 180 days

pos_links(id, club_id, provider[wongnai|foodstory|other], status, credentials_ref, settings jsonb)
pos_bills(id, booking_id, provider_bill_id, opened_at, closed_at, total_satang, synced_at)

audit_log(id, club_id, actor_type, actor_id, action, entity, entity_id, before jsonb, after jsonb, at)
```

- Money is stored as integer **satang**.
- Every table carries `club_id`, and every query is scoped by club (multi-tenant isolation, §12).

---

## 10. Phases and scope

| Phase | Scope | Exit criteria |
|---|---|---|
| **0: Demo** (own test OA, fictional club) | Steps 1–7 with buttons, PromptPay QR + manual slip approval, basic dashboard (tonight + bookings + manual booking), staff group alerts, handoff | Team completes 50 test bookings with no double booking. Ready to demo to clubs |
| **1a: Live on LINE** (own test OA, real phones) | One-command go-live (`npm run live`): tunnel, webhook set + tested, bilingual rich menu, LIFF endpoint auto-update, every message type validated by LINE, quota readout. LIFF ID-token check (form can only be submitted by the LINE user holding the table). Unfollow handling (no pushes to guests who blocked the OA). Group join instructions. LINE status + "Run LINE setup" in the dashboard | 20 bookings made from real phones (iOS + Android, TH + EN) with no staff help and every webhook delivery handled. Staff group receives every alert |
| **1: Pilot** (House of Savoy, 4 weeks) | Everything in Phase 0 + automatic slip verification, reminders, running late / cancel, door check-in, no-show handling, settings UI, TH/EN, club's greeting and rich menu migrated | Goals G1–G8 measured. Club agrees to continue |
| **2: AI** | Free-text understanding, FAQ answers, handoff summaries | ≥ 85% of free-text booking requests correctly pre-filled (sample review). No AI-caused wrong prices or availability |
| **3: Grow** | Promoter links + commission tracking, **POS integration**, waitlist, bottle pre-orders, payment gateway option, guest CRM + VIP tags, reports | 3 paying clubs |

---

## 11. Integrations

### 11.1 LINE

**11.1.1 What we use**
- **Messaging API** (webhook + reply + push) for all chat.
- **Rich menu API** for the club's menu. We manage it, with buttons the club controls in Settings.
- **Flex Messages** for table cards, summaries and confirmations. **Quick replies** and the **date picker action** for steps 1–2.
- **LIFF** (in-LINE web pages) for the table map, guest details form and My booking. It needs a **LINE Login channel**, set up per club or under our provider (decided at onboarding).

**11.1.2 Connecting a club's OA**
1. The club adds our team as **admins** of their OA.
2. In LINE OA Manager, the club **enables Messaging API** and links the OA to a provider. ⚠️ **This link is permanent.** Default: link to a **provider owned by the club**, with our team added as admins, so the club is never locked to us. Record the decision in the contract.
3. Store the channel secret and access token in our secret manager.
4. Set the webhook URL to `https://api.<domain>/line/webhook/<club-slug>` and verify the `X-Line-Signature` on every request using that club's channel secret.
5. **Turn off the club's old keyword auto-replies and greeting message** in OA Manager, so guests don't get two replies. We send the greeting instead.
6. Create the rich menu, LIFF app and staff groups. Run the go-live checklist (§12.2).

**11.1.3 Chat coexistence and handoff**
- Hosts may keep replying from **LINE OA Manager's chat** on their phones. To check during setup: that the OA's response settings allow **Chat and Webhook to both be on**.
- **Known limitation:** messages hosts send from OA Manager do **not** reach our webhook, so the system can't see them. That's why handoff mode ends with **[Mark resolved]** or the inactivity timeout, not by detecting a staff reply.
- Replies sent from our dashboard go out as **push messages** (they count against the quota, §11.1.4).

**11.1.4 Message quota and cost**
- **Reply messages** (answering a guest message with its reply token) are free. Reply tokens are single-use and short-lived, so the system must reply quickly, including after the slip check.
- **Push messages** (reminders, async confirmations, dashboard replies, follow-ups) count against the club's monthly LINE OA plan quota. Plan sizes and prices must be checked for Thailand at onboarding.
- Design rules: prefer replies; batch information into one message; maximum **2 push messages per booking** by default (reminder + one other); the dashboard shows quota usage and warns at 80%.

### 11.2 Deposits

**Phase 1: PromptPay QR + slip verification**
- QR code: a dynamic PromptPay QR (the standard Thai bank QR format) generated for the **club's own PromptPay ID** (phone or tax ID) with the exact amount. **The money goes directly from guest to club. We never hold it.**
- Slip verification: a Thai slip-verification API that reads the QR code printed on bank slips and confirms the transfer with the bank. Candidates: **SlipOK, EasySlip**; evaluate accuracy, bank coverage, uptime, price per check and data handling before picking one. Checks:
  - amount ≥ expected deposit
  - receiving account matches the club's PromptPay / bank account
  - transfer time is after the hold started (allowing a small clock skew)
  - the slip's transaction reference has **never been used before**, across all bookings for that club (stops reused slips)
- Any check fails, or the service is down, → **payment_review** (a human decides). Never auto-reject.
- Fallback if the slip service isn't available at launch: hosts approve every slip in the dashboard (Phase 0 behaviour).

**Phase 3 option: payment gateway** (Opn/Omise, 2C2P, or Stripe, whichever supports PromptPay and payouts in the club's name). Fully automatic confirmation, card support, refunds through the API. Trade-offs: transaction fees, and possible e-payment regulation depending on the money flow (**legal review needed before building**).

### 11.3 POS: Wongnai POS (LINE MAN Wongnai / FoodStory)

**Goal:** when a booking arrives, the club's POS knows about it, and when the night ends, the actual spend comes back. That closes the loop: minimum spend tracking, real spend per guest, and accurate promoter commission.

**What we found (Nov 2026):**
- Wongnai POS is widely used in Bangkok food and beverage. Its back office moved to **FoodStory POS** in Jan 2025 (FoodStory is part of LINE MAN Wongnai).
- **We found no public developer API or self-serve partner portal.** LINE MAN Wongnai has a built-in integration that sends LINE MAN delivery orders into the POS, and third-party accounting software (e.g. TRCLOUD) has announced connections to FoodStory. So **partner-level API access exists for some companies, but it has to be requested.**

**Plan:**
1. **Ask House of Savoy which POS they use.** Clubs often use different systems from restaurants.
2. **Apply for partner/API access** with LINE MAN Wongnai / FoodStory's business team. Ask about: reading bills (by table and time), creating reservations or pre-opened bills, recording deposits as prepayments, webhooks for bill closed, a sandbox, and rate limits and costs.
3. Build POS support behind a **provider-agnostic adapter**, so one POS can be swapped for another or new ones added:
   ```
   interface PosAdapter {
     pushReservation(booking)            // optional: create reservation / pre-open bill on table
     recordDeposit(booking, deposit)      // optional: prepayment on the bill
     onTableOpened(handler)               // optional: auto check-in when the bill opens
     fetchClosedBills(night): Bill[]      // required for spend sync
     matchBillToBooking(bill): booking_id // by table code + night + time window
   }
   ```
4. **Integration levels** (we ship whichever the POS allows):

| Level | What happens | Needs |
|---|---|---|
| **L0: No API** | Dashboard shows booking ref + deposit so the cashier can enter the prepayment by hand. End-of-night CSV/Excel export from POS uploaded to reconcile spend | Nothing from the POS vendor |
| **L1: Read** | We pull closed bills after the night and match them to bookings by table and time. Actual spend shows on the booking and guest profile | Read API or scheduled export |
| **L2: Write** | Confirmed booking creates a reservation or pre-opened bill on the table in the POS. Deposit recorded as a prepayment | Write API |
| **L3: Real time** | Bill opened → auto check-in. Bill closed → booking completed with spend. Minimum spend progress visible to the host live | Webhooks |

- Matching rule for L1+: same table code, same night, bill opened within [arrival_by − 2h, closing time]. Ambiguous matches go to the host for confirmation.
- Phase 3 ships **L0 for every club** and L1+ only where API access has been granted.

### 11.4 Other integrations (later)

- **Google Sheets export** of tonight's bookings, for clubs that live in spreadsheets.
- **Instagram / website link** opening the LIFF booking page directly.
- **Accounting export** (deposit report) for FlowAccount / PEAK style tools.

---

## 12. Multi-club setup and onboarding

### 12.1 Multi-club architecture
- One system serves every club. **Each club is data and settings, not code.**
- Strict isolation: every record has `club_id`. Access checks happen in the service layer, with database row-level security as a backup. Automated tests check that no query can return another club's data.
- Each club has its own LINE channel, webhook path, PromptPay ID, staff groups, settings and (optionally) POS link.

### 12.2 Onboarding checklist (target ≤ 1 day)
1. Contract + data processing agreement (PDPA) signed. Provider-ownership decision recorded.
2. LINE: admins added, Messaging API enabled, webhook set, signature verified, old auto-replies off, Chat + Webhook mode confirmed.
3. Tables and floor plan entered (from the club's floor plan image). Zones, minimum spends, deposits, nights and event nights.
4. Rules text (TH/EN) approved by the manager. Greeting and rich menu recreated in their branding.
5. PromptPay ID entered and a ฿1 test transfer verified end to end.
6. Staff invited, roles set, staff LINE group linked, door scanner tested on their phone.
7. **Dry run:** 10 test bookings by our team (including a cancellation, a late slip, a handoff and a no-show).
8. Go live, with our team watching every conversation on night 1.

---

## 13. Non-functional requirements

| Area | Requirement |
|---|---|
| **Speed** | Webhook acknowledged in < 1 s. Bot reply sent in < 3 s at p95 (excluding slip verification, which must finish within the reply-token window or fall back to push). |
| **Availability** | 99.9% monthly for the webhook and booking APIs. If our system is down, LINE OA Manager chat still works, so hosts can take bookings by hand. Booking holds must never be lost. |
| **Peak load** | Handle 50 bookings/minute per club and 1,000 inbound messages/minute across all clubs. Load-tested before the pilot (Friday night 22:00–01:00 pattern). |
| **Reliability** | Webhook handling is idempotent (LINE may redeliver; dedupe by message ID). Every state change is logged in the audit trail. |
| **Security** | LINE signature verification on every webhook. Secrets in a secret manager, never in code or the DB. Role-based access. 2FA for managers. Audit log of all staff actions. Encryption in transit and at rest. Slip images in private storage with signed URLs. |
| **Privacy (Thai PDPA)** | Collect only the fields the club needs. Consent captured in the booking form. The club is the data controller and we are the processor (DPA in contract). Guests can request access or deletion via the club. Retention: chat messages 180 days, slips 1 year (for disputes), booking records as required by the club. No sharing between clubs. |
| **Localisation** | Thai and English everywhere (bot, LIFF pages, dashboard). THB formatting (฿15,000). Asia/Bangkok timezone. Optional Buddhist-era year in Thai. |
| **Accessibility** | LIFF pages and dashboard meet WCAG 2.2 AA. The table map also has a list view. Door mode has large targets and works in the dark. |
| **Devices** | LIFF pages are tested on LINE in-app browsers on iOS and Android, including low-end Android. Dashboard works on phone, tablet and laptop. |
| **Observability** | Error tracking, structured logs, uptime alerts on webhook failures. Per-club health view: webhook errors, unanswered messages, slip failures, quota usage. |

---

## 14. Analytics

**Events** (per club): `follow`, `unfollow`, `booking_started`, `night_selected`, `pax_selected`, `table_held`, `details_submitted`, `rules_accepted`, `qr_sent`, `slip_received`, `slip_auto_verified`, `slip_review`, `booking_confirmed`, `hold_expired`, `handoff_requested`, `handoff_resolved`, `reminder_sent`, `running_late`, `booking_cancelled`, `checked_in`, `no_show`, `pos_bill_matched`.

**Funnel report:** started → night → pax → table → details → rules → paid → confirmed, with drop-off at each step.

**Club report** (weekly, in the dashboard and sent to the manager's LINE):
- bookings and deposits
- no-show rate
- % booked with no staff help
- busiest nights and zones
- average spend (with POS connected)
- top promoters (Phase 3)

---

## 15. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Hosts/promoters see the bot as a threat to their job or commission | Club resists or sabotages | Pitch it as removing repetitive work. Promoter attribution in Phase 3. Hosts keep VIP and special bookings |
| Slip fraud (edited or reused slips) | Club loses deposits | Bank-backed slip verification, unique transaction refs, amount/receiver/time checks, human review on any doubt |
| LINE quota/cost grows with volume | Margin squeeze | Reply-first design, push caps, quota dashboard, pricing passes the cost on |
| Provider link permanently ties the OA to the wrong owner | Club lock-in fears / migration pain | Club-owned provider by default, written into the contract |
| We can't see staff replies sent from OA Manager | Bot talks over a host | Explicit handoff mode + Mark resolved + timeout |
| POS vendor won't grant API access | No automated spend sync | L0 manual/CSV path. Adapter supports other POS vendors |
| AI misreads a request | Wrong night or table pre-filled | AI only pre-fills. The guest confirms every value on the review screen. Confidence threshold |
| Regulation if we ever touch funds | Licensing burden | Phase 1 money goes guest → club directly. Legal review before any gateway work |
| Single dependency on LINE | Platform risk | Booking engine and data are ours. The LIFF booking page also works as a normal web link |

---

## 16. Open questions (ask House of Savoy)

1. Floor plan: table codes, capacities, zones. Can they share the plan image?
2. Minimum spend and deposit per table: does it change by weekday or event?
3. How are deposits collected now (bank transfer to which account / PromptPay ID)? How many slips per night?
4. Who handles bookings today (in-house host, promoters, both)? Peak bookings per night?
5. Where are bookings tracked now (paper, Excel, Google Sheets, another system)?
6. Cancellation and no-show reality: is the deposit ever refunded? What's the current no-show rate?
7. **Which POS do they use?** Wongnai POS / FoodStory or something else? Who is their account manager there?
8. Who owns the LINE OA (owner account, provider)? Is an agency or other tool connected to it?
9. Which LINE OA plan are they on (message quota)?
10. Guestlist/free entry: do they want it, and when?
11. Languages: Thai/English enough, or Chinese too?
12. Are the "nationality" and other current form fields required, and why (e.g. door policy, reporting)?

---

## 17. Acceptance criteria (Phase 1 pilot)

- [ ] A guest can go from "book a table" to a confirmed booking with QR using **taps only** in under 3 minutes on iOS and Android.
- [ ] Only tables that are **free and fit the party size** are ever offered for the chosen night.
- [ ] Two simultaneous attempts on the same table produce **exactly one** hold. The other user is offered alternatives.
- [ ] Holds expire on time and the table becomes available again.
- [ ] A valid slip for the right amount and receiving account confirms the booking **without staff action**. A reused slip is caught and goes to review.
- [ ] Any message, including repeats, stickers and unknown text, gets a response within 5 s.
- [ ] "Talk to a person" alerts staff in < 5 s with a summary, and the bot stays silent in that chat until resolved or timed out.
- [ ] Manual bookings from the dashboard block availability exactly like LINE bookings.
- [ ] Door scan checks the guest in. Non-arrivals trigger a release prompt at the cut-off.
- [ ] Reminder sent at the configured time. Running late and cancel work from the reminder.
- [ ] Staff LINE group gets every notification in §6.1.
- [ ] All guest-facing text exists in Thai and English and is editable in Settings.
- [ ] No staff user can see another club's data (automated test).
- [ ] Every booking, payment and staff action is in the audit log.

---

## 18. Glossary

| Term | Meaning |
|---|---|
| **OA** | LINE Official Account, the club's business account guests chat with |
| **Messaging API** | LINE's interface that lets our system receive and send messages for an OA |
| **Webhook** | The address LINE sends every incoming guest message to (our server) |
| **Rich menu** | The button panel at the bottom of a LINE chat |
| **Flex Message** | A LINE message laid out as a card, with images and buttons |
| **LIFF** | LINE Front-end Framework: a web page that opens inside LINE (our table map and forms) |
| **Provider** | The company account in LINE Developers that owns the OA's API channels |
| **Reply / push message** | Reply = answering a guest message (free). Push = a message we send first (counts against quota) |
| **PromptPay** | Thailand's national instant transfer system, paid by QR code or phone/ID number |
| **Slip** | The transfer receipt image from a Thai banking app, with a verifiable QR code |
| **Minimum spend** | The amount the table must spend on the night. The deposit usually counts towards it |
| **Hold** | Temporary lock on a table while the guest finishes booking and pays |
| **POS** | Point of sale, the club's billing/cashier system (e.g. Wongnai POS / FoodStory) |
