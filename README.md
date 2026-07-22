# BeatBites V5 - Customer Ready Demo

This version implements the agreed V4 and V5 scope.

## Added in V4

- Queue position tracking for customers.
- Enhanced DJ dashboard with album art, preview player, skip, remove, play next and mark played.
- Request history.
- Real-time-style customer notifications in demo mode.

## Added in V5

- Business analytics dashboard.
- Guest CRM with search.
- Loyalty points for visits, requests, votes and played songs.
- Table analytics.
- Top artists, genres and hourly request views.

## Existing V3 features preserved

- Secure table token access.
- Guest registration and consent.
- Guest sessions.
- Voting.
- Supabase-ready schema.
- Local demo mode.

## Demo credentials

- DJ PIN: `1234`
- Admin PIN: `9999`
- Table tokens: `demo-table-1` to `demo-table-15`

## Supabase setup

1. Create a Supabase project.
2. Run `database/supabase-schema.sql`.
3. Add your Supabase URL and anon key in `config.js`.
4. Deploy to Vercel.

## Important production notes

For a paid commercial release:

- Move DJ/Admin authentication to Supabase Auth or backend APIs.
- Add OTP verification for mobile numbers.
- Replace demo table tokens with long random tokens.
- Add server-side rate limiting.
- Add Privacy Policy, Terms, consent logs, opt-out and data deletion flow.
- Use a payment provider for premium requests and subscriptions.
