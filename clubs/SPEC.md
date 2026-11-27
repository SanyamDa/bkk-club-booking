# SPEC — Club Platform: LINE Booking, Club Brain, Founder Console and Data

| | |
|---|---|
| **Working name** | Club Booking Automation (product name TBD) |
| **Status** | Draft v2 · 26 Nov 2026 |
| **First client** | House of Savoy, Bangkok (pilot) |
| **Demo club** | Velora (fictional, ours, §12.4) |
| **Owner** | Product: _[name]_ · Engineering: _[name]_ |
| **Replaces** | Draft v1 (one club's booking bot). The earlier Book/Pulse marketplace plan is no longer on hold: the consumer busyness app is built as a separate product and is fed by this platform (§14.7) |
| **Backlog** | Future extensions are in [EXTENSIONS.md](EXTENSIONS.md) (§19) |

**What changed in v2.** The product is now a platform with four commitments (§3.1): any club live in 10–15 minutes, a founder admin console, the Velora demo club, and data collection from day one. New or rewritten sections: §3, §5.5, §6.3–6.6, §8, §10, §11.1.2, §11.3, §11.5, §12, §13.1, §14, §16.1, §17.1, §19. Extended: §4, §9 (the "Added in v2" block), §11.1.1, §11.1.3–11.1.4, §13 (the Security and Privacy and data rows), §15, §18. In the guest flow (§5), step 4 gains an optional date of birth and §5.5 (data notice) is new; the rest of §5 and the booking rules (§7) are unchanged.

---

## 1. Summary

Bangkok clubs take table bookings through their own **LINE Official Account (OA)**. Today only the greeting and one canned "send us your details" reply are automated. Everything after that is done by hand: reading the guest's details, checking which tables are free, quoting minimum spend, collecting a deposit by bank transfer, checking the slip, confirming, and writing the booking down somewhere.

We plug into the club's **existing** LINE OA and automate that whole flow end to end: availability, table choice, guest details, rules acceptance, deposit, confirmation, reminders and door check-in. Staff get a live dashboard and LINE group alerts. The guest never downloads anything and never leaves the club's LINE chat. The club keeps its brand, its LINE account and its customer relationships.

Around that booking flow sits a platform:

- **A club is live in 10–15 minutes.** The club's LINE account is connected, the bot is loaded with the club's tables, policies and FAQs, and it runs 24/7 (§12.2).
- **The bot gets smarter per club.** Each club has a **club brain**: a knowledge base that starts from what the club enters at onboarding and grows from the answers managers give when they take over a chat (§8). It learns only from replies sent through our inbox. Replies typed in the LINE app cannot be seen by any outside system (§6.3). A manager approves each learned answer before the bot uses it.
- **One dashboard for the club.** Messages from LINE, Instagram and later channels sit in one inbox with the guest's bookings beside them. The manager is told when a chat needs them, and sees how many bookings the bot made (§6.3–6.5).
- **A founder console for us.** We add clubs, run onboarding, open any club's dashboard to help, and debug problems from one place (§12.3).
- **A demo club, Velora.** We show the whole product end to end to prospective clubs, from the guest's phone to the admin dashboard (§12.4).
- **Data from day one.** Every chat event, booking step and automation is recorded. The data improves the bot, powers club reports, supplies marketing, and feeds a separate app that predicts which club is busiest at a given moment (§14).

The club's point-of-sale system connects at the level its vendor allows (§11.3). Every POS works at the manual level: staff key in the deposit, and the club uploads its sales report after the night. That is the level for Wongnai POS / FoodStory today, because it has no open API. Where the POS has one (Papaya today), checking a guest in opens the bill and the real spend flows back automatically.

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

### 3.1 Platform goals (what the platform must do)

| # | Goal | What it means | Measure |
|---|---|---|---|
| **P1** | **Any club is live in 10–15 minutes** | Minimum overhead for us and for the club. In one short call: the club's LINE account is connected to our bot; the bot is loaded with the club's baseline data (table layout, prices, policies, FAQs); it runs 24/7. From then on the club brain learns from manager takeovers, the club's POS is connected where the vendor allows it, and the manager works from one dashboard across channels with alerts and stats | Median onboarding call **≤ 15 min** (LINE connected, booking flow working with the club's real tables and prices, core FAQs live, staff logged in). **No code change and no deploy** per club. Founder time per club outside the call (checking the form, entering data, the dry run, watching night 1) is recorded for every club, from form received to the end of the first week, and reported beside the call time. The target is set after the first three clubs (§16.1) |
| **P2** | **Founder admin console** | One place where we add clubs, manage club data, run onboarding, open any club's dashboard to help, and debug any problem. This is how support stays fast as the number of clubs grows | A founder can find the cause of a reported problem (a message that got no answer, a failed send, a stuck booking) in **< 5 min** without database or server access. Every founder access to a club is logged |
| **P3** | **Demo club: Velora** | A fictional club that we own, used to demonstrate the whole product to prospective clubs: guest booking on a real phone, the staff dashboard, the inbox, the club brain learning, and the founder console | The full demo script (§12.4) runs in **≤ 10 min**, resets with one click, and falls back to the browser simulator when LINE or the phone signal is unavailable. The simulator still needs an internet connection to our server |
| **P4** | **Data first** | Everything the platform does is recorded as it happens. The data improves the bot, powers reports, supplies marketing, and feeds a separate app that predicts which club is busiest | **100%** of booking status changes have a matching event (checked nightly, §14.2). Every event type listed in §14.2 is live by the phase that delivers its feature. The signals that cannot be rebuilt later (§14.3) are captured from the first real guest |

**What "live in 10–15 minutes" covers, and what follows it.** P1 has six parts. Two finish on the call, and four start on the call and mature afterwards. §12.2 gives the minute-by-minute script.

| Part | On the call | After the call |
|---|---|---|
| LINE account connected to the bot | Yes, about 8–10 minutes | — |
| Bot loaded with club data | Yes, from a form the club fills in beforehand | Remaining FAQs within the first week |
| Bot runs 24/7 | Yes (hosted service, §13) | — |
| Club brain learns from takeovers | Switched on | Grows with every approved answer (§8.3) |
| POS connected | Manual level for every POS | Live sync where the POS has an open API (§11.3) |
| One dashboard across channels | LINE | Instagram once our Meta app is approved (§11.5) |

### 3.2 Product goals (what success looks like)

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
| **G9** | The bot answers questions **without a takeover** | Deflection rate: the share of free-text conversations that are deflected (defined below the table) | **≥ 50%** by week 4 after the club's brain goes live (Phase 2; not measured in the Phase 1 pilot). The brain starts thin; the rate rises towards 70–80% |
| **G10** | The same question is **not taken over twice** | Takeovers on a topic that already has an approved brain note | **< 10%** of takeovers, measured from Phase 2 |

**How G9 and G10 are counted.** A **free-text conversation** is a run of guest messages on one channel that contains at least one typed question, with no gap longer than 6 hours. The 6 hours is a default to confirm on pilot data (§16.1). The conversation is **deflected** when no takeover starts during it and the bot's last message is an answer, not the fallback menu. A **topic** is one of the template pack's headings (§8.2) or "other". The live AI call (§8.6) sets the topic, and it is copied to the takeover record (`handoff_episodes`, §9) when a takeover starts. For G10, the takeover also records the live note that already covered that topic, if there was one. G9 and G10 need the club brain, so they are measured from Phase 2 (§10).

### 3.3 Business goals

| # | Goal | Measure |
|---|---|---|
| **B1** | House of Savoy keeps using it after the pilot and pays for it | Signed paid contract by end of pilot |
| **B2** | Prove the product works beyond one club | 3 paying clubs within 3 months of pilot end |
| **B3** | A new club is onboarded in one short call | **≤ 15 minutes** on the call, no code change, no deploy (P1) |
| **B4** | Unit economics work | LINE message costs + infrastructure + slip verification + AI cost < **15%** of revenue per club |
| **B5** | The data is an asset from the first club | Every club's history is complete from its go-live date: events, booking pace, door counts (§14.3) |

### 3.4 Non-goals (explicitly out of scope)

- Holding or moving guest money. Deposits go **directly to the club's account** (see §11.2).
- Replacing the club's POS, accounting or payroll.
- Card payments in Phase 1 (PromptPay transfer only).
- A full guestlist product in Phase 1. Door counts by guest type are in scope (§14.3).
- Building our own inbox, or our own Instagram and WhatsApp connectors. We build on an existing open-source inbox (§6.3).
- Building the consumer busyness app in this codebase. This platform **feeds** it through one API (§14.7). The app itself is a separate product.
- Publishing learned answers without a manager's approval (§8.3).
- A promise of live sync with every POS. Every POS works at the manual level. Live sync depends on the POS vendor (§11.3).

**Removed from the v1 non-goals:** "a consumer app or marketplace", "cross-club guest profiles" and "live crowd ratings (Pulse), parked". The busyness app and a platform-level guest identity are now part of the plan (§14.4, §14.7).

---

## 4. Users and roles

| Role | Where they work | Can do |
|---|---|---|
| **Guest** | The club's LINE OA (chat + in-LINE booking pages) | Book, pay deposit, view/change/cancel own booking, ask for a human |
| **Host** (reservations staff) | Dashboard (phone/tablet/laptop) + staff LINE group | See and manage bookings, take over chats, approve slips, create manual bookings, check guests in |
| **Door staff** | Door check-in screen on a phone | Scan the guest's QR code, check guests in, see table and party size |
| **Promoter** (Phase 3) | Personal booking link/QR + limited dashboard | Share their link, see their bookings and commission |
| **Manager / owner** | Dashboard | Everything a host can do, plus: tables, pricing, rules, deposit policy, staff accounts, reports, integrations |
| **Platform admin** (founding team) | Founder console (§12.3) | Add and configure clubs, run onboarding, open any club's dashboard through a logged support session, debug, pause a club's bot, read the data dashboard (§14.6) |
| **Busyness app** (a machine, not a person) | Busyness feed API (§14.7) | Read club-level busyness levels. Nothing else |

One person can belong to several clubs (an owner with two venues), so staff accounts are **per person**, with a role per club. A shared staff password is not acceptable once a second club exists (§13.1).

---

## 5. Guest experience

### 5.1 Ways a booking starts

| Entry point | What happens |
|---|---|
| Guest adds the OA | Club's greeting (we take over sending it) + **[Book a table]** button |
| Rich menu **Book a table** | Starts the flow at step 1 |
| Typed message containing a booking keyword (EN/TH: *book, table, reserve, จอง, โต๊ะ, ...*) | Starts the flow at step 1. In Phase 2, the AI pre-fills whatever the message already contains |
| Promoter link or QR (Phase 3) | Starts the flow with the promoter attached to the booking |
| Club's Instagram / website link | Opens the club's LINE account, where the guest taps **Book a table**. The link goes through our redirect, so the tap is counted (§14.2) |

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
  - optional: date of birth, occasion (birthday, etc.) and a special request (free text, max 200 characters)
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
- The staff LINE group (when new-booking alerts are on for the club, §6.1) gets: *"✅ New booking · 17A · Sat 29 · 6 pax · ฿5,000 paid · Ari (TH) · 08x-xxx-1234"*.
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
| **Unrecognised message** (Phase 2) | The AI works out what the guest wants (§8). If it cannot tell, it shows the menu above (§8.5). |
| **Sticker / image that isn't a slip** | Polite menu reply. Images during the payment step are treated as possible slips. |
| **Guest already has a booking** | *"My booking"* shows it with [Change party size] [Running late] [Cancel] [Talk to a host]. Changing table or night goes to a host in Phase 1. |
| **Outside booking hours / club closed** | The bot still works 24/7. Handoff replies say when a host will be available: *"Our hosts are online from 18:00."* |
| **Guest blocks the OA** | Upcoming bookings stay. The host is flagged that the guest can't be messaged. |
| **Language** | Thai or English, matched to the guest's LINE language setting, with a switch available in the menu. Chinese can be added per club later. |

### 5.4 Tone

- Short, warm and confident, written in the club's voice, which is configurable per club (e.g. formal *ค่ะ/ครับ* vs. casual).
- Never invent anything. Prices, availability and rules always come from the system, not from wording templates or the AI.

### 5.5 Data notice at first contact

- The greeting a guest gets when they add the OA carries one line and a link: chats and bookings are stored and used to run the service, to improve the answers, and for analytics and marketing by the club and by us.
- The guest details form (step 4) shows the same notice above the submit button.
- The rule is: the first bot reply to any guest with no `notices` row for the current notice version on that channel carries the notice line and link, whatever the entry point. The record is written with that reply and `notice.shown` is recorded. This covers people who followed the club's LINE account before we connected (they never get our greeting), Instagram guests (Instagram has no greeting) and every later channel.
- The rich menu also carries a permanent Privacy link to the same notice.
- The system records which **version** of the notice each guest was shown, when, and on which channel (`notices`, §9). This record is what lets the data be used later, so it is written from the first real guest.
- `accepted_at` is set, and `notice.accepted` recorded, when the guest submits the details form with the notice displayed. A guest who only chats has `shown_at` only.
- A guest can stop marketing messages at any time by typing *stop* (EN/TH keywords) or from the menu. The opt-out applies at once and to every later send.
- We are the data controller for the platform's data (§13). The notice text is ours, with the club's name inserted.

---

## 6. Staff experience

### 6.1 Staff LINE group (notifications)

Each club links one or more staff LINE groups. Which of the messages below reach the group is set per club.

- **Phase 1 (the pilot):** all of them go to the group. Each one is counted once per group member (§11.1.4).
- **From Phase 2:** the default follows the alert level (§6.4). Only the urgent ones go to the group: payment needs review, guest wants a human, not arrived at release time. The others go to the dashboard feed unless the club switches their LINE alert on.

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

