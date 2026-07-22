# BeatBites V3 - Guest Secure Jukebox Platform

This version adds the product points we calibrated:

## Included now

- Secure table token flow instead of raw `?table=1` access.
- Guest registration with name, mobile, email, DOB, favorite genre and consent.
- Guest session creation linked to table token.
- Song request queue with duplicate prevention.
- Customer voting on queued songs.
- Queue position display.
- DJ dashboard with play-next logic.
- Admin dashboard with guest intelligence and QR codes.
- Supabase schema for multi-device realtime data.
- Local demo mode if Supabase is not configured.

## Demo credentials

- DJ PIN: `1234`
- Admin PIN: `9999`
- Table token: `demo-table-1` to `demo-table-15`

## Supabase setup

1. Create Supabase project.
2. Run `database/supabase-schema.sql` in SQL Editor.
3. Open `config.js` and add:
   - SUPABASE_URL
   - SUPABASE_ANON_KEY
4. Deploy to Vercel.

## Production security warning

This is customer-demo ready and architecturally stronger, but for paid production:

- Move DJ/Admin auth to Supabase Auth or backend API.
- Generate long random table tokens, not demo tokens.
- Add OTP verification through Twilio, MSG91, Firebase Auth, or similar vendor.
- Add server-side rate limits.
- Add Privacy Policy and Terms.
- Add consent tracking and data deletion/export flows.
