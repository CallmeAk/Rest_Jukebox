// --- Utilities ---




// Debounce prevents API calls on every single keystroke

function debounce(func, wait) {

    let timeout;

    return function(...args) {

        clearTimeout(timeout);

        timeout = setTimeout(() => func.apply(this, args), wait);

    };

}




// --- Storage ---

const store = {

    getQueue: () => JSON.parse(localStorage.getItem('bb_queue')) || [],

    setQueue: (q) => localStorage.setItem('bb_queue', JSON.stringify(q)),

    

    getDJPin: () => localStorage.getItem('bb_dj_pin') || '1234',

    setDJPin: (p) => localStorage.setItem('bb_dj_pin', p),




    getLastSubmit: (tid) => parseInt(localStorage.getItem(`bb_t_${tid}`)) || 0,

    setLastSubmit: (tid, t) => localStorage.setItem(`bb_t_${tid}`, t),




    getPlaying: () => JSON.parse(localStorage.getItem('bb_playing')) || null,

    setPlaying: (s) => localStorage.setItem('bb_playing', JSON.stringify(s))

};




const app = {

    currentTable: null,




    init: () => {

        // Generate Table Buttons (1-15)

        const grid = document.getElementById('tableGridContainer');

        for(let i = 1; i <= 15; i++) {

            const btn = document.createElement('button');

            btn.className = 'btn-table';

            btn.innerHTML = `<span>${i}</span> Table`;

            btn.onclick = () => app.tableLogin(i);

            grid.appendChild(btn);

        }




        document.getElementById('homeBtn').addEventListener('click', () => app.navigateTo('landing'));

        document.getElementById('songSearch').addEventListener('input', (e) => app.handleSearch(e.target.value));

        document.addEventListener('click', (e) => {

            if (!e.target.closest('.search-container')) document.getElementById('suggestionsList').style.display = 'none';

        });

        

        // Sync tabs (if multiple tabs open)

        window.addEventListener('storage', () => {

            app.refreshViews();

        });

    },




    refreshViews: () => {

        if(document.getElementById('view-dj-dashboard').classList.contains('active')) app.renderDJQueue();

        if(document.getElementById('view-admin-dashboard').classList.contains('active')) app.renderAdminQueue();

        const playing = store.getPlaying();

        if(playing) {

            document.getElementById('currentSongName').innerText = playing.t;

            document.getElementById('currentSongArtist').innerText = playing.a;

        }

    },




    navigateTo: (v) => {

        document.querySelectorAll('.view-section').forEach(el => el.classList.remove('active'));

        document.getElementById(`view-${v}`).classList.add('active');

        

        if (v === 'dj-dashboard') app.renderDJQueue();

        if (v === 'admin-dashboard') app.renderAdminQueue();

        if (v === 'table-app') app.startCooldownCheck();

    },




    // --- Customer ---

    tableLogin: (id) => {

        app.currentTable = id;

        app.navigateTo('table-app');

    },




    // iTunes API Integration

    handleSearch: debounce(async function(query) {

        const list = document.getElementById('suggestionsList');

        if (query.length < 2) {

            list.style.display = 'none';

            return;

        }




        try {

            // Call iTunes API

            const response = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&entity=song&limit=5`);

            const data = await response.json();




            if (data.results.length > 0) {

                list.innerHTML = data.results.map(song => {

                    // Escape single quotes to prevent JS errors

                    const safeTitle = song.trackName.replace(/'/g, "\\'");

                    const safeArtist = song.artistName.replace(/'/g, "\\'");

                    return `

                        <div class="suggestion-item" onclick="app.selectSong('${safeTitle}', '${safeArtist}')">

                            <img src="${song.artworkUrl100}" class="suggestion-img" alt="Cover">

                            <div>

                                <div style="font-weight:bold">${song.trackName}</div>

                                <div style="font-size:0.8rem; color:var(--text-muted)">${song.artistName}</div>

                            </div>

                        </div>

                    `;

                }).join('');

                list.style.display = 'block';

            } else {

                list.innerHTML = '<div style="padding:1rem; text-align:center; color:var(--text-muted)">No results found</div>';

                list.style.display = 'block';

            }

        } catch (error) {

            console.error("Search failed", error);

        }

    }, 300),




    selectSong: (t, a) => {

        const last = store.getLastSubmit(app.currentTable);

        const now = Date.now();

        if (now - last < 5 * 60000) {

            app.showToast('Wait 5 minutes!', 'error');

            app.startCooldownCheck();

            return;

        }

        

        const queue = store.getQueue();

        queue.push({ id: now, t, a, tbl: app.currentTable });

        store.setQueue(queue);

        store.setLastSubmit(app.currentTable, now);

        

        document.getElementById('songSearch').value = '';

        document.getElementById('suggestionsList').style.display = 'none';

        app.showToast('Requested!');

        app.startCooldownCheck();

    },




    startCooldownCheck: () => {

        const disp = document.getElementById('cooldownMsg');

        const input = document.getElementById('songSearch');

        const last = store.getLastSubmit(app.currentTable);

        const now = Date.now();

        const diff = now - last;

        const limit = 5 * 60000;




        if (diff < limit) {

            disp.style.display = 'block';

            input.disabled = true;

            input.placeholder = "Cooldown active...";

            const int = setInterval(() => {

                const cDiff = Date.now() - last;

                if (cDiff >= limit) {

                    clearInterval(int);

                    disp.style.display = 'none';

                    input.disabled = false;

                    input.placeholder = "Type song name...";

                } else {

                    const s = Math.ceil((limit - cDiff)/1000);

                    document.getElementById('timeLeft').innerText = `${Math.floor(s/60)}:${s%60<10?'0':''}${s%60}`;

                }

            }, 1000);

        } else {

            disp.style.display = 'none';

            input.disabled = false;

        }

    },




    // --- DJ ---

    djLogin: () => {

        if(document.getElementById('djPass').value === store.getDJPin()) {

            app.navigateTo('dj-dashboard');

        } else { app.showToast('Wrong PIN', 'error'); }

    },




    renderDJQueue: () => {

        const q = store.getQueue();

        const list = document.getElementById('djQueueList');

        const empty = document.getElementById('djEmptyState');

        const playing = store.getPlaying();

        

        if(playing) {

            document.getElementById('currentSongName').innerText = playing.t;

            document.getElementById('currentSongArtist').innerText = playing.a;

        }




        list.innerHTML = q.map((s, i) => `

            <li class="dj-queue-item">

                <div><strong>${i+1}. ${s.t}</strong> <span class="table-badge">T${s.tbl}</span></div>

                <small>${s.a}</small>

            </li>`).join('');

        

        empty.style.display = q.length ? 'none' : 'block';

    },




    playNext: () => {

        const q = store.getQueue();

        if(!q.length) return app.showToast('Empty Queue', 'error');

        const next = q.shift();

        store.setQueue(q);

        store.setPlaying(next);

        app.renderDJQueue();

        app.showToast(`Playing: ${next.t}`);

    },




    // --- Super Admin ---

    adminLogin: () => {

        if(document.getElementById('adminPass').value === '9999') {

            app.navigateTo('admin-dashboard');

        } else { app.showToast('Access Denied', 'error'); }

    },




    renderAdminQueue: () => {

        const q = store.getQueue();

        document.getElementById('adminQueueList').innerHTML = q.map((s, i) => `

            <li class="dj-queue-item" style="border-color: var(--admin-color);">

                <div><strong>${i+1}. ${s.t}</strong> <span class="table-badge">T${s.tbl}</span></div>

                <button class="btn btn-danger" onclick="app.adminRemove(${s.id})">Remove</button>

            </li>`).join('');

    },




    adminRemove: (id) => {

        let q = store.getQueue();

        q = q.filter(s => s.id !== id);

        store.setQueue(q);

        app.renderAdminQueue();

    },




    clearQueue: () => {

        if(confirm('Clear all songs?')) {

            store.setQueue([]);

            app.renderAdminQueue();

            app.showToast('Queue Cleared');

        }

    },




    changePassword: () => {

        const p = document.getElementById('newDjPin').value;

        if(p && p.length === 4) {

            store.setDJPin(p);

            app.showToast('PIN Changed');

            document.getElementById('newDjPin').value = '';

        } else {

            app.showToast('Invalid PIN', 'error');

        }

    },




    showToast: (msg, t='success') => {

        const x = document.getElementById('toast');

        x.innerText = msg;

        x.style.background = t==='error'?'#ef4444':'#10b981';

        x.style.color = t==='error'?'white':'#064e3b';

        x.classList.add('show');

        setTimeout(() => x.classList.remove('show'), 3000);

    }

};




// Initialize app when DOM is ready

document.addEventListener('DOMContentLoaded', () => {

    app.init();

});