**Chats (handoffs)**
- In Phase 2 this page is replaced by the inbox (§6.3).
- Chats waiting for a human, oldest first, with summaries.
- A host can **reply from the dashboard** (we send it through the API) or reply in LINE OA Manager on their phone (see §11.1.3), then hand the chat back to the bot with [Mark resolved]. Replies typed in the LINE app are not recorded and not learned from (§6.3).

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
- **Staff:** invite by email, assign a role per club. A second factor for managers is added later (§13). A lower-friction sign-in for hosts is an open question (§16.1, question 6).
- **Integrations:** LINE channel status, PromptPay ID, slip-verification service, POS (manual entry in Phase 1; report import and live sync in Phase 3).

### 6.3 One inbox across channels

The club works from **one inbox** for every channel, with the guest's bookings shown beside the chat (LINE from the start; other channels once the guest is linked, §11.5). We do not write this inbox ourselves. We run one self-hosted install of **Chatwoot Community Edition** (open source) and connect our bot to it.

**How it is wired**

- **LINE stays ours.** LINE allows one webhook address per account, and our server keeps it. An inbox placed in front of LINE would drop the button taps and date picks the booking flow depends on, and would send every bot message as a paid push. So our server receives every LINE event, runs the bot, and **mirrors** each guest message and each bot message into that club's inbox.
- **Staff replies come back to us.** When a host replies in the inbox, the inbox calls our server. We send the reply to the guest on LINE and record it as a **takeover turn**, paired with the guest's question. That pair is what the club brain learns from (§8.3).
- **Instagram** uses the inbox's built-in Instagram connection on our own Meta app (§11.5). The bot attaches to it as an agent. WhatsApp, Messenger and a web chat widget follow the same pattern later.
- **One inbox account per club**, created by the onboarding tool through the inbox's admin API. Managers open it from our dashboard with a single sign-on link and never see a second login. Our booking and table panel is embedded inside the inbox next to each conversation.

**Bot and human in the same conversation**

| Conversation state | Who answers | How it changes |
|---|---|---|
| **Bot** | The bot | Default |
| **Human** | A host. The bot is silent | Guest asks for a person, the bot cannot answer from the brain (§8.5), or a host opens the chat and replies |
| **Resolved** | The bot again | Host presses [Mark resolved], or the per-club timeout passes with no staff activity (it re-alerts first, §5.3) |

Our server sets these states. It posts bot messages under the bot's own identity, and ignores the echoes of messages it created itself, so a bot message is never mistaken for a host's reply.

**The rule that makes learning work: hosts reply in the inbox.** A reply typed in the LINE app (LINE OA Manager) never reaches any API. LINE sends no event for messages the account itself sends, and offers no way to read them back. Those replies cannot be learned from and do not appear in the club's stats.

| | Reply in our inbox | Reply in the LINE app |
|---|---|---|
| Recorded, shown in stats, learned by the brain | Yes | No |
| Cost | A counted push message (§11.1.4) | Free |
| Works if our system is down | No | Yes |

So LINE chat stays switched **on** in the club's LINE settings as the fallback for an outage, and the club agrees at onboarding that day-to-day replies go through the inbox. The onboarding wizard reads the club's chat setting and its message plan and warns if the plan is too small (§12.2).

Until the inbox ships (Phase 2, §10), the existing Chats page in our dashboard does this job for LINE, with the same rule.

### 6.4 Alerts: when the manager is needed

The manager should hear about the chats that need them and nothing else.

| Level | Examples | Where it shows |
|---|---|---|
| **Urgent** | Guest asks for a person · the bot handed the chat over because it could not answer (§8.5) · complaint or safety word detected (a Thai and English word list we maintain, editable per club, §8.1) · payment needs review · table not arrived at release time · bot error · LINE disconnected or quota exhausted | Inbox notification **and** staff LINE alert |
| **Needs input** | A gap is waiting for a written answer (§6.6) · a drafted brain note is waiting for approval | Inbox notification and a counter on the dashboard |
| **Information** | New confirmed booking · running late · cancellation · daily summary | Dashboard feed. LINE alert only if the club switches it on |

A push to a LINE **group** is counted once **per member**: one alert to an 8-person staff group costs 8 messages. So from Phase 2, by default only urgent alerts go to the staff LINE group, and the rest use the inbox's own notifications, which cost nothing.

This relies on the inbox's notifications reaching the manager's phone. That has not been tested on our self-hosted install (§16.1). If they prove unreliable, needs-input items go to the manager alone as one batched LINE message a day (one counted message), not to the group.

### 6.5 Stats for the club

One page, per club, for any date range:

- **Bookings made by the bot** against manual bookings, and the share completed with **no staff message** (G1).
- **Deflection rate** (G9) and **takeover rate by topic** (both defined in §3.2), so the manager sees which questions still need a human.
- Median time to first response (G2), handoff response time (G8), booking time (G5).
- Deposits collected, minimum spend booked, no-show rate (G6).
- Messages by channel (LINE, Instagram), push quota used against the plan, and AI cost against the club's cap.
- The funnel and the weekly club report (§14.10).

### 6.6 Brain (manager)

- **Notes:** every answer the bot can give, readable and editable as plain text, grouped by type (FAQ, policy, layout, event, learned). Each note shows where it came from and when it was last reviewed.
- **Approval queue:** answers drafted from takeovers, each with the guest's question, the host's reply and the proposed note. [Approve] [Edit] [Reject]. Ranked by how often the topic caused a takeover.
- **Gaps:** questions the bot could not answer, most frequent first, with [Write an answer].

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

## 8. AI layer and club brain

**Purpose:** understand free-text messages in Thai and English, pre-fill the booking flow, answer questions from the club's own knowledge, and learn new answers from the club's hosts. **The AI never confirms a booking, sets a price or promises a table.** Those come from the booking system only.

### 8.1 What the AI does

| Capability | Example | Output |
|---|---|---|
| Extract booking details | *"โต๊ะ 6 คน เสาร์นี้ ใกล้ดีเจ"* (table, 6 people, this Saturday, near the DJ) · *"17A sat 6ppl"* | `{date, pax, table_code?, zone_pref?}` → jumps to the right step with the values filled in |
| Detect intent | *"can i bring my own cake"*, *"what time do you close"*, *"I'm running late"* | Routes to an answer, My booking, or a host |
| Answer questions | Dress code, parking, age, location, music tonight | Answered **only from the club brain**. If the answer is not there, the chat goes to a host and the question is logged as a gap |
| Summarise for a handoff | A long, messy chat | A 2-line summary for the host |
| Draft a new brain note | A resolved takeover | A proposed note for the manager to approve (§8.3) |
| Flag urgent messages | A complaint, or a message about a guest's safety | Marks the conversation urgent and hands it to a host (§6.4). Matched against a Thai and English word list that we maintain and each club can edit |

### 8.2 The club brain

Each club has its own brain: the set of notes the bot may answer from. It is written in plain language, so a manager can read and correct it.

**Storage**

- Notes are rows in our database (`brain_notes`, §9), scoped to one club, versioned, with a status: draft, live or retired.
- The body of a note is **plain markdown with links between notes**, the format the Obsidian note-taking app uses. A club's whole brain can be exported as a folder of files that opens in Obsidian, and imported back.
- We borrow the format and do not build on the Obsidian app itself. The database gives per-club isolation, approval states and an audit trail, which a folder of files does not.

**Seeding at onboarding (the baseline)**

- **Template pack:** about 25 standard nightclub questions with blanks (dress code, age, parking, opening hours, entry fee, cake and decorations, lost property, bottle keep, cancellations). The club fills the blanks in the pre-call form (§12.2).
- **Paste or photo import:** the club pastes existing text (a pinned message, a rules page) or uploads a menu or house-rules image. The AI turns it into draft notes for review.
- **Layout notes are generated, not typed:** zones, capacities and which tables are near the DJ come from the tables the club entered. They update when the tables change.

**How the bot reads it**

- A club's whole brain is small (about 5,000–50,000 tokens), so **all of it goes into every AI request**, stored in the provider's prompt cache. There is no search index and no embeddings.
- The brain is compiled into one fixed text whenever a note is approved or expires, so the cached part stays identical between requests.
- Size limit: warn the manager at 40,000 tokens, hard cap at 60,000. A club that outgrows the cap gets a note index and a "read this note" tool. Still no vector search.

### 8.3 Learning from takeovers

1. **Trigger.** A takeover is resolved and the host sent at least one reply that we recorded: through our inbox on any channel, or typed in the Instagram app (§6.3, §11.5).
2. **Redact.** Phone numbers, names, LINE IDs, booking references and slip details are removed from the transcript.
3. **Draft.** The AI reads the transcript and the current brain and returns a structured result: is this worth learning; is it a new note or an edit to an existing one; the question in Thai and English; the proposed answer; flags for *contains a price or availability*, *contains personal data*, *one-off exception*; and any existing note it contradicts.
4. **Discard automatically** any draft flagged as price, personal data or one-off exception.
5. **Approve.** The draft is in the manager's approval queue (§6.6) within 60 seconds of the takeover being resolved, with [Approve] [Edit] [Reject]. One tap.
6. **Live.** An approved note is in the compiled brain within 10 seconds. The original question is added to that club's test set (§8.5). The test set runs afterwards and alerts us if it fails; it does not delay the note.

**A manager approves every learned note before the bot uses it.** A host's reply can be wrong, or right only for that guest (a deposit waived for a regular). Prices quoted in chat go stale. A guest can also write text designed to plant a false fact. One tap keeps these out. Drafts nobody reviews expire after 4 weeks.

Only **host-written** messages are learned from. The guest's text frames the question and is never treated as a fact or an instruction.

**Limit to state plainly to every club:** on LINE, the brain learns only from replies sent through our inbox. Replies typed in the LINE app are invisible to us (§6.3) and teach it nothing.

### 8.4 Keeping the brain correct

| Problem | Rule |
|---|---|
| **Prices and availability** | Never stored in the brain. A note containing an amount near "minimum spend", "deposit", ขั้นต่ำ, มัดจำ, ฿ or บาท is blocked on save, with a link to the pricing screen. In a bot answer, any amount, table code or "available" claim must match a booking-system result from the same turn. If it does not, the answer is replaced by the button flow or a handoff |
| **Out-of-date notes** | Event and promotion notes need an end date. Other notes are reviewed every 90 days by default. Expired notes leave the brain automatically and appear in a weekly digest |
| **Contradictions** | The approval screen shows "replaces note X" as a before-and-after. A weekly check reads the whole brain for contradictions, duplicates, leaked prices and personal data |
| **Which source wins** | Booking system result, then policy note, then FAQ note, then learned note. An unresolved conflict goes to a host |
| **A bad answer in the wild** | A takeover within 10 minutes of a bot answer flags the notes that answer used for review |
| **Two languages** | One source note in the manager's language, with the question phrased in Thai and English. The bot answers in the guest's language. Text with legal weight (non-refundable deposit, house rules) stays as approved Thai and English pairs and is quoted word for word |

### 8.5 Guardrails

- The model works through a fixed set of tools (`check_availability`, `start_booking`, `get_booking`, `request_handoff`). Tools take the club and the guest from the server's session, never from what the model writes. No tool can set a price, waive a deposit or confirm a booking.
- The live call returns a fixed result, not a score: the answer, the language, the notes it used, `needs_handoff` and the topic. There are three outcomes and no fourth:
  - **(a) The bot cannot tell what the guest wants.** It shows the button menu and does not guess. No handoff. `bot.fallback_menu` is recorded.
  - **(b) The bot understands the question but the brain has no answer, or the answer fails the price check and no button flow fits (§8.4).** The chat goes to a host with the reason recorded, and `faq.missed` is recorded.
  - **(c) Otherwise** the bot answers.
- Guest text is treated as data. Instructions inside guest messages are ignored.
- **Test set per club:** Thai, English, mixed and romanised-Thai questions, plus attempts to trick the bot. It runs on every brain change and every model change.
- All AI replies are logged with the notes they used. In week 1 of a new club, a host reviews a sample every day.
- Cost cap per club per month, with an alert before the cap.

### 8.6 Models and cost

| Job | Model | Why |
|---|---|---|
| Live answer, extraction and routing (one call per message) | `claude-haiku-5-5` | Fast and cheap. Reads the whole brain from cache |
| Handoff summary | `claude-haiku-5-5` | Short, low risk |
| Note drafting | `claude-opus-5-5`, called directly when a takeover is resolved. The draft is in the approval queue within 60 seconds (§8.3) | Low volume, mistakes are costly |
| Weekly brain check | `claude-opus-5-5`, batch mode | No time pressure |
| Sampled quality review | `claude-sonnet-5-5`, batch mode | Judges a sample of answers |

- **Estimated AI cost: about US$37–62 per club per month** at 3,000 guest messages, 300 takeovers and a brain near 20,000 tokens. Note drafting is a direct call, so it costs twice the batch price for that part (about US$34 instead of US$17).
- **The cost grows with the brain**, because note drafting reads the whole brain each time. Near 50,000 tokens the total is about **US$92–102**: US$55–65 at batch prices, plus about US$37 more for drafting directly. If the drafting cost grows, give the note drafter the note index in place of the full brain (§8.2).
- These are estimates, not measured on real traffic. They do not yet include three known multipliers: the current tokenizer's roughly 30% higher token counts, Thai token density, and the fast model's thinking output, which is on by default and billed as output.
- **Thai answer quality on the fast model has not been measured.** Before choosing it, run a 100-question Thai/English/mixed test. If it fails, live answers move to `claude-sonnet-5-5`, which costs roughly 20 times more for that job (up to about US$435–540 per club per month if the cache is cold).
- Measure token counts on real Thai samples before quoting a club.

### 8.7 What must exist in the code first

