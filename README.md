# WhatsApp Invitation Sender (Local)

Send a personalised PDF invitation to every guest on WhatsApp, from your own WhatsApp number, using an app that runs only on your Windows PC.

**The flow (left sidebar):**

1. **Upload Contacts**: choose a CSV with names and phone numbers.
2. **Invitation PDF**: upload your invitation and click where each guest's name should be printed.
3. **Connect WhatsApp**: scan a QR code with your phone (once; the login is remembered).
4. **Send**: write the message, review, and send. Progress shows at the top; results are in **Sent History**.

Nothing is deployed or uploaded anywhere except the messages WhatsApp delivers.

---

## Install and start (Windows)

Requirements: **Node.js 22.13 or newer** (tested on Node 24) and an internet connection for WhatsApp.

Double-click **`start.bat`**. It installs dependencies the first time, starts the app, waits until it is ready, and opens `http://localhost:5173`. Close the "Server" window (or press Ctrl+C in it) to stop.

Or from PowerShell in the project folder:

```powershell
npm install
npm run dev          # opens on http://localhost:5173
```

Production-style build:

```powershell
npm run build
npm run start        # opens on http://127.0.0.1:3001
```

> After changing the code, `npm run start` keeps serving the old build until you run `npm run build` again and restart. `npm run dev` reloads automatically. Don't run both at the same time: only one copy can use the WhatsApp session.

---

## Step 1: Contacts CSV

Any CSV with a name column and a phone column works, for example:

```csv
name,phone
Rahul Shah,9876543210
પ્રિયા પટેલ,919876543211
आरव मेहता,+91 98765 43212
```

- Columns are detected automatically; you can re-map them.
- Phone numbers are cleaned up; 10-digit Indian mobiles get `91` added.
- Invalid and duplicate rows are flagged and not selected. **Export Invalid** downloads them as a CSV to fix in Excel.
- You can edit, select or exclude individual guests. Your original file is never changed.

## Step 2: Invitation PDF

- Upload your PDF with the upload icon (or type a path). Your original file is never changed.
- Click on the page to place the name; adjust size, colour, alignment, page and greeting ("Dear ").
- **Font**: defaults to Windows' built-in *Nirmala UI*, which covers English, Gujarati and Hindi. You can upload another `.ttf`/`.otf`, and optionally separate Gujarati and Hindi fonts.
- A name whose letters the font cannot draw is refused (instead of printing empty boxes).
- **Test PDF** creates a sample for the selected guest so you can check the position.

## Step 3: Connect WhatsApp (QR)

Uses [whatsapp-web.js](https://wwebjs.dev/), which runs a hidden Chromium browser logged in to WhatsApp Web. It is installed from the official GitHub repository, pinned to commit `064a3d5` (28 Sep 2026), because the fix for sending PDFs on current WhatsApp Web is not in an npm release yet (npm's newest is 1.34.7). Switch back to npm once a release after 1.34.7 is out: `npm install whatsapp-web.js@latest --workspace=server`.

1. Click **Connect WhatsApp**. After 10–30 seconds a QR code appears.
2. On your phone: WhatsApp → **Linked Devices** → **Link a Device**, and scan it.
3. Status goes *Authenticating* → *Connected*. Sending is only allowed once it says Connected.

The login is saved in `data/whatsapp-session/` and reused automatically when the app restarts. **Log out** unlinks this PC and deletes the session; **Clear session** deletes the local files for a stuck login.

> ⚠️ **Unofficial automation.** whatsapp-web.js is not made or supported by WhatsApp. It can stop working when WhatsApp updates its web app, and automated sending may break WhatsApp's terms and get your number restricted or banned, especially when messaging people who have not saved your number. Only send to guests who expect the invitation and keep the 20–30 second gap. The gap paces the queue; it is not a way around WhatsApp's anti-spam systems.

**Chromium.** Puppeteer downloads Chrome for Testing to `%USERPROFILE%\.cache\puppeteer` during `npm install`. If npm blocked that step, run `npx puppeteer browsers install chrome`, or set `WIS_CHROME_PATH` in `.env` to your installed Chrome.

## Step 4: Send

- Write the message; `{{name}}` is replaced with each guest's name. It is sent as the caption of the PDF. Messages can be saved and reused.
- Gap between guests: random each time, 20–30 seconds by default.
- **Review & Send** first renders a test PDF (nothing is sent if that fails), then asks for confirmation showing which WhatsApp number will send.
- Sending runs in the background on your PC: refreshing the browser does not stop it. Pause, Resume and Cancel are in the bar at the top.

### Statuses in Sent History

| Status | Meaning |
|---|---|
| Queued | Waiting its turn |
| Sending | Being sent right now |
| Accepted | Handed to WhatsApp Web, not yet confirmed by WhatsApp's server |
| Sent | Reached WhatsApp's server |
| Delivered | Reached the guest's phone |
| Read | Guest opened it (only if they have read receipts on) |
| Failed | See the error, e.g. "not registered on WhatsApp". Can be retried |

---

## Sending safety

- **One sender at a time.** Pause/resume, double clicks and restarts never start a second sender.
- **Random gap** (`crypto.randomInt`) between consecutive guests only; pausing never shortens it.
- **WhatsApp disconnects** pause the campaign with the current guest still queued; reconnect and Resume.
- **Crash recovery.** A guest caught mid-send during a crash or power cut is marked "may already have received it" and is left out of normal retries; resending asks for confirmation.
- **Duplicate campaigns** (same PDF, message and guests) are refused while one is active; repeating a finished one asks first.

## Troubleshooting

| Problem | Fix |
|---|---|
| "Chromium for WhatsApp Web was not found" | `npx puppeteer browsers install chrome`, or set `WIS_CHROME_PATH`. |
| "The WhatsApp session is in use by another running copy" | Close the other copy of the app (`npm run dev` and `npm run start` together). |
| QR never appears / stuck on Initializing | Check the internet connection, then Reconnect. If it persists, Clear session. |
| "Authentication failed" | Clear session and scan again. |
| Disconnected after unlinking on the phone | Expected: scan a new QR code. |
| Broke after a WhatsApp update | Update to the newest fix: `npm install github:wwebjs/whatsapp-web.js#main --workspace=server` (or `whatsapp-web.js@latest` once npm has a newer release). |
| PDF send fails with "Data passed to getter must include an id property" | Bug in npm whatsapp-web.js 1.34.7, fixed by [wwebjs PR #201923](https://github.com/wwebjs/whatsapp-web.js/pull/201923). The app pins the GitHub commit containing it; if the server log warns the fix is missing, run `npm install` and restart. |
| Names show as boxes / generation refused | Choose a font that supports the language (Nirmala UI covers English, Gujarati, Hindi). |

---

## Where things are stored

| What | Where |
|---|---|
| Campaign history and settings | `data/database.sqlite` |
| WhatsApp login | `data/whatsapp-session/` |
| Uploaded PDFs and fonts | `assets/` |
| Generated invitations | `output/generated-pdfs/` |
| Logs | `logs/app.log` (phone numbers masked) |

All of these are excluded from Git. The server listens only on `127.0.0.1` and refuses requests from other sites; the WhatsApp session is never served over HTTP. Finished campaigns older than 90 days are pruned automatically.

## Tests

```powershell
npm test
```

Tests use a fake WhatsApp client (nothing is ever sent), a throwaway database and session folder, a generated PDF, and the Windows Nirmala/Arial fonts.

## License

ISC
