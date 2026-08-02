// ==UserScript==
// @name         1 Doits Flight Tracker v17.1 – Mobile‑First
// @namespace    https://github.com/your-repo
// @version      17.1.0
// @description  Travel tracker with local Termux server + GitHub Gist fallback + personal TBS colouring (mobile optimised)
// @author       Doitsburger + Grok
// @match        https://www.torn.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @run-at       document-end
// @connect      127.0.0.1
// @connect      gist.githubusercontent.com
// @connect      api.torn.com
// @connect      ffscouter.com
// ==/UserScript==

(function () {
    'use strict';

    // ==================== CONFIG ====================
    const GIST_RAW_URL = 'https://gist.github.com/doitsburger/f6146b9fc97ed168fecd84a4ea3ea8d2/raw/travel-state.json';
    const LOCAL_SERVER = 'http://127.0.0.1:3000';

    const POLL_INTERVAL_LOCAL = 1500;
    const POLL_INTERVAL_GIST  = 12000;
    const PANEL_UPDATE_INTERVAL = 2000; // reduced from 1s for mobile performance
    const DETECT_DELAY = 20000;

    const DEFAULT_DURATIONS = {
        "Mexico": { "Commercial": 24, "Personal": 17, "Private": 12 },
        "Cayman Islands": { "Commercial": 33, "Personal": 23, "Private": 17 },
        "Canada": { "Commercial": 39, "Personal": 27, "Private": 19 },
        "Hawaii": { "Commercial": 127, "Personal": 89, "Private": 63 },
        "United Kingdom": { "Commercial": 151, "Personal": 106, "Private": 75 },
        "Argentina": { "Commercial": 158, "Personal": 111, "Private": 79 },
        "Switzerland": { "Commercial": 166, "Personal": 116, "Private": 83 },
        "Japan": { "Commercial": 213, "Personal": 149, "Private": 107 },
        "China": { "Commercial": 229, "Personal": 160, "Private": 114 },
        "UAE": { "Commercial": 257, "Personal": 180, "Private": 128 },
        "South Africa": { "Commercial": 282, "Personal": 197, "Private": 141 }
    };

    const BUSINESS_DURATIONS = {
        "Mexico": 7.5, "Cayman Islands": 9.9, "Canada": 11.7, "Hawaii": 38.1,
        "United Kingdom": 45.3, "Argentina": 47.4, "Switzerland": 49.8,
        "Japan": 63.9, "China": 68.7, "United Arab Emirates": 77.1, "UAE": 77.1,
        "South Africa": 84.3
    };

    const FLAG_EMOJI = {
        "Mexico": "🇲🇽", "Cayman Islands": "🇰🇾", "Canada": "🇨🇦", "Hawaii": "🇺🇸",
        "United Kingdom": "🇬🇧", "Argentina": "🇦🇷", "Switzerland": "🇨🇭",
        "Japan": "🇯🇵", "China": "🇨🇳", "UAE": "🇦🇪", "United Arab Emirates": "🇦🇪",
        "South Africa": "🇿🇦"
    };

    const HONOR_IDS = {
        "Argentina": 66, "Canada": 75, "China": 76, "Japan": 97,
        "Mexico": 104, "South Africa": 119, "Switzerland": 123,
        "United Arab Emirates": 126, "UAE": 126, "United Kingdom": 127, "UK": 127,
        "Cayman Islands": 775, "Hawaii": 133
    };

    const BS_COLORS = {
        low:  { bg: '#87CEEB', text: '#000' },
        mid:  { bg: '#28c628', text: '#000' },
        high: { bg: '#AA7DCE', text: '#fff' },
        top:  { bg: '#c62828', text: '#fff' }
    };

    // ==================== STATE ====================
    let myBattleStats = null;
    let usingLocal = true;
    let autoWatchDone = false;
    let pollTimer = null;

    let state = {
        apiKeySet: false,
        watchedFactions: {},
        selectedFactionId: null,
        panelVisible: false,
        panelInterval: null,
        myUserID: null,
        myDestination: null,
        myFactionID: null,
        myFactionName: null,
        myTravelArrival: null,
        warFactions: new Set(),
        lastPollTime: 0,
        serverOnline: false,
        activeTab: 'all',
        previousMembers: {},
        notifiedFlights: {},
        businessFlights: {},
        personalApiKey: GM_getValue('personalApiKey', '') || ''
    };

    // ==================== HELPERS ====================
    function getMyTornUserId() {
        try { if (typeof unsafeWindow !== 'undefined' && unsafeWindow.uid) return unsafeWindow.uid.toString(); } catch (e) {}
        const link = document.querySelector('a[href*="/profiles.php?XID="]');
        if (link) { const m = link.href.match(/XID=(\d+)/); if (m) return m[1]; }
        const el = document.querySelector('.user-info-value .user-id');
        if (el) { const t = el.textContent.replace(/[^0-9]/g, ''); if (t) return t; }
        return null;
    }

    function standardizeCountryName(country) {
        if (!country) return '';
        const map = {
            'United Kingdom': 'uk', 'UK': 'uk', 'UAE': 'uae',
            'United Arab Emirates': 'uae', 'Cayman Islands': 'cayman_islands', 'Hawaii': 'hawaii'
        };
        const trimmed = country.trim();
        return map[trimmed] || trimmed.toLowerCase().replace(/ /g, '_');
    }

    function getFlagUrl(country) {
        const std = standardizeCountryName(country);
        return std ? `/images/v2/travel_agency/flags/fl_${std}.svg` : null;
    }

    function getBSColorConfig(theirBS) {
        if (theirBS == null || isNaN(theirBS) || !myBattleStats || myBattleStats === 0) return null;
        const ratio = theirBS / myBattleStats;
        if (ratio < 0.83) return BS_COLORS.low;
        if (ratio < 1.27) return BS_COLORS.mid;
        if (ratio < 1.50) return BS_COLORS.high;
        return BS_COLORS.top;
    }

    function formatBS(n) {
        if (n == null || isNaN(n)) return null;
        if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'b';
        if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'm';
        if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
        return n.toString();
    }

    function renderBSPill(member) {
        const bs = member.tbs || member.bs_estimate || null;
        if (bs == null || isNaN(bs)) return '';
        const formatted = formatBS(bs);
        if (!formatted) return '';
        const colorConfig = getBSColorConfig(bs);
        if (!colorConfig) {
            return `<span style="display:inline-flex;align-items:center;gap:3px;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:700;background:rgba(255,255,255,0.08);color:#aaa;">⚔ ${formatted}</span>`;
        }
        return `<span style="display:inline-flex;align-items:center;gap:3px;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:700;background:${colorConfig.bg};color:${colorConfig.text};">⚔ ${formatted}</span>`;
    }

    function escapeHtml(t) {
        return t ? t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') : '';
    }

    function getFastestDuration(dest, type) {
        const b = DEFAULT_DURATIONS[dest]?.[type];
        return b ? b * 0.97 : 10;
    }
    function getSlowestDuration(dest, type) {
        const b = DEFAULT_DURATIONS[dest]?.[type];
        return b ? b * 1.03 : 10;
    }

    function formatTime(ms) {
        if (ms <= 0) return '0:00';
        const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
        return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
    }

    function formatElapsed(ms) {
        if (ms <= 0) return '0s';
        const s = Math.floor(ms / 1000);
        const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
        let parts = [];
        if (d > 0) parts.push(d + 'd');
        if (h > 0) parts.push(h + 'h');
        if (m > 0) parts.push(m + 'm');
        if (sec > 0 || parts.length === 0) parts.push(sec + 's');
        return parts.join(' ');
    }

    function formatWallClock(ts) {
        return new Date(ts).toISOString().split('T')[1].slice(0, 8);
    }

    function isFactionProfilePage() { return /\/factions\.php\?step=profile/i.test(window.location.href); }
    function getCurrentFactionIdFromUrl() { return new URLSearchParams(window.location.search).get('ID'); }

    function scrapeFactionNameFromPage() {
        const el = document.querySelector('.title-black.hospital-dark.top-round.m-top10');
        if (!el) return null;
        const clone = el.cloneNode(true);
        const respect = clone.querySelector('.bold.f-title-respect');
        if (respect) respect.remove();
        const t = clone.textContent.trim().replace(/\s+/g, ' ').trim();
        return t.length > 0 && t.length < 100 ? t : null;
    }

    function requestNotificationPermission() {
        if (Notification.permission === 'default') Notification.requestPermission();
    }
    function sendBrowserNotification(title, body) {
        if (Notification.permission === 'granted') new Notification(title, { body, icon: 'https://www.torn.com/favicon.ico' });
    }

    // ==================== PERSONAL TBS ====================
    async function fetchMyOwnTBS() {
        const key = state.personalApiKey;
        if (!key) return;

        const myId = getMyTornUserId();
        if (!myId) return;

        return new Promise(resolve => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: `https://ffscouter.com/api/v1/get-stats?key=${encodeURIComponent(key)}&targets=${myId}`,
                onload: r => {
                    try {
                        const data = JSON.parse(r.responseText);
                        if (Array.isArray(data) && data[0] && data[0].bs_estimate) {
                            myBattleStats = data[0].bs_estimate;
                            console.log('[TBS] Personal from FFScouter:', formatBS(myBattleStats));
                            resolve();
                            return;
                        }
                    } catch (e) {}
                    GM_xmlhttpRequest({
                        method: 'GET',
                        url: `https://api.torn.com/user/?selections=battlestats&key=${encodeURIComponent(key)}`,
                        onload: r2 => {
                            try {
                                const j = JSON.parse(r2.responseText);
                                if (j.strength && j.defense && j.speed && j.dexterity) {
                                    const bss = Math.sqrt(j.strength) + Math.sqrt(j.defense) + Math.sqrt(j.speed) + Math.sqrt(j.dexterity);
                                    myBattleStats = Math.round(bss * bss * 0.85);
                                    console.log('[TBS] Approximate from Torn:', formatBS(myBattleStats));
                                }
                            } catch (e) {}
                            resolve();
                        },
                        onerror: () => resolve()
                    });
                },
                onerror: () => resolve()
            });
        });
    }

    // ==================== DATA FETCHING ====================
    function serverRequest(method, path, data) {
        return new Promise((resolve, reject) => {
            const opts = {
                method,
                url: LOCAL_SERVER + path,
                headers: { 'Accept': 'application/json' },
                onload: (r) => {
                    if (r.status >= 200 && r.status < 300) {
                        try { resolve(JSON.parse(r.responseText)); } catch (e) { resolve({}); }
                    } else reject(new Error('HTTP ' + r.status));
                },
                onerror: reject
            };
            if (data) {
                opts.headers['Content-Type'] = 'application/json';
                opts.data = JSON.stringify(data);
            }
            GM_xmlhttpRequest(opts);
        });
    }

    function fetchFromGist() {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: GIST_RAW_URL + '?t=' + Date.now(),
                onload: (r) => {
                    try {
                        const data = JSON.parse(r.responseText);
                        data.apiKeySet = true;
                        data.myUserID = data.myUserID || getMyTornUserId();
                        data.myFactionID = data.myFactionID || null;
                        data.myFactionName = data.myFactionName || null;
                        data.myDestination = data.myDestination || null;
                        data.myTravelArrival = data.myTravelArrival || null;
                        data.factions = data.factions || {};
                        resolve(data);
                    } catch (e) {
                        reject(e);
                    }
                },
                onerror: reject
            });
        });
    }

    async function fetchState() {
        try {
            const data = await serverRequest('GET', '/api/state');
            usingLocal = true;
            return data;
        } catch (e) {
            usingLocal = false;
        }
        try {
            return await fetchFromGist();
        } catch (e) {
            throw new Error('Both local and Gist failed');
        }
    }

    function detectNewFlights(currentFactions) {
        for (const fid in currentFactions) {
            const currM = currentFactions[fid]?.members || {};
            const prevM = state.previousMembers[fid] || {};
            for (const xid in currM) {
                const c = currM[xid], p = prevM[xid];
                if (c && c.status === 'traveling' && (!p || p.status !== 'traveling')) {
                    const key = fid + ':' + xid + ':' + c.destination + ':' + c.travelStarted;
                    if (!state.notifiedFlights[key]) {
                        state.notifiedFlights[key] = true;
                        if (Object.keys(state.notifiedFlights).length > 100) {
                            const cut = Date.now() - 86400000;
                            for (const k in state.notifiedFlights) {
                                if (parseInt(k.split(':')[3]) < cut) delete state.notifiedFlights[k];
                            }
                        }
                        if (c.sameDestination) {
                            sendBrowserNotification('Enemy inbound!', c.playerName + ' flying to ' + c.destination);
                        }
                    }
                }
            }
        }
    }

    async function pollServer() {
        try {
            const data = await fetchState();

            state.apiKeySet = data.apiKeySet;
            state.myUserID = data.myUserID;
            state.myDestination = data.myDestination;
            state.myFactionID = data.myFactionID || null;
            state.myFactionName = data.myFactionName || null;
            state.myTravelArrival = data.myTravelArrival || null;
            state.lastPollTime = Date.now();
            state.serverOnline = true;

            if (data.factions) {
                state.watchedFactions = {};
                for (const fid in data.factions) {
                    state.watchedFactions[fid] = {
                        name: data.factions[fid].name || 'Faction ' + fid,
                        members: data.factions[fid].members || {}
                    };
                }
            }

            if (data.myBattleStats) {
                myBattleStats = data.myBattleStats;
            } else if (state.personalApiKey && !myBattleStats) {
                fetchMyOwnTBS();
            } else {
                const myId = getMyTornUserId();
                if (myId) {
                    for (const fid in state.watchedFactions) {
                        const m = state.watchedFactions[fid].members[myId];
                        if (m && m.tbs != null) {
                            myBattleStats = m.tbs;
                            break;
                        }
                    }
                }
            }

            if (usingLocal && state.apiKeySet && state.myFactionID) {
                if (!state.watchedFactions[state.myFactionID]) {
                    try {
                        await serverRequest('POST', '/api/watch', {
                            fid: state.myFactionID,
                            name: state.myFactionName || 'Faction ' + state.myFactionID
                        });
                    } catch (e) {}
                }
            }

            detectNewFlights(state.watchedFactions);
            state.previousMembers = {};
            for (const fid in state.watchedFactions) {
                state.previousMembers[fid] = JSON.parse(JSON.stringify(state.watchedFactions[fid]?.members || {}));
            }

            const dot = document.getElementById('travel-tracker-status');
            if (dot) {
                if (!state.serverOnline) dot.className = 'tt-dot tt-dot--offline';
                else if (usingLocal) dot.className = 'tt-dot tt-dot--online';
                else dot.className = 'tt-dot tt-dot--gist';
            }
        } catch (e) {
            state.serverOnline = false;
            const dot = document.getElementById('travel-tracker-status');
            if (dot) dot.className = 'tt-dot tt-dot--offline';
        }
    }

    function startPolling() {
        if (pollTimer) clearInterval(pollTimer);
        const interval = usingLocal ? POLL_INTERVAL_LOCAL : POLL_INTERVAL_GIST;
        pollTimer = setInterval(pollServer, interval);
    }

    // ==================== UI ACTIONS ====================
    function promptForApiKey() {
        const key = prompt('Enter Torn API key (stored on local server only):', '');
        if (key && key.trim()) {
            serverRequest('POST', '/api/apikey', { key: key.trim() })
                .then(() => alert('Saved on server!'))
                .catch(e => alert(e.message));
        }
        return !!key;
    }

    function promptForPersonalKey() {
        const key = prompt('Optional: Your personal Torn API key for accurate TBS colouring (stored only in this browser):', state.personalApiKey || '');
        if (key !== null) {
            state.personalApiKey = key.trim();
            GM_setValue('personalApiKey', state.personalApiKey);
            if (state.personalApiKey) {
                fetchMyOwnTBS().then(() => { if (state.panelVisible) updatePanelContent(); });
            } else {
                myBattleStats = null;
            }
            alert(state.personalApiKey ? 'Personal key saved (local only)' : 'Personal key cleared');
        }
    }

    async function addFactionToWatch(fid) {
        if (!usingLocal) {
            alert('Watching factions only works when connected to the local Termux server.');
            return;
        }
        if (!state.apiKeySet) {
            if (!promptForApiKey()) return;
            await new Promise(r => setTimeout(r, 1500));
        }
        const name = scrapeFactionNameFromPage() || ('Faction ' + fid);
        try {
            await serverRequest('POST', '/api/watch', { fid, name });
            state.selectedFactionId = fid;
            if (!state.panelVisible) createPanel();
            else updatePanelContent();
        } catch (e) {
            alert('Failed: ' + e.message);
        }
    }

    function removeWatchedFaction(fid) {
        if (!usingLocal) return;
        if (fid === state.myFactionID) return;
        serverRequest('DELETE', '/api/watch/' + fid).then(() => {
            if (state.selectedFactionId === fid) state.selectedFactionId = null;
            state.warFactions.delete(fid);
            updatePanelContent();
        });
    }

    function toggleWarFaction(fid) {
        if (state.warFactions.has(fid)) state.warFactions.delete(fid);
        else state.warFactions.add(fid);
        GM_setValue('warFactions', JSON.stringify([...state.warFactions]));
        updatePanelContent();
    }

    function detectWarFactionsFromPage() {
        if (window.location.href.includes('war.php') || window.location.href.includes('factions.php?step=war')) {
            document.querySelectorAll('.war-status, .war-declare, .faction-war').forEach(el => {
                const factionLink = el.querySelector('a[href*="factions.php?step=profile&ID="]');
                if (factionLink) {
                    const fid = new URLSearchParams(factionLink.href.split('?')[1]).get('ID');
                    if (fid && !state.warFactions.has(fid)) {
                        state.warFactions.add(fid);
                        GM_setValue('warFactions', JSON.stringify([...state.warFactions]));
                    }
                }
            });
        }
    }

    // ==================== FLOATING ICON (mobile) ====================
    function injectFloatingIcon() {
        if (document.getElementById('travel-float-icon')) return;
        const icon = document.createElement('div');
        icon.id = 'travel-float-icon';
        Object.assign(icon.style, {
            position: 'fixed',
            bottom: '16px',
            right: '16px',
            width: '48px',
            height: '48px',
            borderRadius: '50%',
            background: 'radial-gradient(circle at 30% 0, rgba(255,255,255,0.2), transparent 55%), rgba(18,18,18,0.92)',
            border: '1px solid rgba(255,255,255,0.15)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            zIndex: '100000',
            color: '#fff',
            fontSize: '24px',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            transition: 'transform 0.15s ease-out, box-shadow 0.15s ease-out',
            userSelect: 'none',
            WebkitTapHighlightColor: 'transparent'
        });
        icon.innerHTML = '<span style="font-size:20px;line-height:1;">✈️</span>';
        const dot = document.createElement('div');
        dot.id = 'travel-tracker-status';
        dot.className = 'tt-dot tt-dot--offline';
        dot.style.cssText = 'position:absolute; top:4px; right:8px; width:10px; height:10px; border-radius:50%; border:1px solid #000;';
        icon.appendChild(dot);
        icon.addEventListener('click', () => {
            if (state.panelVisible) closePanel();
            else { state.selectedFactionId = null; createPanel(); }
        });
        icon.addEventListener('contextmenu', e => {
            e.preventDefault();
            promptForPersonalKey();
        });
        document.body.appendChild(icon);
    }

    // ==================== STYLES (mobile-first) ====================
    function injectGlobalStyles() {
        if (document.getElementById('travel-tracker-global-styles')) return;
        const style = document.createElement('style');
        style.id = 'travel-tracker-global-styles';
        style.textContent = `
      :root {
        --tt-bg-elevated: rgba(18,18,18,0.94);
        --tt-bg-card: rgba(32,32,32,0.96);
        --tt-bg-card-soft: rgba(40,40,40,0.9);
        --tt-border-subtle: rgba(255,255,255,0.08);
        --tt-border-strong: rgba(255,255,255,0.2);
        --tt-accent: #2196F3;
        --tt-accent-soft: rgba(33,150,243,0.2);
        --tt-success: #4CAF50;
        --tt-warning: #FFB300;
        --tt-danger: #EF5350;
        --tt-purple: #9C27B0;
        --tt-text-main: #F5F5F5;
        --tt-text-muted: #B0B0B0;
        --tt-text-soft: #888;
        --tt-radius-lg: 18px;
        --tt-radius-md: 12px;
        --tt-radius-sm: 8px;
        --tt-shadow-strong: 0 -10px 30px rgba(0,0,0,0.8);
        --tt-shadow-soft: 0 4px 12px rgba(0,0,0,0.5);
        --tt-transition-fast: 0.18s ease-out;
        --tt-transition-med: 0.25s cubic-bezier(0.2,0.8,0.2,1);
      }
      #travel-float-icon { -webkit-tap-highlight-color: transparent; }
      .tt-panel { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
      .tt-scrollbar::-webkit-scrollbar { width: 4px; }
      .tt-scrollbar::-webkit-scrollbar-track { background: transparent; }
      .tt-scrollbar::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 2px; }
      .tt-chip { display: inline-flex; align-items: center; gap: 4px; padding: 3px 10px; border-radius: 999px; font-size: 11px; font-weight: 600; letter-spacing: 0.02em; text-transform: uppercase; }
      .tt-chip-soft { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.08); color: var(--tt-text-soft); }
      .tt-chip-accent { background: var(--tt-accent-soft); border: 1px solid rgba(33,150,243,0.5); color: #E3F2FD; }
      .tt-chip-success { background: rgba(76,175,80,0.15); border: 1px solid rgba(76,175,80,0.5); color: #C8E6C9; }
      .tt-chip-warning { background: rgba(255,179,0,0.15); border: 1px solid rgba(255,179,0,0.6); color: #FFE082; }
      .tt-chip-danger { background: rgba(239,83,80,0.15); border: 1px solid rgba(239,83,80,0.6); color: #FFCDD2; }
      .tt-chip-purple { background: rgba(156,39,176,0.15); border: 1px solid rgba(156,39,176,0.6); color: #E1BEE7; }
      .tt-tab-row { display: flex; gap: 4px; padding: 3px; background: rgba(255,255,255,0.04); border-radius: 999px; border: 1px solid rgba(255,255,255,0.06); flex:1; }
      .tt-tab { flex: 1; border-radius: 999px; padding: 8px 4px; font-size: 12px; font-weight: 600; text-align: center; cursor: pointer; color: var(--tt-text-soft); border: none; background: transparent; transition: background var(--tt-transition-fast), color var(--tt-transition-fast); touch-action: manipulation; }
      .tt-tab.tt-active { background: rgba(255,255,255,0.1); color: var(--tt-text-main); }
      .tt-tab.tt-danger { color: var(--tt-danger); }
      .tt-tab.tt-danger.tt-active { background: rgba(239,83,80,0.25); color: #FFCDD2; }
      .tt-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .tt-row-gap { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
      .tt-member-card { position: relative; overflow: hidden; background: var(--tt-bg-card); border-radius: var(--tt-radius-md); border: 1px solid var(--tt-border-subtle); padding: 12px 14px; margin-bottom: 8px; box-shadow: var(--tt-shadow-soft); cursor: pointer; touch-action: manipulation; }
      .tt-member-card--same-dest { border-color: rgba(183,28,28,0.9); box-shadow: 0 0 0 1px rgba(183,28,28,0.5), var(--tt-shadow-soft); background: radial-gradient(circle at 0 0, rgba(183,28,28,0.25), transparent 55%), var(--tt-bg-card); }
      .tt-member-card--self { border-color: #FFD700; box-shadow: 0 0 12px #FFD70040, 0 0 0 1px rgba(255,215,0,0.5), var(--tt-shadow-soft); }
      .tt-member-main { display: flex; justify-content: space-between; align-items: center; gap: 6px; }
      .tt-member-name { font-size: 15px; font-weight: 600; color: var(--tt-text-main); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 55%; }
      .tt-member-name a { color: inherit; text-decoration: none; }
      .tt-member-name a:active { opacity:0.7; }
      .tt-member-route { font-size: 13px; color: var(--tt-text-muted); text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 45%; }
      .tt-member-meta { display: flex; justify-content: space-between; align-items: center; margin-top: 6px; font-size: 12px; color: var(--tt-text-soft); flex-wrap: wrap; gap: 4px; }
      .tt-progress-shell-new { margin-top: 8px; }
      .tt-progress-flags-row { display: flex; align-items: center; gap: 8px; justify-content: center; }
      .tt-circular-flag img { width: 28px; height: 28px; border-radius: 50%; border: 1px solid rgba(255,255,255,0.2); background: #1a1a1a; display: block; }
      .tt-progress-track-new { position: relative; flex: 1; height: 8px; background: rgba(255,255,255,0.08); border-radius: 999px; overflow: visible; max-width: 100%; }
      .tt-progress-fill-new { position: absolute; top: 0; height: 100%; border-radius: 999px; transition: width 1s linear, background 0.2s; }
      .tt-progress-plane-new { position: absolute; top: 50%; font-size: 16px; filter: drop-shadow(0 1px 3px rgba(0,0,0,0.8)); transition: left 1s linear, transform 0.2s; pointer-events: none; z-index: 1; transform: translate(-50%, -50%) rotate(45deg); }
      .tt-progress-ghost-fill { position: absolute; top: 0; height: 100%; border-radius: 999px; background: rgba(255,0,0,0.2); transition: width 1s linear, left 1s linear; opacity: 0.6; pointer-events: none; z-index: 0; }
      .tt-progress-ghost-plane { position: absolute; top: 50%; font-size: 14px; filter: drop-shadow(0 1px 2px rgba(0,0,0,0.3)); transition: left 1s linear, transform 0.2s; pointer-events: none; z-index: 0; opacity: 0.35; transform: translate(-50%, -50%) rotate(45deg); color: #ff4444; }
      .tt-section-title { font-size: 14px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: var(--tt-text-soft); }
      .tt-faction-card { background: var(--tt-bg-card-soft); border-radius: var(--tt-radius-md); border: 1px solid var(--tt-border-subtle); padding: 14px 16px; margin-bottom: 8px; cursor: pointer; transition: background var(--tt-transition-fast), border-color var(--tt-transition-fast); box-shadow: var(--tt-shadow-soft); display: flex; justify-content: space-between; align-items: center; touch-action: manipulation; }
      .tt-faction-card:active { opacity:0.7; }
      .tt-faction-name { font-size: 15px; font-weight: 600; color: var(--tt-text-main); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .tt-faction-sub { font-size: 12px; color: var(--tt-text-soft); margin-top: 2px; }
      .tt-kbd { display: inline-flex; align-items: center; justify-content: center; padding: 2px 6px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.15); font-size: 10px; font-family: monospace; background: rgba(0,0,0,0.4); color: var(--tt-text-soft); }
      .tt-footer { position: sticky; bottom: -16px; margin: 12px -16px -18px -16px; padding: 12px 16px 18px 16px; background: linear-gradient(to top, rgba(0,0,0,0.9), transparent); display: flex; justify-content: space-between; align-items: center; font-size: 11px; color: var(--tt-text-soft); }
      .tt-dot { width: 10px; height: 10px; border-radius: 50%; border: 1px solid #000; }
      .tt-dot--online { background: var(--tt-success); }
      .tt-dot--offline { background: var(--tt-danger); }
      .tt-dot--apikey { background: var(--tt-warning); }
      .tt-dot--gist { background: #9C27B0; }
      .tt-watch-btn { background: none; border: 1px solid rgba(255,255,255,0.15); border-radius: 999px; color: #fff; cursor: pointer; padding: 8px 14px; font-size: 13px; font-weight: 600; touch-action: manipulation; }
      .tt-watch-btn--active { background: rgba(76,175,80,0.25); border-color: rgba(76,175,80,0.6); }
      .tt-watch-btn:active { opacity:0.6; }
      .tt-war-toggle { font-size: 11px; padding: 6px 12px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.2); background: rgba(255,255,255,0.05); color: var(--tt-text-soft); cursor: pointer; touch-action: manipulation; }
      .tt-war-toggle.active { background: rgba(239,83,80,0.25); border-color: rgba(239,83,80,0.8); color: #FFCDD2; }
      .tt-war-toggle:active { opacity:0.6; }
      .tt-copy-all-btn { background: rgba(255,215,0,0.15); border: 1px solid rgba(255,215,0,0.5); border-radius: 50%; color: #FFE082; font-size: 20px; width: 44px; height: 44px; padding: 0; cursor: pointer; display: flex; align-items: center; justify-content: center; touch-action: manipulation; }
      .tt-copy-all-btn:active { opacity:0.6; }
      .tt-danger-group { background: var(--tt-bg-card); border-radius: var(--tt-radius-md); border: 1px solid var(--tt-border-subtle); margin-bottom: 10px; overflow: hidden; box-shadow: var(--tt-shadow-soft); }
      .tt-danger-header { display: flex; justify-content: space-between; align-items: center; padding: 14px 16px; background: rgba(239,83,80,0.15); border-bottom: 1px solid var(--tt-border-strong); cursor: pointer; font-weight: 700; font-size: 14px; color: #FFCDD2; touch-action: manipulation; }
      .tt-danger-body { padding: 10px 14px; }
      .tt-danger-group.collapsed .tt-danger-body { display: none; }
      .tt-danger-subtitle { font-weight: 700; font-size: 12px; text-transform: uppercase; color: var(--tt-text-soft); margin: 6px 0; }
      .tt-danger-item { display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,0.04); font-size: 13px; color: var(--tt-text-muted); }
      .tt-danger-item:last-child { border-bottom: none; }
      .tt-danger-item .bs { font-size: 11px; color: var(--tt-text-soft); margin-left: 6px; }
      .tt-danger-item .eta { font-size: 12px; color: var(--tt-text-soft); }
    `;
        document.head.appendChild(style);
    }

    // ==================== PANEL (mobile) ====================
    function createPanel() {
        if (document.getElementById('travel-panel')) { closePanel(); return; }
        const overlay = document.createElement('div');
        overlay.id = 'travel-panel-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.3);z-index:9998;';
        overlay.addEventListener('click', closePanel);
        document.body.appendChild(overlay);

        const panel = document.createElement('div');
        panel.id = 'travel-panel';
        panel.className = 'tt-panel tt-scrollbar';
        panel.style.cssText = `
      position:fixed;left:0;bottom:0;width:100vw;max-height:85vh;
      background:var(--tt-bg-elevated);
      backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);
      border-radius:var(--tt-radius-lg) var(--tt-radius-lg) 0 0;
      box-shadow:var(--tt-shadow-strong);
      padding:16px 16px 20px 16px;z-index:999999;
      color:var(--tt-text-main);display:flex;flex-direction:column;box-sizing:border-box;
      overflow-y:auto;transition:transform var(--tt-transition-med);
      transform:translateY(100%);
    `;
        panel.addEventListener('click', e => e.stopPropagation());
        document.body.appendChild(panel);
        requestAnimationFrame(() => { panel.style.transform = 'translateY(0)'; });
        state.panelVisible = true;
        updatePanelContent();
        startPanelInterval();
    }

    function closePanel() {
        const panel = document.getElementById('travel-panel');
        if (!panel) return;
        panel.style.transform = 'translateY(100%)';
        panel.addEventListener('transitionend', function h() {
            panel.removeEventListener('transitionend', h);
            panel.remove();
        });
        const overlay = document.getElementById('travel-panel-overlay');
        if (overlay) overlay.remove();
        state.panelVisible = false;
        state.selectedFactionId = null;
        if (state.panelInterval) { clearInterval(state.panelInterval); state.panelInterval = null; }
    }

    function startPanelInterval() {
        if (state.panelInterval) clearInterval(state.panelInterval);
        state.panelInterval = setInterval(() => {
            if (state.panelVisible) updatePanelContent();
            else { clearInterval(state.panelInterval); state.panelInterval = null; }
        }, PANEL_UPDATE_INTERVAL);
    }

    // ==================== DANGER ZONES ====================
    function renderDangerZones(fid) {
        const now = Date.now();
        const ownFaction = state.watchedFactions[fid];
        if (!ownFaction) return '<div>No data</div>';

        const enemies = [];
        for (const efid of state.warFactions) {
            if (efid === fid) continue;
            const ef = state.watchedFactions[efid];
            if (!ef) continue;
            for (const xid in ef.members) {
                const m = ef.members[xid];
                if (m.status === 'traveling' && m.destination !== 'Torn') {
                    enemies.push({ ...m, xid, factionName: ef.name });
                }
            }
        }

        const zones = {};
        for (const xid in ownFaction.members) {
            const m = ownFaction.members[xid];
            if (m.status !== 'traveling' || m.destination === 'Torn') continue;
            const dest = m.destination;
            if (!zones[dest]) zones[dest] = { friendlies: [], foes: [] };
            zones[dest].friendlies.push({ ...m, xid });
        }
        for (const e of enemies) {
            if (zones[e.destination]) zones[e.destination].foes.push(e);
        }

        const dangerKeys = Object.keys(zones).filter(d => zones[d].foes.length > 0);
        if (dangerKeys.length === 0) {
            return '<div style="padding:16px;border-radius:var(--tt-radius-md);border:1px dashed rgba(255,255,255,0.15);text-align:center;font-size:13px;color:var(--tt-text-soft);">No immediate threats detected.</div>';
        }

        dangerKeys.sort();
        let html = '';
        for (const dest of dangerKeys) {
            const zone = zones[dest];
            const flagEmoji = FLAG_EMOJI[dest] || '';
            html += `<div class="tt-danger-group" data-dest="${escapeHtml(dest)}">
                <div class="tt-danger-header">
                    <span>⚠️ AT RISK ${flagEmoji} ${escapeHtml(dest)}</span>
                    <span class="collapse-icon">▼</span>
                </div>
                <div class="tt-danger-body">
                    <div class="tt-danger-subtitle">👥 Your Faction (${zone.friendlies.length})</div>`;
            zone.friendlies.sort((a, b) => {
                const aETA = a.travelStarted + getFastestDuration(a.lookupDest, a.flightType) * 60000 - DETECT_DELAY;
                const bETA = b.travelStarted + getFastestDuration(b.lookupDest, b.flightType) * 60000 - DETECT_DELAY;
                return aETA - bETA;
            });
            for (const m of zone.friendlies) {
                const bs = m.tbs || m.bs_estimate || null;
                const bsStr = bs ? formatBS(bs) : 'N/A';
                const fastestDur = getFastestDuration(m.lookupDest, m.flightType);
                const fastestETA = m.travelStarted + fastestDur * 60000 - DETECT_DELAY;
                const rem = Math.max(0, fastestETA - now);
                const etaDisplay = rem <= 0 ? 'Landing' : formatTime(rem);
                html += `<div class="tt-danger-item">
                    <span><a href="/profiles.php?XID=${m.xid}" target="_blank" style="color:var(--tt-text-main);text-decoration:none;">${escapeHtml(m.playerName)}</a> <span class="bs">⚔ ${bsStr}</span></span>
                    <span class="eta">${etaDisplay}</span>
                </div>`;
            }
            html += `<div class="tt-danger-subtitle">☠️ Enemy Inbound (${zone.foes.length})</div>`;
            zone.foes.sort((a, b) => {
                const aETA = a.travelStarted + getFastestDuration(a.lookupDest, a.flightType) * 60000 - DETECT_DELAY;
                const bETA = b.travelStarted + getFastestDuration(b.lookupDest, b.flightType) * 60000 - DETECT_DELAY;
                return aETA - bETA;
            });
            for (const e of zone.foes) {
                const bs = e.tbs || e.bs_estimate || null;
                const bsStr = bs ? formatBS(bs) : 'N/A';
                const fastestDur = getFastestDuration(e.lookupDest, e.flightType);
                const fastestETA = e.travelStarted + fastestDur * 60000 - DETECT_DELAY;
                const rem = Math.max(0, fastestETA - now);
                const etaDisplay = rem <= 0 ? 'Landing' : formatTime(rem);
                html += `<div class="tt-danger-item">
                    <span><a href="/profiles.php?XID=${e.xid}" target="_blank" style="color:var(--tt-text-main);text-decoration:none;">${escapeHtml(e.playerName)}</a> <span class="bs">⚔ ${bsStr}</span></span>
                    <span class="eta">${etaDisplay}</span>
                </div>`;
            }
            html += `</div></div>`;
        }
        return html;
    }

    // ==================== MAIN RENDER (mobile) ====================
    function updatePanelContent() {
        const panel = document.getElementById('travel-panel');
        if (!panel) return;

        if (!state.serverOnline) {
            panel.innerHTML = `<div style="text-align:center;padding:32px 16px;"><div style="font-size:40px;">⚠️</div><div style="font-weight:700;font-size:18px;margin:8px 0;">Server offline</div><div style="font-size:14px;color:var(--tt-text-soft);">Local server not reachable – trying Gist…</div><button id="retry-poll" style="margin-top:16px;padding:12px 24px;border-radius:999px;border:none;background:var(--tt-accent);color:#fff;font-size:16px;font-weight:600;cursor:pointer;">Retry</button></div>`;
            document.getElementById('retry-poll')?.addEventListener('click', () => pollServer().then(updatePanelContent));
            return;
        }

        if (!state.apiKeySet && usingLocal) {
            panel.innerHTML = `<div style="text-align:center;padding:32px 16px;"><div style="font-size:40px;">🔑</div><div style="font-weight:700;font-size:18px;margin:8px 0;">API key required</div><div style="font-size:14px;color:var(--tt-text-soft);">Stored on local server only</div><button id="set-api-key" style="margin-top:16px;padding:12px 24px;border-radius:999px;border:none;background:var(--tt-accent);color:#fff;font-size:16px;font-weight:600;cursor:pointer;">Set API key</button></div>`;
            document.getElementById('set-api-key')?.addEventListener('click', promptForApiKey);
            return;
        }

        const fids = Object.keys(state.watchedFactions);
        const isOwnFactionSelected = state.selectedFactionId && state.selectedFactionId === state.myFactionID;

        let tabsHtml = '';
        if (state.selectedFactionId) {
            let tabItems = `
                <button class="tt-tab ${state.activeTab==='all'?'tt-active':''}" data-tab="all">All</button>
                <button class="tt-tab ${state.activeTab==='outbound'?'tt-active':''}" data-tab="outbound">Out</button>
                <button class="tt-tab ${state.activeTab==='return'?'tt-active':''}" data-tab="return">Return</button>
            `;
            if (isOwnFactionSelected) {
                tabItems += `<button class="tt-tab tt-danger ${state.activeTab==='danger'?'tt-active':''}" data-tab="danger">⚠️ Danger</button>`;
            }
            tabsHtml = `<div class="tt-tab-row">${tabItems}</div>`;
        }

        const copyAllBtnHtml = state.selectedFactionId
            ? `<button id="tt-copy-all-btn" class="tt-copy-all-btn" title="Copy all flights as text">📋</button>`
            : '';

        const modeLabel = usingLocal ? 'Local' : 'Gist';
        const headerHtml = `
      <div style="position:sticky;top:-16px;margin:-16px -16px 10px;padding:12px 16px 10px;background:linear-gradient(to bottom,rgba(0,0,0,0.96),rgba(0,0,0,0.7));z-index:3;border-radius:var(--tt-radius-lg) var(--tt-radius-lg) 0 0;">
        <div class="tt-row">
          <div class="tt-row-gap"><span style="font-size:22px;">✈️</span><div><div style="font-size:16px;font-weight:700;">Travel tracker</div><div style="font-size:12px;color:var(--tt-text-soft);">${fids.length} faction${fids.length!==1?'s':''} • ${modeLabel}</div></div></div>
          <div style="display:flex; gap:8px; align-items:center;">
            ${copyAllBtnHtml}
            <button id="tt-close-panel" style="background:none;border:none;color:var(--tt-text-soft);font-size:24px;cursor:pointer;padding:4px;touch-action:manipulation;">✕</button>
          </div>
        </div>
        <div style="margin-top:10px;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
          ${tabsHtml}
          <div class="tt-chip tt-chip-soft"><span class="tt-dot ${usingLocal?'tt-dot--online':'tt-dot--gist'}"></span><span style="margin-left:6px;font-size:11px;"> ${modeLabel}</span></div>
        </div>
      </div>`;

        let bodyHtml;
        if (state.selectedFactionId && state.watchedFactions[state.selectedFactionId]) {
            if (state.activeTab === 'danger' && state.selectedFactionId === state.myFactionID) {
                bodyHtml = `<div style="margin-top:4px;">
                    <div class="tt-row" style="margin-bottom:8px;">
                        <button id="tt-back-to-list" style="background:none;border:none;color:var(--tt-text-soft);cursor:pointer;display:flex;align-items:center;gap:6px;font-size:16px;touch-action:manipulation;"><span style="font-size:20px;">←</span><span>Factions</span></button>
                        <div style="text-align:right;"><div style="font-size:16px;font-weight:700;">Danger Zones</div></div>
                    </div>
                    ${renderDangerZones(state.selectedFactionId)}
                </div>`;
            } else {
                bodyHtml = renderFactionMembers(state.selectedFactionId);
            }
        } else {
            bodyHtml = renderFactionList();
        }

        panel.innerHTML = headerHtml + bodyHtml + `<div class="tt-footer"><div><span style="font-weight:600;">Legend</span><span style="margin-left:6px;font-size:11px;"><span style="color:var(--tt-accent);">■</span> Out <span style="color:var(--tt-purple);margin-left:6px;">■</span> Return <span style="color:var(--tt-warning);margin-left:6px;">■</span> Landing</span></div><div><span class="tt-kbd">v17.1</span><span style="margin-left:6px;font-size:11px;">FF BS</span></div></div>`;

        // Event listeners
        document.getElementById('tt-close-panel')?.addEventListener('click', closePanel);

        const copyAllBtn = document.getElementById('tt-copy-all-btn');
        if (copyAllBtn) {
            copyAllBtn.addEventListener('click', () => {
                if (!state.selectedFactionId || !state.watchedFactions[state.selectedFactionId]) return;
                const fid = state.selectedFactionId;
                const f = state.watchedFactions[fid];
                const members = f.members || {};
                const now = Date.now();
                const flying = [];
                for (const xid in members) {
                    const m = members[xid];
                    if (m.status !== 'traveling') continue;
                    m.xid = xid;
                    flying.push(m);
                }
                flying.sort((a, b) => {
                    const aETA = a.travelStarted + getFastestDuration(a.lookupDest, a.flightType) * 60000 - DETECT_DELAY;
                    const bETA = b.travelStarted + getFastestDuration(b.lookupDest, b.flightType) * 60000 - DETECT_DELAY;
                    return aETA - bETA;
                });
                if (flying.length === 0) { alert('No traveling members to copy.'); return; }
                let text = `Travel Tracker Report – ${f.name}\n`;
                const outCount = flying.filter(m => m.destination !== 'Torn').length;
                const retCount = flying.filter(m => m.destination === 'Torn').length;
                text += `Out: ${outCount}  Return: ${retCount}  Total flying: ${flying.length}\n\n`;
                flying.forEach((m, idx) => {
                    const isYou = (m.xid === String(state.myUserID));
                    const fastestDur = getFastestDuration(m.lookupDest, m.flightType);
                    let fastestETA;
                    if (isYou && state.myTravelArrival) {
                        fastestETA = now + Math.max(0, state.myTravelArrival - now);
                    } else {
                        fastestETA = m.travelStarted + fastestDur * 60000 - DETECT_DELAY;
                    }
                    const fastestRem = Math.max(0, fastestETA - now);
                    const isLanding = fastestRem <= 0;
                    const elapsed = now - m.travelStarted;
                    const bs = m.tbs || m.bs_estimate || null;
                    const bsFormatted = bs ? formatBS(bs) : null;
                    const flightTypeLabel = m.flightType || 'Flight';
                    text += `${idx+1}. ✈️ ${m.playerName} → ${FLAG_EMOJI[m.destination] || ''} ${m.destination}\n`;
                    if (bsFormatted) text += `   BS: ${bsFormatted} | Flight: ${flightTypeLabel}\n`;
                    else text += `   Flight: ${flightTypeLabel}\n`;
                    text += `   Flying for ${formatElapsed(elapsed)}\n`;
                    if (isLanding) text += `   Earliest: Landing\n   ETA: Landing\n`;
                    else text += `   Earliest: ${formatTime(fastestRem)}\n   ETA: ${formatWallClock(fastestETA)}\n`;
                    text += '\n';
                });
                navigator.clipboard.writeText(text).then(() => {
                    const btn = document.getElementById('tt-copy-all-btn');
                    if (btn) { btn.style.background = 'rgba(255,215,0,0.4)'; setTimeout(() => btn.style.background = '', 500); }
                }).catch(() => alert('Failed to copy'));
            });
        }

        panel.querySelectorAll('.tt-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const t = tab.dataset.tab;
                if (t && t !== state.activeTab) { state.activeTab = t; updatePanelContent(); }
            });
        });

        panel.querySelectorAll('.tt-danger-header').forEach(header => {
            header.addEventListener('click', function (e) {
                e.stopPropagation();
                const group = this.closest('.tt-danger-group');
                if (group) {
                    group.classList.toggle('collapsed');
                    const icon = this.querySelector('.collapse-icon');
                    if (icon) icon.textContent = group.classList.contains('collapsed') ? '▶' : '▼';
                }
            });
        });

        panel.querySelectorAll('.tt-faction-card').forEach(card => {
            card.addEventListener('click', (e) => {
                if (e.target.closest('.tt-war-toggle') || e.target.closest('.tt-watch-btn')) return;
                state.selectedFactionId = card.dataset.fid;
                updatePanelContent();
            });
        });

        document.getElementById('tt-back-to-list')?.addEventListener('click', () => {
            state.selectedFactionId = null;
            updatePanelContent();
        });

        document.getElementById('tt-stop-watch-faction')?.addEventListener('click', (e) => {
            const fid = e.target.dataset.fid;
            if (fid) removeWatchedFaction(fid);
        });

        const watchBtn = document.getElementById('tt-watch-faction-header');
        if (watchBtn) {
            watchBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const currentFid = getCurrentFactionIdFromUrl();
                if (!currentFid) return;
                if (currentFid === state.myFactionID) return;
                if (state.watchedFactions[currentFid]) removeWatchedFaction(currentFid);
                else await addFactionToWatch(currentFid);
                updatePanelContent();
            });
        }

        panel.querySelectorAll('.tt-war-toggle').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                const fid = btn.dataset.fid;
                toggleWarFaction(fid);
                updatePanelContent();
            });
        });

        panel.querySelectorAll('.tt-member-card').forEach(card => {
            card.addEventListener('click', function (e) {
                if (e.target.closest('a') || e.target.closest('button') || e.target.closest('input')) return;
                const text = this.dataset.clipText;
                if (text) {
                    navigator.clipboard.writeText(text).then(() => {
                        const orig = this.style.borderColor;
                        this.style.borderColor = '#FFD700';
                        setTimeout(() => this.style.borderColor = orig || '', 600);
                    }).catch(() => {});
                }
            });
        });
    }

    function renderFactionList() {
        const fids = Object.keys(state.watchedFactions);
        let html = '<div style="margin-top:6px;">';
        const currentFid = getCurrentFactionIdFromUrl();
        if (isFactionProfilePage() && currentFid) {
            const isWatched = !!state.watchedFactions[currentFid];
            const isOwn = currentFid === state.myFactionID;
            const watchDisabled = isOwn ? 'disabled' : '';
            html += `<div class="tt-row" style="margin-bottom:10px;">
        <div class="tt-section-title">Watched factions</div>
        <button id="tt-watch-faction-header" class="tt-watch-btn ${isWatched?'tt-watch-btn--active':''}" ${watchDisabled}>
          ${isOwn ? 'Own' : (isWatched ? 'Watching' : 'Watch')}
        </button>
      </div>`;
        } else {
            html += '<div class="tt-section-title" style="margin-bottom:8px;">Watched factions</div>';
        }
        if (fids.length === 0) {
            html += '<div style="padding:16px;border-radius:var(--tt-radius-md);border:1px dashed rgba(255,255,255,0.15);text-align:center;font-size:13px;color:var(--tt-text-soft);">No factions watched.</div>';
        } else {
            for (const fid of fids) {
                const f = state.watchedFactions[fid];
                const members = Object.values(f.members || {});
                const travelling = members.filter(m => m.status === 'traveling' || m.status === 'landed');
                const out = travelling.filter(m => m.status === 'traveling' && m.destination !== 'Torn').length;
                const ret = travelling.filter(m => m.status === 'traveling' && m.destination === 'Torn').length;
                const landed = travelling.filter(m => m.status === 'landed').length;
                const isWar = state.warFactions.has(fid);
                html += `<div class="tt-faction-card" data-fid="${fid}">
          <div style="flex:1;min-width:0;">
            <div class="tt-faction-name">${escapeHtml(f.name)}${fid === state.myFactionID ? ' ⭐' : ''}</div>
            <div class="tt-faction-sub">Out:${out} Ret:${ret} Landed:${landed}</div>
          </div>
          <div class="tt-row-gap">
            <button class="tt-war-toggle ${isWar?'active':''}" data-fid="${fid}" style="margin-right:6px;">
              ⚔️ ${isWar?'War':'Mark'}
            </button>
            <span style="font-size:18px;color:var(--tt-text-soft);">›</span>
          </div>
        </div>`;
            }
        }
        return html + '</div>';
    }

    function renderFactionMembers(fid) {
        const f = state.watchedFactions[fid];
        const members = f.members || {};
        const now = Date.now();
        const isOwn = fid === state.myFactionID;
        const flying = [], landed = [];

        for (const xid in members) {
            const m = members[xid];
            m.xid = xid;
            if (m.status === 'traveling') flying.push(m);
            else if (m.status === 'landed') landed.push(m);
        }

        flying.sort((a, b) => {
            const afast = getFastestDuration(a.lookupDest, a.flightType) * 60000 + a.travelStarted;
            const bfast = getFastestDuration(b.lookupDest, b.flightType) * 60000 + b.travelStarted;
            return afast - bfast;
        });
        landed.sort((a, b) => b.landedAt - a.landedAt);

        let cards;
        if (state.activeTab === 'all') cards = [...landed, ...flying];
        else if (state.activeTab === 'outbound') cards = flying.filter(m => m.destination !== 'Torn');
        else if (state.activeTab === 'return') cards = flying.filter(m => m.destination === 'Torn');
        else cards = [];

        const outCount = flying.filter(m => m.destination !== 'Torn').length;
        const retCount = flying.filter(m => m.destination === 'Torn').length;

        let html = `<div style="margin-top:6px;">
      <div class="tt-row" style="margin-bottom:8px;">
        <button id="tt-back-to-list" style="background:none;border:none;color:var(--tt-text-soft);cursor:pointer;display:flex;align-items:center;gap:6px;font-size:16px;touch-action:manipulation;">
          <span style="font-size:20px;">←</span><span>Factions</span>
        </button>
        <div style="text-align:right;">
          <div style="font-size:16px;font-weight:700;">
            <a href="/factions.php?step=profile&ID=${fid}" target="_blank" style="color:inherit;text-decoration:none;">
              ${escapeHtml(f.name)} ${isOwn ? ' ⭐' : ''}
            </a>
          </div>
          <div style="font-size:12px;color:var(--tt-text-soft);">
            Out: ${outCount} • Ret: ${retCount} • Landed: ${landed.length}
          </div>
        </div>
      </div>
      <div class="tt-row" style="margin-bottom:10px;flex-wrap:wrap;gap:6px;">
        <div class="tt-chip tt-chip-accent">
          <span style="width:8px;height:8px;border-radius:50%;background:var(--tt-accent);display:inline-block;"></span>
          Outbound
        </div>
        <div class="tt-chip tt-chip-purple">
          <span style="width:8px;height:8px;border-radius:50%;background:var(--tt-purple);display:inline-block;"></span>
          Return
        </div>
        ${!isOwn ? `<button id="tt-stop-watch-faction" data-fid="${fid}" style="border-radius:999px;border:none;padding:6px 14px;font-size:12px;font-weight:600;background:rgba(239,83,80,0.2);color:#FFCDD2;cursor:pointer;touch-action:manipulation;">Stop</button>` : ''}
      </div>`;

        if (cards.length === 0) {
            html += `<div style="padding:16px;border-radius:var(--tt-radius-md);border:1px dashed rgba(255,255,255,0.15);text-align:center;font-size:13px;color:var(--tt-text-soft);">No members matching this filter.</div>`;
        } else {
            for (const m of cards) {
                if (m.status === 'landed') html += renderLandedCard(m);
                else html += renderTravelCard(m, now);
            }
        }

        return html + '</div>';
    }

    function renderLandedCard(m) {
        const bsPill = renderBSPill(m);
        const elapsed = Date.now() - m.landedAt;
        const elapsedStr = formatElapsed(elapsed);
        const route = m.destination === 'Torn' ? '← ' + m.origin : m.origin + ' → ' + m.destination;
        return `<div class="tt-member-card" style="background:radial-gradient(circle at 0 0, rgba(76,175,80,0.2), transparent 55%), var(--tt-bg-card);border-color:rgba(76,175,80,0.7);">
      <div class="tt-member-main"><div class="tt-member-name"><a href="/profiles.php?XID=${m.xid}" target="_blank">${escapeHtml(m.playerName)}</a></div><div class="tt-member-route">${escapeHtml(route)}</div></div>
      <div class="tt-member-meta">
        <span class="tt-chip tt-chip-success"><span style="font-size:12px;">LANDED</span><span style="font-family:monospace;font-size:11px;margin-left:4px;">${formatWallClock(m.landedAt)}</span></span>
        <div class="tt-row-gap">${bsPill}<span style="font-size:12px;color:var(--tt-text-soft);">${m.flightType}</span></div>
      </div>
      <div style="margin-top:4px;font-size:11px;color:var(--tt-text-soft);text-align:right;">Elapsed: ${elapsedStr}</div>
    </div>`;
    }

    function renderTravelCard(m, now) {
        const isYou = (m.xid === String(state.myUserID));
        const baseDur = DEFAULT_DURATIONS[m.lookupDest]?.[m.flightType] || 120;
        const fastestDur = getFastestDuration(m.lookupDest, m.flightType);
        const slowestDur = getSlowestDuration(m.lookupDest, m.flightType);

        let fastestETA, slowestETA;
        if (isYou && state.myTravelArrival) {
            const exactRem = Math.max(0, state.myTravelArrival - now);
            fastestETA = now + exactRem;
            slowestETA = now + exactRem;
        } else {
            fastestETA = m.travelStarted + fastestDur * 60000 - DETECT_DELAY;
            slowestETA = m.travelStarted + slowestDur * 60000;
        }

        const fastestRem = Math.max(0, fastestETA - now);
        const slowestRem = Math.max(0, slowestETA - now);
        const total = baseDur * 60000;
        const elapsed = now - m.travelStarted;
        const pct = total > 0 ? Math.min(100, (elapsed / total) * 100) : 100;
        const isLanding = fastestRem <= 0;
        const isReturn = m.destination === 'Torn';

        const barColor = isLanding ? '#FFB300' : isReturn ? '#9C27B0' : (pct > 90 ? '#FFB300' : '#2196F3');
        const barWidth = isLanding ? 100 : pct;
        const chipClass = isLanding ? 'tt-chip-warning' : isReturn ? 'tt-chip-purple' : 'tt-chip-accent';
        const chipLabel = isReturn ? 'Return' : 'Outbound';
        const chipTime = formatTime(fastestRem);
        const bsPill = renderBSPill(m);
        const route = isReturn ? '← ' + m.origin : m.origin + ' → ' + m.destination;
        const cardClasses = ['tt-member-card'];
        if (m.sameDestination) cardClasses.push('tt-member-card--same-dest');
        if (isYou) cardClasses.push('tt-member-card--self');

        const planeLeft = isReturn ? (100 - barWidth) : barWidth;
        const planeTransform = isReturn ? 'translateX(-50%) translateY(-50%) scaleX(-1) rotate(45deg)' : 'translateX(-50%) translateY(-50%) rotate(45deg)';
        const abroadCountry = isReturn ? (m.origin ? standardizeCountryName(m.origin) : '') : (m.destination ? standardizeCountryName(m.destination) : '');
        let abroadFlagUrl = '/images/v2/travel_agency/flags/fl_torn.svg';
        if (abroadCountry) {
            const flagUrl = getFlagUrl(isReturn ? m.origin : m.destination);
            if (flagUrl) abroadFlagUrl = flagUrl;
        }
        const fillStyle = isReturn ? `right:0;left:auto;width:${barWidth}%;background:${barColor};` : `left:0;right:auto;width:${barWidth}%;background:${barColor};`;

        const flagEmoji = FLAG_EMOJI[m.destination] || '';
        let clipLines = [];
        clipLines.push(`✈️ ${m.playerName} → ${flagEmoji} ${m.destination}`);
        const bsFormatted = (m.tbs || m.bs_estimate) ? formatBS(m.tbs || m.bs_estimate) : null;
        if (bsFormatted) clipLines.push(`BS: ${bsFormatted} | Flight: ${m.flightType}`);
        else clipLines.push(`Flight: ${m.flightType}`);
        clipLines.push(`Flying for ${formatElapsed(elapsed)}`);
        if (isLanding) {
            clipLines.push(`Earliest: Landing`);
            clipLines.push(`ETA: Landing`);
        } else {
            clipLines.push(`Earliest: ${formatTime(fastestRem)}`);
            clipLines.push(`ETA: ${formatWallClock(fastestETA)}`);
        }
        const clipText = clipLines.join('\n');

        return `<div class="${cardClasses.join(' ')}" data-clip-text="${escapeHtml(clipText)}">
      <div class="tt-member-main">
        <div class="tt-member-name">
          <a href="/profiles.php?XID=${m.xid}" target="_blank">${escapeHtml(m.playerName)}</a>
        </div>
        <div class="tt-member-route">${escapeHtml(route)}</div>
      </div>
      <div class="tt-member-meta">
        <span class="tt-chip ${chipClass}"><span style="font-size:11px;">${chipLabel}</span><span style="font-family:monospace;font-size:11px;margin-left:4px;">${chipTime}</span></span>
        <div class="tt-row-gap">
          ${bsPill}
          <span style="font-size:12px;color:var(--tt-text-soft);">${m.flightType}</span>
        </div>
      </div>
      <div style="margin-top:4px;font-size:12px;color:${isLanding ? 'var(--tt-warning)' : 'var(--tt-text-soft)'};text-align:left;">
        <span>Elapsed: ${formatElapsed(elapsed)}</span>
        <span style="margin-left:8px;">Window: <span style="font-weight:700;color:#FFD700;">${isLanding ? 'Landing' : formatTime(fastestRem)}</span>–${formatTime(slowestRem)}</span>
      </div>
      <div class="tt-progress-shell-new">
        <div class="tt-progress-flags-row">
          <div class="tt-circular-flag"><img src="/images/v2/travel_agency/flags/fl_torn.svg" alt="Torn"></div>
          <div class="tt-progress-track-new">
            <div class="tt-progress-fill-new" style="${fillStyle}"></div>
            <div class="tt-progress-plane-new" style="left:${planeLeft}%; transform:${planeTransform};">✈️</div>
          </div>
          <div class="tt-circular-flag"><img src="${abroadFlagUrl}" alt="Abroad"></div>
        </div>
      </div>
    </div>`;
    }

    // ==================== INIT ====================
    function init() {
        injectGlobalStyles();
        requestNotificationPermission();

        const savedWar = GM_getValue('warFactions', null);
        if (savedWar) {
            try {
                const parsed = JSON.parse(savedWar);
                if (Array.isArray(parsed)) state.warFactions = new Set(parsed);
            } catch (e) {}
        }

        if (state.personalApiKey) fetchMyOwnTBS();

        pollServer().then(() => startPolling());
        injectFloatingIcon();
        detectWarFactionsFromPage();

        let lastUrl = window.location.href;
        new MutationObserver(() => {
            if (window.location.href !== lastUrl) {
                lastUrl = window.location.href;
                detectWarFactionsFromPage();
            }
        }).observe(document, { subtree: true, childList: true });
    }

    init();
})();
