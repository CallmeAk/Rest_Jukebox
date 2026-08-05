# BeatBites

A multi-restaurant guest-engagement platform. The song jukebox is the hook that
gets guests to scan, register, and come back — but the product underneath is a
CRM + loyalty engine. One deployment serves **many venues**; each venue is a
tenant with its own branding, tables, guests, and reward economy.

It runs two ways with the same code:

- **Offline demo** (default): everything lives in the browser's localStorage,
  namespaced per tenant. No backend, no accounts. Great for trying it on one device.
- **Live** (set `SUPABASE_URL` + `SUPABASE_ANON_KEY`): real cross-device data,
  realtime queue updates, and row-level-security multi-tenancy.

---

## What's new in this build (Increment 1)

- **Multi-tenant by design** — a restaurant registry in `config.js`; the active
  venue is chosen by a `?r=<id>` URL parameter. Data is isolated per tenant in
  both storage backends.
- **Two-currency economy** — *Beats* (engagement) and *Loyalty points* (value),
  built on an immutable points ledger instead of a mutable balance.
- **Manual "Go live"** — staff open/close requests for the night with one toggle.
- **Per-guest song cap** — fairness lever so one table can't hog the queue.
- **Staged verification** — browse and vote anonymously; verify to request or earn.
- **Auto-DJ hook mode** — the app can self-advance the queue in hook-length
  segments with a house-playlist fallback, or stay in DJ-assist mode (default).
- **Redemption + staff verify** — loyalty rewards produce a short code staff
  confirm in the console; Beats buy instant "free sinks."
- **Dedication moderation** — shout-outs are approved by staff before they display.
- **Downloadable QR codes** — per-table and "download all," tenant-aware links.

Real-money / third-party integrations (OTP, WhatsApp, licensed full-track
playback, POS) are intentionally **held** for Increment 2 and stubbed at clean
seams — see the end of this document.

---

## Multi-tenancy: running many restaurants

Venues live in `config.js` under `RESTAURANTS`:

```js
DEFAULT_RESTAURANT: "table-stories",
RESTAURANTS: {
  "table-stories": {
    name: "Table Stories Bar & Kitchen",
    emoji: "🍸", color: "#4b4f7a",
    tagline: "Pick the music. Earn as you go.",
    tableCount: 12,
    privacyContact: "hello@tablestories.example"
  },
  "demo-lounge": { /* ... */ }
}
```

The active tenant is resolved at load time from `?r=<id>` in the URL, falling
back to `DEFAULT_RESTAURANT`. So:

- `https://yourapp.vercel.app/?r=table-stories&t=demo-table-3` -> Table Stories, table 3
- `https://yourapp.vercel.app/?r=demo-lounge&t=demo-table-1` -> Demo Lounge, table 1

**Adding a venue:** add an entry to `RESTAURANTS`, and (for the live backend)
insert a row into `restaurants` plus its `restaurant_tables`. Branding, table
count, and privacy contact all come from the registry entry — no code changes.

Isolation is enforced in both backends: the offline store namespaces every key
by tenant id, and Supabase uses tenant-scoped row-level security.

---

## The two-currency economy

Points are stored as an **append-only ledger** (`loyalty_events`), never as a
single editable number. Every earn and spend is a row; a balance is the sum of
rows for a guest and currency. This is what makes two currencies, expiry, atomic
spends, and a full audit trail possible — and it means a balance can always be
recomputed and can't be tampered with client-side.

### Beats — the engagement currency

Earned by playing with the app, spent on things that cost the venue nothing.

| Action | Beats | Notes |
| --- | --- | --- |
| Request a song | +5 | |
| Vote | +1 | only when verified |
| Your song plays | +10 | |
| Per-session cap | 30 | stops a table farming points in one sitting |

Beats buy **free sinks** (`BEATS_REWARDS`): skip your cooldown, bump your song up
the queue, or send a dedication. These are instant and self-serve.

### Loyalty points — the value currency

Earned only by **showing up**, spent on things that cost real money.

| Action | Points |
| --- | --- |
| Verified visit | +50 |
| Return within 14 days | +25 bonus |

Loyalty buys real rewards (`LOYALTY_TIERS`) — a free soft drink, a starter, a
discount. **You cannot tap your way to a free drink; you can only visit your way
there.** That's the whole point of splitting the currencies.

Redeeming a loyalty tier creates a short code (e.g. `R-AB12`, valid 15 minutes).
The guest shows it; staff type it into **Verify reward code** in the console,
which marks it fulfilled so it can't be reused.

All values above are owner-configurable in `config.js` under `ECONOMY`,
`BEATS_REWARDS`, and `LOYALTY_TIERS`.

