/*
 * BeatBites core business logic (v7).
 * Pure logic over a store adapter. No DOM. Node-testable.
 *
 * Points are a TWO-CURRENCY LEDGER, never a mutable balance:
 *   beats   = engagement currency (request/vote/played, session-capped) -> free sinks
 *   loyalty = value currency (earned by verified VISITS) -> drinks/discounts
 * Every earn and spend is an immutable ledger event; balances are derived by
 * summing. Redemptions insert negative events, so a balance can never be tampered
 * with client-side and can always be recomputed/audited.
 */
(function (root, factory) {
  const api = factory(
    typeof require !== "undefined" ? require("./store.js") : root.BBStore
  );
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof root !== "undefined") root.BBCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (Store) {
  "use strict";
  const { uid, nowISO } = Store;
  const ts = () => Date.now();
  const shortCode = () =>
    "R-" + Math.random().toString(36).slice(2, 6).toUpperCase();

  function createCore(store, config) {
    const C = config;
    const ECON = C.ECONOMY;
    const tiers = (C.LOYALTY_TIERS || []).slice().sort((a, b) => a.points - b.points);

    // ---- ledger helpers ----
    async function ledger(guestId, currency, points, reason, sessionId) {
      if (!guestId || !points) return;
      await store.insertLedger({
        id: uid(),
        restaurant_id: C.RESTAURANT_ID,
        guest_id: guestId,
        currency,
        points,
        reason,
        session_id: sessionId || null,
        created_at: nowISO(),
      });
    }
    // Beats respect a per-session earning cap so a table can't farm points.
    async function earnBeats(guestId, sessionId, amount, reason) {
      if (!guestId || !sessionId) return 0;
      const already = await store.beatsEarnedInSession(sessionId);
      const room = Math.max(0, (ECON.BEATS.SESSION_CAP || Infinity) - already);
      const give = Math.min(amount, room);
      if (give > 0) await ledger(guestId, "beats", give, reason, sessionId);
      return give;
    }

    async function notify(guestId, message) {
      if (!guestId) return;
      await store.insertNotification({
        id: uid(),
        restaurant_id: C.RESTAURANT_ID,
        guest_id: guestId,
        message,
        read: false,
        created_at: nowISO(),
      });
    }
    async function logEvent(req, status) {
      await store.insertEvent({
        id: uid(),
        restaurant_id: C.RESTAURANT_ID,
        request_id: req.id,
        guest_id: req.guest_id,
        table_number: req.table_number,
        title: req.title,
        artist: req.artist,
        genre: req.genre,
        history_status: status,
        history_at: nowISO(),
      });
    }

    return {
      store,
      config: C,
      tiers,

      async findTable(token) {
        return store.findTableByToken(token);
      },

      // Verified visit (registration is the verification step; OTP stubs in here
      // for Increment 2). Awards LOYALTY only — never from tapping the app.
      async registerGuest(fields) {
        const { guest, returning, previousVisitAt } = await store.upsertGuest(fields);
        await ledger(guest.id, "loyalty", ECON.LOYALTY.VISIT, "visit");
        let bonus = 0;
        if (returning && previousVisitAt) {
          const days = (Date.now() - new Date(previousVisitAt).getTime()) / 86400000;
          if (days <= (ECON.LOYALTY.RETURN_WINDOW_DAYS || 14)) {
            bonus = ECON.LOYALTY.RETURN_BONUS || 0;
            await ledger(guest.id, "loyalty", bonus, "return_bonus");
          }
        }
        return { guest, returning, visitAward: ECON.LOYALTY.VISIT, returnBonus: bonus };
      },

      async createSession(guest, table) {
        return store.insertSession({
          id: uid(),
          restaurant_id: C.RESTAURANT_ID,
          guest_id: guest.id,
          table_id: table.id,
          table_number: table.table_number,
          created_at: nowISO(),
          expires_at: new Date(Date.now() + 4 * 3600 * 1000).toISOString(),
        });
      },

      async balances(guestId) {
        return store.getBalances(guestId);
      },

      // ---- go-live gate ----
      async isLive() {
        const v = await store.getLive();
        return v === undefined ? Boolean(C.LIVE_BY_DEFAULT) : Boolean(v);
      },
      async setLive(on) {
        await store.setLive(on);
      },

      async getQueue() {
        return store.getQueue();
      },
      async getPlaying() {
        return store.getPlaying();
      },

      // ---- requests ----
      async requestSong(song, guest, session) {
        if (!session) return { ok: false, reason: "session" };
        if (!(await this.isLive())) return { ok: false, reason: "closed" };
        const last = await store.getCooldown(session.id);
        if (ts() - last < C.REQUEST_COOLDOWN_MS) return { ok: false, reason: "cooldown" };

        const queue = await store.getQueue();
        // Per-guest fairness cap: how many songs this guest already has waiting.
        const mine = queue.filter((q) => q.guest_id === guest.id).length;
        if (mine >= (C.PER_GUEST_QUEUE_CAP || Infinity))
          return { ok: false, reason: "your_limit" };
        if (queue.length >= C.MAX_QUEUE_SIZE) return { ok: false, reason: "full" };
        const dupe = queue.some(
          (x) =>
            x.title.toLowerCase() === song.title.toLowerCase() &&
            x.artist.toLowerCase() === song.artist.toLowerCase()
        );
        if (dupe) return { ok: false, reason: "duplicate" };

        const req = await store.insertRequest({
          id: uid(),
          restaurant_id: C.RESTAURANT_ID,
          guest_id: guest.id,
          session_id: session.id,
          table_number: session.table_number,
          title: song.title,
          artist: song.artist,
          genre: song.genre || guest.favorite_genre || "Unknown",
          artwork_url: song.artwork_url || "",
          preview_url: song.preview_url || "",
          status: "queued",
          priority: 0,
          requested_at: ts(),
          played_at: null,
          deleted_at: null,
        });
        await store.setCooldown(session.id, ts());
        await logEvent(req, "queued");
        await notify(guest.id, `Request accepted: ${req.title}`);
        const got = await earnBeats(guest.id, session.id, ECON.BEATS.REQUEST, "song_request");
        return { ok: true, request: req, beats: got };
      },

      async vote(requestId, session) {
        if (!session) return { ok: false, reason: "session" };
        const added = await store.insertVote({
          id: uid(),
          restaurant_id: C.RESTAURANT_ID,
          request_id: requestId,
          session_id: session.id,
          guest_id: session.guest_id,
          created_at: nowISO(),
        });
        if (!added) return { ok: false, reason: "already" };
        const got = await earnBeats(session.guest_id, session.id, ECON.BEATS.VOTE, "song_vote");
        return { ok: true, beats: got };
      },

      // ---- playback ----
      houseTrack() {
        const list = (C.AUTODJ && C.AUTODJ.HOUSE_PLAYLIST) || [];
        if (!list.length) return null;
        const pick = list[Math.floor(Math.random() * list.length)];
        return { ...pick, house: true };
      },
      async playNext() {
        const queue = await store.getQueue();
        const cur = await store.getPlaying();
        if (cur) await store.updateRequest(cur.id, { status: "played" });
        if (!queue.length) return this.houseTrack(); // fallback keeps the room alive
        const next = queue[0];
        const req = await store.updateRequest(next.id, { status: "playing", played_at: ts() });
        await logEvent(req, "playing");
        await notify(req.guest_id, `Now playing: ${req.title}`);
        // Requester earns beats when their song actually plays.
        await earnBeats(req.guest_id, req.session_id, ECON.BEATS.PLAYED, "song_played");
        // Heads-up to whoever is next.
        if (queue[1]) await notify(queue[1].guest_id, `You're next: ${queue[1].title}`);
        return req;
      },
      async markPlayed() {
        const p = await store.getPlaying();
        if (!p) return;
        await store.updateRequest(p.id, { status: "played" });
        await logEvent(p, "played");
        await notify(p.guest_id, `Completed: ${p.title}`);
      },
      async remove(id, status = "removed") {
        const req = (await store.getRequests()).find((r) => r.id === id);
        if (!req) return;
        await store.updateRequest(id, { status });
        await logEvent(req, status);
        await notify(req.guest_id, `Your request was ${status}: ${req.title}`);
      },
      async skip(id) {
        return this.remove(id, "skipped");
      },
      async clearQueue() {
        for (const r of await store.getQueue())
          await store.updateRequest(r.id, { status: "removed" });
      },

      // ---- Beats redemption (free sinks) ----
      async redeemBeats(guest, rewardId, session, extra) {
        const reward = (C.BEATS_REWARDS || []).find((r) => r.id === rewardId);
        if (!reward) return { ok: false, reason: "unknown" };
        const bal = await store.getBalances(guest.id);
        if (bal.beats < reward.cost) return { ok: false, reason: "insufficient" };
        await ledger(guest.id, "beats", -reward.cost, "redeem_" + reward.action, session && session.id);

        if (reward.action === "cooldown_reduce" && session) {
          await store.setCooldown(session.id, 0);
        } else if (reward.action === "queue_jump") {
          const mine = (await store.getQueue())
            .filter((q) => q.guest_id === guest.id)
            .sort((a, b) => b.requested_at - a.requested_at)[0];
          if (mine) await store.updateRequest(mine.id, { priority: ts() });
        } else if (reward.action === "dedicate") {
          await store.insertDedication({
            id: uid(),
            restaurant_id: C.RESTAURANT_ID,
            guest_id: guest.id,
            message: String((extra && extra.message) || "").slice(0, 120),
            status: "pending", // must be approved by staff before it shows
            created_at: nowISO(),
          });
        }
        return { ok: true, action: reward.action, spent: reward.cost };
      },

      // ---- Loyalty redemption (staff-verified) ----
      async redeemLoyalty(guest, tierIndex) {
        const tier = tiers[tierIndex];
        if (!tier) return { ok: false, reason: "unknown" };
        const bal = await store.getBalances(guest.id);
        if (bal.loyalty < tier.points) return { ok: false, reason: "insufficient" };
        await ledger(guest.id, "loyalty", -tier.points, "redeem_reward");
        const code = shortCode();
        await store.insertRedemption({
          id: uid(),
          restaurant_id: C.RESTAURANT_ID,
          guest_id: guest.id,
          label: tier.label,
          points: tier.points,
          code,
          status: "pending",
          created_at: nowISO(),
          expires_at: new Date(Date.now() + 15 * 60000).toISOString(),
        });
        return { ok: true, code, label: tier.label };
      },
      async verifyRedemption(code) {
        const r = await store.getRedemptionByCode(String(code || "").trim().toUpperCase());
        if (!r) return { ok: false, reason: "not_found" };
        if (r.status === "fulfilled") return { ok: false, reason: "used" };
        if (r.expires_at && new Date(r.expires_at) < new Date())
          return { ok: false, reason: "expired" };
        await store.updateRedemption(r.id, { status: "fulfilled", fulfilled_at: nowISO() });
        return { ok: true, redemption: r };
      },

      // ---- dedications moderation ----
      async getDedications(statusFilter) {
        const all = await store.getDedications();
        return statusFilter ? all.filter((d) => d.status === statusFilter) : all;
      },
      async moderateDedication(id, approve) {
        return store.updateDedication(id, { status: approve ? "approved" : "rejected" });
      },

      async submitFeedback(guest, rating, comment) {
        await store.insertFeedback({
          id: uid(),
          restaurant_id: C.RESTAURANT_ID,
          guest_id: guest ? guest.id : null,
          rating,
          comment: comment || null,
          created_at: nowISO(),
        });
      },

      async getGuests() {
        return store.getGuests();
      },
      async getNotifications(guestId) {
        return store.getNotifications(guestId);
      },
      async getEvents() {
        return store.getEvents();
      },

      rewardProgress(points) {
        points = points || 0;
        const next = tiers.find((t) => t.points > points);
        const prev = [...tiers].reverse().find((t) => t.points <= points);
        const floor = prev ? prev.points : 0;
        const ceil = next ? next.points : floor || 1;
        const pct = next ? Math.min(100, Math.round(((points - floor) / (ceil - floor)) * 100)) : 100;
        return { next, pct, current: prev || null };
      },

      // CORRECTED analytics + owner ROI framing (contacts captured, returns).
      async analytics() {
        const requests = await store.getRequests();
        const guests = await store.getGuests();
        const totalVotes = requests.reduce((a, r) => a + (r.votes || 0), 0);
        const countBy = (key, prefix = "") =>
          requests.reduce((acc, r) => {
            let k = r[key] == null ? "Unknown" : r[key];
            k = prefix ? prefix + k : k;
            acc[k] = (acc[k] || 0) + 1;
            return acc;
          }, {});
        const byHour = requests.reduce((acc, r) => {
          const d = new Date(r.requested_at || Date.now());
          const h = String(d.getHours()).padStart(2, "0") + ":00";
          acc[h] = (acc[h] || 0) + 1;
          return acc;
        }, {});
        const contactsCaptured = guests.filter((g) => g.mobile).length;
        const marketingOptIns = guests.filter((g) => g.consent_marketing).length;
        return {
          totalGuests: guests.length,
          contactsCaptured,
          marketingOptIns,
          returningGuests: guests.filter((g) => (g.visit_count || 1) > 1).length,
          totalRequests: requests.length,
          totalVotes,
          topArtists: countBy("artist"),
          topGenres: countBy("genre"),
          byTable: countBy("table_number", "Table "),
          byHour,
        };
      },
    };
  }

  return { createCore };
});
