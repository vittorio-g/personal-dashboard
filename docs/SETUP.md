# Setup, step by step

Roughly 15 minutes for the dashboard, another 20 if you want the WhatsApp bot.

---

## 1. Cloudflare Worker

```bash
npm install -g wrangler
wrangler login
wrangler kv namespace create DASH_KV
```

Copy the returned id into `wrangler.jsonc` → `kv_namespaces[0].id`.

Pick a long random access token and store it:

```bash
wrangler secret put ACCESS_TOKEN
wrangler deploy
```

Open `https://<your-worker>.workers.dev/?t=<ACCESS_TOKEN>` once — a cookie keeps
you signed in afterwards.

> **Multiple Cloudflare accounts?** `wrangler whoami` shows which one you are on.
> Deploying to the wrong account fails with `Authentication error [code: 10000]`.

---

## 2. Google (Gmail + Calendar)

### 2.1 Cloud project
1. [console.cloud.google.com](https://console.cloud.google.com) → create a project.
2. **APIs & Services → Library** → enable **Gmail API** and **Google Calendar API**.
3. **OAuth consent screen** → **External** → fill in name and e-mail → add yourself
   under *Test users* → then **PUBLISH the app**.
   > ⚠️ While the app is in *Testing*, refresh tokens **expire after 7 days**.
   > Publishing (even unverified, for personal use) makes them last.
4. **Credentials → Create credentials → OAuth client ID → Web application**.
   Add `http://localhost:8765` to *Authorized redirect URIs*.
   Save the **Client ID** and **Client secret**.

### 2.2 Refresh token, one per account

```bash
export GOOGLE_CLIENT_ID=...        # set GOOGLE_CLIENT_ID=... on Windows
export GOOGLE_CLIENT_SECRET=...
python scripts/get_google_token.py
```

Click **Allow** in the browser; the script prints the refresh token. Repeat while
logged into each Google account you want on the dashboard.

```bash
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put GOOGLE_RT_PERSONALE      # one per account id
```

Account ids come from `DEFAULT_ACCOUNTS` in `src/index.js` (or the `ACCOUNTS`
var): each id `x` reads the secret `GOOGLE_RT_<X>`. An account without a secret
is simply skipped.

> **Scopes are frozen at consent time.** To add a permission later (say, writing
> to the calendar) you must re-run the script and replace the token — there is no
> API that upgrades an existing one. Only the account owner can grant it.

---

## 3. WhatsApp Cloud API (optional)

Lets you message a bot that creates tasks and calendar events.

### 3.1 Meta app
1. [developers.facebook.com](https://developers.facebook.com) → **Create App** →
   use case **"Connect with customers through WhatsApp"**.
2. In the app: **WhatsApp → API Setup** (newer UI: *Use cases → Connect on
   WhatsApp → Basic setup → Step 1*) → **Claim a test number**.
   Note the **Phone number ID** and **WhatsApp Business Account ID**.
3. Add your own phone under **To** and verify it — the Meta test number can only
   message up to 5 verified recipients, so without this you get no replies.
4. **Settings → Basic** → copy **App ID** and **App secret**.

### 3.2 Permanent token (order matters)
1. [business.facebook.com](https://business.facebook.com/latest/settings) →
   **Users → System users** → add one, role **Admin**.
2. **Add assets → Apps** → your app → *Full control* → save.
3. **Add assets → WhatsApp accounts** → your WABA → *Full control* → save.
4. **Generate new token** → pick the app → **expiry: Never** → tick
   **`whatsapp_business_messaging`** *and* **`whatsapp_business_management`** →
   generate and copy it immediately.

> Skipping steps 2–3 leaves the permission list empty at step 4.
> The "Access token" box in *API Setup* is a **24-hour** token — not this one.
> The Graph API Explorer also only issues temporary tokens.

```bash
wrangler secret put WHATSAPP_APP_ID
wrangler secret put WHATSAPP_APP_SECRET
wrangler secret put WHATSAPP_TOKEN
wrangler secret put WHATSAPP_PHONE_ID
wrangler secret put WHATSAPP_WABA_ID
wrangler secret put WA_VERIFY_TOKEN      # invent a long random string
```

### 3.3 Webhook
In the app → **WhatsApp → Configuration → Webhook → Edit**:

- **Callback URL** `https://<your-worker>.workers.dev/api/wa-webhook`
- **Verify token** the `WA_VERIFY_TOKEN` you just set
- Save, then subscribe the **`messages`** field.

Finally make sure the app is subscribed to the WABA's events:

```bash
curl -X POST "https://graph.facebook.com/v21.0/<WABA_ID>/subscribed_apps?access_token=<PERMANENT_TOKEN>"
curl "https://graph.facebook.com/v21.0/<WABA_ID>/subscribed_apps?access_token=<PERMANENT_TOKEN>"
```

The second call must list **your** app. Saving the callback URL alone is not
enough — without the subscription no message ever reaches the Worker.

### 3.4 Check it
```bash
curl "https://<your-worker>.workers.dev/api/wa-webhook?hub.mode=subscribe&hub.verify_token=<WA_VERIFY_TOKEN>&hub.challenge=ok"   # -> ok
curl "https://<your-worker>.workers.dev/api/cmd?q=aiuto&t=<ACCESS_TOKEN>"                                                        # -> the command list
```
Then message the test number from your phone and read `/api/wa-inbox?t=…`.
If a reply never arrives, `/api/wa-debug?t=…` holds the last send error.

---

## 4. Morning routine (optional)

`docs/SCHEDULED-TASK.md` contains the prompt for a Claude Code scheduled task
that sweeps WhatsApp groups, reads your mail and refills the *Consigli* column.
It needs a browser session, so it is not a headless cron.
