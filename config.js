/*
 * BeatBites configuration (v7 — multi-tenant engine).
 *
 * BeatBites is a MULTI-RESTAURANT product: one deployment can serve many venues.
 * Each venue is a "tenant" with its own branding, tables, guests and economy.
 * Leave SUPABASE_* blank to run the OFFLINE DEMO (localStorage, per-tenant,
 * single device). Fill them in for the real cross-device + realtime backend.
 */
window.BEATBITES_CONFIG = {
  // --- Backend (blank = offline demo) ---
  SUPABASE_URL: "",
  SUPABASE_ANON_KEY: "",

  // --- Multi-tenant registry --------------------------------------------
  // The active tenant is chosen by ?r=<id> in the URL, else DEFAULT_RESTAURANT.
  DEFAULT_RESTAURANT: "table-stories",
  RESTAURANTS: {
    "table-stories": {
      name: "Table Stories Bar & Kitchen",
      emoji: "🍸",
      color: "#4b4f7a",
      tagline: "Pick the music. Earn as you go.",
      tableCount: 12,
      privacyContact: "hello@tablestories.example"
    },
    "demo-lounge": {
      name: "BeatBites Demo Lounge",
      emoji: "🎵",
      color: "#8b5cf6",
      tagline: "Request songs, vote, earn rewards.",
      tableCount: 15,
      privacyContact: "privacy@beatbites.example"
    }
  },

  // --- Behaviour --------------------------------------------------------
  REQUEST_COOLDOWN_MS: 5 * 60 * 1000,
  SEARCH_LIMIT: 8,
  MAX_QUEUE_SIZE: 70,          // global safety ceiling
  PER_GUEST_QUEUE_CAP: 2,      // fairness: songs one guest may have waiting
  LIVE_BY_DEFAULT: false,      // venue starts OFF; staff press "Go live"
  FILTER_EXPLICIT: true,

  // --- Auto-DJ ----------------------------------------------------------
  // mode 'assist' (default): requests feed a human DJ's screen.
  // mode 'auto': the app advances the queue itself (hook-length segments).
  AUTODJ: {
    MODE: "assist",
    SEGMENT_SECONDS: 35,       // hook mode: play the hook, not the whole song
    HOUSE_PLAYLIST: [          // plays when the request queue is empty
      { title: "House Vibes 1", artist: "BeatBites Radio", genre: "Lounge" },
      { title: "House Vibes 2", artist: "BeatBites Radio", genre: "Lounge" }
    ]
  },

  // --- Economy: TWO currencies ------------------------------------------
  // Beats  = engagement currency (earn by playing with the app; buys free sinks).
  // Loyalty = value currency (earn by SHOWING UP; buys drinks/discounts).
  ECONOMY: {
    BEATS: { REQUEST: 5, VOTE: 1, PLAYED: 10, SESSION_CAP: 30 },
    LOYALTY: { VISIT: 50, RETURN_BONUS: 25, RETURN_WINDOW_DAYS: 14, EXPIRY_DAYS: 90 }
  },
  // Free sinks priced in Beats (cost the venue nothing).
  BEATS_REWARDS: [
    { id: "cooldown", cost: 15, label: "Skip the cooldown", action: "cooldown_reduce" },
    { id: "jump", cost: 25, label: "Bump my song up", action: "queue_jump" },
    { id: "dedicate", cost: 20, label: "Dedication shout-out", action: "dedicate" }
  ],
  // Real rewards priced in Loyalty points (owner absorbs the cost).
  LOYALTY_TIERS: [
    { points: 150, label: "Free soft drink / chai" },
    { points: 300, label: "Free starter or dessert" },
    { points: 500, label: "20% off the bill / premium drink" }
  ],

  // --- Privacy / consent ------------------------------------------------
  PRIVACY_CONTACT: "privacy@beatbites.example",
  DATA_RETENTION_NOTE: "We keep your details only while you remain an active guest and delete them on request.",

  // --- Offline-demo staff access ONLY (real deployments use Supabase Auth) ---
  DEMO_MODE_PINS: { DJ: "1234", ADMIN: "9999" }
};