---

## Go-live, fairness, and staged verification

- **Go live:** the venue starts closed (`LIVE_BY_DEFAULT: false`). Staff flip
  *"Venue is live"* in the DJ console each night. While closed, guests can still
  browse and vote, but requests are rejected with a friendly message.
- **Per-guest cap:** `PER_GUEST_QUEUE_CAP` (default 2) limits how many songs one
  guest can have *waiting* at once — the real fairness control. `MAX_QUEUE_SIZE`
  (70) is just a global safety ceiling.
- **Staged verification:** anyone can browse and vote immediately (votes order
  the queue but earn nothing while anonymous). Requesting a song or redeeming a
  reward requires a quick verify (registration), which is where the guest contact
  is captured. This protects conversion — no wall in front of the fun part.

---

## Auto-DJ

Set in `config.js` under `AUTODJ`, toggleable live in the console:

- **`assist` (default):** requests feed a human DJ's screen; a person stays in control.
- **`auto`:** the app advances the queue itself every `SEGMENT_SECONDS` (default
  35 — play the *hook*, not the whole track, so more guests get their moment).
  When the queue empties it falls back to the `HOUSE_PLAYLIST` so the room is
  never silent. Auto-advance only runs while a staff console is open and the
  venue is live; a manager can always veto with **Play Next** / skip.

Full licensed playback is a venue responsibility (integrate your existing
licensed source, e.g. a PPL/Novex-covered player in India). The built-in iTunes
previews are for search and demo.

---

## Downloadable QR codes

In the Admin -> QR panel:

- Each table card has a **Download** button (600x600 PNG).
- **Download all** grabs every table's code in sequence.

Every QR encodes a tenant-aware deep link (`?r=<venue>&t=<token>`), so a scanned
code drops the guest straight into the right venue at the right table. Demo
tokens are `demo-table-1 ... demo-table-N`; live deployments also generate
non-guessable secure tokens.

---

## Running it

### Offline demo (no setup)

```bash
# from the project root
python3 -m http.server 8000
# open http://localhost:8000/?r=table-stories&t=demo-table-1
```

Staff access in demo mode uses PINs from `config.js` (`DEMO_MODE_PINS`):
**DJ 1234 / Admin 9999**. (Live deployments use Supabase Auth instead.)

### Live (Supabase + Vercel)

1. Create a Supabase project (use a **separate staging project** first).
2. Run `database/schema.sql` in the SQL editor. It creates the tenant model,
   tables, the points ledger, redemptions, dedications, row-level security, and
   the `bb_find_table` / `bb_upsert_guest` server functions, then seeds two demo
   venues.
3. Put your project URL + anon key into `config.js` (`SUPABASE_URL`,
   `SUPABASE_ANON_KEY`). The anon key is safe to ship — RLS is what protects data.
   Any server-only secrets (OTP/WhatsApp/POS, later) go in **Vercel environment
   variables**, never in this file.
4. Deploy to Vercel. `vercel.json` ships a locked-down Content-Security-Policy
   (only Supabase, jsdelivr, iTunes, and the QR service are allowed) plus
   `X-Frame-Options`, HSTS, and related headers.

**Deploy discipline:** build on a feature branch, demo from the Vercel preview
URL, and only promote to production once it's verified.

---

## Tests

Pure-logic core, no dependencies:

```bash
node tests/core.test.js
```

56 checks cover token validation, the two-currency ledger, earning caps, the
go-live gate, per-guest and global queue limits, voting, Beats and Loyalty
redemption (including staff verify and reuse protection), dedication moderation,
playback with house fallback, analytics correctness, and multi-tenant isolation.

---

## Held for Increment 2 (stubbed seams)

These need paid providers or live accounts, so they're parked — but the code is
shaped so turning them on is a swap, not a rewrite:

- **OTP / WhatsApp verification** — the verify *flow* exists; only the message
  send is a stub. Swap the stub for a provider call when you have one. (WhatsApp
  is generally preferable to SMS in India but needs Meta business verification +
  DLT registration.)
- **Geofence** — browser-geolocation soft check; no paid service. Needs the
  venue's coordinates + an acceptable radius, then verify on the live HTTPS site.
- **POS** — starts as a manual "table charges" list staff read at billing;
  replace with a real integration (e.g. Petpooja / Posist) later.
- **Licensed full-track playback** and **push notifications** — integrate the
  venue's licensed source and a push provider when ready.

---

## What must be verified on the deployed site

Some things can't be tested in a sandbox and need a real phone on the live HTTPS
URL: Supabase realtime sync across devices, QR scanning end to end, PWA install,
auto-DJ audio timing, and (in Increment 2) geolocation and OTP delivery.
