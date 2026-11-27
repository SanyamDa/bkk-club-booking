# Going live on LINE (Phase 1a)

This connects a **real LINE Official Account** to the bot so you can book from your phone. The account setup in LINE's consoles is a one-time job of about 20–30 minutes. After that, one command does the rest:

```bash
npm run live
```

`npm run live` does all of this:
1. Starts an HTTPS tunnel to your laptop.
2. Writes the tunnel's address into `.env`.
3. Starts the app.
4. Points the LINE webhook at it and asks LINE to test it.
5. Installs the button menu under the chat (Book a table · My booking · Location · Talk to a host, in English and Thai).
6. Points the booking form (LIFF) at the new address.
7. Has LINE validate **every message type the bot can send**.
8. Shows your message quota.
9. Prints a QR code. Scan it with your phone to add the bot.

You can run the same setup from the dashboard: **Setup → Run LINE setup**.

> Use a **fictional club name** for the test account (e.g. "Velora (Demo)"). Only use a real club's name or logo with that club's written permission.

LINE's console screens change from time to time. If a label below doesn't match exactly, look for the closest one.

---

## One-time setup

### 1. Create the Official Account
1. Go to **LINE Official Account Manager** (manager.line.biz) and sign in with your LINE account.
2. Create an account. The free plan is fine for testing.

### 2. Turn on the Messaging API
1. In OA Manager open **Settings → Messaging API → Enable Messaging API**.
2. Choose or create a **provider**, which is your company's account in LINE Developers.
   ⚠️ An account's provider can't be changed later. That's fine for your own test account. For a real club, read SPEC §11.1.2 first.

### 3. Copy the bot's two keys into `apps/server/.env`
In **LINE Developers Console** (developers.line.biz) → your provider → the Messaging API channel:
- **Basic settings** → **Channel secret** goes in `DEMO_LINE_CHANNEL_SECRET`.
- **Messaging API** → issue a **Channel access token (long-lived)** and put it in `DEMO_LINE_ACCESS_TOKEN`.

Also in the **Messaging API** tab:
- Turn **Use webhook** on. `npm run live` fills in the URL.
- Turn **Allow bot to join group chats** on (needed for the staff alerts group).

### 4. Turn off LINE's own auto-replies
In OA Manager → **Settings → Response settings**:
- Turn **off** auto-reply messages and greeting messages. The bot sends its own greeting, and leaving these on gives guests two answers.
- **Chat:** on if hosts should be able to reply from the LINE OA app on their phones, off if only the bot replies. Setup reports which mode you're in.

### 5. Set up a tunnel tool (pick one)
- **ngrok with a free static domain (recommended).** The address never changes, so LINE never needs re-pointing.
  1. Sign up at ngrok.com and run `ngrok config add-authtoken <your token>`.
  2. In the ngrok dashboard, claim your free static domain.
  3. Put it in `.env` as `NGROK_DOMAIN=your-name.ngrok-free.app`.
- **Cloudflare quick tunnel:** `brew install cloudflared`. There's no account needed, but the address changes on every run. `npm run live` re-points LINE automatically each time.

### 6. Booking form inside LINE (LIFF, recommended)
Without this the details form opens in the phone's browser. Everything still works, but it feels less native.

1. In LINE Developers, under the **same provider**, create a **LINE Login** channel.
2. Copy its **Channel ID** into `DEMO_LINE_LOGIN_CHANNEL_ID` and its **Channel secret** into `DEMO_LINE_LOGIN_CHANNEL_SECRET`.
3. In that channel's **LIFF** tab, **Add** an app:
   - **Size:** Tall.
   - **Endpoint URL:** anything for now, e.g. `https://example.com`. `npm run live` sets the real one.
   - **Scopes:** `openid`, `profile` and `chat_message.write`.
4. Copy the **LIFF ID** into `DEMO_LIFF_ID`.

What you get from this:
- The form opens inside LINE.
- After submitting, the form sends "Details sent" back into the chat, so the bot's next reply is free.
- The server verifies with LINE that the person filling in the form is the same LINE user who holds the table. A forwarded link can't be used by someone else.

### 7. Deposits (optional)
1. Put a PromptPay phone number or tax ID **you own** in `DEMO_PROMPTPAY_ID`.
2. The bot will then send a real, scannable PromptPay QR.
3. ⚠️ Demo deposits are ฿3,000–฿10,000. Don't pay unless you mean to send yourself that money. For ฿1 tests, lower the zone deposits in `apps/server/src/db/seed.ts` and delete `apps/server/.data/`.

Leave it empty to stay in demo mode: no real QR is sent, and any image counts as a "slip" for staff to approve.

---

## Every time

1. Stop `npm run dev` if it's running.
2. Run:

```bash
npm run live
```

3. Scan the QR it prints with your phone to add the bot.
4. Type "book a table".
5. Watch the booking appear in the staff dashboard. The URL is printed at the end.

Add `-- --refresh-menu` to rebuild the button menu after changing it, or `-- --no-tunnel` when `PUBLIC_URL` is already a public HTTPS server.

### Staff alerts group
1. Create a LINE group (e.g. "Velora staff") and invite the bot.
2. The bot explains what to do. Type `link CODE` in the group. The code is on the dashboard's **Setup** page.

---

## Troubleshooting

| What you see | Likely cause |
|---|---|
| ✗ LINE credentials | Access token wrong or revoked. Issue a new long-lived token |
| ✗ Webhook, status 401 | `DEMO_LINE_CHANNEL_SECRET` doesn't match the channel |
| ✗ Webhook, 502/timeout | Tunnel not up yet or blocked. Run `npm run live` again |
| Webhook OK but the bot never answers | **Use webhook** is off in the Messaging API tab |
| ✗ Message check | LINE rejected a message format. The detail says which field. Report it, because it's a code bug |
| Guest gets two replies | OA Manager auto-reply or greeting messages are still on |
| Bot silent for one guest | That chat is waiting for a host. Use **Hand back to bot** in the dashboard's **Chats** |
| Form says "different LINE account" | The link was opened by someone other than the guest who started the booking (working as intended) |
| Form opens in a browser | `DEMO_LIFF_ID` or the LINE Login keys are missing |
| "ngrok exited … authtoken" | Run `ngrok config add-authtoken <token>` once |
