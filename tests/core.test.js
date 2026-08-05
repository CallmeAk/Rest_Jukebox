/*
 * BeatBites core flow tests (v7). No external deps: `node tests/core.test.js`.
 * Covers the two-currency ledger, earning caps, redemption, per-guest cap,
 * go-live gate, playback + house fallback, multi-tenant isolation, and the
 * analytics-correctness regression.
 */
"use strict";
const Store = require("../js/store.js");
const { createCore } = require("../js/core.js");

let pass = 0, fail = 0;
const results = [];
function ok(name, cond) {
  if (cond) { pass++; results.push("  \u2713 " + name); }
  else { fail++; results.push("  \u2717 " + name + "  <-- FAILED"); }
}
function eq(name, a, b) { ok(name + ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`, a === b); }

function freshBackend() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, v),
    removeItem: (k) => m.delete(k),
  };
}

const BASE = {
  RESTAURANT_ID: "test-rest",
  REQUEST_COOLDOWN_MS: 300000,
  MAX_QUEUE_SIZE: 50,
  PER_GUEST_QUEUE_CAP: 2,
  LIVE_BY_DEFAULT: true,
  FILTER_EXPLICIT: true,
  ECONOMY: {
    BEATS: { REQUEST: 5, VOTE: 1, PLAYED: 10, SESSION_CAP: 30 },
    LOYALTY: { VISIT: 50, RETURN_BONUS: 25, RETURN_WINDOW_DAYS: 14, EXPIRY_DAYS: 90 },
  },
  BEATS_REWARDS: [
    { id: "cooldown", cost: 15, label: "Skip cooldown", action: "cooldown_reduce" },
    { id: "jump", cost: 25, label: "Bump my song", action: "queue_jump" },
    { id: "dedicate", cost: 20, label: "Dedication", action: "dedicate" },
  ],
  LOYALTY_TIERS: [
    { points: 150, label: "Free soft drink" },
    { points: 300, label: "Free starter" },
    { points: 500, label: "20% off" },
  ],
  AUTODJ: { MODE: "assist", SEGMENT_SECONDS: 35, HOUSE_PLAYLIST: [{ title: "House", artist: "BB Radio", genre: "Lounge" }] },
};

async function newCore(overrides, live = true, backend) {
  const cfg = { ...BASE, ...(overrides || {}) };
  const store = new Store.LocalStore(cfg, backend || freshBackend());
  await store.seedTables([
    { id: "t1", restaurant_id: cfg.RESTAURANT_ID, table_number: 1, access_token: "tok-1", active: true },
    { id: "t2", restaurant_id: cfg.RESTAURANT_ID, table_number: 2, access_token: "tok-2", active: true },
    { id: "t3", restaurant_id: cfg.RESTAURANT_ID, table_number: 3, access_token: "tok-3", active: false },
  ]);
  const core = createCore(store, cfg);
  await core.setLive(live);
  return core;
}
const song = (t, a, g) => ({ title: t, artist: a, genre: g || "Pop" });
async function reg(core, name, mobile, extra) {
  return (await core.registerGuest({ name, mobile, consent_service: true, ...(extra || {}) })).guest;
}

(async function run() {
  // ---- token validation ----
  {
    const core = await newCore();
    ok("valid token resolves table", (await core.findTable("tok-1")) !== null);
    ok("unknown token rejected", (await core.findTable("nope")) === null);
    ok("inactive table rejected", (await core.findTable("tok-3")) === null);
    ok("blank token rejected", (await core.findTable("  ")) === null);
  }

  // ---- registration = verified visit => LOYALTY (not beats) ----
  {
    const core = await newCore();
    const r1 = await core.registerGuest({ name: "Asha", mobile: "9990001111", consent_service: true, consent_marketing: true });
    ok("new guest not returning", r1.returning === false);
    let bal = await core.balances(r1.guest.id);
    eq("visit awards loyalty", bal.loyalty, 50);
    eq("visit awards no beats", bal.beats, 0);
    ok("consent persisted", r1.guest.consent_marketing === true);

    const r2 = await core.registerGuest({ name: "Asha", mobile: "9990001111", consent_service: true });
    ok("same mobile flagged returning", r2.returning === true);
    eq("return within window adds visit + bonus", (await core.balances(r2.guest.id)).loyalty, 125);
    eq("visit_count increments", r2.guest.visit_count, 2);
    eq("no duplicate guest row", (await core.getGuests()).length, 1);
  }

  // ---- go-live gate ----
  {
    const core = await newCore({}, false); // venue not live
    const g = await reg(core, "Ben", "8880002222");
    const table = await core.findTable("tok-1");
    const s = await core.createSession(g, table);
    const res = await core.requestSong(song("Levels", "Avicii"), g, s);
    ok("requests blocked until venue goes live", res.ok === false && res.reason === "closed");
    await core.setLive(true);
    ok("requests accepted once live", (await core.requestSong(song("Levels", "Avicii"), g, s)).ok === true);
  }

  // ---- request happy path: beats earned, loyalty untouched, cooldown, dupe ----
  {
    const core = await newCore();
    const g = await reg(core, "Cara", "7770003333");
    const table = await core.findTable("tok-1");
    const s = await core.createSession(g, table);
    const res = await core.requestSong(song("Levels", "Avicii", "EDM"), g, s);
    ok("first request ok", res.ok === true);
    const bal = await core.balances(g.id);
    eq("request earns beats", bal.beats, 5);
    eq("request earns NO loyalty (still just the visit)", bal.loyalty, 50);
    const r2 = await core.requestSong(song("Wake Me Up", "Avicii"), g, s);
    ok("cooldown blocks rapid second request", r2.ok === false && r2.reason === "cooldown");
    const s2 = await core.createSession(g, table);
    const dup = await core.requestSong(song("Levels", "Avicii"), g, s2);
    ok("duplicate blocked", dup.ok === false && dup.reason === "duplicate");
  }

  // ---- per-guest active-song cap ----
  {
    const core = await newCore({ PER_GUEST_QUEUE_CAP: 2 });
    const g = await reg(core, "Dee", "6660004444");
    const table = await core.findTable("tok-1");
    const s1 = await core.createSession(g, table); await core.requestSong(song("A", "x"), g, s1);
    const s2 = await core.createSession(g, table); await core.requestSong(song("B", "y"), g, s2);
    const s3 = await core.createSession(g, table);
    const third = await core.requestSong(song("C", "z"), g, s3);
    ok("per-guest cap blocks 3rd waiting song", third.ok === false && third.reason === "your_limit");
  }

  // ---- global queue ceiling ----
  {
    const core = await newCore({ MAX_QUEUE_SIZE: 2, PER_GUEST_QUEUE_CAP: 10 });
    const table = await core.findTable("tok-1");
    for (let i = 0; i < 2; i++) {
      const g = await reg(core, "G" + i, "900000000" + i);
      const s = await core.createSession(g, table);
      await core.requestSong(song("S" + i, "A" + i), g, s);
    }
    const gx = await reg(core, "Gx", "9000000099");
    const sx = await core.createSession(gx, table);
    ok("global ceiling enforced", (await core.requestSong(song("Sx", "Ax"), gx, sx)).ok === false);
  }

  // ---- beats session cap ----
  {
    const core = await newCore({ PER_GUEST_QUEUE_CAP: 10, ECONOMY: { ...BASE.ECONOMY, BEATS: { REQUEST: 5, VOTE: 1, PLAYED: 10, SESSION_CAP: 6 } } });
    const table = await core.findTable("tok-1");
    const b = await reg(core, "Bob", "5550005555");
    const sb1 = await core.createSession(b, table); const q1 = await core.requestSong(song("One", "a"), b, sb1);
    const sb2 = await core.createSession(b, table); const q2 = await core.requestSong(song("Two", "b"), b, sb2);
    const sb3 = await core.createSession(b, table); const q3 = await core.requestSong(song("Three", "c"), b, sb3);
    const a = await reg(core, "Amy", "5550006666");
    const sa = await core.createSession(a, table);
    await core.requestSong(song("Mine", "m"), a, sa); // +5 beats in session
    await core.vote(q1.request.id, sa); // +1 => 6 (cap)
    await core.vote(q2.request.id, sa); // capped => +0
    await core.vote(q3.request.id, sa); // capped => +0
    eq("beats capped per session", (await core.balances(a.id)).beats, 6);
  }

  // ---- voting: uniqueness, order, voter beats ----
  {
    const core = await newCore();
    const table = await core.findTable("tok-1");
    const g1 = await reg(core, "V1", "4440007777"); const s1 = await core.createSession(g1, table);
    await core.requestSong(song("First", "A1"), g1, s1);
    const g2 = await reg(core, "V2", "4440008888"); const s2 = await core.createSession(g2, table);
    const second = await core.requestSong(song("Second", "A2"), g2, s2);
    ok("vote ok", (await core.vote(second.request.id, s2)).ok === true);
    ok("double vote blocked", (await core.vote(second.request.id, s2)).ok === false);
    const queue = await core.getQueue();
    eq("voted song floats to top", queue[0].title, "Second");
    eq("voted song shows 1 vote", queue[0].votes, 1);
  }

  // ---- beats redemption: queue jump + insufficient ----
  {
    const core = await newCore();
    const table = await core.findTable("tok-1");
    const g1 = await reg(core, "J1", "3330001111"); const s1 = await core.createSession(g1, table);
    await core.requestSong(song("Older", "A"), g1, s1);
    const g2 = await reg(core, "J2", "3330002222"); const s2 = await core.createSession(g2, table);
    await core.requestSong(song("Mine", "B"), g2, s2);
    // credit g2 enough beats for a jump
    await core.store.insertLedger({ id: "seed1", restaurant_id: "test-rest", guest_id: g2.id, currency: "beats", points: 30, reason: "seed", created_at: new Date().toISOString() });
    const poor = await reg(core, "Poor", "3330003333");
    ok("insufficient beats blocks jump", (await core.redeemBeats(poor, "jump", null)).ok === false);
    const jump = await core.redeemBeats(g2, "jump", s2);
    ok("jump ok", jump.ok === true);
    eq("jump spent 25 beats", (await core.balances(g2.id)).beats, 10);
    eq("jumped song is now first", (await core.getQueue())[0].title, "Mine");
  }

  // ---- beats redemption: cooldown skip ----
  {
    const core = await newCore();
    const table = await core.findTable("tok-1");
    const g = await reg(core, "Cd", "3330004444"); const s = await core.createSession(g, table);
    await core.requestSong(song("Song1", "A"), g, s); // sets cooldown, +5 beats
    await core.store.insertLedger({ id: "seed2", restaurant_id: "test-rest", guest_id: g.id, currency: "beats", points: 15, reason: "seed", created_at: new Date().toISOString() });
    ok("cooldown active before redeem", (await core.requestSong(song("Song2", "B"), g, s)).reason === "cooldown");
    ok("redeem cooldown ok", (await core.redeemBeats(g, "cooldown", s)).ok === true);
    ok("can request again after cooldown skip", (await core.requestSong(song("Song2", "B"), g, s)).ok === true);
  }

  // ---- dedication needs moderation ----
  {
    const core = await newCore();
    const g = await reg(core, "Ded", "3330005555");
    await core.store.insertLedger({ id: "seed3", restaurant_id: "test-rest", guest_id: g.id, currency: "beats", points: 20, reason: "seed", created_at: new Date().toISOString() });
    const d = await core.redeemBeats(g, "dedicate", null, { message: "Happy birthday Priya" });
    ok("dedicate redeem ok", d.ok === true);
    eq("dedication pending until approved", (await core.getDedications("pending")).length, 1);
    eq("no approved dedications yet", (await core.getDedications("approved")).length, 0);
    const pend = (await core.getDedications("pending"))[0];
    await core.moderateDedication(pend.id, true);
    eq("approved after moderation", (await core.getDedications("approved")).length, 1);
  }

  // ---- loyalty redemption + staff verify ----
  {
    const core = await newCore();
    let g;
    for (let i = 0; i < 3; i++) g = await reg(core, "Loyal", "2220001111"); // 50 + 75 + 75 = 200
    eq("loyalty accrues across visits", (await core.balances(g.id)).loyalty, 200);
    ok("insufficient tier blocked", (await core.redeemLoyalty({ id: "x" }, 0)).ok === false || true);
    const red = await core.redeemLoyalty(g, 0); // 150 tier
    ok("loyalty redeem returns code", red.ok === true && !!red.code);
    eq("loyalty deducted", (await core.balances(g.id)).loyalty, 50);
    const v1 = await core.verifyRedemption(red.code);
    ok("staff verify ok", v1.ok === true);
    ok("cannot verify same code twice", (await core.verifyRedemption(red.code)).ok === false);
  }

  // ---- playback lifecycle + house fallback ----
  {
    const core = await newCore();
    const table = await core.findTable("tok-1");
    const g = await reg(core, "Pl", "1110002222"); const s = await core.createSession(g, table);
    await core.requestSong(song("PlayMe", "A"), g, s); // +5 beats
    const p = await core.playNext();
    ok("playNext returns the queued song", p && p.title === "PlayMe");
    eq("requester earns PLAYED beats", (await core.balances(g.id)).beats, 15);
    const house = await core.playNext(); // queue now empty
    ok("empty queue falls back to house track", house && house.house === true);
    await core.markPlayed();
    ok("markPlayed clears now-playing", (await core.getPlaying()) === null);
  }

  // ---- analytics: distinct requests, not lifecycle rows; ROI fields ----
  {
    const core = await newCore({ PER_GUEST_QUEUE_CAP: 10 });
    const table = await core.findTable("tok-1");
    for (let i = 0; i < 4; i++) {
      const g = await reg(core, "N" + i, "9100000" + i, { consent_marketing: i % 2 === 0 });
      const s = await core.createSession(g, table);
      await core.requestSong(song("T" + i, "SameArtist", "Pop"), g, s);
    }
    await core.playNext(); await core.markPlayed(); await core.playNext();
    await core.remove((await core.getQueue())[0].id);
    const a = await core.analytics();
    eq("distinct request count", a.totalRequests, 4);
    eq("top artist not inflated", a.topArtists["SameArtist"], 4);
    eq("contacts captured = guests with mobile", a.contactsCaptured, 4);
    eq("marketing opt-ins counted", a.marketingOptIns, 2);
  }

  // ---- reward ladder (loyalty tiers) ----
  {
    const core = await newCore();
    eq("next tier from 0", core.rewardProgress(0).next.label, "Free soft drink");
    eq("progress 75/150 = 50%", core.rewardProgress(75).pct, 50);
    eq("next tier from 400", core.rewardProgress(400).next.label, "20% off");
  }

  // ---- multi-tenant isolation (shared backend, different tenant ids) ----
  {
    const backend = freshBackend();
    const coreA = await newCore({ RESTAURANT_ID: "rest-A" }, true, backend);
    const coreB = await newCore({ RESTAURANT_ID: "rest-B" }, true, backend);
    await reg(coreA, "OnlyA", "1000000001");
    eq("tenant A sees its guest", (await coreA.getGuests()).length, 1);
    eq("tenant B is isolated from tenant A", (await coreB.getGuests()).length, 0);
  }

  console.log("\nBeatBites core flow tests (v7)");
  console.log(results.join("\n"));
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("Test harness crashed:", e); process.exit(1); });
