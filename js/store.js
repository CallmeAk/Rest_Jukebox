/*
 * BeatBites storage layer.
 *
 * Two adapters implement one identical async interface:
 *   - LocalStore     : localStorage. Single-device OFFLINE DEMO ONLY. No cross-device sync.
 *   - SupabaseStore  : real Postgres via Supabase. Cross-device + realtime. Production path.
 *
 * The core business logic (core.js) never talks to a backend directly; it only
 * talks to whichever store it is handed. That is what makes cross-device sync a
 * config switch instead of a rewrite.
 *
 * Works in the browser (attaches to window.BBStore) and in Node (module.exports)
 * so the logic can be unit-tested without a browser.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof root !== "undefined") root.BBStore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const nowISO = () => new Date().toISOString();
  const uid = () =>
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : "id-" + Math.random().toString(16).slice(2) + Date.now().toString(16);

  // Ordering: a purchased priority boost wins, then votes, then recency.
  const scoreSort = (a, b) =>
    (b.priority || 0) - (a.priority || 0) ||
    (b.votes || 0) * 1e13 + b.requested_at - ((a.votes || 0) * 1e13 + a.requested_at);

  /* --------------------------------------------------------------------- *
   * LocalStore — offline demo. Everything is one browser's localStorage.
   * Single source of truth for requests => no double-counting, no vote drift.
   * --------------------------------------------------------------------- */
  class LocalStore {
    constructor(config, backend) {
      this.config = config;
      this.rid = config.RESTAURANT_ID;
      // Injectable backend so Node tests can pass an in-memory map.
      this.mem =
        backend ||
        (typeof localStorage !== "undefined"
          ? localStorage
          : (() => {
              const m = new Map();
              return {
                getItem: (k) => (m.has(k) ? m.get(k) : null),
                setItem: (k, v) => m.set(k, v),
                removeItem: (k) => m.delete(k),
              };
            })());
      this.listeners = new Set();
      const ns = (k) => `${k}:${this.rid}`; // per-tenant isolation
      this.K = {
        TABLES: ns("bb_tables"),
        GUESTS: ns("bb_guests"),
        SESSIONS: ns("bb_sessions"),
        REQUESTS: ns("bb_requests"), // single source of truth for every request
        VOTES: ns("bb_votes"),
        EVENTS: ns("bb_events"), // append-only feed for the DJ history panel
        LEDGER: ns("bb_ledger"), // two-currency points ledger (source of truth)
        NOTES: ns("bb_notifications"),
        COOLDOWNS: ns("bb_cooldowns"),
        FEEDBACK: ns("bb_feedback"),
        REDEMPTIONS: ns("bb_redemptions"),
        LIVE: ns("bb_live"),
        DEDICATIONS: ns("bb_dedications"),
      };
      // cross-tab (same device) realtime
      if (typeof window !== "undefined") {
        window.addEventListener("storage", () => this._emit());
        window.addEventListener("bb-local", () => this._emit());
      }
    }

    kind() {
      return "local";
    }
    _get(k, fb) {
      try {
        const v = JSON.parse(this.mem.getItem(k));
        return v == null ? fb : v;
      } catch {
        return fb;
      }
    }
    _set(k, v) {
      this.mem.setItem(k, JSON.stringify(v));
      if (typeof window !== "undefined")
        window.dispatchEvent(new Event("bb-local"));
    }
    _emit() {
      this.listeners.forEach((fn) => {
        try {
          fn();
        } catch {}
      });
    }
    onChange(fn) {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    }

    async seedTables(tables) {
      if (this._get(this.K.TABLES, null)) return;
      this._set(this.K.TABLES, tables);
    }
    async getTables() {
      return this._get(this.K.TABLES, []).filter((t) => t.active);
    }
    async findTableByToken(token) {
      token = String(token || "").trim();
      return (
        this._get(this.K.TABLES, []).find(
          (t) => t.access_token === token && t.active
        ) || null
      );
    }

    async getGuestByMobile(mobile) {
      return (
        this._get(this.K.GUESTS, []).find((g) => g.mobile === mobile) || null
      );
    }
    async insertGuest(g) {
      const guests = this._get(this.K.GUESTS, []);
      guests.push(g);
      this._set(this.K.GUESTS, guests);
      return g;
    }
    async updateGuest(id, patch) {
      let updated = null;
      const guests = this._get(this.K.GUESTS, []).map((g) => {
        if (g.id === id) {
          updated = { ...g, ...patch };
          return updated;
        }
        return g;
      });
      this._set(this.K.GUESTS, guests);
      return updated;
    }
    async getGuests() {
      return this._get(this.K.GUESTS, []).filter((g) => !g.deleted_at);
    }
    // Upsert by mobile. Returning guests get a visit-point bump.
    async upsertGuest(fields) {
      const existing = await this.getGuestByMobile(fields.mobile);
      if (existing) {
        const previousVisitAt = existing.last_visit_at || null;
        const guest = await this.updateGuest(existing.id, {
          ...fields,
          visit_count: (existing.visit_count || 1) + 1,
          last_visit_at: nowISO(),
        });
        return { guest, returning: true, previousVisitAt };
      }
      const guest = await this.insertGuest({
        id: uid(),
        restaurant_id: this.rid,
        ...fields,
        visit_count: 1,
        created_at: nowISO(),
        last_visit_at: nowISO(),
      });
      return { guest, returning: false, previousVisitAt: null };
    }

    async insertSession(s) {
      const arr = this._get(this.K.SESSIONS, []);
      arr.push(s);
      this._set(this.K.SESSIONS, arr);
      return s;
    }

    async insertRequest(r) {
      const arr = this._get(this.K.REQUESTS, []);
      arr.push(r);
      this._set(this.K.REQUESTS, arr);
      return r;
    }
    async updateRequest(id, patch) {
      let updated = null;
      const arr = this._get(this.K.REQUESTS, []).map((r) => {
        if (r.id === id) {
          updated = { ...r, ...patch };
          return updated;
        }
        return r;
      });
      this._set(this.K.REQUESTS, arr);
      return updated;
    }
    // All requests ever (distinct rows). Votes are computed here, never stored,
    // so the count can never drift from the votes table.
    async getRequests() {
      const votes = this._get(this.K.VOTES, []);
      return this._get(this.K.REQUESTS, [])
        .filter((r) => !r.deleted_at)
        .map((r) => ({
          ...r,
          votes: votes.filter((v) => v.request_id === r.id).length,
        }));
    }
    async getQueue() {
      return (await this.getRequests())
        .filter((r) => r.status === "queued")
        .sort(scoreSort);
    }
    async getPlaying() {
      return (await this.getRequests()).find((r) => r.status === "playing") || null;
    }

    async insertVote(v) {
      const votes = this._get(this.K.VOTES, []);
      if (
        votes.some(
          (x) => x.request_id === v.request_id && x.session_id === v.session_id
        )
      )
        return false; // uniqueness enforced
      votes.push(v);
      this._set(this.K.VOTES, votes);
      return true;
    }
    async countVotes(requestId) {
      return this._get(this.K.VOTES, []).filter(
        (v) => v.request_id === requestId
      ).length;
    }

    async insertEvent(e) {
      const arr = this._get(this.K.EVENTS, []);
      arr.push(e);
      this._set(this.K.EVENTS, arr.slice(-500));
      return e;
    }
    async getEvents() {
      return this._get(this.K.EVENTS, []);
    }

    // Two-currency ledger: every earn/spend is an event; balances are derived.
    async insertLedger(e) {
      const arr = this._get(this.K.LEDGER, []);
      arr.push(e);
      this._set(this.K.LEDGER, arr);
      return e;
    }
    async getLedger(guestId) {
      const all = this._get(this.K.LEDGER, []);
      return guestId ? all.filter((e) => e.guest_id === guestId) : all;
    }
    async getBalances(guestId) {
      const rows = await this.getLedger(guestId);
      const sum = (cur) =>
        rows.filter((r) => r.currency === cur).reduce((a, r) => a + r.points, 0);
      return { beats: sum("beats"), loyalty: sum("loyalty") };
    }
    async beatsEarnedInSession(sessionId) {
      return this._get(this.K.LEDGER, [])
        .filter((r) => r.session_id === sessionId && r.currency === "beats" && r.points > 0)
        .reduce((a, r) => a + r.points, 0);
    }

    // Manual go-live state.
    async getLive() {
      return Boolean(this._get(this.K.LIVE, false));
    }
    async setLive(on) {
      this._set(this.K.LIVE, Boolean(on));
    }

    // Loyalty redemptions awaiting staff verification.
    async insertRedemption(r) {
      const arr = this._get(this.K.REDEMPTIONS, []);
      arr.push(r);
      this._set(this.K.REDEMPTIONS, arr);
      return r;
    }
    async getRedemptionByCode(code) {
      return this._get(this.K.REDEMPTIONS, []).find((r) => r.code === code) || null;
    }
    async updateRedemption(id, patch) {
      let out = null;
      const arr = this._get(this.K.REDEMPTIONS, []).map((r) =>
        r.id === id ? (out = { ...r, ...patch }) : r
      );
      this._set(this.K.REDEMPTIONS, arr);
      return out;
    }
    async getRedemptions() {
      return this._get(this.K.REDEMPTIONS, []);
    }

    // Dedications (public shout-outs) need staff approval before display.
    async insertDedication(d) {
      const arr = this._get(this.K.DEDICATIONS, []);
      arr.push(d);
      this._set(this.K.DEDICATIONS, arr);
      return d;
    }
    async getDedications() {
      return this._get(this.K.DEDICATIONS, []);
    }
    async updateDedication(id, patch) {
      let out = null;
      const arr = this._get(this.K.DEDICATIONS, []).map((r) =>
        r.id === id ? (out = { ...r, ...patch }) : r
      );
      this._set(this.K.DEDICATIONS, arr);
      return out;
    }

    async insertNotification(n) {
      const arr = this._get(this.K.NOTES, []);
      arr.unshift(n);
      this._set(this.K.NOTES, arr.slice(0, 200));
      return n;
    }
    async getNotifications(guestId) {
      return this._get(this.K.NOTES, []).filter((n) => n.guest_id === guestId);
    }

    async insertFeedback(f) {
      const arr = this._get(this.K.FEEDBACK, []);
      arr.push(f);
      this._set(this.K.FEEDBACK, arr);
      return f;
    }
    async getFeedback() {
      return this._get(this.K.FEEDBACK, []);
    }

    async getCooldown(sessionId) {
      return Number(this._get(this.K.COOLDOWNS, {})[sessionId] || 0);
    }
    async setCooldown(sessionId, ts) {
      const cds = this._get(this.K.COOLDOWNS, {});
      cds[sessionId] = ts;
      this._set(this.K.COOLDOWNS, cds);
    }
  }

  /* --------------------------------------------------------------------- *
   * SupabaseStore — real backend. Cross-device state + realtime.
   * Same interface as LocalStore. This is the production path.
   * --------------------------------------------------------------------- */
  class SupabaseStore {
    constructor(config, sb) {
      this.config = config;
      this.rid = config.RESTAURANT_ID;
      this.sb = sb;
      this.listeners = new Set();
      this._channel = null;
    }
    kind() {
      return "supabase";
    }
    _t(name) {
      return this.sb.from(name);
    }

    onChange(fn) {
      this.listeners.add(fn);
      if (!this._channel) {
        // Realtime: any change to requests or votes re-renders every device.
        this._channel = this.sb
          .channel("bb-realtime")
          .on(
            "postgres_changes",
            { event: "*", schema: "public", table: "song_requests" },
            () => this._emit()
          )
          .on(
            "postgres_changes",
            { event: "*", schema: "public", table: "song_votes" },
            () => this._emit()
          )
          .subscribe();
      }
      return () => this.listeners.delete(fn);
    }
    _emit() {
      this.listeners.forEach((fn) => {
        try {
          fn();
        } catch {}
      });
    }

    async seedTables() {
      /* seeded by SQL migration */
    }
    async getTables() {
      const { data } = await this._t("restaurant_tables")
        .select("*")
        .eq("restaurant_id", this.rid)
        .eq("active", true);
      return data || [];
    }
    async findTableByToken(token) {
      // SECURITY DEFINER RPC: resolves one table by exact token without
      // exposing a SELECT that could enumerate every table/token.
      const { data } = await this.sb.rpc("bb_find_table", {
        p_restaurant: this.rid,
        p_token: String(token || "").trim(),
      });
      return (Array.isArray(data) ? data[0] : data) || null;
    }

    // Server-side upsert. No anon SELECT on the guest PII table.
    async upsertGuest(fields) {
      const { data } = await this.sb.rpc("bb_upsert_guest", {
        p_restaurant: this.rid,
        p_fields: fields,
      });
      const row = Array.isArray(data) ? data[0] : data;
      return {
        guest: row.guest,
        returning: row.returning,
        previousVisitAt: row.previous_visit_at || null,
      };
    }
    async getGuestByMobile() {
      return null; // not exposed to anon; upsert handled server-side
    }
    async insertGuest(g) {
      const { data } = await this._t("guests").insert(g).select().single();
      return data;
    }
    async updateGuest(id, patch) {
      const { data } = await this._t("guests")
        .update(patch)
        .eq("id", id)
        .select()
        .single();
      return data;
    }
    async getGuests() {
      const { data } = await this._t("guests")
        .select("*")
        .eq("restaurant_id", this.rid)
        .is("deleted_at", null);
      return data || [];
    }

    async insertSession(s) {
      const { data } = await this._t("guest_sessions").insert(s).select().single();
      return data;
    }

    async insertRequest(r) {
      const { data } = await this._t("song_requests").insert(r).select().single();
      return data;
    }
    async updateRequest(id, patch) {
      const { data } = await this._t("song_requests")
        .update(patch)
        .eq("id", id)
        .select()
        .single();
      return data;
    }
    async getRequests() {
      // View computes votes via join => never drifts.
      const { data } = await this._t("song_requests_view")
        .select("*")
        .eq("restaurant_id", this.rid)
        .is("deleted_at", null);
      return data || [];
    }
    async getQueue() {
      return (await this.getRequests())
        .filter((r) => r.status === "queued")
        .sort(scoreSort);
    }
    async getPlaying() {
      return (await this.getRequests()).find((r) => r.status === "playing") || null;
    }

    async insertVote(v) {
      const { error } = await this._t("song_votes").insert(v);
      return !error; // unique(request_id, session_id) rejects duplicates
    }
    async countVotes(requestId) {
      const { count } = await this._t("song_votes")
        .select("*", { count: "exact", head: true })
        .eq("request_id", requestId);
      return count || 0;
    }

    async insertEvent(e) {
      await this._t("request_history").insert(e);
      return e;
    }
    async getEvents() {
      const { data } = await this._t("request_history")
        .select("*")
        .eq("restaurant_id", this.rid)
        .order("history_at", { ascending: false })
        .limit(50);
      return (data || []).reverse();
    }

    async insertLedger(e) {
      await this._t("loyalty_events").insert(e);
      return e;
    }
    async getLedger(guestId) {
      let q = this._t("loyalty_events").select("*").eq("restaurant_id", this.rid);
      if (guestId) q = q.eq("guest_id", guestId);
      const { data } = await q;
      return data || [];
    }
    async getBalances(guestId) {
      const rows = await this.getLedger(guestId);
      const sum = (cur) =>
        rows.filter((r) => r.currency === cur).reduce((a, r) => a + r.points, 0);
      return { beats: sum("beats"), loyalty: sum("loyalty") };
    }
    async beatsEarnedInSession(sessionId) {
      const { data } = await this._t("loyalty_events")
        .select("points")
        .eq("session_id", sessionId)
        .eq("currency", "beats")
        .gt("points", 0);
      return (data || []).reduce((a, r) => a + r.points, 0);
    }
    async getLive() {
      const { data } = await this._t("restaurants")
        .select("is_live")
        .eq("id", this.rid)
        .maybeSingle();
      return Boolean(data && data.is_live);
    }
    async setLive(on) {
      await this._t("restaurants").update({ is_live: Boolean(on) }).eq("id", this.rid);
    }
    async insertRedemption(r) {
      await this._t("redemptions").insert(r);
      return r;
    }
    async getRedemptionByCode(code) {
      const { data } = await this._t("redemptions")
        .select("*")
        .eq("restaurant_id", this.rid)
        .eq("code", code)
        .maybeSingle();
      return data || null;
    }
    async updateRedemption(id, patch) {
      const { data } = await this._t("redemptions").update(patch).eq("id", id).select().single();
      return data;
    }
    async getRedemptions() {
      const { data } = await this._t("redemptions").select("*").eq("restaurant_id", this.rid);
      return data || [];
    }
    async insertDedication(d) {
      await this._t("dedications").insert(d);
      return d;
    }
    async getDedications() {
      const { data } = await this._t("dedications").select("*").eq("restaurant_id", this.rid);
      return data || [];
    }
    async updateDedication(id, patch) {
      const { data } = await this._t("dedications").update(patch).eq("id", id).select().single();
      return data;
    }
    async insertNotification(n) {
      await this._t("guest_notifications").insert(n);
      return n;
    }
    async getNotifications(guestId) {
      if (!guestId) return [];
      const { data } = await this._t("guest_notifications")
        .select("*")
        .eq("guest_id", guestId)
        .order("created_at", { ascending: false })
        .limit(20);
      return data || [];
    }
    async insertFeedback(f) {
      await this._t("guest_feedback").insert(f);
      return f;
    }
    async getFeedback() {
      const { data } = await this._t("guest_feedback")
        .select("*")
        .eq("restaurant_id", this.rid);
      return data || [];
    }
    // Cooldown enforced server-side in production; kept local for responsiveness.
    async getCooldown() {
      return 0;
    }
    async setCooldown() {}
  }

  return { LocalStore, SupabaseStore, uid, nowISO, scoreSort };
});
