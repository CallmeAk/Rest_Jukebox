// BeatBites V5 config. Leave Supabase blank for local demo mode.
window.BEATBITES_CONFIG = {
  SUPABASE_URL: "",
  SUPABASE_ANON_KEY: "",
  RESTAURANT_ID: "demo-restaurant",
  RESTAURANT_NAME: "BeatBites Demo Lounge",
  TABLE_COUNT: 15,
  REQUEST_COOLDOWN_MS: 5 * 60 * 1000,
  SEARCH_LIMIT: 8,
  MAX_QUEUE_SIZE: 70,
  DEMO_DJ_PIN: "1234",
  DEMO_ADMIN_PIN: "9999",
  LOYALTY: {
    VISIT_POINTS: 10,
    REQUEST_POINTS: 5,
    VOTE_POINTS: 1,
    PLAYED_POINTS: 10
  }
};
