// ==UserScript==
// @name         1 Travel Tracker (Premium Standalone UI)
// @version      13.0
// @description  Premium UI design with direct Torn API polling, clickable links, and honor bar backgrounds
// @author       Doitsburger
// @match        https://www.torn.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    const SCAN_INTERVAL_MS = 20000;
    const FACTION_DELAY_MS = 2000;
    const PANEL_UPDATE_INTERVAL = 1000;
    const LANDED_DISPLAY_MS = 30000;
    const STORAGE_KEY = 'torn_persistent_tracker_v7';
    const API_KEY_STORAGE = 'torn_api_key';

    const STUCK_BUFFER_MINS = 5;

    const DEFAULT_DURATIONS = {
        "Mexico":          { "Commercial": 26,  "Personal": 18,  "Private": 13 },
        "Cayman Islands":  { "Commercial": 35,  "Personal": 25,  "Private": 18 },
        "Canada":          { "Commercial": 41,  "Personal": 29,  "Private": 20 },
        "Hawaii":          { "Commercial": 134, "Personal": 94,  "Private": 67 },
        "United Kingdom":  { "Commercial": 159, "Personal": 111, "Private": 80 },
        "Argentina":       { "Commercial": 167, "Personal": 117, "Private": 83 },
        "Switzerland":     { "Commercial": 175, "Personal": 123, "Private": 88 },
        "Japan":           { "Commercial": 225, "Personal": 158, "Private": 113 },
        "China":           { "Commercial": 242, "Personal": 169, "Private": 121 },
        "UAE":             { "Commercial": 271, "Personal": 190, "Private": 135 },
        "South Africa":    { "Commercial": 297, "Personal": 208, "Private": 149 }
    };

    const PLANE_TYPE_MAP = {
        "light_aircraft": "Personal",
        "airliner":       "Commercial",
        "private_jet":    "Private"
    };

    const HONOR_IDS = {
        "Argentina": 66,
        "Canada": 75,
        "China": 76,
        "Japan": 97,
        "Mexico": 104,
        "South Africa": 119,
        "Switzerland": 123,
        "United Arab Emirates": 126,
        "UAE": 126,
        "United Kingdom": 127,
        "UK": 127,
        "Cayman Islands": 775,
        "Hawaii": 133
    };

    function getHonorImageUrl(locationName) {
        if (!locationName) return null;
        let normalized = locationName.trim();
        if (normalized === "UK") normalized = "United Kingdom";
        if (normalized === "UAE") normalized = "United Arab Emirates";
        const honorId = HONOR_IDS[normalized];
        return honorId ? `https://www.torn.com/images/honors/${honorId}/f.png` : null;
    }

    let state = {
        apiKey: '',
        watchedFactions: {},
        selectedFactionId: null,
        panelVisible: false,
        panelInterval: null,
        scanTimer: null,
        lastScanTime: 0,
        myUserID: null,
        myDestination: null,
        activeTab: 'all'
    };

    // ---------- DESIGN SYSTEM ----------
    function injectGlobalStyles() {
        if (document.getElementById('travel-tracker-global-styles')) return;
        const style = document.createElement('style');
        style.id = 'travel-tracker-global-styles';
        style.textContent = `
            :root {
                --tt-bg-elevated: rgba(18, 18, 18, 0.92);
                --tt-bg-card: rgba(32, 32, 32, 0.96);
                --tt-bg-card-soft: rgba(40, 40, 40, 0.9);
                --tt-border-subtle: rgba(255, 255, 255, 0.06);
                --tt-border-strong: rgba(255, 255, 255, 0.16);
                --tt-accent: #2196F3;
                --tt-accent-soft: rgba(33, 150, 243, 0.18);
                --tt-success: #4CAF50;
                --tt-warning: #FFB300;
                --tt-danger: #EF5350;
                --tt-purple: #9C27B0;
                --tt-text-main: #F5F5F5;
                --tt-text-muted: #9E9E9E;
                --tt-text-soft: #757575;
                --tt-radius-lg: 18px;
                --tt-radius-md: 10px;
                --tt-radius-sm: 6px;
                --tt-shadow-strong: 0 -14px 40px rgba(0,0,0,0.75);
                --tt-shadow-soft: 0 6px 18px rgba(0,0,0,0.55);
                --tt-transition-fast: 0.18s ease-out;
                --tt-transition-med: 0.25s cubic-bezier(0.2,0.8,0.2,1);
            }
            #travel-float-icon { -webkit-tap-highlight-color: transparent; }
            .tt-panel { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
            .tt-scrollbar::-webkit-scrollbar { width: 6px; }
            .tt-scrollbar::-webkit-scrollbar-track { background: transparent; }
            .tt-scrollbar::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 3px; }

            .tt-chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 999px; font-size: 10px; font-weight: 600; letter-spacing: 0.02em; text-transform: uppercase; }
            .tt-chip-soft { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); color: var(--tt-text-soft); }
            .tt-chip-accent { background: var(--tt-accent-soft); border: 1px solid rgba(33,150,243,0.6); color: #E3F2FD; }
            .tt-chip-success { background: rgba(76,175,80,0.16); border: 1px solid rgba(76,175,80,0.6); color: #C8E6C9; }
            .tt-chip-warning { background: rgba(255,179,0,0.16); border: 1px solid rgba(255,179,0,0.7); color: #FFE082; }
            .tt-chip-danger { background: rgba(239,83,80,0.16); border: 1px solid rgba(239,83,80,0.7); color: #FFCDD2; }
            .tt-chip-purple { background: rgba(156,39,176,0.16); border: 1px solid rgba(156,39,176,0.7); color: #E1BEE7; }

            .tt-tab-row { display: flex; gap: 6px; padding: 4px; background: rgba(255,255,255,0.03); border-radius: 999px; border: 1px solid rgba(255,255,255,0.06); }
            .tt-tab { flex: 1; border-radius: 999px; padding: 4px 0; font-size: 11px; font-weight: 600; text-align: center; cursor: pointer; color: var(--tt-text-soft); border: none; background: transparent; transition: background var(--tt-transition-fast), color var(--tt-transition-fast), transform 0.12s ease-out; }
            .tt-tab:hover { color: var(--tt-text-main); }
            .tt-tab.tt-active { background: rgba(255,255,255,0.08); color: var(--tt-text-main); transform: translateY(-1px); }

            .tt-pill-badge { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; padding: 0 6px; border-radius: 999px; font-size: 10px; font-weight: 600; background: rgba(255,255,255,0.08); color: var(--tt-text-main); }
            .tt-row { display: flex; align-items: center; justify-content: space-between; }
            .tt-row-gap { display: flex; align-items: center; gap: 6px; }

            .tt-member-card { position: relative; overflow: hidden; background: var(--tt-bg-card); border-radius: var(--tt-radius-md); border: 1px solid var(--tt-border-subtle); padding: 8px 10px; margin-bottom: 6px; box-shadow: var(--tt-shadow-soft); }
            .tt-member-card--same-dest { border-color: rgba(183,28,28,0.9); box-shadow: 0 0 0 1px rgba(183,28,28,0.6), var(--tt-shadow-soft); background: radial-gradient(circle at 0 0, rgba(183,28,28,0.35), transparent 55%), var(--tt-bg-card); }

            .tt-member-main { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
            .tt-member-name { font-size: 13px; font-weight: 600; color: var(--tt-text-main); max-width: 52%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .tt-member-name a { color: inherit; text-decoration: none; transition: color var(--tt-transition-fast); }
            .tt-member-name a:hover { color: var(--tt-accent); text-decoration: underline; }

            .tt-member-route { font-size: 11px; color: var(--tt-text-muted); text-align: right; max-width: 48%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .tt-member-meta { display: flex; justify-content: space-between; align-items: center; margin-top: 4px; font-size: 10px; color: var(--tt-text-soft); }

            .tt-progress-shell { position: relative; height: 30px; margin-top: 6px; }
            .tt-progress-bg { position: absolute; top: 0; left: 0; width: 100%; height: 100%; background-size: contain; background-repeat: no-repeat; background-position: center; opacity: 0.35; z-index: 0; pointer-events: none; }
            .tt-progress-labels { position: absolute; top: -2px; left: 0; right: 0; font-size: 9px; color: var(--tt-text-soft); display: flex; justify-content: space-between; padding: 0 4px; z-index: 1; }
            .tt-progress-track { position: absolute; top: 14px; left: 0; right: 0; height: 6px; background: rgba(255,255,255,0.06); border-radius: 999px; overflow: hidden; z-index: 1; }
            .tt-progress-fill { position: absolute; top: 0; height: 100%; border-radius: 999px; transition: width 1s linear, background var(--tt-transition-fast); }
            .tt-progress-node { position: absolute; top: 9px; width: 12px; height: 12px; border-radius: 50%; border: 2px solid #111; box-shadow: 0 0 0 1px rgba(0,0,0,0.6); z-index: 2; }
            .tt-progress-plane { position: absolute; top: 10px; font-size: 13px; filter: drop-shadow(0 1px 2px rgba(0,0,0,0.7)); transition: left 1s linear, transform var(--tt-transition-fast); z-index: 2; }

            .tt-section-title { font-size: 13px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--tt-text-soft); }
            .tt-faction-card { background: var(--tt-bg-card-soft); border-radius: var(--tt-radius-md); border: 1px solid var(--tt-border-subtle); padding: 10px 12px; margin-bottom: 6px; cursor: pointer; transition: background var(--tt-transition-fast), border-color var(--tt-transition-fast), transform 0.12s ease-out; box-shadow: var(--tt-shadow-soft); }
            .tt-faction-card:hover { background: rgba(255,255,255,0.04); border-color: var(--tt-border-strong); transform: translateY(-1px); }

            .tt-faction-name { font-size: 13px; font-weight: 600; color: var(--tt-text-main); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .tt-faction-name a { color: inherit; text-decoration: none; transition: color var(--tt-transition-fast); }
            .tt-faction-name a:hover { color: var(--tt-accent); text-decoration: underline; }
            .tt-faction-sub { font-size: 10px; color: var(--tt-text-soft); margin-top: 2px; }

            .tt-kbd { display: inline-flex; align-items: center; justify-content: center; padding: 1px 5px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.18); font-size: 9px; font-family: monospace; background: rgba(0,0,0,0.4); color: var(--tt-text-soft); }
            .tt-footer { position: sticky; bottom: -16px; margin: 10px -16px -16px -16px; padding: 8px 16px 14px 16px; background: linear-gradient(to top, rgba(0,0,0,0.9), transparent); display: flex; justify-content: space-between; align-items: center; font-size: 10px; color: var(--tt-text-soft); pointer-events: none;}

            .tt-dot { width: 8px; height: 8px; border-radius: 50%; border: 1px solid #000; }
            .tt-dot--online { background: var(--tt-success); }
            .tt-dot--offline { background: var(--tt-danger); }
            .tt-dot--apikey { background: var(--tt-warning); }
        `;
        document.head.appendChild(style);
    }

    // ---------- STORAGE & HELPERS ----------
    function loadState() {
        try {
            const raw = GM_getValue(STORAGE_KEY, null);
            if (raw) {
                const saved = JSON.parse(raw);
                state.watchedFactions = saved.watchedFactions || {};
            } else state.watchedFactions = {};
        } catch(e) { state.watchedFactions = {}; }
        state.apiKey = GM_getValue(API_KEY_STORAGE, '');
    }

    function saveState() { GM_setValue(STORAGE_KEY, JSON.stringify({ watchedFactions: state.watchedFactions })); }
    function saveApiKey(key) { GM_setValue(API_KEY_STORAGE, key); state.apiKey = key; }

    function escapeHtml(text) { return text ? text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') : ''; }
    function getFastestDuration(dest, type) { return (DEFAULT_DURATIONS[dest]?.[type] || 10) * 0.97; }
    function getSlowestDuration(dest, type) { return (DEFAULT_DURATIONS[dest]?.[type] || 10) * 1.03; }
    function isFactionProfilePage() { return /\/factions\.php\?step=profile(&|$)/i.test(window.location.href); }
    function getCurrentFactionIdFromUrl() { return new URLSearchParams(window.location.search).get('ID'); }

    function formatTime(ms) {
        if (ms <= 0) return '0:00';
        const totalSeconds = Math.floor(ms / 1000);
        const hrs = Math.floor(totalSeconds / 3600);
        const mins = Math.floor((totalSeconds % 3600) / 60);
        const secs = totalSeconds % 60;
        return hrs > 0 ? `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}` : `${mins}:${secs.toString().padStart(2, '0')}`;
    }
    function formatWallClock(timestamp) { return new Date(timestamp).toTimeString().split(' ')[0]; }

    function scrapeFactionNameFromPage() {
        const el = document.querySelector('.title-black.hospital-dark.top-round.m-top10');
        if (!el) return null;
        const clone = el.cloneNode(true);
        const respect = clone.querySelector('.bold.f-title-respect');
        if (respect) respect.remove();
        const text = clone.textContent.trim().replace(/\s+/g, ' ').trim();
        return text.length > 0 && text.length < 100 ? text : null;
    }

    function playBeep() {
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine'; osc.frequency.setValueAtTime(800, ctx.currentTime);
            gain.gain.setValueAtTime(0.3, ctx.currentTime); gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);
            osc.connect(gain); gain.connect(ctx.destination); osc.start(); osc.stop(ctx.currentTime + 0.2);
        } catch(e) {}
    }

    // ---------- API ----------
    function promptForApiKey() {
        const key = prompt('Enter your Torn API key (Public access, faction permission):', '');
        if (key && key.trim()) { saveApiKey(key.trim()); return true; }
        return false;
    }

    async function fetchFactionMembers(fid) {
        if (!state.apiKey) throw new Error('No API key');
        const url = `https://api.torn.com/v2/faction/${fid}/members?striptags=true&key=${state.apiKey}`;
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET', url: url, headers: { 'Accept': 'application/json' },
                onload: (resp) => { resp.status === 200 ? resolve(JSON.parse(resp.responseText)) : reject(new Error(`HTTP ${resp.status}`)); },
                onerror: reject
            });
        });
    }

    async function fetchMyTravelInfo() {
        if (!state.apiKey) return;
        try {
            const url = `https://api.torn.com/v2/user/?selections=travel&key=${state.apiKey}`;
            const resp = await fetch(url);
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            const data = await resp.json();
            state.myUserID = data.player_id;
            state.myDestination = (data.travel?.destination && data.travel.method !== 'Return') ? data.travel.destination : null;
        } catch(e) {}
    }

    // ---------- SCAN LOOP ----------
    async function scanAllFactions() {
        await fetchMyTravelInfo();
        if (Object.keys(state.watchedFactions).length === 0) {
            state.scanTimer = setTimeout(scanAllFactions, SCAN_INTERVAL_MS); return;
        }
        const fids = Object.keys(state.watchedFactions);
        for (let i = 0; i < fids.length; i++) {
            try {
                const data = await fetchFactionMembers(fids[i]);
                processApiData(fids[i], data);
            } catch(e) {}
            if (i < fids.length - 1) await new Promise(r => setTimeout(r, FACTION_DELAY_MS));
        }
        state.lastScanTime = Date.now();
        saveState(); updatePanelIfOpen();
        state.scanTimer = setTimeout(scanAllFactions, SCAN_INTERVAL_MS);
    }

    function processApiData(fid, data) {
        const faction = state.watchedFactions[fid];
        if (!faction) return 0;
        const members = faction.members;
        const apiMembers = data.members || [];

        for (const apiMem of apiMembers) {
            const xid = apiMem.id.toString();
            if (!members[xid]) {
                members[xid] = { id: xid, status: 'idle', playerName: apiMem.name, destination: null, flightType: null, travelStarted: null, lookupDest: null, origin: null, landedAt: null, sameDestination: false, alertPlayed: false };
            }
            const member = members[xid];
            member.playerName = apiMem.name;
            member.id = xid;

            const isTravelling = apiMem.status.state === 'Traveling';

            if (isTravelling) {
                const match = (apiMem.status.description || '').match(/Traveling from (.+?) to (.+)/);
                if (!match) continue;

                const origin = match[1].trim(), dest = match[2].trim();
                const flightType = PLANE_TYPE_MAP[apiMem.status.plane_image_type] || 'Commercial';
                const lookupDest = dest === 'Torn' ? origin : dest;

                if (member.status === 'landed' && member.destination === dest && member.flightType === flightType) continue;
                if (member.status === 'landed') { member.landedAt = null; member.alertPlayed = false; }

                member.sameDestination = (state.myDestination && dest !== 'Torn' && dest === state.myDestination && xid !== state.myUserID?.toString());

                if (member.status !== 'traveling' || member.destination !== dest || member.flightType !== flightType) {
                    member.alertPlayed = false;
                    let departureTime = Date.now();
                    if (state.lastScanTime > 0) departureTime = Math.floor((state.lastScanTime + Date.now()) / 2);
                    else if (apiMem.last_action?.timestamp) departureTime = Math.min(apiMem.last_action.timestamp * 1000, Date.now());

                    Object.assign(member, { status: 'traveling', destination: dest, flightType: flightType, travelStarted: departureTime, lookupDest: lookupDest, origin: origin, landedAt: null });
                    if (member.sameDestination) { playBeep(); member.alertPlayed = true; }
                } else {
                    const slowestDuration = getSlowestDuration(member.lookupDest, member.flightType);
                    if (Date.now() > member.travelStarted + (slowestDuration + STUCK_BUFFER_MINS) * 60000) {
                        Object.assign(member, { status: 'landed', landedAt: member.travelStarted + (slowestDuration * 60000), alertPlayed: false });
                    }
                }
            } else {
                if (member.status === 'traveling') {
                    Object.assign(member, { status: 'landed', landedAt: Date.now(), alertPlayed: false });
                } else if (member.status === 'landed' && Date.now() - member.landedAt > LANDED_DISPLAY_MS) {
                    Object.assign(member, { status: 'idle' });
                }
            }
        }
    }

    // ---------- UI: FLOATING ICON ----------
    function injectFloatingIcon() {
        if (document.getElementById('travel-float-icon')) return;
        const icon = document.createElement('div');
        icon.id = 'travel-float-icon';
        icon.style.cssText = `
            position: fixed; bottom: 82px; right: 10px; width: 46px; height: 46px; border-radius: 999px;
            background: radial-gradient(circle at 30% 0, rgba(255,255,255,0.16), transparent 55%), rgba(18,18,18,0.96);
            border: 1px solid rgba(255,255,255,0.12); box-shadow: 0 10px 26px rgba(0,0,0,0.75);
            display: flex; align-items: center; justify-content: center; cursor: pointer; z-index: 10000;
            color: #fff; font-size: 22px; backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px);
            transition: transform 0.12s ease-out, box-shadow 0.12s ease-out, background 0.18s ease-out;
        `;

        const inner = document.createElement('div');
        inner.style.cssText = `display:flex; align-items:center; justify-content:center; gap:4px;`;
        inner.innerHTML = `<span style="font-size:18px;">✈️</span>`;

        const dot = document.createElement('div');
        dot.id = 'travel-tracker-status';
        dot.className = `tt-dot ${state.apiKey ? 'tt-dot--online' : 'tt-dot--apikey'}`;
        dot.style.cssText = `position:absolute; top:4px; right:4px;`;

        icon.appendChild(inner);
        icon.appendChild(dot);

        icon.addEventListener('mousedown', () => { icon.style.transform = 'translateY(1px) scale(0.97)'; icon.style.boxShadow = '0 4px 14px rgba(0,0,0,0.8)'; });
        icon.addEventListener('mouseup', () => { icon.style.transform = 'translateY(0) scale(1)'; icon.style.boxShadow = '0 10px 26px rgba(0,0,0,0.75)'; });
        icon.addEventListener('mouseleave', () => { icon.style.transform = 'translateY(0) scale(1)'; icon.style.boxShadow = '0 10px 26px rgba(0,0,0,0.75)'; });

        icon.addEventListener('click', () => { state.panelVisible ? closePanel() : (state.selectedFactionId = null, createPanel()); });
        document.body.appendChild(icon);
    }

    function updateFloatingIconDot() {
        const dot = document.getElementById('travel-tracker-status');
        if (dot) {
            dot.className = `tt-dot ${state.apiKey ? 'tt-dot--online' : 'tt-dot--apikey'}`;
        }
    }

    // ---------- UI: PANEL LIFECYCLE ----------
    function updatePanelIfOpen() { if (state.panelVisible) updatePanelContent(); }

    function createPanel() {
        if (document.getElementById('travel-panel')) return closePanel();

        const overlay = document.createElement('div');
        overlay.id = 'travel-panel-overlay';
        overlay.style.cssText = `position: fixed; inset: 0; background: rgba(0,0,0,0.25); z-index: 9998;`;
        overlay.addEventListener('click', closePanel);
        document.body.appendChild(overlay);

        const panel = document.createElement('div');
        panel.id = 'travel-panel';
        panel.className = 'tt-panel tt-scrollbar';
        panel.style.cssText = `
            position: fixed; left: 50%; bottom: 0; transform: translate(-50%, 100%);
            width: min(420px, calc(100vw - 32px)); max-width: 480px; max-height: 78vh;
            background: var(--tt-bg-elevated); backdrop-filter: blur(22px); -webkit-backdrop-filter: blur(22px);
            border-top-left-radius: var(--tt-radius-lg); border-top-right-radius: var(--tt-radius-lg);
            box-shadow: var(--tt-shadow-strong); padding: 14px 16px 18px 16px; z-index: 9999;
            color: var(--tt-text-main); display: flex; flex-direction: column; box-sizing: border-box;
            overflow-y: auto; transition: transform var(--tt-transition-med);
        `;
        panel.addEventListener('click', (e) => e.stopPropagation());
        document.body.appendChild(panel);

        requestAnimationFrame(() => { panel.style.transform = 'translate(-50%, 0)'; });

        state.panelVisible = true;
        updatePanelContent();

        if (state.panelInterval) clearInterval(state.panelInterval);
        state.panelInterval = setInterval(() => { state.panelVisible ? updatePanelContent() : clearInterval(state.panelInterval); }, PANEL_UPDATE_INTERVAL);
    }

    function closePanel() {
        const panel = document.getElementById('travel-panel');
        if (!panel) return;
        panel.style.transform = 'translate(-50%, 100%)';
        panel.addEventListener('transitionend', function handler() { panel.removeEventListener('transitionend', handler); panel.remove(); });
        const overlay = document.getElementById('travel-panel-overlay');
        if (overlay) overlay.remove();
        state.panelVisible = false;
        state.selectedFactionId = null;
        if (state.panelInterval) { clearInterval(state.panelInterval); state.panelInterval = null; }
    }

    // ---------- UI: RENDERING ----------
    function updatePanelContent() {
        const panel = document.getElementById('travel-panel');
        if (!panel) return;

        if (!state.apiKey) {
            panel.innerHTML = `
                <div style="display:flex; flex-direction:column; align-items:center; text-align:center; padding:24px 8px 10px 8px;">
                    <div style="font-size:32px; margin-bottom:8px;">🔑</div>
                    <div style="font-weight:600; margin-bottom:4px;">API key required</div>
                    <div style="font-size:11px; color:var(--tt-text-soft); margin-bottom:12px;">
                        Public access required to fetch faction member data.<br>
                        This client polls Torn directly.
                    </div>
                    <button id="set-api-key" style="padding:6px 16px; border-radius:999px; border:none; background:var(--tt-accent); color:#fff; font-size:12px; font-weight:600; cursor:pointer; box-shadow:0 4px 12px rgba(33,150,243,0.45);">
                        Set API key
                    </button>
                </div>
            `;
            document.getElementById('set-api-key')?.addEventListener('click', () => {
                if (promptForApiKey()) { updateFloatingIconDot(); updatePanelContent(); if(!state.scanTimer) state.scanTimer = setTimeout(scanAllFactions, 1000); }
            });
            return;
        }

        const fids = Object.keys(state.watchedFactions);
        const totalTravelling = fids.reduce((acc, fid) => {
            const members = state.watchedFactions[fid].members || {};
            return acc + Object.values(members).filter(m => m.status === 'traveling' || m.status === 'landed').length;
        }, 0);

        const currentFid = getCurrentFactionIdFromUrl();
        const isProfilePage = isFactionProfilePage();
        const isWatched = currentFid && !!state.watchedFactions[currentFid];

        // Watch/Unwatch icon button (icon only)
        const watchBtnHtml = isProfilePage && currentFid ? `
            <button id="tt-watch-btn" title="${isWatched ? 'Stop watching this faction' : 'Watch this faction'}"
                style="background: none; border: none; cursor: pointer; padding: 20px; display: flex; align-items: center;"
            >
                <svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="6 5 28 28" style="vertical-align: middle;">
                    <path d="M23,23.5a2,2,0,1,1,2,2A2,2,0,0,1,23,23.5Zm-10,0a2,2,0,1,1,2,2A2,2,0,0,1,13,23.5Zm1-7a2.15,2.15,0,0,0-2,2v5a3.23,3.23,0,0,0,3,3,3.23,3.23,0,0,0,3-3v-2h1v-1h2v1h1v2a3.23,3.23,0,0,0,3,3,3.23,3.23,0,0,0,3-3v-5a2.15,2.15,0,0,0-2-2v-2a1.08,1.08,0,0,0-1-1v-1h1v-2H22v2h1v1l-3,1.69L17,13.5v-1h1v-2H14v2h1v1a1.08,1.08,0,0,0-1,1Z"
                        fill="${isWatched ? '#4CAF50' : 'rgba(255,255,255,0.5)'}"></path>
                </svg>
            </button>
        ` : '';

        let headerHtml = `
            <div style="position:sticky; top:-14px; padding-bottom:10px; margin:-14px -16px 8px -16px; padding:14px 16px 10px 16px; background:linear-gradient(to bottom, rgba(0,0,0,0.95), rgba(0,0,0,0.7)); z-index:2;">
                <div class="tt-row">
                    <div class="tt-row-gap">
                        <span style="font-size:18px;">✈️</span>
                        <div>
                            <div style="font-size:14px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase;">Travel tracker</div>
                            <div style="font-size:10px; color:var(--tt-text-soft);">
                                ${fids.length === 0 ? 'No factions watched yet' : `${fids.length} faction${fids.length > 1 ? 's' : ''} • ${totalTravelling} tracked`}
                            </div>
                        </div>
                    </div>
                    <div class="tt-row-gap">
                        ${watchBtnHtml}
                        <button id="tt-close-panel" style="background:none; border:none; color:var(--tt-text-soft); font-size:16px; cursor:pointer; padding:4px;">✕</button>
                    </div>
                </div>
                <div style="margin-top:8px; display:flex; justify-content:space-between; align-items:center; gap:8px;">
                    <div class="tt-tab-row" style="flex:1;">
                        <button class="tt-tab ${state.activeTab === 'all' ? 'tt-active' : ''}" data-tab="all">All</button>
                        <button class="tt-tab ${state.activeTab === 'outbound' ? 'tt-active' : ''}" data-tab="outbound">Outbound</button>
                        <button class="tt-tab ${state.activeTab === 'return' ? 'tt-active' : ''}" data-tab="return">Return</button>
                    </div>
                    <div class="tt-chip tt-chip-soft">
                        <span class="tt-dot tt-dot--online"></span>
                        <span style="margin-left:4px; font-size:9px;">Live API</span>
                    </div>
                </div>
            </div>
        `;

        let bodyHtml = state.selectedFactionId && state.watchedFactions[state.selectedFactionId] ? renderFactionMembers(state.selectedFactionId) : renderFactionList();

        const footerHtml = `
            <div class="tt-footer">
                <div style="pointer-events: auto;">
                    <span style="font-weight:600;">Legend</span>
                    <span style="margin-left:6px; font-size:9px;">
                        <span style="color:var(--tt-accent);">■</span> Outbound
                        <span style="margin-left:4px; color:var(--tt-purple);">■</span> Return
                        <span style="margin-left:4px; color:var(--tt-warning);">■</span> Landing
                    </span>
                </div>
                <div style="pointer-events: auto;">
                    <span class="tt-kbd">Direct API</span>
                    <span style="margin-left:4px; font-size:9px;">No Server</span>
                </div>
            </div>
        `;

        panel.innerHTML = headerHtml + bodyHtml + footerHtml;

        document.getElementById('tt-close-panel')?.addEventListener('click', closePanel);
        panel.querySelectorAll('.tt-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const t = tab.getAttribute('data-tab');
                if (!t || t === state.activeTab) return;
                state.activeTab = t;
                updatePanelContent();
            });
        });

        panel.querySelectorAll('.tt-faction-card').forEach(card => {
            card.addEventListener('click', (e) => {
                if (e.target.tagName === 'A') return;
                state.selectedFactionId = card.getAttribute('data-fid');
                updatePanelContent();
            });
        });

        document.getElementById('tt-back-to-list')?.addEventListener('click', () => { state.selectedFactionId = null; updatePanelContent(); });
        document.getElementById('tt-stop-watch-faction')?.addEventListener('click', (e) => removeWatchedFaction(e.target.getAttribute('data-fid')));

        // Watch button toggle logic (icon only)
        const watchBtn = document.getElementById('tt-watch-btn');
        if (watchBtn) {
            watchBtn.addEventListener('click', () => {
                if (!currentFid) return;
                if (state.watchedFactions[currentFid]) {
                    removeWatchedFaction(currentFid);
                } else {
                    if (!state.apiKey && !promptForApiKey()) return;
                    state.watchedFactions[currentFid] = { name: scrapeFactionNameFromPage() || `Faction ${currentFid}`, members: {} };
                    state.lastScanTime = 0;
                    saveState();
                    if (!state.scanTimer) state.scanTimer = setTimeout(scanAllFactions, 1000);
                    updatePanelContent();
                }
            });
        }
    }

    function renderFactionList() {
        const fids = Object.keys(state.watchedFactions);
        let html = `<div style="margin-top:4px;"><div class="tt-section-title" style="margin-bottom:6px;">Watched factions</div>`;

        if (fids.length === 0) {
            html += `
                <div style="padding:14px 10px; border-radius:var(--tt-radius-md); border:1px dashed rgba(255,255,255,0.18); background:rgba(255,255,255,0.02); font-size:11px; color:var(--tt-text-soft); text-align:center;">
                    No factions watched yet.<br>
                    Open a faction profile and use the <span style="font-weight:600;">✈️</span> icon in the panel.
                </div>
            `;
        } else {
            for (const fid of fids) {
                const faction = state.watchedFactions[fid];
                const members = faction.members || {};
                const travelling = Object.values(members).filter(m => m.status === 'traveling' || m.status === 'landed');
                const outbound = travelling.filter(m => m.status === 'traveling' && m.destination && m.destination !== 'Torn').length;
                const returning = travelling.filter(m => m.status === 'traveling' && m.destination === 'Torn').length;
                const landedCount = travelling.filter(m => m.status === 'landed').length;
                const totalActive = outbound + returning + landedCount;

                html += `
                    <div class="tt-faction-card" data-fid="${fid}">
                        <div class="tt-row">
                            <div>
                                <div class="tt-faction-name"><a href="/factions.php?step=profile&ID=${fid}" target="_blank">${escapeHtml(faction.name || `Faction ${fid}`)}</a></div>
                                <div class="tt-faction-sub">
                                    ${totalActive === 0 ? 'No active flights' : `Out: ${outbound} • Ret: ${returning}${landedCount > 0 ? ` • Landed: ${landedCount}` : ''}`}
                                </div>
                            </div>
                            <div class="tt-row-gap">
                                ${totalActive > 0 ? `<span class="tt-pill-badge" style="background:rgba(76,175,80,0.18); color:#C8E6C9;">${totalActive}</span>` : ''}
                                <span style="font-size:14px; color:var(--tt-text-soft);">›</span>
                            </div>
                        </div>
                    </div>
                `;
            }
        }
        html += `</div>`; return html;
    }

    function renderFactionMembers(fid) {
        const faction = state.watchedFactions[fid];
        const members = faction.members || {};
        const now = Date.now();

        const inflight = [], landed = [];
        for (const xid in members) {
            const m = members[xid];
            if (m.status === 'traveling') inflight.push(m);
            else if (m.status === 'landed') landed.push(m);
        }

        inflight.sort((a, b) => (getFastestDuration(a.lookupDest, a.flightType)*60000 + a.travelStarted) - (getFastestDuration(b.lookupDest, b.flightType)*60000 + b.travelStarted));
        landed.sort((a, b) => b.landedAt - a.landedAt);

        let allToShow = [];
        if (state.activeTab === 'all') allToShow = [...landed, ...inflight];
        else if (state.activeTab === 'outbound') allToShow = inflight.filter(m => m.destination !== 'Torn');
        else if (state.activeTab === 'return') allToShow = inflight.filter(m => m.destination === 'Torn');

        const outboundCount = inflight.filter(m => m.destination !== 'Torn').length;
        const returnCount = inflight.filter(m => m.destination === 'Torn').length;

        let html = `
            <div style="margin-top:4px;">
                <div class="tt-row" style="margin-bottom:6px;">
                    <button id="tt-back-to-list" style="background:none; border:none; color:var(--tt-text-soft); font-size:13px; cursor:pointer; padding:2px 4px; display:flex; align-items:center; gap:4px;">
                        <span style="font-size:14px;">←</span><span style="font-size:11px;">Factions</span>
                    </button>
                    <div style="text-align:right;">
                        <div style="font-size:14px; font-weight:700;">
                            <a href="/factions.php?step=profile&ID=${fid}" target="_blank" style="color: inherit; text-decoration: none;">${escapeHtml(faction.name || `Faction ${fid}`)}</a>
                        </div>
                        <div style="font-size:10px; color:var(--tt-text-soft);">
                            Out: ${outboundCount} • Ret: ${returnCount} • Landed: ${landed.length}
                        </div>
                    </div>
                </div>
                <div class="tt-row" style="margin-bottom:8px;">
                    <div class="tt-row-gap">
                        <div class="tt-chip tt-chip-accent"><span style="width:6px; height:6px; border-radius:50%; background:var(--tt-accent);"></span><span>Outbound</span></div>
                        <div class="tt-chip tt-chip-purple"><span style="width:6px; height:6px; border-radius:50%; background:var(--tt-purple);"></span><span>Return</span></div>
                    </div>
                    <button id="tt-stop-watch-faction" data-fid="${fid}" style="border-radius:999px; border:none; padding:4px 10px; font-size:10px; font-weight:600; background:rgba(239,83,80,0.16); color:#FFCDD2; cursor:pointer;">
                        Stop watching
                    </button>
                </div>
        `;

        if (allToShow.length === 0) {
            html += `
                <div style="padding:14px 10px; border-radius:var(--tt-radius-md); border:1px dashed rgba(255,255,255,0.18); background:rgba(255,255,255,0.02); font-size:11px; color:var(--tt-text-soft); text-align:center;">
                    No members currently matching this filter.
                </div>
            `;
        } else {
            for (const m of allToShow) {
                const isLanded = m.status === 'landed';
                const isReturn = m.destination === 'Torn';
                const routeText = isReturn ? `← ${m.origin}` : `${m.origin} → ${m.destination}`;

                let backgroundUrl = null;
                if (m.status === 'traveling') backgroundUrl = getHonorImageUrl(m.destination === 'Torn' ? m.origin : m.destination);
                else if (m.status === 'landed') backgroundUrl = getHonorImageUrl(m.destination);

                const progressBgHtml = backgroundUrl ? `<div class="tt-progress-bg" style="background-image: url('${backgroundUrl}');"></div>` : '';

                if (isLanded) html += renderLandedCard(m, routeText, m.id);
                else html += renderTravelCard(m, routeText, now, isReturn, m.id, progressBgHtml);
            }
        }
        html += `</div>`; return html;
    }

    function renderLandedCard(m, routeText, xid) {
        return `
            <div class="tt-member-card" style="background:radial-gradient(circle at 0 0, rgba(76,175,80,0.35), transparent 55%), var(--tt-bg-card); border-color:rgba(76,175,80,0.8);">
                <div class="tt-member-main">
                    <div class="tt-member-name"><a href="/profiles.php?XID=${xid}" target="_blank">${escapeHtml(m.playerName)}</a></div>
                    <div class="tt-member-route">${escapeHtml(routeText)}</div>
                </div>
                <div class="tt-member-meta">
                    <span class="tt-chip tt-chip-success"><span style="font-size:11px;">LANDED</span><span style="font-family:monospace; font-size:10px;">${formatWallClock(m.landedAt)}</span></span>
                    <span style="font-size:10px; color:var(--tt-text-soft);">${m.flightType}</span>
                </div>
            </div>
        `;
    }

    function renderTravelCard(m, routeText, now, isReturn, xid, progressBgHtml) {
        const fastestETA = m.travelStarted + getFastestDuration(m.lookupDest, m.flightType) * 60000;
        const slowestETA = m.travelStarted + getSlowestDuration(m.lookupDest, m.flightType) * 60000;
        const fastRem = Math.max(0, fastestETA - now);
        const slowRem = Math.max(0, slowestETA - now);

        const total = (DEFAULT_DURATIONS[m.lookupDest]?.[m.flightType] || 120) * 60000;
        const percent = total > 0 ? Math.min(100, Math.max(0, ((now - m.travelStarted) / total) * 100)) : 100;

        const isLanding = fastRem <= 0;
        let statusText, barColor, barWidth, chipClass;
        if (isLanding) {
            statusText = `Landing • latest ${formatTime(slowRem)}`;
            barColor = '#FFB300'; barWidth = 100; chipClass = 'tt-chip-warning';
        } else {
            statusText = `${formatTime(fastRem)} • window ${formatTime(fastRem)}–${formatTime(slowRem)}`;
            barColor = isReturn ? '#9C27B0' : (percent > 90 ? '#FFB300' : '#2196F3');
            barWidth = percent; chipClass = isReturn ? 'tt-chip-purple' : 'tt-chip-accent';
        }

        const planeLeft = Math.max(4, Math.min(96, isReturn ? (100 - barWidth) : barWidth));
        const planeTransform = isReturn ? 'translateX(-50%) scaleX(-1) rotate(45deg)' : 'translateX(-50%) rotate(45deg)';
        const fillStyle = isReturn ? `right:0; left:auto; width:${barWidth}%; background:${barColor};` : `left:0; right:auto; width:${barWidth}%; background:${barColor};`;

        return `
            <div class="tt-member-card ${m.sameDestination ? 'tt-member-card--same-dest' : ''}">
                <div class="tt-member-main">
                    <div class="tt-member-name"><a href="/profiles.php?XID=${xid}" target="_blank">${escapeHtml(m.playerName)}</a></div>
                    <div class="tt-member-route">${escapeHtml(routeText)}</div>
                </div>
                <div class="tt-member-meta">
                    <span class="tt-chip ${chipClass}"><span style="font-size:10px;">${isReturn ? 'Return' : 'Outbound'}</span><span style="font-family:monospace; font-size:10px;">${formatTime(fastRem)}</span></span>
                    <span style="font-size:10px; color:var(--tt-text-soft);">${m.flightType}</span>
                </div>
                <div style="margin-top:4px; font-size:10px; color:${isLanding ? 'var(--tt-warning)' : 'var(--tt-text-soft)'}; text-align:center;">${statusText}</div>
                <div class="tt-progress-shell">
                    ${progressBgHtml}
                    <div class="tt-progress-labels"><span>${isReturn ? 'Arr' : 'Dep'}</span><span>${isReturn ? 'Dep' : 'Arr'}</span></div>
                    <div class="tt-progress-track"><div class="tt-progress-fill" style="${fillStyle}"></div></div>
                    <div class="tt-progress-node" style="${isReturn ? 'right:0;' : 'left:0;'} background:${isReturn ? barColor : (isLanding ? '#FFB300' : '#333')};"></div>
                    <div class="tt-progress-node" style="${isReturn ? 'left:0;' : 'right:0;'} background:${isReturn ? (isLanding ? '#FFB300' : '#333') : barColor};"></div>
                    <div class="tt-progress-plane" style="left:${planeLeft}%; transform:${planeTransform};">✈️</div>
                </div>
            </div>
        `;
    }

    // ---------- PAGE INJECTIONS ----------
    function removeWatchedFaction(fid) {
        if (!state.watchedFactions[fid]) return;
        delete state.watchedFactions[fid]; saveState();
        if (state.selectedFactionId === fid) state.selectedFactionId = null;
        updatePanelContent();
    }

    // ---------- INIT ----------
    function init() {
        injectGlobalStyles();
        loadState();
        fetchMyTravelInfo();
        injectFloatingIcon();
        if (Object.keys(state.watchedFactions).length > 0 && state.apiKey) state.scanTimer = setTimeout(scanAllFactions, 1000);
    }

    init();
})();