The learning loop depends on four things the code does not have today. All four are built in Phase 1b (§10); items 1 and 4 are also security fixes (§13.1).

1. **Per-person staff accounts**, so a reply and an approval have an author.
2. **An author on every message** (guest, bot, staff, system). Today a host's reply is stored exactly like a bot message.
3. **A takeover record** (`handoff_episodes`) with a start, an end, who resolved it and which messages it covers. Today resolving a chat erases the handoff fields. The timeout fires only when the guest writes again, so a quiet takeover never ends. It needs a timed close (§13.1 row 12).
4. **Club scope on the reply and resolve actions.** Today they accept any club's conversation.

---

## 9. Data model (core)

```
clubs(id, name, slug, timezone='Asia/Bangkok', default_lang, tone, status, created_at)
line_channels(id, club_id, channel_ref, channel_id, liff_id NULL, rich_menu_id,
              webhook_path, status)    -- LINE-only settings; channel_ref points to channels.id (v2 block)
              -- secrets are in club_credentials (v2 block); no long-lived access token is stored (§11.1.2)
              -- liff_id is set only when a club has its own LINE Login channel (§11.1.1)
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
         verified_by[auto|user_id], verified_at)

conversations(id, club_id, guest_id, mode[bot|human], handoff_requested_at, assigned_user_id,
              resolved_at, summary)
messages(id, conversation_id, direction[in|out], kind[text|image|sticker|postback|flex],
         payload jsonb, line_message_id, sent_via[reply|push], created_at)      -- retention: life of the club's account (§14.9)

pos_links(id, club_id, provider[wongnai_foodstory|papaya|loyverse|other], status, settings jsonb)
         -- the key is in club_credentials (kind=pos, v2 block)
pos_bills(id, booking_id, provider_bill_id, opened_at, closed_at, total_satang, synced_at)

audit_log(id, club_id, actor_type, actor_id, action, entity, entity_id, before jsonb, after jsonb, at)
```

**Added in v2** (`+` means new columns on a table above)

```
-- People, access, support
users(id, email UNIQUE, name, password_hash, platform_role NULL|admin, totp_secret,
      disabled_at, last_login_at, created_at)                 -- replaces v1's staff_users
club_memberships(user_id, club_id, role[owner|manager|host|door|promoter], UNIQUE (user_id, club_id))
sessions(id_hash, user_id, created_at, expires_at, revoked_at, ip, user_agent)   -- server-side, revocable
support_grants(id, user_id, club_id, reason, ticket_ref, mode[read|write],
               started_at, expires_at, ended_at, ip)          -- a founder's access to one club
audit_log   + actor_type[guest|bot|staff|platform|system], actor_id, session_id,
              support_grant_id, reason, ip                    -- club_id nullable for platform events

-- Clubs and channels
clubs       + status[onboarding|live|paused|demo], bot_paused, created_by
club_profile(club_id, capacity_standing, capacity_seated, lat, lng, district, venue_type,
             genres[], price_band, opening_hours jsonb, usual_peak_hour, licence_type,
             crowd_mix, guestlist_offered, pos_vendor, go_live_at)
club_credentials(id, club_id, kind[line_messaging|line_login|instagram|pos], ciphertext,
                 key_ref, last4, set_by, set_at)              -- encrypted; never returned by any API
channels(id, club_id, kind[line|instagram|whatsapp|web], external_id, status, connected_at)
             -- one row per connected channel of any kind; line_channels holds the LINE-only settings for a kind=line row
tables, price_rules  + valid_from, valid_to                   -- so past nights keep their real inventory
nights      + closed_reason, event_type, lineup                 -- a row for every night, open or closed (§14.3)

-- Chat
messages    + author_type[guest|bot|staff|system], author_id, channel_id, occurred_at,
              sent_via[reply|push|none], delivery_status[sent|failed|skipped], error
handoff_episodes(id, club_id, conversation_id, started_at, ended_at, trigger, reason,
                 resolver_user_id, first_message_id, last_message_id, ended_by[staff|timeout],
                 topic, matched_note_id)
notices(id, club_id, guest_id, purpose, text_version, channel, shown_at, accepted_at, withdrawn_at)

-- Club brain
brain_notes(id, club_id, slug, title, type[faq|policy|layout|event|learned],
            status[draft|live|retired], body_md, frontmatter jsonb,
            source[onboarding|manual|takeover|import], source_episode_id,
            approved_by, approved_at, valid_from, valid_until, review_by, supersedes_id)
brain_note_versions(id, note_id, body_md, edited_by, edited_at)
brain_snapshots(id, club_id, version, compiled_text, token_count, hash, created_at)

-- Bookings: history and outcomes
guests      + birth_date NULL                                 -- optional, from the booking form (§5.2 step 4)
guests      + channel_id, external_user_id                    -- the guest's ID on that channel; line_user_id stays for LINE
guests      + is_test                                         -- simulator guest, registered tester, or any guest of a demo club
bookings    + occasion, arrived_at, arrived_pax, cancelled_at, cancel_reason_code, no_show_at,
              released_at, running_late_minutes, attempt_id, is_test
              -- source widened: line|instagram|manual_phone|manual_walkin|promoter|web
booking_status_history(id, booking_id, from_status, to_status, at, actor_type, actor_id, reason_code)
pos_bills   + club_id, table_code, covers; booking_id becomes NULLable (walk-in bills)

-- Data platform (§14)
raw_webhooks(id, club_id, channel, received_at, body jsonb, signature_ok,
             processed_at, error)                              -- written BEFORE we answer 200
events(seq, id, occurred_at, recorded_at, club_id, type, v,
       actor_type[guest|bot|staff|platform|system], actor_id,
       channel, data_origin[first_party|line_chat|line_profile|instagram|pos],
       source, guest_id, person_id, conversation_id, booking_id, table_id, zone_id,
       night_date, attempt_id, cause_id, lang, props jsonb, raw jsonb,
       is_test, dedupe_key, UNIQUE (club_id, dedupe_key))
events_dead_letter(id, received_at, payload jsonb, error)
ops_events(id, club_id, kind[webhook_bad_signature|webhook_unknown_club|bot_error|
           send_failed|line_setup|login_failed], detail jsonb, at)
occupancy_snapshots(club_id, night_date, taken_at, lead_bucket, tables_active, tables_held,
                    tables_confirmed, tables_arrived, pax_booked, min_spend_booked_satang,
                    deposits_verified_satang)
door_counts(id, club_id, night_date, at, delta, kind[table_guest|guestlist|walk_in|ticket], user_id)
crowd_ratings(id, club_id, night_date, at, level, user_id)     -- staff "how full now?" 1–5
calendar_days(date, kind[public_holiday|holy_day|alcohol_ban|election|city_event], name, notes)
identity_map(person_id, club_id, guest_id, platform_line_sub, phone_hash, first_linked_at)
removal_requests(id, club_id, guest_id, requested_at, channel, completed_at, completed_by)   -- §14.9
```

- `events.props` holds only coded values (enums, ids, counts). Free text, names and phone numbers go in `events.raw` and in `guests`, so they can be removed for one guest without losing the event (§14.9). The analytics area and the data dashboard read `events` through a view that leaves `raw` out (§14.5).
- `is_test` marks rows created by the demo club, the simulator or an onboarding test. It is set on the guest (a simulator guest, a registered tester, or any guest of a demo club). `bookings` and `events` copy it. Every other table takes it from its guest, booking or club. Three rules:
  1. Test rows of any club never reach a cross-club view, the aggregate area or the production busyness feed.
  2. In a real club, a test row never blocks a table for a real guest (the uniqueness rule on table and night applies to real and test bookings separately) and never appears in the club's reports. Once the club is live, test rows are also hidden from staff views. During onboarding staff see them, so the live test on the call is visible (§12.2).
  3. In a club with status **demo**, every row is a test row and behaves normally inside that club: it blocks the club's tables, appears on the club's own stats page, and feeds a Velora-only board in the data dashboard. That board reads Velora's events directly, not the aggregate area (§12.4).

- Money is stored as integer **satang**.
- Every club-owned table carries `club_id`, directly or through its parent row (`deposits`, `messages`, `booking_status_history` and `brain_note_versions` belong to a booking, a conversation or a note). Every query on them is scoped by club (multi-tenant isolation, §12).
- Platform-level tables (`users`, `sessions`, `calendar_days`, `events_dead_letter`) have no `club_id` and are never reachable from a club-scoped route. `audit_log.club_id` is empty only for platform events.

---

## 10. Phases and scope

| Phase | Scope | Exit criteria |
|---|---|---|
| **0: Demo** (own test OA, fictional club) — **built** | Steps 1–7 with buttons, PromptPay QR + manual slip approval, basic dashboard (tonight + bookings + manual booking), staff group alerts, handoff | Team completes 50 test bookings with no double booking. Ready to demo to clubs |
| **1a: Live on LINE** (own test OA, real phones) — **built, not yet run against a real LINE account** | One-command go-live (`npm run live`): tunnel, webhook set + tested, bilingual rich menu, LIFF endpoint auto-update, every message type validated by LINE, quota readout. LIFF ID-token check. Unfollow handling. Group join instructions. LINE status + "Run LINE setup" in the dashboard | 20 bookings made from real phones (iOS + Android, TH + EN) with no staff help and every webhook delivery handled. Staff group receives every alert |
| **1b: Platform base** (before any real club) | **Security fixes (§13.1).** Per-person accounts, server-side sessions, club check on every route. An author on every message and a takeover record (`handoff_episodes`) with its start, end and resolver. The handoff timeout runs on a timer and re-alerts before handing back to the bot (§8.7, §5.3). Club credentials entered at runtime and encrypted; LINE stateless tokens. **Shared LIFF app** under our provider: LINE Login channel created and published (publishing cannot be undone), first-use identity mapping (§11.1.1), and the device test of `liff.sendMessages()` across providers (§16.1, question 3). **Founder console v1** (§12.3): club list with health, create and configure a club, LINE connection wizard, support sessions, webhook and message logs, conversation and booking timelines, event stream, data health, club status and bot pause, global stop, the simulator behind founder login, and a second factor for founder accounts. **Data collection** (§14.2): `events` + `emit()`, raw webhook stored before the reply, booking status history, entry-point tags, notice records, `is_test`, dated tables and prices (`valid_from`, `valid_to`), the club profile, a `nights` row for every night and the city calendar (§14.3). The identity map (§14.4) and the four access areas (§14.5). **Velora** demo club with one-click reset (§12.4): demo steps 1, 2, 4 and 7. Hosted on a real server and real Postgres (24/7) | A second club is created from the console and takes a signed webhook **with no deploy**. The `liff.sendMessages()` test across providers has been run on a device and its result recorded. The isolation tests pass. The nightly check finds every booking state change in `events`. A host reply and a bot message are stored with different authors. A resolved takeover leaves a `handoff_episodes` row. A takeover with no staff activity re-alerts and times out even if the guest sends nothing more. Velora demo steps 1, 2, 4 and 7 and the one-click reset work on a real phone. In this phase step 4 is run by asking for a person and is answered from the Chats page (§12.4) |
| **1: Pilot build, then pilot run** (House of Savoy, 4 weeks) | Everything above + automatic slip verification, reminders, running late / cancel, **door screen** (QR scan, actual party size, door clicker by guest type), no-show handling, settings UI, TH/EN, club's greeting and rich menu migrated. Occupancy snapshots, staff crowd rating, **data dashboard v1** (§14.6). **Busyness feed v0** (§14.7): the API serving week-0 booking heat for the pilot club, plus a sandbox key that returns only Velora's levels, marked as test and never mixed with real clubs, so the separate app can integrate. Guest removal job and marketing opt-out keyword (§14.9, §5.5). Webhook replay, test message and the extra checks on the three sensitive changes in the founder console (§12.3). The pre-call club form (§12.2) as a plain form; we enter its answers through the console's bulk edit (Phase 1b). POS at level L0a, manual entry (§11.3). Start **Meta business verification** and create the Meta app now. To be able to submit **app review**, also stand up a minimal install of the inbox early, with Instagram connected to our own tester account, and make one logged API call per permission (§11.5). Review cannot be requested before that. Together these are the longest lead item | Goals G1–G8 measured. Club agrees to continue. Onboarding call for the pilot club timed against P1. In Phase 1 the FAQ part of P1 is the FAQ answers in Settings (§6.2); the brain's answers arrive in Phase 2. Velora demo step 8 works |
| **2: Brain and inbox** | **Club brain** (§8): baseline import, AI answers, takeover learning with the approval queue, gaps list. **Inbox** (§6.3) with the LINE bridge. Alert levels (§6.4). Club stats page (§6.5). The pre-call form loads straight into the club record, and the wizard gains the baseline brain import and inbox account creation, so the whole of §12.2 completes in one call. Per-club feature switches (§12.3). Submit the Meta app review if it is not submitted yet (§11.5) | ≥ 85% of free-text booking requests correctly pre-filled (sample review). No AI-caused wrong prices or availability. G9 and G10 measured. Three clubs onboarded at ≤ 15 min each. The full Velora demo script (§12.4) runs end to end. Meta app review submitted |
| **3: Channels, POS and the busyness feed** | **Instagram** in the inbox (§11.5). **POS:** report import (L0b) with column mapping, and a ready-made Wongnai/FoodStory parser once a real export confirms the file has one row per bill (§16.1, question 13). Papaya live sync, Loyverse spend sync (§11.3). **Busyness feed v1** for the separate app (§14.7): per-club weekday baseline, door counts and crowd ratings, every live club. LINE's written answer to question 12 (§16.1) comes before the feed goes to the separate app. Promoter links + commission tracking, waitlist, bottle pre-orders, payment gateway option, guest CRM + VIP tags, reports | 3 paying clubs. One club live on Instagram. The feed publishes a level, or an explicit "no data", for every live club on every open night |
| **Later** | The extensions backlog (§19, [EXTENSIONS.md](EXTENSIONS.md)): loyalty, targeted offers, birthday specials, review requests and more | Chosen per item when there is demand |

