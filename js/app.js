/* BeatBites UI layer. Wires the tested core (BBCore) to the DOM. Browser only. */
"use strict";
(function () {
  const RAW = window.BEATBITES_CONFIG || {};
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const ts = () => Date.now();
  const fmt = (ms) => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  const debounce = (fn, w = 350) => {
    let t;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), w);
    };
  };

  // --- Multi-tenant: one deployment serves many venues. ---
  // Active tenant chosen by ?r=<id>, else DEFAULT_RESTAURANT.
  const registry = RAW.RESTAURANTS || {};
  const rid =
    new URLSearchParams(location.search).get("r") ||
    RAW.DEFAULT_RESTAURANT ||
    Object.keys(registry)[0] ||
    "demo-restaurant";
  const venue = registry[rid] || {};
  // Effective config = base settings + the active venue's branding, flattened
  // into the fields the rest of the app expects.
  const CFG = Object.freeze({
    ...RAW,
    RESTAURANT_ID: rid,
    RESTAURANT_NAME: venue.name || "BeatBites",
    BRAND_EMOJI: venue.emoji || "🎵",
    BRAND_COLOR: venue.color || "#8b5cf6",
    BRAND_TAGLINE: venue.tagline || "Request songs, vote, earn rewards.",
    TABLE_COUNT: venue.tableCount || 15,
    PRIVACY_CONTACT: venue.privacyContact || RAW.PRIVACY_CONTACT || "",
  });

  // --- Choose backend: real Supabase if configured, else offline demo. ---
  const dbOn = Boolean(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY && window.supabase);
  const sb = dbOn
    ? window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY)
    : null;
  const store = dbOn
    ? new BBStore.SupabaseStore(CFG, sb)
    : new BBStore.LocalStore(CFG);
  const core = BBCore.createCore(store, CFG);
  const searchCache = new Map();

  // Seed demo tables with RANDOM tokens (not guessable). Demo tokens 1..N still
  // work as aliases so printed QR sheets and the docs stay valid.
  async function seedDemoTables() {
    if (dbOn) return;
    const rnd = () =>
      "tok_" +
      (crypto.randomUUID
        ? crypto.randomUUID().replace(/-/g, "")
        : Math.random().toString(36).slice(2)).slice(0, 24);
    const tables = Array.from({ length: CFG.TABLE_COUNT }, (_, i) => ({
      id: BBStore.uid(),
      restaurant_id: CFG.RESTAURANT_ID,
      table_number: i + 1,
      access_token: `demo-table-${i + 1}`, // demo alias
      secure_token: rnd(), // production-style token
      active: true,
    }));
    await store.seedTables(tables);
  }

  const app = {
    state: { table: null, guest: null, session: null, queue: [], cdTimer: null, guestMode: false },
    auth: { dj: false, admin: false, attempts: {}, lockedUntil: 0 },

    async init() {
      document.body.dataset.backend = dbOn ? "supabase" : "local";
      document.title = `${CFG.RESTAURANT_NAME} | BeatBites`;
      this.applyBranding();
      this.applyTheme(localStorage.getItem("bb_theme") || "dark");
      this.syncExplicitToggle();
      await seedDemoTables();
      this.bind();
      store.onChange(() => this.renderAll());
      const liveToggle = $("#liveToggle");
      if (liveToggle) liveToggle.checked = await core.isLive();
      this.setupAutoDJ();
      await this.fromUrl();
      await this.buildQRs();
      await this.renderAll();
      if (!dbOn) this.toast("Offline demo mode (single device)", "info");
    },

    applyBranding() {
      $("#brandName").textContent = CFG.RESTAURANT_NAME || "BeatBites";
      $("#brandEmoji").textContent = CFG.BRAND_EMOJI || "🎵";
      $("#heroTagline").textContent = CFG.BRAND_TAGLINE || "";
      if (CFG.BRAND_COLOR)
        document.documentElement.style.setProperty("--primary", CFG.BRAND_COLOR);
      const pc = $("#privacyContact");
      if (pc && CFG.PRIVACY_CONTACT) pc.textContent = CFG.PRIVACY_CONTACT;
    },
    applyTheme(mode) {
      document.documentElement.dataset.theme = mode;
      localStorage.setItem("bb_theme", mode);
      const btn = $("#themeToggle");
      if (btn) btn.textContent = mode === "dark" ? "☀️ Light" : "🌙 Dark";
    },

    bind() {
      $$("[data-view]").forEach((b) =>
        b.addEventListener("click", () => this.nav(b.dataset.view))
      );
      $("#adminLink").addEventListener("click", () => this.nav("admin-login"));
      $("#themeToggle").addEventListener("click", () =>
        this.applyTheme(
          document.documentElement.dataset.theme === "dark" ? "light" : "dark"
        )
      );
      $("#tokenForm").addEventListener("submit", (e) => {
        e.preventDefault();
        this.validateToken($("#tableTokenInput").value);
      });
      $("#guestForm").addEventListener("submit", (e) => {
        e.preventDefault();
        this.registerGuest();
      });
      $("#skipRegister").addEventListener("click", () => this.browseAsGuest());
      $("#songSearch").addEventListener(
        "input",
        debounce((e) => this.searchSong(e.target.value))
      );
      $("#refreshCustomerQueue").addEventListener("click", () => this.renderAll());
      $("#djLoginForm").addEventListener("submit", (e) => {
        e.preventDefault();
        this.djLogin();
      });
      $("#adminLoginForm").addEventListener("submit", (e) => {
        e.preventDefault();
        this.adminLogin();
      });
      $("#playNext").addEventListener("click", () => this.playNext());
      $("#markPlayed").addEventListener("click", () => this.markPlayed());
      $("#clearQueue").addEventListener("click", () => this.clearQueue());
      $("#djFilter").addEventListener("input", () => this.renderDJ());
      $("#guestSearch").addEventListener("input", () => this.renderCRM());
      $$(".tab").forEach((t) =>
        t.addEventListener("click", () => this.openTab(t.dataset.tab))
      );
      $$("#feedbackStars button").forEach((b) =>
        b.addEventListener("click", () => this.sendFeedback(Number(b.dataset.star)))
      );
      // privacy notice
      $("#privacyLink")?.addEventListener("click", (e) => {
        e.preventDefault();
        $("#privacyModal").classList.add("show");
      });
      $("#privacyClose")?.addEventListener("click", () =>
        $("#privacyModal").classList.remove("show")
      );
      // admin: explicit-content filter toggle
      $("#explicitToggle")?.addEventListener("change", (e) => {
        localStorage.setItem("bb_explicit_filter", e.target.checked ? "1" : "0");
        searchCache.clear();
        this.toast(
          e.target.checked ? "Explicit songs will be filtered" : "Explicit filter off"
        );
      });
      // go-live toggle (staff)
      $("#liveToggle")?.addEventListener("change", async (e) => {
        await core.setLive(e.target.checked);
        this.toast(e.target.checked ? "Venue is LIVE — requests open" : "Venue closed for requests");
        this.renderAll();
      });
      // auto-DJ mode toggle
      $("#autodjToggle")?.addEventListener("change", (e) => {
        localStorage.setItem("bb_autodj", e.target.checked ? "auto" : "assist");
        this.setupAutoDJ();
        this.toast(e.target.checked ? "Auto-DJ on (hook mode)" : "DJ-assist mode");
      });
      // staff: verify a loyalty redemption code
      $("#verifyRedeemForm")?.addEventListener("submit", async (e) => {
        e.preventDefault();
        const r = await core.verifyRedemption($("#verifyRedeemInput").value);
        const map = { not_found: "No such code", used: "Code already used", expired: "Code expired" };
        this.toast(r.ok ? `Verified: ${r.redemption.label}` : map[r.reason] || "Invalid", r.ok ? "success" : "error");
        if (r.ok) $("#verifyRedeemInput").value = "";
        this.renderAll();
      });
      $("#downloadAllQR")?.addEventListener("click", () => this.downloadAllQRs());
      // staff logout
      $$("[data-logout]").forEach((b) =>
        b.addEventListener("click", () => this.logout())
      );
      document.addEventListener("click", (e) => {
        if (!e.target.closest(".search-card")) $("#suggestions").style.display = "none";
      });
    },

    async logout() {
      this.auth.dj = false;
      this.auth.admin = false;
      if (dbOn) await sb.auth.signOut().catch(() => {});
      this.nav("landing");
      this.toast("Signed out");
    },

    openTab(tab) {
      $$(".tab").forEach((x) => {
        const on = x.dataset.tab === tab;
        x.classList.toggle("active", on);
        x.setAttribute("aria-selected", on ? "true" : "false");
      });
      $$(".tab-panel").forEach((x) =>
        x.classList.toggle("active", x.id === `tab-${tab}`)
      );
      this.renderAll();
    },
    // Views only staff may ever see, and the auth flag each requires.
    STAFF_VIEWS: { dj: "dj", admin: "admin" },
    LOGIN_VIEWS: ["dj-login", "admin-login", "landing"],

    enterGuestMode() {
      this.state.guestMode = true;
      document.body.dataset.mode = "guest"; // CSS hides staff entry points
    },

    nav(v) {
      // Hard boundary: a guest (someone who entered via a table QR) can never
      // navigate to a staff surface, by button, URL, or console.
      if (this.state.guestMode && (this.STAFF_VIEWS[v] || this.LOGIN_VIEWS.includes(v))) {
        this.toast("This area is for staff only", "error");
        v = this.state.session || this.state.guest ? "customer" : "guest-registration";
      }
      // Staff surfaces require the matching authenticated session.
      const need = this.STAFF_VIEWS[v];
      if (need && !this.auth[need]) {
        return this.nav(need === "dj" ? "dj-login" : "admin-login");
      }
      $$(".view").forEach((x) => x.classList.remove("active"));
      const el = $(`#view-${v}`);
      if (el) el.classList.add("active");
      window.scrollTo({ top: 0 });
      if (v === "customer") this.cooldown();
      this.renderAll();
    },

    async fromUrl() {
      const token = new URLSearchParams(location.search).get("t");
      if (token) await this.validateToken(token);
    },
    async validateToken(token) {
      const table = await core.findTable(token);
      if (!table) return this.toast("Invalid or inactive table QR token", "error");
      this.state.table = table;
      this.enterGuestMode(); // scanning a table QR locks you into the guest flow
      $("#activeTablePill").textContent = `Table ${table.table_number}`;
      this.nav("guest-registration");
    },

    // Request-first: let the guest into the jukebox with a lightweight anonymous
    // session; they are prompted to register the moment they try to request/vote.
    async browseAsGuest() {
      if (!this.state.table) return this.toast("Table token required", "error");
      // Anonymous browse + vote: a session with no guest, so votes count for
      // ordering but earn nothing. Verifying (registering) unlocks earn/request.
      this.state.guest = { id: "guest_anon", name: "Guest" };
      this.state.session = {
        id: "anon_" + BBStore.uid(),
        guest_id: null,
        table_number: this.state.table.table_number,
      };
      this.state.anon = true;
      $("#guestWelcome").textContent = "Browsing";
      this.nav("customer");
      this.toast("Browse & vote freely — verify to request & earn", "info");
    },

    async registerGuest() {
      if (!this.state.table) return this.toast("Table token required", "error");
      const mobile = $("#guestMobile").value.trim();
      if (!/^\+?[0-9\s-]{8,15}$/.test(mobile))
        return this.toast("Enter a valid mobile number", "error");
      if (!$("#consentService").checked)
        return this.toast("Please accept the required consent to continue", "error");
      const { guest, returning, visitAward, returnBonus } = await core.registerGuest({
        restaurant_id: CFG.RESTAURANT_ID,
        name: $("#guestName").value.trim() || "Guest",
        mobile,
        email: $("#guestEmail").value.trim() || null,
        dob: $("#guestDob").value || null,
        favorite_genre: $("#guestGenre").value || null,
        consent_service: true,
        consent_marketing: $("#consentMarketing").checked,
        consent_at: new Date().toISOString(),
      });
      this.state.guest = guest;
      this.state.anon = false;
      this.state.session = await core.createSession(guest, this.state.table);
      $("#guestWelcome").textContent = `Welcome, ${guest.name}`;
      const pts = visitAward + (returnBonus || 0);
      this.toast(`${returning ? "Welcome back" : "Verified"} +${pts} loyalty`);
      this.nav("customer");
    },

    async ensureRegistered() {
      // Voting is allowed anonymously; requesting/redeeming requires verification.
      if (this.state.session && !this.state.anon) return true;
      this.toast("Quick verify to request & earn points", "info");
      this.nav("guest-registration");
      return false;
    },

    explicitFilterOn() {
      const override = localStorage.getItem("bb_explicit_filter");
      return override == null ? CFG.FILTER_EXPLICIT !== false : override === "1";
    },
    syncExplicitToggle() {
      const t = $("#explicitToggle");
      if (t) t.checked = this.explicitFilterOn();
    },
    autodjMode() {
      return localStorage.getItem("bb_autodj") || (CFG.AUTODJ && CFG.AUTODJ.MODE) || "assist";
    },
    // Auto-DJ: in 'auto' mode the app advances the queue itself on a hook-length
    // timer and falls back to the house playlist when the queue is empty — so the
    // room is never silent and no human DJ is required. 'assist' leaves control
    // to a human (default). A manager can always veto via skip/Play Next.
    setupAutoDJ() {
      if (this._autodjTimer) clearInterval(this._autodjTimer);
      const t = $("#autodjToggle");
      if (t) t.checked = this.autodjMode() === "auto";
      const badge = $("#autodjBadge");
      if (badge) badge.textContent = this.autodjMode() === "auto" ? "Auto-DJ" : "DJ-assist";
      if (this.autodjMode() !== "auto") return;
      const seconds = (CFG.AUTODJ && CFG.AUTODJ.SEGMENT_SECONDS) || 35;
      const advance = async () => {
        if (!this.auth.dj && !this.auth.admin) return; // only while staff console open
        if (!(await core.isLive())) return;
        await core.playNext();
        this.renderAll();
      };
      advance();
      this._autodjTimer = setInterval(advance, seconds * 1000);
    },

    async searchSong(q) {
      q = q.trim();
      const box = $("#suggestions");
      if (q.length < 2) {
        box.style.display = "none";
        return;
      }
      const filter = this.explicitFilterOn();
      const key = (filter ? "clean:" : "all:") + q;
      if (searchCache.has(key)) return this.renderSuggestions(searchCache.get(key));
      box.textContent = "";
      box.append(this.msg("Searching..."));
      box.style.display = "block";
      try {
        const res = await fetch(
          `https://itunes.apple.com/search?term=${encodeURIComponent(
            q
          )}&media=music&entity=song&limit=${CFG.SEARCH_LIMIT}${filter ? "&explicit=No" : ""}`
        );
        const json = await res.json();
        let songs = (json.results || []).filter((s) => s.trackName && s.artistName);
        // Belt-and-suspenders: iTunes still returns some flagged tracks.
        if (filter) songs = songs.filter((s) => s.trackExplicitness !== "explicit");
        searchCache.set(key, songs);
        this.renderSuggestions(songs);
      } catch {
        box.textContent = "";
        box.append(this.msg("Search failed. Check internet."));
      }
    },
    renderSuggestions(songs) {
      const box = $("#suggestions");
      box.textContent = "";
      box.style.display = "block";
      if (!songs.length) return box.append(this.msg("No songs found"));
      songs.forEach((s) => box.append(this.songButton(s)));
    },

    async addSong(raw) {
      if (!(await this.ensureRegistered())) return;
      const res = await core.requestSong(
        {
          title: raw.trackName,
          artist: raw.artistName,
          genre: raw.primaryGenreName,
          artwork_url: raw.artworkUrl100 || "",
          preview_url: raw.previewUrl || "",
        },
        this.state.guest,
        this.state.session
      );
      if (!res.ok) {
        const map = {
          cooldown: "Cooldown active — please wait",
          full: "Queue is full right now",
          your_limit: `You can have ${CFG.PER_GUEST_QUEUE_CAP} songs waiting at once`,
          duplicate: "That song is already queued",
          closed: "The venue isn't taking requests yet tonight",
          session: "Please verify first",
        };
        this.cooldown();
        return this.toast(map[res.reason] || "Could not add song", "error");
      }
      $("#songSearch").value = "";
      $("#suggestions").style.display = "none";
      const box = $("#myRequestBox");
      box.classList.remove("hidden");
      box.textContent = `Added: ${res.request.title}. +${res.beats || 0} Beats.`;
      this.toast("Song requested");
      this.cooldown();
      this.renderAll();
    },

    cooldown() {
      if (this.state.cdTimer) clearInterval(this.state.cdTimer);
      const box = $("#cooldownBox"),
        time = $("#cooldownTime"),
        input = $("#songSearch");
      const tick = async () => {
        const sid = this.state.session?.id;
        const last = sid ? await store.getCooldown(sid) : 0;
        const left = CFG.REQUEST_COOLDOWN_MS - (ts() - last);
        if (left > 0) {
          box.classList.remove("hidden");
          input.disabled = true;
          time.textContent = fmt(left);
        } else {
          box.classList.add("hidden");
          input.disabled = false;
          clearInterval(this.state.cdTimer);
          this.state.cdTimer = null;
        }
      };
      tick();
      this.state.cdTimer = setInterval(tick, 1000);
    },

    async vote(id) {
      // Voting is free and allowed anonymously (staged verification).
      if (!this.state.session) return this.toast("Open the jukebox first", "error");
      const r = await core.vote(id, this.state.session);
      if (!r.ok)
        return this.toast(
          r.reason === "already" ? "You already voted for this" : "Vote failed",
          "error"
        );
      this.toast(this.state.anon ? "Vote added" : `Vote added +${r.beats || 0} Beats`);
      this.renderAll();
    },

    // Staff auth. When a real backend is configured, this uses Supabase Auth
    // and checks the staff role table (the true security boundary). Offline, it
    // falls back to a demo PIN with attempt lockout — clearly demo-only.
    async staffLogin(kind) {
      const now = Date.now();
      if (now < this.auth.lockedUntil) {
        return this.toast(
          `Too many attempts. Try again in ${Math.ceil((this.auth.lockedUntil - now) / 1000)}s`,
          "error"
        );
      }
      if (dbOn) return this.staffLoginSupabase(kind);

      const pin = $(kind === "dj" ? "#djPin" : "#adminPin").value.trim();
      const expected = kind === "dj" ? CFG.DEMO_MODE_PINS?.DJ : CFG.DEMO_MODE_PINS?.ADMIN;
      if (pin && pin === expected) {
        this.auth.attempts[kind] = 0;
        this.grantStaff(kind);
        return;
      }
      this.auth.attempts[kind] = (this.auth.attempts[kind] || 0) + 1;
      if (this.auth.attempts[kind] >= 5) {
        this.auth.lockedUntil = now + 30000;
        this.auth.attempts[kind] = 0;
        return this.toast("Locked for 30s after too many attempts", "error");
      }
      this.toast(
        `Wrong ${kind.toUpperCase()} PIN (${5 - this.auth.attempts[kind]} left)`,
        "error"
      );
    },

    async staffLoginSupabase(kind) {
      const email = $(kind === "dj" ? "#djEmail" : "#adminEmail").value.trim();
      const password = $(kind === "dj" ? "#djPin" : "#adminPin").value;
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error || !data?.user) return this.toast("Invalid credentials", "error");
      // Confirm the signed-in user is staff of this tenant with a sufficient role.
      const { data: rows } = await sb
        .from("staff")
        .select("role")
        .eq("restaurant_id", CFG.RESTAURANT_ID);
      const roles = (rows || []).map((r) => r.role);
      const allowed =
        kind === "dj"
          ? roles.some((r) => ["owner", "dj"].includes(r))
          : roles.some((r) => ["owner", "staff"].includes(r));
      if (!allowed) {
        await sb.auth.signOut();
        return this.toast("Your account lacks the required role", "error");
      }
      this.grantStaff(kind);
    },

    grantStaff(kind) {
      this.auth[kind] = true;
      this.nav(kind);
      this.setupAutoDJ();
      this.toast(`${kind === "dj" ? "DJ" : "Admin"} access granted`);
    },
    djLogin() {
      this.staffLogin("dj");
    },
    adminLogin() {
      this.staffLogin("admin");
    },
    async playNext() {
      if (!this.auth.dj) return this.toast("DJ login required", "error");
      const n = await core.playNext();
      if (!n) return this.toast("Queue empty", "error");
      this.toast(`Playing: ${n.title}`);
      this.renderAll();
    },
    async markPlayed() {
      if (!this.auth.dj) return this.toast("DJ login required", "error");
      await core.markPlayed();
      this.toast("Marked as played");
      this.renderAll();
    },
    async clearQueue() {
      if (!this.auth.admin)
        return this.toast("Admin login required", "error");
      if (confirm("Clear all queued songs?")) {
        await core.clearQueue();
        this.toast("Queue cleared");
        this.renderAll();
      }
    },
    async remove(id) {
      if (!this.auth.admin && !this.auth.dj)
        return this.toast("Login required", "error");
      await core.remove(id);
      this.toast("Removed");
      this.renderAll();
    },
    async skip(id) {
      if (!this.auth.dj) return this.toast("DJ login required", "error");
      await core.skip(id);
      this.toast("Skipped");
      this.renderAll();
    },

    async sendFeedback(stars) {
      await core.submitFeedback(this.state.guest, stars);
      $$("#feedbackStars button").forEach((b) =>
        b.classList.toggle("on", Number(b.dataset.star) <= stars)
      );
      this.toast(`Thanks for the ${stars}★ rating`);
    },

    // ---------- rendering ----------
    async renderAll() {
      try {
        this.state.queue = await core.getQueue();
      } catch {
        this.state.queue = [];
      }
      await Promise.all([
        this.renderCustomer(),
        this.renderDJ(),
        this.renderNotifications(),
        this.renderCRM(),
        this.renderAnalytics(),
        this.renderStats(),
        this.renderModeration(),
      ]);
    },

    async renderModeration() {
      // Pending dedications await staff approval before they display publicly.
      const pendRoot = $("#dedicationModeration");
      if (pendRoot) {
        const pending = await core.getDedications("pending");
        pendRoot.textContent = "";
        pending.forEach((d) => {
          const li = document.createElement("li");
          const msg = document.createElement("span");
          msg.textContent = d.message || "(no message)";
          const ok = document.createElement("button");
          ok.className = "btn btn-success small";
          ok.textContent = "Approve";
          ok.addEventListener("click", async () => {
            await core.moderateDedication(d.id, true);
            this.renderAll();
          });
          const no = document.createElement("button");
          no.className = "btn btn-danger small";
          no.textContent = "Reject";
          no.addEventListener("click", async () => {
            await core.moderateDedication(d.id, false);
            this.renderAll();
          });
          li.append(msg, ok, no);
          pendRoot.append(li);
        });
        const empty = $("#dedicationModerationEmpty");
        if (empty) empty.style.display = pending.length ? "none" : "block";
      }
      // Approved dedications show to the room (guest view ticker).
      const ticker = $("#dedicationTicker");
      if (ticker) {
        const approved = await core.getDedications("approved");
        ticker.textContent = approved.length
          ? "💬 " + approved.slice(-3).map((d) => d.message).join("   •   ")
          : "";
        ticker.style.display = approved.length ? "block" : "none";
      }
    },

    async renderCustomer() {
      this.renderQueue($("#customerQueue"), $("#customerEmpty"), this.state.queue, true, false);
      const anon = this.state.anon || !this.state.guest || this.state.guest.id === "guest_anon";
      const bal = anon ? { beats: 0, loyalty: 0 } : await core.balances(this.state.guest.id);

      $("#beatsPill").textContent = `${bal.beats} Beats`;
      $("#loyaltyPill").textContent = `${bal.loyalty} points`;
      const rp = core.rewardProgress(bal.loyalty);
      $("#rewardFill").style.width = rp.pct + "%";
      $("#rewardLabel").textContent = anon
        ? "Verify to start earning loyalty points"
        : rp.next
        ? `${rp.next.points - bal.loyalty} pts to ${rp.next.label}`
        : "Top tier unlocked 🎉";

      // Beats rewards (free sinks) — spendable now
      const beatsBox = $("#beatsRewards");
      if (beatsBox) {
        beatsBox.textContent = "";
        (CFG.BEATS_REWARDS || []).forEach((r) => {
          const b = document.createElement("button");
          b.className = "btn btn-outline small";
          b.textContent = `${r.label} · ${r.cost}`;
          b.disabled = anon || bal.beats < r.cost;
          b.addEventListener("click", () => this.spendBeats(r.id));
          beatsBox.append(b);
        });
      }
      // Loyalty rewards (staff-verified)
      const loyBox = $("#loyaltyRewards");
      if (loyBox) {
        loyBox.textContent = "";
        core.tiers.forEach((t, i) => {
          const b = document.createElement("button");
          b.className = "btn btn-outline small";
          b.textContent = `${t.label} · ${t.points}`;
          b.disabled = anon || bal.loyalty < t.points;
          b.addEventListener("click", () => this.redeemLoyalty(i));
          loyBox.append(b);
        });
      }
      // live banner
      const live = await core.isLive();
      const lb = $("#liveBanner");
      if (lb) lb.style.display = live ? "none" : "block";
    },

    async spendBeats(rewardId) {
      if (!(await this.ensureRegistered())) return;
      let extra = null;
      if (rewardId === "dedicate") {
        const message = prompt("Your dedication / shout-out (staff will approve):");
        if (!message) return;
        extra = { message };
      }
      const r = await core.redeemBeats(this.state.guest, rewardId, this.state.session, extra);
      if (!r.ok)
        return this.toast(r.reason === "insufficient" ? "Not enough Beats" : "Could not redeem", "error");
      const msg = {
        cooldown_reduce: "Cooldown cleared — request away!",
        queue_jump: "Your song jumped up the queue",
        dedicate: "Dedication sent for approval",
      };
      this.toast(msg[r.action] || "Redeemed");
      if (r.action === "cooldown_reduce") this.cooldown();
      this.renderAll();
    },

    async redeemLoyalty(tierIndex) {
      if (!(await this.ensureRegistered())) return;
      const r = await core.redeemLoyalty(this.state.guest, tierIndex);
      if (!r.ok)
        return this.toast(r.reason === "insufficient" ? "Not enough points yet" : "Could not redeem", "error");
      alert(
        `Reward: ${r.label}\nShow this code to staff: ${r.code}\n(Valid 15 minutes)`
      );
      this.toast("Reward code created — show staff");
      this.renderAll();
    },

    async renderDJ() {
      const f = ($("#djFilter")?.value || "").toLowerCase();
      const q = this.state.queue.filter((x) =>
        `${x.title} ${x.artist} ${x.table_number}`.toLowerCase().includes(f)
      );
      this.renderQueue($("#djQueue"), $("#djEmpty"), q, false, true);
      const p = await core.getPlaying();
      $("#nowTitle").textContent = p ? p.title : "Nothing playing";
      $("#nowArtist").textContent = p ? `${p.artist} • Table ${p.table_number}` : "Queue ready";
      const cover = $("#nowCover"),
        audio = $("#previewPlayer");
      if (p?.artwork_url) {
        cover.src = p.artwork_url;
        cover.classList.remove("hidden");
      } else cover.classList.add("hidden");
      if (p?.preview_url) {
        audio.src = p.preview_url;
        audio.classList.remove("hidden");
      } else audio.classList.add("hidden");
      const events = (await core.getEvents()).slice(-12).reverse();
      const root = $("#historyList");
      root.textContent = "";
      events.forEach((x) => {
        const li = document.createElement("li");
        li.textContent = `${x.history_status}: ${x.title} — ${x.artist} • Table ${x.table_number}`;
        root.append(li);
      });
      $("#historyEmpty").style.display = events.length ? "none" : "block";
    },

    renderQueue(root, empty, items, customer, dj) {
      if (!root) return;
      root.textContent = "";
      items.forEach((s, i) => root.append(this.item(s, i + 1, customer, dj)));
      if (empty) empty.style.display = items.length ? "none" : "block";
    },
    item(s, i, customer, dj) {
      const li = document.createElement("li");
      li.className = "queue-item";
      const main = document.createElement("div");
      main.className = "queue-main";
      const img = document.createElement("img");
      img.className = "cover";
      img.alt = "";
      img.loading = "lazy";
      img.src = s.artwork_url || "";
      const info = document.createElement("div");
      const title = document.createElement("div");
      title.className = "title";
      title.textContent = `${i}. ${s.title}`;
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = `${s.artist} • ${s.genre || "Unknown"} • Table ${s.table_number} • Votes ${s.votes || 0}`;
      info.append(title, meta);
      main.append(img, info);
      const actions = document.createElement("div");
      actions.className = "queue-actions";
      const pos = document.createElement("span");
      pos.className = "badge";
      pos.textContent = `#${i}`;
      actions.append(pos);
      if (customer) {
        const v = document.createElement("button");
        v.className = "btn btn-outline small";
        v.textContent = "Vote";
        v.setAttribute("aria-label", `Vote for ${s.title}`);
        v.addEventListener("click", () => this.vote(s.id));
        actions.append(v);
      }
      if (dj) {
        if (s.preview_url) {
          const p = document.createElement("button");
          p.className = "btn btn-outline small";
          p.textContent = "Preview";
          p.addEventListener("click", () => {
            const a = $("#previewPlayer");
            a.src = s.preview_url;
            a.classList.remove("hidden");
            a.play().catch(() => {});
          });
          actions.append(p);
        }
        const skip = document.createElement("button");
        skip.className = "btn btn-outline small";
        skip.textContent = "Skip";
        skip.addEventListener("click", () => this.skip(s.id));
        const rem = document.createElement("button");
        rem.className = "btn btn-danger small";
        rem.textContent = "Remove";
        rem.addEventListener("click", () => this.remove(s.id));
        actions.append(skip, rem);
      }
      li.append(main, actions);
      return li;
    },

    async renderNotifications() {
      const root = $("#notificationList"),
        empty = $("#notificationEmpty");
      if (!root) return;
      const notes = (await core.getNotifications(this.state.guest?.id)).slice(0, 8);
      root.textContent = "";
      notes.forEach((n) => {
        const li = document.createElement("li");
        li.textContent = n.message;
        root.append(li);
      });
      empty.style.display = notes.length ? "none" : "block";
    },

    async renderCRM() {
      const root = $("#guestList"),
        empty = $("#guestEmpty");
      if (!root) return;
      const q = ($("#guestSearch")?.value || "").toLowerCase();
      const guests = (await core.getGuests())
        .filter((g) =>
          `${g.name} ${g.mobile} ${g.email || ""} ${g.favorite_genre || ""}`
            .toLowerCase()
            .includes(q)
        )
        .sort((a, b) => (b.loyalty_points || 0) - (a.loyalty_points || 0));
      root.textContent = "";
      guests.forEach((g) => {
        const li = document.createElement("li");
        const a = document.createElement("div");
        a.className = "crm-line";
        const strong = document.createElement("strong");
        strong.textContent = g.name;
        const span = document.createElement("span");
        span.textContent = `${g.loyalty_points || 0} pts`;
        a.append(strong, span);
        const b = document.createElement("div");
        b.className = "meta";
        b.textContent = `${g.mobile} • Visits ${g.visit_count || 1} • ${g.favorite_genre || "Genre N/A"} • ${g.email || "No email"}`;
        li.append(a, b);
        root.append(li);
      });
      empty.style.display = guests.length ? "none" : "block";
    },

    async renderAnalytics() {
      const a = await core.analytics();
      this.setText("adminGuests", a.totalGuests);
      this.setText("adminReturning", a.returningGuests);
      this.setText("adminRequests", a.totalRequests);
      this.setText("adminVotes", a.totalVotes);
      this.bars("topArtists", a.topArtists);
      this.bars("topGenres", a.topGenres);
      this.bars("tableChart", a.byTable);
      this.bars("hourlyChart", a.byHour);
    },
    bars(id, data) {
      const root = $("#" + id);
      if (!root) return;
      root.textContent = "";
      const entries = Object.entries(data).sort((a, b) => b[1] - a[1]).slice(0, 8);
      const max = Math.max(1, ...entries.map((x) => x[1]));
      if (!entries.length) return root.append(this.msg("No data yet"));
      entries.forEach(([label, val]) => {
        const row = document.createElement("div");
        row.className = "bar-row";
        const l = document.createElement("span");
        l.textContent = label;
        const track = document.createElement("div");
        track.className = "bar-track";
        const fill = document.createElement("div");
        fill.className = "bar-fill";
        fill.style.width = `${Math.max(8, (val / max) * 100)}%`;
        track.append(fill);
        const v = document.createElement("b");
        v.textContent = val;
        row.append(l, track, v);
        root.append(row);
      });
    },
    async renderStats() {
      const guests = await core.getGuests();
      const q = this.state.queue;
      this.setText("statGuests", guests.length);
      this.setText("statQueued", q.length);
      this.setText("statVotes", q.reduce((a, b) => a + (b.votes || 0), 0));
    },
    setText(id, v) {
      const e = $("#" + id);
      if (e) e.textContent = v;
    },

    qrUrl(tok, size = 180) {
      const origin = location.origin + location.pathname;
      const deep = `${origin}?r=${encodeURIComponent(CFG.RESTAURANT_ID)}&t=${encodeURIComponent(tok)}`;
      return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(deep)}`;
    },
    async downloadQR(tableNumber, tok) {
      try {
        const res = await fetch(this.qrUrl(tok, 600));
        const blob = await res.blob();
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${CFG.RESTAURANT_ID}-table-${tableNumber}.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(a.href);
      } catch {
        this.toast("Download failed — check connection", "error");
      }
    },
    async buildQRs() {
      const grid = $("#qrGrid");
      if (!grid) return;
      grid.textContent = "";
      const tables = (await store.getTables()).sort((a, b) => a.table_number - b.table_number);
      this._qrTables = tables;
      tables.forEach((t) => {
        const tok = t.secure_token || t.access_token;
        const card = document.createElement("div");
        card.className = "qr-card";
        const img = document.createElement("img");
        img.alt = `QR for table ${t.table_number}`;
        img.loading = "lazy";
        img.src = this.qrUrl(tok);
        const label = document.createElement("b");
        label.textContent = `Table ${t.table_number}`;
        const small = document.createElement("small");
        small.textContent = t.access_token;
        const dl = document.createElement("button");
        dl.className = "btn btn-outline small";
        dl.textContent = "Download";
        dl.addEventListener("click", () => this.downloadQR(t.table_number, tok));
        card.append(img, label, small, dl);
        grid.append(card);
      });
    },
    async downloadAllQRs() {
      const tables = this._qrTables || (await store.getTables());
      this.toast(`Downloading ${tables.length} QR codes…`);
      for (const t of tables) {
        await this.downloadQR(t.table_number, t.secure_token || t.access_token);
        await new Promise((r) => setTimeout(r, 350)); // be gentle on the QR API
      }
    },

    msg(t) {
      const d = document.createElement("div");
      d.className = "suggestion";
      d.textContent = t;
      return d;
    },
    songButton(s) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "suggestion";
      const img = document.createElement("img");
      img.className = "cover";
      img.alt = "";
      img.loading = "lazy";
      img.src = s.artworkUrl100 || "";
      const div = document.createElement("div");
      const title = document.createElement("div");
      title.className = "title";
      title.textContent = s.trackName;
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = `${s.artistName} • ${s.primaryGenreName || "Unknown genre"}`;
      div.append(title, meta);
      b.append(img, div);
      b.addEventListener("click", () => this.addSong(s));
      return b;
    },

    toast(m, type = "success") {
      const t = $("#toast");
      t.textContent = m;
      t.dataset.type = type;
      t.classList.add("show");
      clearTimeout(this._toastT);
      this._toastT = setTimeout(() => t.classList.remove("show"), 2600);
    },
  };

  window.addEventListener("DOMContentLoaded", () => {
    app.init();
    if ("serviceWorker" in navigator)
      navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
})();