**Why Phase 1b comes before the pilot.** Three of its parts cannot be added later without loss. The security fixes close holes that are open today (§13.1). The club check must exist before a second club shares the system. Data that is not captured on the night it happens cannot be rebuilt (§14.3).

**Phase 1 is built before it is run.** Everything in the Phase 1 scope is built and switched on before the pilot's first night. The door screen and clicker, occupancy snapshots and the crowd rating must be recording from the first real guest (§14.3).

---

## 11. Integrations

### 11.1 LINE

**11.1.1 What we use**
- **Messaging API** (webhook + reply + push) for all chat.
- **Rich menu API** for the club's menu. We manage it, with buttons the club controls in Settings.
- **Flex Messages** for table cards, summaries and confirmations. **Quick replies** and the **date picker action** for steps 1–2.
- **LIFF** (in-LINE web pages) for the table map, guest details form and My booking. LIFF needs a **LINE Login channel**. We use **one shared LIFF app under our own provider** for every club, so a club has nothing to create. What follows from that:
  - LINE user IDs differ between providers, so the ID the LIFF page sees is ours and the ID the club's webhook sees is the club's. On a guest's first form submit we verify the LIFF identity token against our channel and store the pair. Later submits must match it. This keeps the rule that a forwarded booking link cannot be used by someone else.
  - The shared LIFF gives us **one ID per person across all clubs**. We store it from day one (`identity_map.platform_line_sub`, §9). Because it is a LINE-issued ID, it is not used to link a person across clubs until LINE gives written permission (§14.4, §14.8, §16.1 question 12).
  - A per-club LINE Login channel stays available as an option (about 3–4 extra minutes of console work) for a club that wants its own name on the LINE consent screen.
  - **Tested in Phase 1b, before any club is connected:** that `liff.sendMessages()` works when the LIFF app's provider differs from the OA's provider (§16.1 question 3). If it does not, the details form still opens in the shared LIFF and the bot's next message is sent as a push (the fallback the code already has), which counts against the quota (§11.1.4).
  - **Known platform risk:** LINE recommends that new LIFF apps are built as LINE MINI Apps, and a LIFF app under a LINE Login channel cannot be migrated to a MINI App channel. Separately, LINE's documentation says the permission behind `liff.sendMessages()` may be disabled after a move from one LIFF app to another. Our fallback is the same counted push. We watch LINE's announcements and keep the booking form working as a plain web link (§15).

**11.1.2 Connecting a club's OA**

There is no one-click connection for LINE accounts in Thailand. (LINE's consent-based attach, "module channels", is sold only through LINE Marketplace in Japan and accepts only Japan and Taiwan.) The fastest path is two pasted values and three switches. The steps marked **manual** cannot be done by API.

1. **Manual, permanent.** The club's OA **admin**, on a desktop browser, opens LINE OA Manager and **enables the Messaging API**, choosing a provider. ⚠️ **The provider link can never be changed.** Default: a **provider owned by the club**, so the club is never locked to us. Record the decision in the contract.
2. **Manual.** The admin copies the **Channel ID** and **Channel secret** into our onboarding wizard. These are the only two credentials we need. We store them **encrypted** (`club_credentials`, §9) and no API or screen ever shows them again.
3. **Automatic, under a minute.** From those two values the platform issues short-lived access tokens on demand (LINE "stateless" tokens, valid 15 minutes, cached about 10), so nobody has to create a long-lived token in the console. It then: reads the account's details, sets the webhook to `https://api.<domain>/line/webhook/<club-slug>` and tests it, builds the rich menu, validates every message type the bot sends, and reads the message quota. Every incoming request is checked against the club's channel secret (`X-Line-Signature`).
4. **Manual.** In OA Manager's Response settings the admin switches **Webhook on**, **auto-response off** and **greeting off**, and checks the chat response method and response hours, which can also send automatic replies. LINE has no API to change these. The wizard watches the webhook switch and the chat setting and shows them going green. Auto-response and the greeting cannot be read at all, so the admin ticks them by hand and the last check is a **live test from a phone that has not added the account**: exactly one greeting on adding it, and exactly one reply to a message, prove the old greeting and auto-reply are off. We send the greeting from now on.
5. **Manual, can follow the call.** Staff alert group: switch on "Allow bot to join group chats" (in LINE Developers Console, off by default), create the group, invite the bot, and type the one-time link code.
6. **Automatic.** Plan check: the wizard compares the club's message plan with the expected volume and recommends an upgrade if needed (§11.1.4). Expected volume per month = bookings × 2 pushes + host replies sent from the inbox + group alerts × group size.

**Slower cases.** If the OA already has the Messaging API enabled under an agency's or another vendor's provider, the provider cannot be changed, the club may not be able to see its own channel secret, and connecting us displaces the existing tool. That is a migration and does not fit in 15 minutes. A first-time admin also meets a short developer registration screen in step 1.

**11.1.3 Chat coexistence and handoff**
- **Chat stays switched on in LINE OA Manager**, so hosts can still reply from their phones if our system is down. Day-to-day replies go through the inbox (§6.3). LINE's documentation confirms that **Chat and Webhook can both be on**. With Chat on, the chat response method and response hours can still send automatic replies, so the admin checks them during setup (§11.1.2 step 4).
- **Known limitation:** messages hosts send from OA Manager do **not** reach our webhook, so the system can't see them. That's why handoff mode ends with **[Mark resolved]** or the inactivity timeout, not by detecting a staff reply.
- Replies sent from our dashboard go out as **push messages** (they count against the quota, §11.1.4).
- **Consequence for the club brain:** it learns only from replies sent through our inbox (before Phase 2, the dashboard's Chats page) (§6.3, §8.3).
- A reply token lasts about one minute, so a host's typed reply is almost always a counted push.

**11.1.4 Message quota and cost**
- **Reply messages** (answering a guest message with its reply token) are free. Reply tokens are single-use and short-lived, so the system must reply quickly, including after the slip check.
- **Push messages** (reminders, async confirmations, dashboard replies, follow-ups) count against the club's monthly LINE OA plan quota. Plan sizes and prices must be checked for Thailand at onboarding.
- Design rules: prefer replies; batch information into one message; maximum **2 push messages per booking** by default (reminder + one other); the dashboard shows quota usage and warns at 80%.
- **Thailand plans** (LINE's Thai business site, prices exclude 7% VAT): Free, 300 messages a month · Basic, 1,280 THB for 15,000, then 0.10 THB each · Pro, 1,780 THB for 35,000, then 0.06 THB each.
- **Messages are counted per recipient.** A push to a group counts once for every member. An alert to an 8-person staff group costs 8 messages, so a Free plan is used up after about 37 alerts. This is why, from Phase 2, only urgent alerts go to the staff LINE group by default (§6.1, §6.4).
- **Replies typed by a host in the LINE app are free. Replies sent from our inbox are counted pushes.** A club that answers through the inbox needs the **Basic plan as a minimum**. The upgrade is bought by the club in OA Manager on the web.

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

### 11.3 POS: Wongnai POS / FoodStory, Papaya, Loyverse and others

**Goal:** when a booking arrives, the club's POS knows about it, and when the night ends, the actual spend comes back. That closes the loop: minimum spend tracking, real spend per guest, and accurate promoter commission.

**The promise we can keep:** *works with any POS; live sync where the POS allows it.* Every club gets the manual level inside the onboarding call. Live sync depends on whether the POS vendor has an API open to us.

**What we found (Nov 2026)**

| POS | Access | What we can do |
|---|---|---|
| **Wongnai POS / FoodStory** (LINE MAN Wongnai) | No public API, developer portal or partner sign-up. The known outside connections are accounting tools, and what they receive is a **daily sales file**, synced the next morning. The back office exports a sales report as CSV on request, emailed within 3 hours | **Manual level now.** Import the CSV report. Ask for partner access in parallel; no lead time is published. Wongnai sells its own reservations add-on, so write access is unlikely |
| **Papaya** (Bangkok POS, lists bars and nightlife) | Public API with a self-serve key, test sandbox and signed webhooks. Needs the club on Papaya's top plan (about US$149 per location per month). Papaya lists its own reservations product as coming soon, so access could narrow later | **Full live sync.** At check-in we open the bill on the table, pass the booking reference, and record the deposit as a payment already made. Papaya then tells us when the total changes, the table moves or the bill closes |
| **Loyverse** | Public API with a self-serve token and webhooks | **Spend only.** Paid receipts after they close. Open bills cannot be read or created |
| **Qashier, StoreHub, Ocha** | Access by request to the vendor; StoreHub limits its API to its top plan | Manual level until the vendor grants access |
| **Any other POS** | Unknown | Manual level |

No aggregator ("one API for many POS") covers Thai POS systems.

**Plan**

1. **Ask each club which POS it runs**, and on which plan, in the pre-call form (§12.2). Build connectors in the order the first 5–10 clubs need them, not in the order of vendor marketing.
2. Build POS support behind a **provider-agnostic adapter**, so one POS can be swapped for another and new ones added:
   ```
   interface PosAdapter {
     openBillAtCheckIn(booking, deposit)   // optional: open the bill on the table and record the deposit
     onBillUpdated(handler)                // optional: live total, table move, guest count
     fetchClosedBills(night): Bill[]       // required for spend sync
     matchBillToBooking(bill): booking_id  // table code + night + time window
     importReport(file): Bill[]            // report import (L0b): parse the POS's exported report
   }
   ```
3. **Integration levels** (we ship whichever the POS allows):

| Level | What happens | Needs | Available today |
|---|---|---|---|
| **L0a: Manual entry** | The dashboard and the staff alert show the booking reference and deposit, so the cashier enters the prepayment by hand | Nothing from the POS | Every POS |
| **L0b: Report import** | After the night, the club uploads the POS's sales report and we match it to bookings. Matching individual bookings needs a report with one row per bill showing the table and time. That is unconfirmed for the Wongnai/FoodStory report (§16.1, question 13). If the report gives only daily totals, this level yields a nightly total, not spend per booking | Nothing from the POS vendor. A one-time mapping of report columns and table names | Every POS that exports a sales report. A ready-made parser for the Wongnai/FoodStory CSV comes first |
| **L1: Read** | We pull closed bills after the night and match them to bookings by table and time. Actual spend shows on the booking and the guest profile | Read API or scheduled export | Papaya. Loyverse once we confirm its receipts carry a table, dining-option or note field to match on (unverified; expect imperfect matching) |
| **L2: Write** | Checking a guest in opens the bill on that table in the POS, with the deposit recorded as a prepayment | Write API | Papaya |
| **L3: Real time** | Bill total changes → minimum-spend progress shown to the host live. Bill closed → booking completed with spend | Webhooks | Papaya, for bookings checked in through us |

- L0a and L0b together are the **manual level**. L0a ships in Phase 1 and L0b in Phase 3 (§10).
- The bill is opened **at check-in**, not when the booking is confirmed. A POS has open tables, not future reservations.
- For live sync the host must check the guest in **through our dashboard**. A bill a cashier opens by hand in the POS is invisible to us until it closes.
- Matching rule for L1+: same table code, same night, bill opened within [arrival_by − 2h, closing time]. Ambiguous matches go to a host for confirmation. Table names in the POS are mapped to our table codes once, at onboarding.
- Loyverse takes one pasted token. Papaya takes two keys per outlet (Reservations and Order Data), each created with a label and our webhook address, plus a one-time match of Papaya's dine-in channels (one per table) to our table codes. Both are done after the onboarding call (§12.2), not inside it. Keys are stored encrypted like LINE credentials (§12.3).

### 11.4 Other integrations (later)

- **Google Sheets export** of tonight's bookings, for clubs that live in spreadsheets.
- **Instagram / website link** opening the LIFF booking page directly.
- **Accounting export** (deposit report) for FlowAccount / PEAK style tools.

### 11.5 Instagram and other channels

**Instagram**

- **One-time gate, ours:** our own Meta app must pass **business verification** and **app review** for Instagram messaging before any club's Instagram can connect. Until then only accounts added as testers on our app work. Meta's review needs a finished, testable app and one logged API call per permission before the request can even be submitted. **Start business verification in Phase 1, and bring the inbox's Instagram connection forward on a tester account so the review can be submitted** (§10). It is the longest lead item in the plan and no part of it is in our control.
- **Per club, after approval:** the person who can log in to the club's Instagram **professional** account completes one login screen inside the inbox. About 2 minutes. An Instagram account run by an outside agency will stall here.
- **What the bot can do on Instagram through the inbox:** text and attachments only. No buttons, quick replies or date picker. So on Instagram the bot answers questions from the brain and sends a **link that opens the club's LINE account** (the same link as in §5.1), where the guest taps Book a table and finishes the booking in LINE. This spec has no web-only booking flow. The link goes through our redirect, so the tap is counted as an Instagram entry (§14.2); matching it to the final booking is best effort. (Rich Instagram messages are possible later by calling Meta's API directly from our server.)
- **An Instagram contact and a LINE guest are separate records** until the guest identity merge in the backlog is built (§19). Until then the bookings panel beside an Instagram chat is empty.
- **Takeovers are fully visible on Instagram.** Meta sends an event for replies typed in the Instagram app, so the brain can learn from them. The LINE limit in §6.3 does not apply.
- Meta's messaging window applies: free-form replies within 24 hours of the guest's last message, and up to 7 days for a human agent's reply.
- **Instagram data stays with its club.** Meta's platform terms do not allow a provider to use one client's Instagram data for its own products or for another client. Instagram events are tagged at the source and kept out of the cross-club data and the busyness feed (§14.8).

**Later channels:** WhatsApp, Facebook Messenger and a web chat widget connect through the same inbox in the same way. Each has its own rules and costs, noted in the backlog (§19).

---

## 12. Multi-club setup, onboarding, founder console and demo club

### 12.1 Multi-club architecture
- One system serves every club. **Each club is data and settings, not code.** A club is created, configured and connected from the founder console with **no code change, no environment variable and no deploy**.
- Strict isolation: every club-owned record carries `club_id`, directly or through its parent row (§9). Access checks happen in the service layer on **every** route, including routes addressed by a booking, conversation or deposit ID. Database row-level security is the backup. Automated tests check that no user of club A can read or change anything of club B.
- Each club has its own LINE channel, webhook path, PromptPay ID, staff groups, settings, brain, inbox account and (optionally) POS link.
- The system runs as a **hosted service on real Postgres, 24/7**. The laptop-and-tunnel setup of Phase 1a is for development only.

### 12.2 Onboarding in 10–15 minutes

The call is short because the slow part, the club's own data, is collected **before** it. The LINE connection alone fits in about 8–10 minutes. No timing has been measured on a real Thai account yet; the pilot club's onboarding is the first measurement.

**Before the call (the club, in its own time)**

We send one link a day or more ahead. The club fills in:

- **Tables:** code, zone, capacity. Or uploads the floor plan image and we enter them.
- **Prices:** minimum spend and deposit per zone or table, and any weekday or event differences.
- **Policies:** opening nights and hours, arrival cut-off, cancellation and deposit policy, age, dress code, house rules (Thai and English).
- **FAQs:** the template pack of about 25 standard questions with blanks to fill (§8.2), plus anything the club pastes in.
- **PromptPay ID** for deposits.
- **Club profile** for the data platform: capacity (standing and seated), location, venue type, music, price band, usual peak hour, licence type, POS vendor and plan (§14.3).
- **Who will be on the call:** the person who can log in to the LINE OA as **admin**, at a **desktop browser**. Confirmation that no other bot tool is connected to the OA.

We check the form and create the club in the founder console as **onboarding**. Tables, prices, rules and the baseline brain are loaded before anyone joins the call.

**On the call**

| Minute | Step | Who |
|---|---|---|
| 0–1 | Open the wizard for this club. Club admin logs in to LINE OA Manager | Both |
| 1–4 | Enable the Messaging API, choose the club's own provider (§11.1.2 step 1). **Permanent** | Club admin |
| 4–5 | Paste Channel ID and Channel secret into the wizard | Club admin |
| 5–6 | Wizard connects everything: tokens, webhook set and tested, rich menu, message check, quota read | Automatic |
| 6–8 | Response settings: webhook on, auto-response off, greeting off, chat response method and hours checked. The wizard shows the webhook switch and the chat setting going green (the two LINE lets us read). The admin ticks the other two by hand and the live test confirms them | Club admin |
| 8–10 | **Live test from a phone that has not added the account:** adding it gets exactly one greeting; it types the wizard's tester code, so its rows are test data (§9, §12.3); one message gets exactly one reply; a test booking on the club's real tables as far as the PromptPay QR (nobody pays: the phone sends any photo as the slip and we approve it in a support session to show the confirmation card); ask for a person and see the alert on the dashboard on our shared screen | Both |
| 10–12 | Manager and hosts log in to the dashboard with their own accounts. The brain's baseline answers are reviewed at a glance and switched on (from Phase 2; in Phase 1 the FAQ answers in Settings are checked instead) | Club |
| 12–15 | Plan check (§11.1.4). POS: record the vendor and switch on the manual level. Key-based connections follow the call (§11.3). Switch the club to **live** | Both |

**"Live" means:** the club's LINE account answers through our bot, a guest can book a real table at the real price, the core FAQs are answered (in Phase 1 from the FAQ answers in Settings, from Phase 2 by the brain), staff can log in, and the bot runs 24/7.

**After the call (first week, no call needed)**

- Staff alert group (§11.1.2 step 5), linked before the club's first open night. Until it is linked, the club's health tile shows "no alert reaches a phone" (§12.3) and we watch the club's handoffs ourselves.
- ฿1 PromptPay test transfer verified end to end.
- Remaining FAQs, and the first approved answers from takeovers.
- Instagram connection, once our Meta app is approved (§11.5).
- POS live sync where available, or the report mapping, once that level ships (§10).
- A **dry run** of 10 test bookings by our team through the simulator (cancellation, late slip, handoff, no-show), marked as test data so they never block a real table.
- Night 1: our team watches the conversations from the founder console.

**What cannot be automated** (so the wizard makes it foolproof with deep links to the exact LINE page and screenshots in Thai and English): enabling the Messaging API and choosing the provider, copying the two credentials, the three response switches, the group-join switch, and buying a bigger message plan.

### 12.3 Founder admin console

The console is where we run the business: adding clubs, onboarding them, looking after their data, and fixing problems. It is built by hand inside the existing app (new pages and a separate API), not on an internal-tool builder, because the controls below are application logic.

**Who can use it.** Named founder accounts only. No shared login. A second factor is required from Phase 1b, because one founder account reaches every club's guest phone numbers and payment slips.

**What it does**

| Area | What we can do | Phase (§10) |
|---|---|---|
| **Clubs** | List every club with a health tile: LINE connected, webhook correct and active, last message received, failures in the last 24 h, quota used, handoffs past their timeout, payments waiting for review, staff alert group linked, bot paused. Create a club from a template. Change its status: onboarding, live, paused, demo | Phase 1b |
| **Onboarding** | The wizard in §12.2. Enter LINE and POS credentials (write-only: shown once, then only the last 4 characters, who set it and when). Run and re-run the LINE setup. Enter and bulk-edit tables, zones, prices and rules. Invite staff and set roles | Phase 1b for LINE and club data. Brain import and inbox accounts: Phase 2. POS keys: Phase 3 |
| **Club data** | Edit anything a manager can edit, on the club's behalf: settings, brain notes, bot wording, the event calendar | Phase 1b. Brain notes: Phase 2 |
| **Open the club's dashboard** | See exactly what the club's staff see, through a **support session** (below) | Phase 1b |
| **Debug** | **Webhook log:** every delivery we received, raw, with its processing result. **Message log:** every outbound message with reply or push, sent or failed, and LINE's error. **Conversation timeline:** guest messages, bot decisions, host replies and booking changes on one line of time. **Booking timeline:** every status change with who and why. **Replay** a stored webhook as a dry run. **Send a test message** to our own LINE account or the staff group, never to a guest | Logs and timelines: Phase 1b. Replay and test message: Phase 1 |
| **Controls** | Pause one club's bot (messages are still stored, no automatic replies, staff alerted). A global stop for all clubs. Per-club feature switches. All without a deploy | Pause and global stop: Phase 1b. Feature switches: Phase 2 |
| **Data** | Data health and the live event stream (§14.6) | Phase 1b |
| **Simulator** | Run a guest conversation against any club as test data. Used for the onboarding dry run and for demos | Phase 1b |

The Phase column follows §10. The extra checks on the three sensitive changes (below) arrive in Phase 1, before the pilot's first night.

**What each status does** (for the owner to confirm, §16.1 question 22)

| Status or switch | What the system does |
|---|---|
| **onboarding** | The bot answers everyone once the webhook is on. A LINE account becomes a tester by typing a one-time code shown in the wizard. A tester's bookings are test data (§9). Any other guest's booking is real |
| **live** | Normal operation |
| **paused** (status) | The club has stopped using the platform, or we have suspended it. The bot is silent, inbound messages are still stored, and the dashboard is read-only |
| **demo** | Every row is test data (§9, §12.4) |
| **`bot_paused`** (switch) | A temporary stop on a live club. No automatic replies, staff are alerted, everything else works |

**Support sessions: how we get into a club's data**

Fast support needs us to see what the club sees. It also needs a record, because we are entering a business's customer data.

- To open a club's dashboard a founder states a **reason** (and a ticket reference if there is one). That starts a support session for **that club only**, which **expires after 60 minutes**.
- A banner stays on screen for the whole session: *Support access: Velora, ends 23:41* [End now].
- A session starts **read-only**. Changing something on the club's behalf needs an explicit step up, with a second reason.
- **Every action in a session is written to the audit log** with the founder's name, the club, the reason, the time and what was viewed or changed. Opening a conversation, a payment slip or a phone number is logged, not only edits.
- **The inbox is the exception.** It is a separate application (§6.3) and its free edition keeps no access log. So a founder reads a club's chats in our own conversation timeline, where every message is also stored and each conversation opened is logged. Opening the club's inbox itself is possible only through the sign-on link, which needs an active support session and writes one audit row on entry. What the founder views inside the inbox after that is not logged per conversation.
- A founder can hold sessions for several clubs at once, so support on two clubs does not collide.
- Three changes need extra care because they move money or reach every guest: the **PromptPay ID** (it decides where deposits go), the **greeting and map link**, and the **LINE credentials**. Each needs a fresh second-factor check, records the before and after values, and notifies the club's owner.
- The club's contract says we may access its account for support, onboarding and troubleshooting. A support request from the club counts as the instruction to look.

### 12.4 Demo club: Velora

**Velora** is a fictional club that we own. Its job is to let a prospective club see the whole product in ten minutes, on a real phone, without touching a real club's data. (In the code it is the seeded demo club, `Velora (Demo)`, slug `demo`.)

The demo grows with the phases (§10). The full script needs Phase 2. Before that, the demo covers the guest booking, the live dashboard, a takeover on the Chats page and the founder console. The **Works from** column in the script shows when each step arrives.

**What Velora has**

- Its own LINE test account under our provider, with the full rich menu, in Thai and English. The account is on the Basic plan, because demo replies and alerts are counted pushes (§11.1.4). If it is ever on the Free plan, check the quota before each demo.
- A believable club: zones (VIP riser, DJ side booth, high tables), a floor plan, prices, house rules, opening nights and an event night.
- A seeded **brain** with the standard FAQs answered, plus a few deliberate gaps for the learning demo.
- Seeded **history**: several weeks of bookings, no-shows, takeovers and door counts, so the stats page and the data dashboard show real-looking charts. The seed data follows the phases: door counts from Phase 1; the brain, takeovers and stats history from Phase 2.
- A seeded **tonight**: some tables booked, one hold in progress, one payment slip waiting for review, one guest waiting for a host.
- Status **demo**. Everything Velora produces is marked as test data and behaves normally inside Velora: its bookings hold its tables, and its own stats page and its board in the data dashboard show them (§9). It never appears in cross-club figures or the production busyness feed.

**The demo script (about 10 minutes)**

| Step | What the customer sees | Shows | Works from |
|---|---|---|---|
| 1 | They add Velora on their own phone and tap **Book a table**: night, party size, table cards, details form, rules, PromptPay QR | The guest experience, taps only | Phase 1b |
| 2 | The table turns from free to held on the dashboard as they tap. They send any photo as the slip (we ask them not to pay). It lands in Payment review, we approve it on the dashboard, and the confirmation card with the door QR arrives | Live dashboard, no double booking | Phase 1b |
| 3 | They type a question the brain knows (*"what's the dress code?"*) and get an instant answer | The bot answers without staff | Phase 2 |
| 4 | They type a question the brain does **not** know. The chat is handed to a host, an alert arrives, and we answer from the inbox and press [Mark resolved] | Alerts and takeover | Phase 1b, by asking for a person and answering from the Chats page. As written from Phase 2 |
| 5 | Within a minute the drafted note appears in the approval queue. We approve it. They ask the same question again and the bot answers | The club brain learning | Phase 2 |
| 6 | The stats page: bookings made by the bot, deflection rate, takeovers by topic | What the manager sees | Phase 2 |
| 7 | The founder console: create a second club in the wizard and connect a prepared spare LINE account. We paste its Channel ID and Channel secret and watch the automatic steps go green. The spare account already has the Messaging API enabled, because that step is permanent (§11.1.2 step 1) | Onboarding speed | Phase 1b |
| 8 | The data dashboard, on a Velora-only board: tonight's booking pace and Velora's booking-heat level (§14.7, week-0 method) | The data side | Phase 1 |

**Demo controls**

- **Reset** (one click, founder console): clears what the last demo created and restores the seeded tonight, with dates moved to today. Reset also deletes the club created in step 7 and clears the spare account's webhook, retires the note approved in step 5 so the gap exists again, and returns every Velora chat to the bot.
- **Simulator fallback:** the same script runs in the browser simulator when there is no phone signal or LINE is slow. The simulator still needs an internet connection to our server, and the bot's answers still call the AI provider. Step 7 connects a real LINE account, so it is skipped when LINE itself is unavailable.
- **Fast-forward:** jump the clock so a hold expires, a reminder sends, or a table reaches its release time, without waiting.
- Velora can be reset and demoed while real clubs are live on the same system. Nothing it does can reach another club.

---

## 13. Non-functional requirements

| Area | Requirement |
|---|---|
| **Speed** | Webhook acknowledged in < 1 s. Bot reply sent in < 3 s at p95 (excluding slip verification, which must finish within the reply-token window or fall back to push). |
| **Availability** | 99.9% monthly for the webhook and booking APIs. If our system is down, LINE OA Manager chat still works, so hosts can take bookings by hand. Booking holds must never be lost. |
| **Peak load** | Handle 50 bookings/minute per club and 1,000 inbound messages/minute across all clubs. Load-tested before the pilot (Friday night 22:00–01:00 pattern). |
| **Reliability** | Webhook handling is idempotent (LINE may redeliver; dedupe by message ID). Every state change is logged in the audit trail. |
| **Security** | LINE signature verification on every webhook. **Club credentials (LINE, POS, Instagram) are stored encrypted in the database**, with the key held outside it; they are entered at runtime, never shown again and never returned by any API. (v1 said "never in the DB". That is changed, because a club must be connectable without a deploy.) Per-person accounts, server-side sessions that can be revoked, role-based access, club check on every route. Second factor for platform admins from day one, for managers later. Audit log of all staff and platform actions. Encryption in transit and at rest. Slip images in private storage with signed URLs. Fixes required before the first real club are in §13.1. |
| **Privacy and data** | **We are the data controller** for the data the platform collects. Collection is broad by design (§14): every chat event, booking step and automation is recorded. Guests are told at first contact and in the booking form, and the notice version each guest saw is recorded (§5.5). Each club has full access to its own data and its own guests. A guest can stop marketing at any time and can ask for their data to be removed (§14.9). Retention (§14.9): first-party events, booking history, snapshots, door counts and aggregates are kept for the life of the platform; chat messages, raw event payloads and chat-origin events for the life of the club's account (v1 said 180 days); slips 1 year (for disputes); raw webhook deliveries 30 days. Three limits come from the channels, not from us: LINE chat content and profile data, and all Instagram data, stay per club unless the channel owner permits wider use (§14.8); and LINE requires LINE-origin user data to be deleted when a club stops using the platform (§14.9). |
| **Localisation** | Thai and English everywhere (bot, LIFF pages, dashboard). THB formatting (฿15,000). Asia/Bangkok timezone. Optional Buddhist-era year in Thai. |
| **Accessibility** | LIFF pages and dashboard meet WCAG 2.2 AA. The table map also has a list view. Door mode has large targets and works in the dark. |
| **Devices** | LIFF pages are tested on LINE in-app browsers on iOS and Android, including low-end Android. Dashboard works on phone, tablet and laptop. |
| **Observability** | Error tracking, structured logs, uptime alerts on webhook failures. Per-club health view: webhook errors, unanswered messages, slip failures, quota usage. |

### 13.1 Fixes required before the first real club

A review of the code as built (Phase 0 + 1a) found the problems below. They were found by reading the code; none has been exploited or tested live. All are fixed in Phase 1b (§10).

**Open today, on the documented way of running the app**

| # | Problem | Why it matters | Fix |
|---|---|---|---|
| 1 | The simulator routes (`/api/dev/*`) need **no login** and are on by default. The example settings file ships with `DEV_SIMULATOR=1`, and the block that should stop this in production only fires when `NODE_ENV` is exactly `production`, which `npm start` never sets | On the public tunnel used by `npm run live`, anyone with the address can read recent staff alerts (guest names, phone numbers, booking references), hold real tables as fake guests, and upload files | Mount the routes only when development is explicitly chosen. Move the simulator behind platform-admin login (§12.3) |
| 2 | The app starts with the **placeholder** values from the example settings file for `APP_SECRET` and `STAFF_PASSWORD` | A deploy that copies the example file runs with a publicly known signing key and password. That key signs the staff session and every guest link | Refuse to start on placeholder values |
| 3 | The **staff link code** is returned by the settings route, is 6 characters, never expires, never rotates and is printed in the logs. Typing it in any LINE group the bot is in replaces the club's staff group | Whoever holds the code can redirect a club's staff alerts (guest name, phone, booking) to their own group and silently cut off the real one | One-time code that expires. Confirm before replacing a linked group. Tell the old group. Audit the change |

**Become a data leak the moment a second club exists**

| # | Problem | Fix |
|---|---|---|
| 4 | **One shared staff password**, and a session that carries no user and no club. `/me` lists every club. Routes addressed by booking, conversation or deposit ID have **no club check** | Per-person accounts, server-side sessions, a club check on every route and inside the booking service |
| 5 | The staff session cannot be revoked. Logging out only deletes the browser cookie | Server-side sessions |
| 6 | Login attempts are limited by an address the client supplies. The limit can be bypassed, and it can also be used to lock everybody out | Limit by account with back-off, stored in the database |
| 7 | The guest details link returns the guest's name, phone and nationality to anyone holding the link, and the link never expires | Require the LINE identity check to read as well as to submit. A link opened outside LINE never shows stored guest details: the form opens empty unless the guest signs in with LINE first. Links expire with the hold |
| 8 | No cross-club test exists, although v1 required one | Add a second seeded club to the tests and check every route |

**Reliability problems that also lose data**

| # | Problem | Fix |
|---|---|---|
| 9 | The webhook answers LINE before processing and keeps nothing. LINE does not resend a delivery it was told succeeded, so a crash or deploy mid-processing loses the message for good | Store the raw delivery **before** answering. Mark it processed afterwards. Replay unprocessed ones at start-up. The duplicate check must use the processed marker, not the row written when a message first arrives. Today that row is written before handling, so a replay after a crash would be dropped as a duplicate. On shutdown, wait for in-flight deliveries to finish |
| 10 | Failed sends, rejected webhooks and bot errors go only to the console | Record them (`ops_events`, message delivery status) so the founder console can show them |
| 11 | Most booking state changes are not inside a transaction with their history record, and several (hold created, hold expired, booking abandoned) write no history at all | One transaction per state change, including its event (§14.2) |
| 12 | The handoff timeout is checked only when the guest sends another message. It counts from the request time, not from the last staff activity, and it never re-alerts. A takeover the guest does not follow up stays open for ever | A timed job closes takeovers on the clock, counting from the last staff activity. It re-alerts first, and records the true end time (`handoff_episodes`, §9) |

---

## 14. Data platform

### 14.1 Principle

**We are a data-first company. Record everything the platform does, at the moment it happens, and never overwrite it.** The data has four uses: it improves each club's bot, it powers the club's reports, it feeds a separate app that predicts which club is busiest at a given moment (§14.7), and it supplies marketing, for the club and for us. No campaign tool is built now. What marketing will need is captured now (§19), within LINE's and Meta's limits (§14.8).

Today the system keeps the **current state** and loses the **history**. A booking's status is overwritten in place. The raw message from LINE is discarded after reading. A search that found no free table leaves no trace. The data platform changes that from the first real guest, because none of it can be rebuilt afterwards.

It is built as **part of the existing server and database**, not as a separate stack. There is no queue and no data warehouse until volume demands one (§14.11).

### 14.2 The collection service

**One table, one function.** Every part of the system records what happened by calling one function, `emit()`, which writes one row to the `events` table (§9).

| Field | Purpose |
|---|---|
| `occurred_at`, `recorded_at` | When it happened by the source's clock (LINE's timestamp where there is one), and when we stored it |
| `club_id`, `night_date` | Which club and which **night** (02:00 Sunday belongs to Saturday night, §7.2). `night_date` is the key the busyness predictor reads by |
| `type`, `v` | A named event, such as `availability.searched`, and the version of its fields |
| `actor_type`, `actor_id`, `channel` | Who caused it (guest, bot, staff, platform, system) and where (line, liff, instagram, dashboard, door, pos) |
| `data_origin` | Where the data came from: first-party record, LINE chat, LINE profile, Instagram, POS. Decides what the data may feed (§14.8) |
| `source` | The entry point: rich menu, quick reply, typed keyword, greeting, reminder, promoter link |
| `guest_id`, `person_id`, `conversation_id`, `booking_id`, `table_id`, `zone_id` | What the event is about |
| `attempt_id` | One booking attempt from start to end. The key for funnels |
| `cause_id` | The incoming message or request that triggered this event, so a reply can be tied to what caused it |
| `props` | Coded details only: counts, ids, enums |
| `raw` | The untouched source payload, including text. Removable per guest |
| `is_test` | Demo, simulator and dry-run activity. Excluded from every cross-club view, the aggregate area and the production feed, and from a real club's own reports (§9) |

**Rules**

- **Same transaction.** `emit()` writes inside the caller's database transaction. There are three cases:
  1. A valid event is inserted with the change. They commit or roll back together.
  2. An event that fails its declaration does not stop the change. It is written to `events_dead_letter` in the same transaction and the change commits.
  3. A repeat of the same `dedupe_key` is skipped (insert with ON CONFLICT DO NOTHING). In Postgres a failed insert would otherwise abort the transaction and lose the booking.
- **The raw delivery is stored before we answer LINE** (`raw_webhooks`), and marked processed afterwards. Unprocessed deliveries are replayed at start-up. Replay must not be blocked by the message duplicate check (§13.1 row 9). This also lets new event types be filled in later from stored deliveries.
- **Every event type is declared in code** with its fields and a privacy class per field. A document listing all events is generated from that declaration. An event that does not match its declaration goes to `events_dead_letter` (see Same transaction) and is never silently dropped.
- **Entry points are tagged.** Today the rich menu, a quick reply and "try again" all send the same signal. Each button gets its own tag. Links that LINE opens without telling us (location, the details form) go through a redirect on our server so the tap is counted.
- **Staff group chatter is not kept.** A delivery is stored whole before we answer LINE. Once it is processed, messages from a staff group are stripped from the stored copy, except the bot's own commands. Nothing else from a staff group becomes an event.
- **Nightly checks**, with alerts to us: every booking status change has its event; `events_dead_letter` is empty; every live club sent events during its opening hours; no personal data has leaked into `props`; no test data is in the aggregate area, any real club's report or the production feed. A dead-letter row, or a status change without an event, is a failure to fix the next day.

**What is recorded** (the 22 events in v1, renamed, plus what v1 missed)

| Area | Events |
|---|---|
| Contact | `guest.first_seen`, `guest.followed`, `guest.unfollowed`, `guest.refollowed`, `notice.shown`, `notice.accepted`, `marketing.opted_out` |
| Messages | `message.received`, `message.sent` (reply or push, delivered or failed, latency, template), `intent.detected`, `intent.unknown`, `bot.fallback_menu`, `bot.error` |
| **Demand** | `booking.started`, `night.selected`, `night.rejected`, `pax.selected`, **`availability.searched`** (night, party size, tables shown, **result count, including zero**), `night.sold_out_shown`, `waitlist.joined` |
| Booking | `table.held`, `table.hold_lost_race`, `hold.expired`, `booking.abandoned` (with the last step reached), `form.opened`, `form.validation_failed`, `form.identity_rejected`, `form.submit_rejected`, `details.submitted`, `rules.accepted`, `deposit.qr_sent`, `slip.received`, `slip.auto_verified`, `slip.review`, `deposit.verified`, `deposit.rejected`, `booking.confirmed`, `booking.manual_created`, `booking.cancelled`, `running_late`, `reminder.sent` |
| The night | `booking.checked_in` (with actual party size), `booking.no_show`, `table.released`, `door.count`, `crowd.rated`, `night.sold_out`, `booking.completed`, `pos.bill_opened`, `pos.bill_updated`, `pos.bill_closed`, `pos.bill_matched` |
| Handoff and brain | `handoff.requested` (with trigger), `handoff.resolved` (with duration), `handoff.timed_out`, `host.replied`, `ai.answered` (notes used, topic, language), `ai.call` (model, tokens, latency, cost), `faq.missed`, `brain.note_drafted`, `brain.note_approved`, `brain.note_rejected` |
| Staff and platform | `staff.login`, `staff.booking_viewed`, `staff.slip_viewed`, `support.session_started`, `support.session_ended`, `club.created`, `club.settings_changed`, `club.price_changed`, `club.event_night_created`, `line.setup_run`, `line.webhook.rejected` |

About 75 places in the current code need an `emit()` call. This is real work, sized as part of Phase 1b.

### 14.3 What cannot be rebuilt later

These are captured from the first real guest. Weather, public holidays and tourist seasons can be added afterwards from public sources; the items below cannot.

| Signal | How it is captured |
|---|---|
| **Demand that did not become a booking** | `availability.searched` with zero results, expired holds, abandoned attempts with the step reached, the time a night sold out, and waitlist joins once the waitlist ships (Phase 3). These are the strongest "busier than usual" signals |
| **The booking curve** | A timed snapshot of each club-night (`occupancy_snapshots`): tables active, held, confirmed and arrived, guests booked, minimum spend booked. Taken at 14, 7, 3 and 1 days before, at 12:00 and 18:00 on the day, then every 30 minutes from doors to close |
| **People actually inside** | Table bookings are only part of a club's crowd. Walk-ins, guestlist and the standing crowd are invisible to a booking system. Three cheap measures close the gap: **a door clicker** (+1 / −1 on the door screen, tagged table guest, guestlist, walk-in or ticket); **actual party size** entered at check-in; and a **staff crowd rating**, "how full now?" 1–5, asked in the dashboard or door screen every hour from 22:00 to 01:00 by default, set per club |
| **Inventory and prices as they were** | Tables and prices carry valid-from and valid-to dates, so "share of tables booked" for a past night is measured against that night's tables |
| **The club itself** | The club profile from onboarding (§12.2): capacity, location, venue type, music, price band, hours, usual peak, licence type |
| **Every night, open or closed** | A row for each night with its status, closed reason, event type and line-up. A missing night must not look like a quiet night |
| **The city calendar** | Public holidays, holy days, alcohol-ban days, election days, major concerts and festivals, entered by hand as they are announced |

The door screen and clicker do not exist in the code today. They are new screens (Phase 1).

### 14.4 Guest identity

- **Per club:** a guest is identified by the LINE user ID that club's account sees. LINE issues different IDs under different providers, so this ID is different at every club (clubs own their providers, §11.1.2).
- **Across clubs:** the platform has its own `person_id`. `identity_map` (§9) records two links from the first real guest, so nothing is lost: a keyed hash of the phone number the guest gives in our booking form, and the ID our shared LIFF app sees (the same for one person at every club, §11.1.1). The two are kept in separate columns, so each can be switched on or off.
- **The phone link is on from day one.** The phone number is typed into our own booking form, which on our reading makes it a first-party field (§14.8). LINE has not confirmed that reading. The link is switched off if LINE disagrees.
- **The LIFF-ID link stays off until LINE approves it in writing.** The ID is LINE-issued, and LINE's terms do not allow user information from different services to be linked without LINE's approval (§14.8). Until then `platform_line_sub` is used only to protect booking links (§11.1.1). Because it is stored from the first guest, approval unlocks the full history.
- This lets us recognise a returning person across clubs for our own analytics. One club never sees another club's guest records.
- Both points are in the question to LINE (§16.1, question 12).

### 14.5 Zones and access

The data lives in one database, in four areas with separate access:

| Area | Holds | Who reads it |
|---|---|---|
| **Operations** | Guests, bookings, messages, slips, raw webhooks, `events.raw` | The application only |
| **Vault** | Identity links, encryption key references, notice records, removal requests | The application, with every read logged |
| **Analytics** | `events` without the `raw` column, read through a view, and the tables built from them. Guests appear as IDs, not names. `raw` stays in the Operations area | The data dashboard (read-only, with chat-origin rows left out, §14.6) |
| **Aggregates** | Per-club, per-night, per-time-bucket figures. No guest-level rows | The busyness feed and cross-club views |

### 14.6 The data dashboard and viewer

Collection and viewing are built together, so the data is usable from the first week.

- **Data dashboard (ours, cross-club):** a self-hosted open-source dashboard tool (**Metabase**, open-source edition). Its database role is read-only and can read two things: a view of `events` that leaves out the `raw` column and every row whose `data_origin` is `instagram`, `line_chat` or `line_profile`; and the aggregate area. Starter boards, built from first-party records only: the booking funnel, the booking curve by club and night, demand that found no table, no-show rate, door counts against bookings, busyness by club and hour. Chat-based figures (handoff and deflection rates, takeovers by topic) are shown one club at a time, on the club stats page (§6.5), which we open through a support session (§12.3). They are not in the cross-club tool. We can build new charts without writing code.
- **In the founder console** (§12.3), two pages built by us:
  - **Data health:** events per club per day, time of the last event, rejected events, share of guests with a notice record, pending removal requests. A club that goes silent is visible at a glance.
  - **Event stream:** a live, filterable timeline by club, conversation, booking or guest. This is also the main debugging view.
- **Club reports stay inside our own dashboard** (§6.5, §14.10). Each club sees only its own data, and that isolation is enforced by our code. The open-source dashboard tool has no per-club row security in its free edition, so it is for internal use only.

### 14.7 The busyness feed (for the separate app)

A separate consumer app will show which club is busiest at a given moment. This platform's job is to supply the signal.

- **One API:** `GET /data/v1/busyness`, with an access key, a rate limit and an access log. It reads only the aggregate area. The app never touches bookings, guests or events.
- **What it returns:** for each club and each 30-minute bucket, a **level on a 5-step scale relative to that club's own capacity**, with a confidence flag and which inputs were present. No head counts, no guest details, no breakdown by nationality.
- **Thin data is not published.** A bucket resting on fewer than a set minimum of booked guests (starting value 10, tuned on pilot data), or on a night with neither a door count nor a staff crowd rating, is returned as "no data", not as "quiet".
- **Inputs are first-party records and POS bills** (§14.8): bookings and holds, demand events, occupancy snapshots, check-ins, door counts, crowd ratings and POS bills. Records made through LINE count as first-party on our reading, which LINE has not confirmed (§14.8).
- **Each club agrees** in its contract to its busyness being shown. Booking counts and spend are a club's commercial information, which is why the feed publishes a relative level and not the numbers.
- **Versions (§10):** v0 ships in Phase 1 and serves the week-0 method below for the pilot club. v1 ships in Phase 3 with the weekday baseline, door counts and crowd ratings, for every live club.
- **Sandbox key:** a separate key returns only Velora's levels, marked as test, so the separate app can integrate before real data exists. A sandbox response is computed from Velora's own rows, not from the aggregate area, and never contains a real club. Velora never appears in the production feed (§12.4).

**The model, in stages**

| When | Method |
|---|---|
| Week 0 | "Booking heat": tables booked ÷ tables active for that night. Needs no history |
| Weeks 4–8 | Per-club baseline for the same weekday, adjusted by how tonight's booking pace compares with the usual curve |
| About 6 months and 5+ clubs | One model trained across clubs, predicting each club's level relative to its own weekday norm |
| 12+ months | Yearly effects (Songkran, New Year, high season). Until then, special nights are flagged by hand |

What bookings add that phone-location products do not have is that **they look forward**: tonight's tables are known days ahead. What bookings lack is the true crowd, which is why the door count and crowd rating in §14.3 matter. These stages and timings are estimates to be tested on our own data.

### 14.8 Where data may be used (data origin)

We collect and keep everything. What differs is what each kind of data may **feed**, and that is set by the owner of the channel it came through. The `data_origin` tag on every event enforces it.

| Origin | Examples | May feed |
|---|---|---|
| **First-party records** | Bookings, holds, searches, deposits, check-ins, door counts, crowd ratings, the fields a guest types into our booking form. For records made inside LINE this is our reading, which LINE has not confirmed (see below) | Everything: the club's bot and reports, our cross-club analytics, the busyness feed, marketing |
| **LINE chat and profile** | Message text, LINE user IDs, display names, profile data | That club's own bot, brain and reports. **Not** cross-club products, until LINE gives written permission. LINE's developer terms limit this data to the service it was collected for, and do not allow linking it across services without LINE's approval |
| **Instagram** | Messages and profile data received through Meta's API | That club only. Meta's platform terms do not allow a provider to use a client's data for its own purposes, **including in aggregated or derived form** |
| **POS** | Bills, covers, spend | Everything, subject to the club's contract |

The busyness predictor is designed to run on first-party records. Door counts, staff crowd ratings, check-ins, dashboard bookings and POS bills never pass through LINE at all.

**One point is unverified:** whether LINE treats bookings, holds, searches and form fields that reach us through button taps and the booking form inside a club's LINE chat as our own data or as LINE user information. Our reading is that they are our own. LINE's policy counts information a developer receives from users inside LINE's services as LINE user information, and LINE has not confirmed how that applies here. We ask LINE in writing before the feed goes to the separate app (§16.1, question 12). Every event carries its `channel`, so records made through LINE or Instagram can be left out of the feed if the answer is no. The feed then runs on the first group alone.

The reason to respect the channel rules is practical. Breaking them risks losing API access, which would stop the product for every club.

### 14.9 Retention and removal

| Data | Kept for |
|---|---|
| First-party events, booking history, snapshots, door counts, aggregates | The life of the platform |
| Chat messages, `events.raw`, and events whose origin is LINE chat, LINE profile or Instagram | The life of the club's account. Deleted when the club's account ends. Anonymised counts built from them stay |
| Payment slips | 1 year |
| Raw webhook deliveries | 30 days |

- A guest can ask for their data to be removed, through the club or directly through us (a menu item and a keyword).
- Removal is one job with a checklist: the guest's record is anonymised in place (the database links bookings and messages to it, so it cannot simply be deleted); message text, `events.raw` and slip files are deleted; the identity links are deleted; the IDs that tie the guest's events together are cleared. Stored staff alerts about the guest are deleted too. For that, each alert row is saved with the guest and booking it concerns; today it is saved with neither. Aggregates stay, because they are counts.
- Chat transcripts used to test or improve the bot are redacted first: images dropped, the guest's known name and phone replaced, then patterns for Thai phone numbers, emails and ID numbers. A redacted transcript improves **that club's** bot only (§14.8).
- **LINE sets its own deletion rules for LINE-origin data** (LINE user ID, profile, chat text). Its User Data Policy (3.5) requires this data to be deleted when a club stops using LINE through us, and when a guest leaves the service. First-party records and anonymised statistics are not covered. How LINE applies "leaves the service" to an unfollow is not confirmed (§16.1, question 12). LINE-origin fields are therefore stored so they can be cleared for one guest or for one club without losing the booking history.

### 14.10 Reports

**Funnel report:** started → night → pax → table → details → rules → paid → confirmed, with drop-off at each step.

**Club report** (weekly, in the dashboard and sent to the manager's LINE):
- bookings and deposits
- no-show rate
- % booked with no staff help
- busiest nights and zones
- average spend (with POS connected)
- top promoters (Phase 3)
- deflection rate and takeovers by topic (§6.5)
- door count against bookings, and peak hour

### 14.11 Storage path and cost

| Stage | What runs | Rough added cost per month (estimates) |
|---|---|---|
| **Day one** | Everything above in the existing Postgres database. One small server for the dashboard tool | US$15–50 |
| **About 5 clubs** | A separate worker process for scheduled jobs. Events split by month. A read copy of the database if dashboards slow the booking path | US$80–200 |
| **About 30 clubs** | The analytics area moved to a data warehouse, only if needed: more than about 50–100 million events, dashboards slower than 3 seconds, or analytics visibly slowing the webhook. A warehouse region in Thailand keeps the data in the country | US$300–700 |

No message queue is needed at this volume (roughly 1,000–5,000 events per club per day, estimated).

---

## 15. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Hosts/promoters see the bot as a threat to their job or commission | Club resists or sabotages | Pitch it as removing repetitive work. Promoter attribution in Phase 3. Hosts keep VIP and special bookings |
| Slip fraud (edited or reused slips) | Club loses deposits | Bank-backed slip verification, unique transaction refs, amount/receiver/time checks, human review on any doubt |
| LINE quota/cost grows with volume | Margin squeeze | Reply-first design, push caps, quota dashboard, pricing passes the cost on |
| Provider link permanently ties the OA to the wrong owner | Club lock-in fears / migration pain | Club-owned provider by default, written into the contract |
| We can't see staff replies sent from OA Manager | Bot talks over a host | Explicit handoff mode + Mark resolved + timeout |
| POS vendor won't grant API access | No automated spend sync | Manual entry and report import (L0a and L0b, §11.3). Adapter supports other POS vendors |
| AI misreads a request | Wrong night or table pre-filled | AI only pre-fills. The guest confirms every value on the review screen. If the bot cannot tell what the guest wants, it shows the button menu and does not guess (§8.5) |
| Regulation if we ever touch funds | Licensing burden | Phase 1 money goes guest → club directly. Legal review before any gateway work |
| Single dependency on LINE | Platform risk | Booking engine and data are ours. The LIFF booking page also works as a normal web link |
| Hosts keep replying in the LINE app, not our inbox | The brain learns nothing, stats undercount, the "bot gets smarter" promise fails | Make the inbox the easier place to reply (bookings beside the chat, mobile notifications). Agree the rule at onboarding. Show the club the share of its takeovers that had at least one reply through the inbox; the rest were answered in the LINE app or not at all |
| Channel owners' terms on data use (LINE, Meta) | Loss of API access would stop the product for every club | Tag every event with its origin. Cross-club products run on first-party records only (§14.8). Ask LINE for written permission before using chat-derived data or LINE-issued IDs across clubs (§14.4) |
| Meta verification and app review take long or are refused | No Instagram for any club | Start business verification in Phase 1 and submit the review as soon as the inbox runs on a tester account (§10). LINE-only product stands on its own. Instagram is a later addition, not a launch dependency |
| Bookings are only part of a club's crowd | Busyness predictions are wrong on walk-in-heavy nights | Door clicker, actual party size and staff crowd rating from the pilot (§14.3). Publish "no data" when inputs are thin |
| Clubs object to being compared with competitors | Clubs refuse the busyness feed, or leave | Feed shows a level relative to the club's own capacity, never counts. Contract term agreed at onboarding |
| The 15-minute onboarding slips | P1 missed; founders spend hours per club | Club data collected before the call. Wizard with deep links and live checks. Time every onboarding and fix the slowest step |
| The OA is already tied to another vendor's provider | That club cannot be onboarded quickly | Ask in the pre-call form. Treat as a migration with its own plan |
| The brain learns a wrong or one-off answer | The bot repeats a mistake to every guest | Manager approval on every learned note. Automatic discard of prices, personal data and exceptions. Review flag after a quick re-takeover (§8.4) |
| Thai answer quality on the fast AI model is unmeasured | Poor answers, or roughly 20× the AI cost on the larger model | 100-question Thai test before choosing the model. Per-club cost cap |
| A founder account is compromised | Every club's guest data is exposed | Named accounts, second factor, 60-minute support sessions, full access log, extra checks on PromptPay and credential changes (§12.3) |
| We run the inbox software ourselves | Upgrades, backups and outages are ours | One shared install. Our server keeps the LINE webhook, so the bot keeps answering if the inbox is down |
| Wongnai will not open its POS, and sells its own reservations | No live spend sync for clubs on Wongnai | Report import for every club. Live sync on POS systems with open APIs. Adapter keeps each POS replaceable |
| Message costs rise when replies move to the inbox | Clubs resist the plan upgrade | State the cost at onboarding (Basic plan, 1,280 THB). Urgent-only LINE group alerts. Quota view in the dashboard |

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

### 16.1 Open questions (platform)

**To test on a real Thai LINE account**

1. Does LINE OA Manager in Thailand show the Channel ID, Channel secret and webhook switch where the wizard's instructions say?
2. Can "Allow bot to join group chats" be switched from OA Manager, or only from LINE Developers Console?
3. Does `liff.sendMessages()` work when the LIFF app's provider differs from the OA's provider (§11.1.1)?
4. How long does the onboarding call really take? Nothing has been timed yet.

**Must be decided before Phase 1b starts**

Phase 1b builds on each of these (§10). Questions 6 and 7 have a default. The defaults are proposals for the owner to confirm.

5. Where is production hosted, and in which region? A Thailand region keeps guest data in the country. This is the owner's decision. It is needed before the Phase 1b hosting work starts.
6. How do staff log in? Default for Phase 1b: email and password, with a second factor for founders (matches `users`, §9). Still open: do hosts also get a lower-friction sign-in (LINE Login or a phone code)? It can be added later.
7. May a founder in a support session send a message to a guest in the club's name? Default for Phase 1b: no. A support session can read, and can change settings after an explicit step up, but cannot send a message to a guest (§12.3).

**To decide**

Questions 9 and 10 must be answered before Phase 1 starts. They decide what the door screen records and how often snapshots are taken (§10, §14.3).

8. Does Velora live on the production system (marked demo) or on its own copy? This spec assumes the production system. Either way the demo needs an internet connection (§12.4). A demo with no connection at all would need a copy on a laptop and would lose the AI answers in steps 3–5. It is not planned.
9. What does "busy" mean for the separate app: people inside against capacity, tables filled, or the queue at the door? This sets what the door staff are asked to record.
10. What does the separate app need from the feed: bucket size, how fresh, how far ahead?
11. Will door staff reliably use the clicker on a busy night? If not, the hourly crowd rating becomes the main measure.

**To ask others**

12. LINE: written permission or confirmation on four points (§14.4, §14.8, §14.9): (a) using chat-derived data in cross-club products; (b) linking the shared-LIFF user ID across clubs; (c) that fields typed into our booking form, and bookings, holds and searches made by taps in the chat, are our own first-party records, for cross-club identity and for the busyness feed; (d) how the deletion rule applies when a guest unfollows. Send the request in Phase 1b. The answer is needed before the busyness feed goes to the separate app (§10).
13. LINE MAN Wongnai: partner access to bills, in what form, and who the contact is. Does the CSV report have one row per bill with table and times?
14. Each club: which POS and plan, and whether its Instagram is run by an agency.
15. Papaya (sandbox): does a deposit recorded at check-in show as a prepayment on the bill?

**To measure before quoting a club**

16. Thai answer quality and token counts on the fast AI model (§8.6).
17. The share of each club's attendance that comes through table bookings (first 4 weeks of door counts).

**To settle during the pilot**

18. Does the pilot club need spend data in Phase 1? If yes, report import (L0b) moves from Phase 3 to Phase 1 (§10, §11.3).
19. What is the target for founder time per club outside the onboarding call (P1, §3.1)? Set it after the first three clubs.
20. Is 6 hours the right gap for ending a free-text conversation (§3.2)? Check against the pilot chats.

**To test on our own inbox install**

21. Do the inbox's phone and browser notifications reach a manager's phone reliably from our self-hosted install? Not checked. If not, needs-input alerts need another route (§6.4).

**To confirm before Phase 1b**

22. Are the club statuses in §12.3 right as written? In particular: during onboarding the bot answers every guest once the webhook is on, and a tester is registered by typing a one-time code from the wizard.

**To ask Meta**

23. Is a booking made in our own form by a guest who arrived from Instagram covered by Meta's platform-data rules (§14.8)?

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
- [ ] Staff LINE group gets every notification in §6.1 that is switched on for the club.
- [ ] All guest-facing text exists in Thai and English and is editable in Settings.
- [ ] No staff user can see another club's data (automated test).
- [ ] Every booking, payment and staff action is in the audit log.

### 17.1 Acceptance criteria (platform)

**Onboarding (P1)**

- [ ] A new club is created, loaded with its tables, prices, rules and baseline FAQs, and connected to its LINE account from the founder console, with **no code change, no environment variable and no deploy**.
- [ ] The onboarding call for a prepared club takes **≤ 15 minutes** from opening the wizard to the club being live, measured on three clubs.
- [ ] The wizard needs only the Channel ID and Channel secret. It confirms the webhook switch and the chat setting by API. Auto-response and the greeting are confirmed by the live test: exactly one greeting on adding the account from a phone that had not added it, and exactly one reply to a message.
- [ ] Club credentials are never returned by any API or shown on any screen after entry.

**Club brain and inbox**

- [ ] A question answered by a host through the inbox produces a drafted note in the approval queue within 60 seconds of the takeover being resolved. After one tap to approve, the note is in the compiled brain within 10 seconds and the bot answers that question itself.
- [ ] A drafted note containing a price, personal data or a one-off exception is discarded automatically.
- [ ] No bot answer states an amount, table code or availability that did not come from the booking system in the same turn.
- [ ] A host's reply and a bot message are stored with different authors.
- [ ] An urgent chat reaches the manager in the inbox and the staff LINE group within 5 s. A needs-input item appears in the dashboard counter.
- [ ] The stats page shows bookings made by the bot, deflection rate and takeovers by topic for any date range.

**Founder console (P2)**

- [ ] A founder can open any club's dashboard only through a support session with a stated reason. The session ends by itself after 60 minutes and shows a banner throughout. (Phase 1b)
- [ ] Every action in a support session appears in the audit log with the founder, the club, the reason and what was viewed or changed. (Phase 1b)
- [ ] Changing a club's PromptPay ID or LINE credentials needs a fresh second-factor check and notifies the club's owner. (Phase 1)
- [ ] For any guest message, a founder can see whether it arrived, how it was processed, what was sent back and whether the send succeeded. (Phase 1b)
- [ ] Pausing a club's bot stops automatic replies within one message, keeps storing inbound messages and alerts the staff. (Phase 1b)

**Security (§13.1)**

- [ ] The simulator routes are unreachable without platform-admin login on any deployment.
- [ ] The app refuses to start with placeholder secrets.
- [ ] For every staff route, a user of club A gets a refusal on club B's slug and on club B's booking, conversation and deposit IDs (automated test).
- [ ] A staff link code works once, expires, and cannot silently replace a linked group.

**Demo club (P3)**

- [ ] The Velora demo script (§12.4) runs end to end on a real phone and in the simulator (Phase 2). Before that, each phase runs the steps it delivers (§10).
- [ ] Reset restores the seeded state in one click, with dates moved to today.
- [ ] Nothing Velora produces appears in a cross-club figure, a real club's report or the production busyness feed. The sandbox key returns Velora only (§14.7).

**Data (P4)**

- [ ] Every booking state change has a matching event, checked nightly with zero tolerance.
- [ ] The first bot reply to a guest with no notice record on that channel carries the notice, and the notice record is written (automated test).
- [ ] A webhook delivery received just before a crash is processed after restart.
- [ ] A search that finds no free table is recorded with the night, party size and a result count of zero.
- [ ] An occupancy snapshot exists for every open club-night at every scheduled time.
- [ ] The door screen records a count by guest type and the actual party size at check-in.
- [ ] The busyness feed returns a level for every live club on an open night, returns "no data" when inputs are thin, and contains no guest-level field.
- [ ] No event with an Instagram, LINE-chat or LINE-profile origin is read by any view that combines more than one club, or by the feed (automated test).
- [ ] The feed can be rebuilt with every event whose `channel` is `line`, `liff` or `instagram` left out (automated test).
- [ ] A guest removal request clears that guest's name, phone, message text, stored staff alerts and slips, and leaves the aggregates unchanged.

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
| **LINE OA Manager** | LINE's own web and phone console where a club runs its account: chats, response settings, message plan |
| **LINE Developers Console** | LINE's separate site for technical settings, such as the switch that lets the bot join group chats |
| **LINE Login channel** | The LINE registration a LIFF page needs. Ours is shared by every club (§11.1.1) |
| **Reply / push message** | Reply = answering a guest message (free). Push = a message we send first (counts against quota) |
| **PromptPay** | Thailand's national instant transfer system, paid by QR code or phone/ID number |
| **Slip** | The transfer receipt image from a Thai banking app, with a verifiable QR code |
| **Minimum spend** | The amount the table must spend on the night. The deposit usually counts towards it |
| **Hold** | Temporary lock on a table while the guest finishes booking and pays |
| **POS** | Point of sale, the club's billing/cashier system (e.g. Wongnai POS / FoodStory) |
| **Club brain** | A club's own knowledge base: the notes the bot may answer from. Starts from onboarding data and grows from approved host answers |
| **Takeover** | A host answering a guest in place of the bot. Also called a handoff |
| **Deflection rate** | The share of free-text conversations in which no takeover starts and the bot's last message is an answer (§3.2) |
| **Inbox** | The one screen where a club's hosts read and answer chats from every channel. Built on Chatwoot, an open-source inbox we host |
| **Founder console** | Our own admin area for adding, onboarding, supporting and debugging clubs |
| **Support session** | A founder's time-limited, logged access to one club's dashboard, opened with a stated reason |
| **Second factor** | A one-time code from a phone app, asked for on top of the password |
| **Velora** | Our fictional demo club |
| **Simulator** | Our browser tool that plays the guest's side of a LINE chat, for tests and demos |
| **Event** | One recorded fact about something that happened (a search, a hold, a reply), stored permanently |
| **Data origin** | A tag on each event saying which channel the data came through, which decides what it may feed |
| **Booking curve** | How a night's bookings build up over the days and hours before it |
| **Busyness feed** | The one API through which the separate consumer app reads each club's busyness level |
| **Stateless token** | A LINE access token valid for 15 minutes, issued on demand from the Channel ID and Channel secret |

---

## 19. Future extensions (backlog, not being built)

Once a club's bookings, chats, guests and spend run through the platform, a long list of further products becomes possible: loyalty, targeted offers, birthday specials, review requests and more. They are kept as a backlog in **[EXTENSIONS.md](EXTENSIONS.md)**: 170 items in 14 themes, each with what it is, what it needs first, a rough effort, a horizon and its main constraint. **The backlog is not a schedule.** Where a backlog item overlaps a phase in §10 (per-person logins, door counter, gap finder, data removal, Instagram, payment gateway, promoter commission, waitlist, pre-orders), §10 decides when the basic version ships and the backlog row describes the fuller version. Other items are chosen one at a time when clubs ask for them.

| Theme | Items | Examples |
|---|---|---|
| Foundations and compliance (enablers for everything else) | 8 | Consent and preference centre, Outbound compliance guardrail (alcohol law, PDPA, platform rules), Licence and compliance calendar, AI disclosure and human handoff layer |
| Loyalty and retention | 15 | Status tiers with non-price perks, Points on spend (own ledger), Stamp card tied to check-in, Birthday and occasion specials and packages |
| Marketing and targeting | 24 | Auto-tags and guest segments, Segment builder and targeted campaigns, Demographic narrowcast, Retargeting on opens and clicks |
| Reviews and reputation | 6 | Review requests after visit, Private feedback survey and service recovery, In-night issue capture, Review inbox and reply drafting |
| Revenue add-ons before arrival | 17 | Pre-order packages and add-ons at booking, Add-on partner marketplace, Dynamic pricing of deposits and minimum spend, Premium table auction for peak nights |
| Guest experience on the night | 19 | In-LINE membership QR and staff door scanner, Offline mode for door check-in, Host briefing card, VIP arrival alert |
| Club operations and back office | 18 | No-show risk score and risk-based deposit rules, Controlled overbooking, Blacklist and incident log (per club), Deposit fraud detection and reconciliation |
| Promoters, partners and distribution | 9 | Promoter commission ledger and self-serve portal, Promoter payout tax paperwork, Booking widget for website, link-in-bio and Google, Hotel concierge and agent channel |
| Channels and LINE platform | 13 | Per-guest rich menus, Tabbed rich menu, Multilingual assistant with two-way translation, Instagram DM and comment triage to booking |
| Payments | 7 | Payment gateway option: cards, wallets, cross-border QR, Bank-direct dynamic QR with payment callback, LINE Pay as a second deposit method, Card hold as no-show guarantee |
| AI and automation | 16 | Reply copilot in the staff inbox, Knowledge-base gap and conflict finder, Agentic changes and cancellations, Voice-note and image understanding in chat |
| Analytics and insight | 6 | Owner digest: end of night, morning after and weekly, Event and DJ night performance reports, Analytics dashboard, Cross-club benchmarking |
| Our own business model | 7 | Pricing: tiered plans plus add-on modules, Pricing: setup fee, managed service and usage pass-through, Club-to-club referral programme, Pricing: per-booking or percent-of-deposit fee |
| Dropped or parked: not legal or not possible as designed | 5 | DROPPED: spirits-brand sponsored campaigns to guests, DROPPED: alcohol as the reward (discounted or free drinks, bottle giveaways, prize draws for buyers), DROPPED: incentivised or sentiment-gated review requests, PARKED: shared ban list or payer blocklist across unrelated clubs |

**Seven findings shape the backlog.** They come from checking the ideas against LINE's, Meta's and Thai rules, and are explained in EXTENSIONS.md. The checks are research, not legal advice.

1. **Rewards must be access and service, not cheaper alcohol.** Thai alcohol law restricts price cuts, giveaways and benefits tied to buying alcohol. Loyalty works as status and treatment: priority booking, better tables, deposit waived, queue skip.
2. **Birthdays must come from our own booking form.** LINE does not give birth dates to Thai accounts.
3. **Paid ads are closed for this business** on both Meta and LINE. Growth comes through the club's own LINE messages, referrals and links.
4. **Every targeted message is a counted push**, so campaign features need a cost preview and a frequency cap.
5. **Prize draws need a permit.**
6. **Review requests go to every guest, with no reward** and no filtering by how happy they were.
7. **WhatsApp cannot carry alcohol promotion in Thailand.** Bookings and reminders only.

**What the platform should do now so these stay cheap later.** None of it is extra scope; it is already in this spec:

- Record every event with the guest, booking and night attached (§14.2).
- Ask for birthday and occasion in the booking form and store them (§5.2 step 4).
- Keep one profile per guest per club, with a platform-level identity across clubs (§14.4; the LIFF-ID link waits for LINE's approval).
- Record which notice each guest saw and whether they opted out of marketing (§5.5).
- Attach real spend to bookings wherever the POS allows (§11.3).
