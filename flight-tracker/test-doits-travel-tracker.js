// ==UserScript==
// @name         1 Doits Flight Tracker v18.2.6 - Opponent + Exact Landing
// @namespace    https://github.com/your-repo
// @version      18.2.6
// @description  Private Cloudflare tracker with one-key registration, automatic installation linking, admin approval, faction access, recovery, and admin management
// @author       Doitsburger + Grok
// @match        https://www.torn.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @run-at       document-end
// @connect      doits-flight-tracker-relay.ezekeo.workers.dev
// ==/UserScript==

(function () {
    'use strict';

    // ==================== CONFIG ====================
    const CLOUD_SERVER = 'https://doits-flight-tracker-relay.ezekeo.workers.dev';
    const CLOUD_POLL_INTERVAL = 5000;
    const ACCESS_POLL_INTERVAL = 30000;
    const ADMIN_POLL_INTERVAL = 30000;
    const PANEL_UPDATE_INTERVAL = 250;
    const DETECT_DELAY = 30000; // Cloud scheduler can first detect a departure up to one 30s cycle late.
    const NOTIFICATION_HISTORY_MS = 24 * 60 * 60 * 1000;
    const FLIGHT_KEY_BUCKET_MS = 5 * 60 * 1000;
    const LANDING_ALERT_MS = 5 * 60 * 1000;
    const EXACT_LANDING_PHASE_MS = 2 * 60 * 1000;

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
        "Mexico": "\uD83C\uDDF2\uD83C\uDDFD", "Cayman Islands": "\uD83C\uDDF0\uD83C\uDDFE", "Canada": "\uD83C\uDDE8\uD83C\uDDE6", "Hawaii": "\uD83C\uDDFA\uD83C\uDDF8",
        "United Kingdom": "\uD83C\uDDEC\uD83C\uDDE7", "Argentina": "\uD83C\uDDE6\uD83C\uDDF7", "Switzerland": "\uD83C\uDDE8\uD83C\uDDED",
        "Japan": "\uD83C\uDDEF\uD83C\uDDF5", "China": "\uD83C\uDDE8\uD83C\uDDF3", "UAE": "\uD83C\uDDE6\uD83C\uDDEA", "United Arab Emirates": "\uD83C\uDDE6\uD83C\uDDEA",
        "South Africa": "\uD83C\uDDFF\uD83C\uDDE6"
    };

    const HONOR_IDS = {
        "Argentina": 66, "Canada": 75, "China": 76, "Japan": 97,
        "Mexico": 104, "South Africa": 119, "Switzerland": 123,
        "United Arab Emirates": 126, "UAE": 126, "United Kingdom": 127, "UK": 127,
        "Cayman Islands": 775, "Hawaii": 133
    };

    const BS_COLORS = {
        low: { bg: '#87CEEB', text: '#000' },
        mid: { bg: '#28c628', text: '#000' },
        high: { bg: '#AA7DCE', text: '#fff' },
        top: { bg: '#c62828', text: '#fff' }
    };

    const GREEN_RATIO_MAX = 2 / 3.5;

    // ==================== TEMP THREAT DEBUG ====================
    // CHANGE THIS TO false WHEN YOU HAVE FINISHED DESIGNING THE OVERLAY.
    const THREAT_OVERLAY_DEBUG = false;
    const THREAT_DEBUG_STARTED = Date.now();

    // ==================== PERSISTENT NOTIFICATION STORAGE ====================
    function loadNotifiedFlights() {
        try {
            const parsed = JSON.parse(GM_getValue('notifiedFlights', '{}'));
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (e) {
            return {};
        }
    }

    function saveNotifiedFlights() {
        try {
            GM_setValue('notifiedFlights', JSON.stringify(state.notifiedFlights));
        } catch (e) {}
    }

    function loadNotifiedLandings() {
        try {
            const parsed = JSON.parse(GM_getValue('notifiedLandings', '{}'));
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (e) {
            return {};
        }
    }

    function saveNotifiedLandings() {
        try {
            GM_setValue('notifiedLandings', JSON.stringify(state.notifiedLandings));
        } catch (e) {}
    }

    // ==================== STATE ====================
    let myBattleStats = null;
    let pollTimer = null;

    let state = {
        apiKeySet: false,
        authenticated: false,
        watchedFactions: {},
        trackedIndividuals: {},
        pendingTrackedIds: new Set(),
        trackedActionBusy: new Set(),
        selectedFactionId: null,
        panelMode: 'factions',
        panelVisible: false,
        panelInterval: null,
        myUserID: null,
        myDestination: null,
        myFactionID: null,
        myFactionName: null,
        myTravelArrival: null,
        warFactions: new Set(),
        lastPollTime: 0,
        serverOnline: true,
        activeTab: 'all',
        abroadView: 'all',
        abroadCollapsedSections: new Set(),
        threatOverlayExpanded: false,
        threatOverlayInterval: null,
        previousMembers: {},
        notifiedFlights: loadNotifiedFlights(),
        notifiedLandings: loadNotifiedLandings(),
        businessFlights: {},
        trackerClientId: GM_getValue('trackerClientId', '') || '',
        trackerClientSecret: GM_getValue('trackerClientSecret', '') || '',
        trackerLabel: GM_getValue('trackerLabel', '') || '',
        registrationPending: !!GM_getValue('trackerRegistrationPending', false),
        registrationAccessLost: false,
        registrationBusy: false,
        pendingActivationBusy: false,
        accessInfo: null,
        accessLastPoll: 0,
        adminRequests: { pendingCount: 0, approvedCount: 0, requests: [] },
        adminUsers: [],
        adminFactions: [],
        adminSection: 'requests',
        adminLastPoll: 0,
        adminLoading: false,
        adminError: null
    };

    // ==================== HELPERS ====================
    function getMyFactionDetails() {
        try {
            const faction = window.myfaction?.get?.();
            if (faction?.id) return { id: String(faction.id), name: faction.name || null };
        } catch (e) {}

        try {
            const stored = JSON.parse(localStorage.getItem('myfaction') || 'null');
            if (stored?.id) return { id: String(stored.id), name: stored.name || null };
        } catch (e) {}

        return { id: null, name: null };
    }

    function getMyTornUserId() {
        try {
            if (typeof unsafeWindow !== 'undefined' && unsafeWindow.uid) return unsafeWindow.uid.toString();
        } catch (e) {}

        const link = document.querySelector('a[href*="/profiles.php?XID="]');

        if (link) {
            const m = link.href.match(/XID=(\d+)/);
            if (m) return m[1];
        }

        const el = document.querySelector('.user-info-value .user-id');

        if (el) {
            const t = el.textContent.replace(/[^0-9]/g, '');
            if (t) return t;
        }

        return null;
    }

    function standardizeCountryName(country) {
        if (!country) return '';

        const map = {
            'United Kingdom': 'uk',
            'UK': 'uk',
            'UAE': 'uae',
            'United Arab Emirates': 'uae',
            'Cayman Islands': 'cayman_islands',
            'Hawaii': 'hawaii'
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

        if (ratio <= GREEN_RATIO_MAX) return BS_COLORS.low;
        if (ratio < 0.83) return BS_COLORS.mid;
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
        const bs = getMemberBS(member);

        if (bs == null || isNaN(bs)) return '';

        const formatted = formatBS(bs);

        if (!formatted) return '';

        const colorConfig = getBSColorConfig(bs);

        if (!colorConfig) return `<span style="display:inline-flex;align-items:center;gap:3px;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:700;background:rgba(255,255,255,0.08);color:#aaa;">\u2694 ${formatted}</span>`;

        return `<span style="display:inline-flex;align-items:center;gap:3px;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:700;background:${colorConfig.bg};color:${colorConfig.text};">\u2694 ${formatted}</span>`;
    }

    function escapeHtml(t) {
        return t ? String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') : '';
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
        if (!Number.isFinite(Number(ms)) || ms <= 0) return '0:00';

        const s = Math.ceil(ms / 1000);
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = s % 60;

        return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
    }

    function formatElapsed(ms) {
        if (ms <= 0) return '0s';

        const s = Math.floor(ms / 1000);
        const d = Math.floor(s / 86400);
        const h = Math.floor((s % 86400) / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = s % 60;

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

    function formatArrivalClock(timestamp) {
        if (!timestamp || !Number.isFinite(timestamp)) return '--:--';

        return new Date(timestamp).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        });
    }

    function isFactionProfilePage() {
        return /\/factions\.php\?step=profile/i.test(window.location.href);
    }

    function getCurrentFactionIdFromUrl() {
        return new URLSearchParams(window.location.search).get('ID');
    }

    function isPlayerProfilePage() {
        return /\/profiles\.php/i.test(window.location.pathname);
    }

    function getCurrentPlayerIdFromUrl() {
        return new URLSearchParams(window.location.search).get('XID');
    }

    function scrapeFactionNameFromPage() {
        const el = document.querySelector('.title-black.hospital-dark.top-round.m-top10');

        if (!el) return null;

        const clone = el.cloneNode(true);
        const respect = clone.querySelector('.bold.f-title-respect');

        if (respect) respect.remove();

        const t = clone.textContent.trim().replace(/\s+/g, ' ').trim();

        return t.length > 0 && t.length < 100 ? t : null;
    }

    function cleanupNotifiedFlights() {
        const cutoff = Date.now() - NOTIFICATION_HISTORY_MS;
        let changed = false;

        for (const key in state.notifiedFlights) {
            if (!state.notifiedFlights[key] || state.notifiedFlights[key] < cutoff) {
                delete state.notifiedFlights[key];
                changed = true;
            }
        }

        if (changed) saveNotifiedFlights();
    }

    function cleanupNotifiedLandings() {
        const cutoff = Date.now() - NOTIFICATION_HISTORY_MS;
        let changed = false;

        for (const key in state.notifiedLandings) {
            if (!state.notifiedLandings[key] || state.notifiedLandings[key] < cutoff) {
                delete state.notifiedLandings[key];
                changed = true;
            }
        }

        if (changed) saveNotifiedLandings();
    }

    function makeFlightNotificationKey(fid, xid, member) {
        const started = Number(member.travelStarted || 0);
        const bucket = started ? Math.floor(started / FLIGHT_KEY_BUCKET_MS) : 0;

        return `${fid}:${xid}:${member.origin || ''}:${member.destination || ''}:${member.flightType || ''}:${bucket}`;
    }

    function getMemberExactArrival(member) {
        if (!member) return null;

        const xid = String(
            member.xid ??
            member.playerId ??
            member.player_id ??
            ''
        ).trim();

        const candidates = [
            member.exactArrival,
            member.exact_arrival,
            member.travelArrival,
            member.travel_arrival,
            xid && xid === String(state.myUserID || '') ? state.myTravelArrival : null
        ];

        for (const value of candidates) {
            if (value == null) continue;

            const timestamp = Number(value);

            if (Number.isFinite(timestamp) && timestamp > 0) return timestamp;
        }

        return null;
    }

    function getMemberArrivalWindow(member) {
        const exactArrival = getMemberExactArrival(member);

        if (exactArrival != null) {
            return {
                earliest: exactArrival,
                latest: exactArrival,
                earliestText: formatArrivalClock(exactArrival),
                latestText: formatArrivalClock(exactArrival),
                exact: true
            };
        }

        if (!member?.travelStarted || !member?.lookupDest || !member?.flightType) return null;

        const fastestMinutes = getFastestDuration(member.lookupDest, member.flightType);
        const slowestMinutes = getSlowestDuration(member.lookupDest, member.flightType);
        const earliest = Number(member.travelStarted) + fastestMinutes * 60000 - DETECT_DELAY;
        const latest = Number(member.travelStarted) + slowestMinutes * 60000;

        return {
            earliest,
            latest,
            earliestText: formatArrivalClock(earliest),
            latestText: formatArrivalClock(latest),
            exact: false
        };
    }

    function requestNotificationPermission() {
        if (typeof Notification !== 'undefined' && Notification.permission === 'default') Notification.requestPermission();
    }

    function sendBrowserNotification(title, body) {
        try {
            if (typeof GM_notification === 'function') {
                GM_notification({
                    title,
                    text: body,
                    image: 'https://www.torn.com/favicon.ico',
                    timeout: 12000
                });

                return true;
            }
        } catch (e) {
            console.warn('[Travel Tracker] GM_notification failed:', e);
        }

        try {
            if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
                new Notification(title, {
                    body,
                    icon: 'https://www.torn.com/favicon.ico'
                });

                return true;
            }
        } catch (e) {
            console.warn('[Travel Tracker] Browser notification failed:', e);
        }

        return false;
    }

    function buildTravelNotification(member, mode = 'inbound') {
        const arrival = getMemberArrivalWindow(member);

        if (!arrival) return null;

        const flag = FLAG_EMOJI[member.destination] || '\u2708\uFE0F';
        const flightType = member.flightType || 'Flight';
        const bs = member.tbs ?? member.bs_estimate ?? null;
        const bsText = bs != null && !isNaN(bs) ? formatBS(Number(bs)) : 'N/A';
        const title = mode === 'landing' ? `\u23F0 ${member.playerName} landing \u2192 ${flag} ${member.destination}` : `\uD83D\uDEA8 ${member.playerName} \u2192 ${flag} ${member.destination}`;
        const arrivalText = arrival.exact ? `Landing in ${formatTime(Math.max(0, arrival.earliest - Date.now()))}` : `ETA ${arrival.earliestText}\u2013${arrival.latestText}`;
        const body = `${flightType} \u2022 ${arrivalText} \u2022 \u2694 ${bsText}`;

        return { title, body };
    }

    function detectMyFactionFromWatchedFactions() {
        const myId = String(state.myUserID || getMyTornUserId() || '');

        if (!myId) return { id: null, name: null };

        for (const fid in state.watchedFactions) {
            const faction = state.watchedFactions[fid];

            if (faction?.members && faction.members[myId]) {
                return {
                    id: String(fid),
                    name: faction.name || `Faction ${fid}`
                };
            }
        }

        return { id: null, name: null };
    }

    // ==================== CLOUD ACCOUNT + DATA ====================
    function hasTrackerCredentials() {
        return !!(state.trackerClientId && state.trackerClientSecret);
    }

    function saveTrackerCredentials(clientId, clientSecret, label = '') {
        state.trackerClientId = String(clientId || '').trim();
        state.trackerClientSecret = String(clientSecret || '').trim();
        state.trackerLabel = String(label || '').trim();
        GM_setValue('trackerClientId', state.trackerClientId);
        GM_setValue('trackerClientSecret', state.trackerClientSecret);
        GM_setValue('trackerLabel', state.trackerLabel);
    }

    function setRegistrationPending(value) {
        state.registrationPending = value === true;
        state.registrationAccessLost = false;
        GM_setValue('trackerRegistrationPending', state.registrationPending);
    }

    function clearTrackerCredentials() {
        state.trackerClientId = '';
        state.trackerClientSecret = '';
        state.trackerLabel = '';
        state.authenticated = false;
        state.apiKeySet = false;
        state.watchedFactions = {};
        state.trackedIndividuals = {};
        state.pendingTrackedIds.clear();
        state.myUserID = null;
        state.myFactionID = null;
        state.myFactionName = null;
        state.myDestination = null;
        state.myTravelArrival = null;
        state.accessInfo = null;
        state.accessLastPoll = 0;
        state.registrationPending = false;
        state.registrationAccessLost = false;
        state.registrationBusy = false;
        state.pendingActivationBusy = false;
        state.adminRequests = { pendingCount: 0, approvedCount: 0, requests: [] };
        state.adminUsers = [];
        state.adminFactions = [];
        state.adminLastPoll = 0;
        state.adminLoading = false;
        state.adminError = null;
        myBattleStats = null;
        GM_setValue('trackerClientId', '');
        GM_setValue('trackerClientSecret', '');
        GM_setValue('trackerLabel', '');
        GM_setValue('trackerRegistrationPending', false);
    }

    function cloudRequest(method, path, data = null, options = {}) {
        return new Promise((resolve, reject) => {
            const auth = options.auth !== false;
            const credentials = options.credentials || null;
            const clientId = credentials?.clientId || state.trackerClientId;
            const clientSecret = credentials?.clientSecret || state.trackerClientSecret;
            const headers = { 'Accept': 'application/json' };

            if (auth) {
                if (!clientId || !clientSecret) {
                    const error = new Error('Tracker account is not linked to this browser');
                    error.status = 401;
                    reject(error);
                    return;
                }
                headers['X-Client-ID'] = clientId;
                headers['X-Client-Secret'] = clientSecret;
            }

            const opts = {
                method,
                url: CLOUD_SERVER + path,
                headers,
                onload: response => {
                    let body = null;
                    try { body = JSON.parse(response.responseText || '{}'); } catch (e) {}
                    if (response.status >= 200 && response.status < 300) {
                        resolve(body || {});
                        return;
                    }
                    const error = new Error(body?.error || ('HTTP ' + response.status));
                    error.status = response.status;
                    error.payload = body;
                    reject(error);
                },
                onerror: () => {
                    const error = new Error('Cloudflare tracker could not be reached');
                    error.status = 0;
                    reject(error);
                }
            };

            if (data !== null && data !== undefined) {
                opts.headers['Content-Type'] = 'application/json';
                opts.data = JSON.stringify(data);
            }

            GM_xmlhttpRequest(opts);
        });
    }

    async function registerUniversalTracker() {
        if (state.registrationBusy) return false;

        const keyInput = document.getElementById('tt-registration-api-key');
        const errorEl = document.getElementById('tt-registration-error');
        const submitBtn = document.getElementById('tt-register-universal');

        if (!keyInput) return false;

        let apiKey = String(keyInput.value || '').trim();

        if (!apiKey) {
            if (errorEl) errorEl.textContent = 'Enter your Torn API key.';
            keyInput.focus();
            return false;
        }

        state.registrationBusy = true;
        if (errorEl) errorEl.textContent = '';
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.textContent = 'CONNECTING...';
        }

        try {
            const result = await cloudRequest(
                'POST',
                '/client/register-universal',
                { apiKey },
                { auth: false }
            );

            apiKey = '';
            keyInput.value = '';

            if (!result.clientId || !result.clientSecret) {
                throw new Error('Registration did not return tracker credentials');
            }

            saveTrackerCredentials(
                result.clientId,
                result.clientSecret,
                result.tornName || ''
            );

            state.authenticated = true;
            state.apiKeySet = true;
            state.serverOnline = true;
            state.myUserID = result.tornUserId ? String(result.tornUserId) : null;
            state.myFactionID = result.ownFactionId ? String(result.ownFactionId) : null;
            state.myFactionName = result.factionName || null;
            state.accessLastPoll = 0;

            if (result.pendingApproval === true || result.registrationMode === 'pending_personal') {
                setRegistrationPending(true);
                state.accessInfo = {
                    success: true,
                    tornUserId: state.myUserID,
                    tornName: result.tornName || state.trackerLabel || null,
                    factionName: state.myFactionName,
                    registeredFactionId: state.myFactionID,
                    accessType: 'pending',
                    accessStatus: 'pending',
                    personalAccessReady: false,
                    canActivatePersonal: false,
                    latestRequest: result.requestId ? {
                        requestId: result.requestId,
                        type: 'personal',
                        status: 'pending',
                        requestedAt: Date.now()
                    } : null
                };

                try { await refreshAccessStatus(true); } catch (e) {}
                if (state.panelVisible) updatePanelContent();
                return true;
            }

            setRegistrationPending(false);
            state.accessInfo = null;
            await refreshAccessStatus(true);
            await pollServer({ skipPendingAutoActivate: true });

            if (state.panelVisible) updatePanelContent();
            return true;
        } catch (e) {
            apiKey = '';
            const message = String(e?.message || 'Registration failed');
            if (errorEl) errorEl.textContent = message;
            return false;
        } finally {
            state.registrationBusy = false;
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = 'CONNECT ACCOUNT';
            }
        }
    }

    async function registerWithFactionAccess() {
        let key = prompt(
            'Enter your FFScouter-registered Torn API key.\n\n' +
            'If you are in the tracker admin\'s primary faction, no access code is required. Other registered factions will be asked for their Faction Access Code.',
            ''
        );
        if (key === null) return false;
        key = key.trim();
        if (!key) return false;

        let accessCode = '';

        try {
            let result;

            try {
                result = await cloudRequest('POST', '/client/register-faction', { apiKey: key }, { auth: false });
            } catch (firstError) {
                if (!/Faction Access Code required/i.test(String(firstError.message || ''))) throw firstError;

                const entered = prompt('Enter your faction\'s Faction Access Code:', '');
                if (entered === null) {
                    key = '';
                    return false;
                }

                accessCode = entered.trim().toUpperCase();
                if (!accessCode) {
                    key = '';
                    return false;
                }

                result = await cloudRequest(
                    'POST',
                    '/client/register-faction',
                    { apiKey: key, accessCode },
                    { auth: false }
                );
            }

            key = '';
            accessCode = '';

            if (!result.clientId || !result.clientSecret) {
                throw new Error('Faction registration did not return tracker credentials');
            }

            saveTrackerCredentials(result.clientId, result.clientSecret, result.tornName || '');
            setRegistrationPending(false);
            state.authenticated = true;
            state.apiKeySet = true;
            state.serverOnline = true;
            state.myUserID = result.tornUserId ? String(result.tornUserId) : null;
            state.myFactionID = result.factionId ? String(result.factionId) : null;
            state.myFactionName = result.factionName || null;

            await refreshAccessStatus(true);
            await pollServer();

            alert(
                result.primaryFaction
                    ? 'Faction access approved automatically. Your private tracker is running.'
                    : 'Faction access approved. Your private tracker is running.'
            );

            if (state.panelVisible) updatePanelContent();
            return true;
        } catch (e) {
            key = '';
            accessCode = '';
            alert('Faction registration failed: ' + e.message);
            return false;
        }
    }

    async function registerWithInvite() {
        const inviteCode = prompt('Enter your Doits Flight Tracker invite code:', '');
        if (inviteCode === null) return false;
        const code = inviteCode.trim();
        if (!code) return false;

        try {
            const result = await cloudRequest('POST', '/client/register', { inviteCode: code }, { auth: false });
            if (!result.clientId || !result.clientSecret) throw new Error('Registration did not return tracker credentials');
            saveTrackerCredentials(result.clientId, result.clientSecret, result.label || '');
            setRegistrationPending(false);
            state.authenticated = true;
            state.serverOnline = true;
            await configureTrackerApiKey();
            await pollServer();
            if (state.panelVisible) updatePanelContent();
            return true;
        } catch (e) {
            alert('Registration failed: ' + e.message);
            return false;
        }
    }

    async function linkExistingTrackerAccount() {
        const clientIdInput = prompt('Enter your existing Tracker Client ID:', state.trackerClientId || '');
        if (clientIdInput === null) return false;
        const clientId = clientIdInput.trim();
        if (!clientId) return false;

        let clientSecretInput = prompt('Enter your existing Tracker Client Secret:', '');
        if (clientSecretInput === null) return false;
        const clientSecret = clientSecretInput.trim();
        clientSecretInput = '';
        if (!clientSecret) return false;

        try {
            const ping = await cloudRequest('GET', '/client/ping', null, { credentials: { clientId, clientSecret } });
            saveTrackerCredentials(clientId, clientSecret, ping.label || '');
            setRegistrationPending(false);
            state.authenticated = true;
            state.serverOnline = true;
            await refreshAccessStatus(true);
            await pollServer();
            if (state.apiKeySet) {
                try { await cloudRequest('POST', '/client/scheduler/start'); } catch (e) {}
            }
            if (state.panelVisible) updatePanelContent();
            return true;
        } catch (e) {
            alert('Could not link that tracker account: ' + e.message);
            return false;
        }
    }

    async function configureTrackerApiKey() {
        if (!hasTrackerCredentials()) {
            alert('Link or register your tracker account first.');
            return false;
        }

        let key = prompt(
            'Enter your FFScouter-registered Torn API key.\n\n' +
            'The same key is used by Torn and FFScouter. It is sent securely to your Cloudflare tracker, encrypted there, and is not stored in this userscript.',
            ''
        );
        if (key === null) return false;
        key = key.trim();
        if (!key) return false;

        try {
            const result = await cloudRequest('POST', '/client/api-key', { apiKey: key });
            key = '';
            state.apiKeySet = true;
            state.authenticated = true;
            state.myUserID = result.tornUserId ? String(result.tornUserId) : state.myUserID;
            state.myFactionID = result.ownFactionId ? String(result.ownFactionId) : null;
            alert('Tracker connected. Your private 30-second Cloudflare tracker is now running.');
            await refreshAccessStatus(true);
            await pollServer();
            if (state.panelVisible) updatePanelContent();
            return true;
        } catch (e) {
            key = '';
            alert('API key setup failed: ' + e.message);
            return false;
        }
    }

    function getStandaloneTrackedIndividuals() {
        const factionMemberIds = new Set();
        for (const fid in state.watchedFactions) {
            for (const xid in state.watchedFactions[fid]?.members || {}) factionMemberIds.add(String(xid));
        }
        const standalone = {};
        for (const xid in state.trackedIndividuals || {}) {
            if (!factionMemberIds.has(String(xid))) standalone[xid] = state.trackedIndividuals[xid];
        }
        return standalone;
    }

    async function fetchState() {
        return cloudRequest('GET', '/client/state');
    }


    function isAdminUser() {
        return state.accessInfo?.accessType === 'admin';
    }

    function getAccessStatus() {
        return String(state.accessInfo?.accessStatus || 'active').toLowerCase();
    }

    function getSupportAdminHtml() {
        const admin = state.accessInfo?.supportAdmin;
        if (!admin?.tornUserId) return '<strong>the tracker administrator</strong>';
        const name = escapeHtml(admin.name || 'Tracker Admin');
        const url = escapeHtml(admin.profileUrl || ('https://www.torn.com/profiles.php?XID=' + admin.tornUserId));
        return `<a class="tt-support-admin-link" href="${url}" target="_blank">${name}</a>`;
    }

    async function refreshAccessStatus(force = false) {
        if (!hasTrackerCredentials()) return null;
        const now = Date.now();
        if (!force && state.accessLastPoll && now - state.accessLastPoll < ACCESS_POLL_INTERVAL) return state.accessInfo;

        try {
            const info = await cloudRequest('GET', '/client/access/status');
            state.accessInfo = info || null;
            state.accessLastPoll = now;
            return state.accessInfo;
        } catch (e) {
            if (e.status === 401) throw e;
            return state.accessInfo;
        }
    }

    async function refreshAdminRequests(force = false) {
        if (!isAdminUser()) return null;
        const now = Date.now();
        if (!force && state.adminLastPoll && now - state.adminLastPoll < ADMIN_POLL_INTERVAL) return state.adminRequests;

        try {
            const result = await cloudRequest('GET', '/admin/access/requests');
            state.adminRequests = result || { pendingCount: 0, approvedCount: 0, requests: [] };
            state.adminLastPoll = now;
            state.adminError = null;
            return state.adminRequests;
        } catch (e) {
            state.adminError = e.message;
            return state.adminRequests;
        }
    }

    async function loadAdminPanelData(force = true) {
        if (!isAdminUser()) return false;
        if (state.adminLoading) return false;

        state.adminLoading = true;
        state.adminError = null;
        if (state.panelVisible && state.panelMode === 'admin') updatePanelContent();

        try {
            const [requests, users, factions] = await Promise.all([
                cloudRequest('GET', '/admin/access/requests'),
                cloudRequest('GET', '/admin/access/users'),
                cloudRequest('GET', '/admin/access/factions')
            ]);

            state.adminRequests = requests || { pendingCount: 0, approvedCount: 0, requests: [] };
            state.adminUsers = Array.isArray(users?.users) ? users.users : [];
            state.adminFactions = Array.isArray(factions?.factions) ? factions.factions : [];
            state.adminLastPoll = Date.now();
            state.adminError = null;
            return true;
        } catch (e) {
            state.adminError = e.message;
            return false;
        } finally {
            state.adminLoading = false;
            if (force && state.panelVisible && state.panelMode === 'admin') updatePanelContent();
        }
    }

    async function requestPersonalAccess() {
        try {
            await cloudRequest('POST', '/client/access/request-personal', {});
            await refreshAccessStatus(true);
            if (state.panelVisible) updatePanelContent();
        } catch (e) {
            alert('Personal access request failed: ' + e.message);
        }
    }

    async function activateApprovedPersonalAccess(options = {}) {
        if (state.pendingActivationBusy) return false;

        state.pendingActivationBusy = true;
        const wasPendingRegistration = state.registrationPending || state.accessInfo?.accessType === 'pending';

        try {
            await cloudRequest('POST', '/client/access/activate-approved', {});
            setRegistrationPending(false);
            state.registrationAccessLost = false;
            state.accessLastPoll = 0;
            await refreshAccessStatus(true);
            await pollServer({ skipPendingAutoActivate: true });

            if (options.silent === true) {
                if (wasPendingRegistration) {
                    sendBrowserNotification('Flight Tracker access approved', 'Your tracker is now active.');
                }
            } else {
                alert(wasPendingRegistration
                    ? 'Access approved. Your tracker is now active.'
                    : 'Personal access activated. Your tracker is active again.');
            }

            if (state.panelVisible) updatePanelContent();
            return true;
        } catch (e) {
            if (options.silent !== true) {
                alert('Could not activate Personal Access: ' + e.message);
            }
            return false;
        } finally {
            state.pendingActivationBusy = false;
        }
    }

    async function refreshPendingRegistrationStatus() {
        try {
            const info = await refreshAccessStatus(true);
            state.authenticated = true;
            state.serverOnline = true;
            state.registrationAccessLost = false;

            if (info?.personalAccessReady === true) {
                await activateApprovedPersonalAccess({ silent: false });
                return true;
            }

            if (state.panelVisible) updatePanelContent();
            return true;
        } catch (e) {
            if (e.status === 401) {
                state.registrationAccessLost = true;
                state.authenticated = false;
                state.serverOnline = true;
                if (state.panelVisible) updatePanelContent();
                return false;
            }

            alert('Could not check access status: ' + e.message);
            return false;
        }
    }

    async function activatePersonalAccessCode() {
        const entered = prompt('Enter your Personal Access Code:', '');
        if (entered === null) return;
        const accessCode = entered.trim().toUpperCase();
        if (!accessCode) return;

        try {
            await cloudRequest('POST', '/client/access/activate-code', { accessCode });
            await refreshAccessStatus(true);
            await pollServer();
            alert('Personal access activated. Your tracker is active again.');
            if (state.panelVisible) updatePanelContent();
        } catch (e) {
            alert('Personal Access Code failed: ' + e.message);
        }
    }

    // ==================== NOTIFICATION DETECTION ====================
    function detectNewFlights(currentFactions) {
        cleanupNotifiedFlights();

        if (!state.myDestination) return;

        for (const fid in currentFactions) {
            const currentMembers = currentFactions[fid]?.members || {};
            const previousMembers = state.previousMembers[fid] || {};

            for (const xid in currentMembers) {
                const member = currentMembers[xid];
                const previous = previousMembers[xid];

                if (!member || member.status !== 'traveling') continue;
                if (member.destination === 'Torn') continue;
                if (String(xid) === String(state.myUserID)) continue;
                if (member.destination !== state.myDestination) continue;

                const newlyTraveling = !previous || previous.status !== 'traveling';
                const changedFlight = previous && previous.status === 'traveling' && (previous.destination !== member.destination || previous.origin !== member.origin || previous.flightType !== member.flightType || previous.travelStarted !== member.travelStarted);

                if (!newlyTraveling && !changedFlight) continue;

                const key = makeFlightNotificationKey(fid, xid, member);

                if (state.notifiedFlights[key]) continue;

                const notification = buildTravelNotification(member, 'inbound');

                if (!notification) continue;

                state.notifiedFlights[key] = Date.now();
                saveNotifiedFlights();

                sendBrowserNotification(notification.title, notification.body);
            }
        }
    }

    function detectLandingAlerts(currentFactions) {
        cleanupNotifiedLandings();

        const now = Date.now();

        for (const fid in currentFactions) {
            const members = currentFactions[fid]?.members || {};

            for (const xid in members) {
                const member = members[xid];

                if (!member || member.status !== 'traveling') continue;
                if (!member.travelStarted || !member.lookupDest || !member.flightType) continue;

                const arrival = getMemberArrivalWindow(member);

                if (!arrival) continue;

                const timeUntilEarliest = arrival.earliest - now;

                if (timeUntilEarliest > LANDING_ALERT_MS) continue;
                if (now > arrival.latest + 10 * 60 * 1000) continue;

                const key = makeFlightNotificationKey(fid, xid, member);

                if (state.notifiedLandings[key]) continue;

                const notification = buildTravelNotification(member, 'landing');

                if (!notification) continue;

                state.notifiedLandings[key] = Date.now();
                saveNotifiedLandings();

                sendBrowserNotification(notification.title, notification.body);
            }
        }
    }

    async function pollServer(options = {}) {
        if (!hasTrackerCredentials()) {
            state.authenticated = false;
            state.apiKeySet = false;
            state.serverOnline = true;
            const dot = document.getElementById('travel-tracker-status');
            if (dot) dot.className = 'tt-dot tt-dot--apikey';
            return;
        }

        try {
            let access = state.accessInfo;

            try {
                access = await refreshAccessStatus(false);
            } catch (accessError) {
                if (state.registrationPending && accessError.status === 401) {
                    state.registrationAccessLost = true;
                    state.authenticated = false;
                    state.apiKeySet = true;
                    state.serverOnline = true;
                    const pendingDot = document.getElementById('travel-tracker-status');
                    if (pendingDot) pendingDot.className = 'tt-dot tt-dot--apikey';
                    if (state.panelVisible) updatePanelContent();
                    return;
                }
                throw accessError;
            }

            if (access && (access.accessType === 'pending' || access.accessStatus === 'pending')) {
                setRegistrationPending(true);
                state.authenticated = true;
                state.apiKeySet = true;
                state.serverOnline = true;
                state.lastPollTime = Date.now();
                state.myUserID = access.tornUserId ? String(access.tornUserId) : state.myUserID;

                if (access.personalAccessReady === true && !options.skipPendingAutoActivate) {
                    await activateApprovedPersonalAccess({ silent: true });
                    return;
                }

                const pendingDot = document.getElementById('travel-tracker-status');
                if (pendingDot) pendingDot.className = 'tt-dot tt-dot--apikey';
                if (state.panelVisible) updatePanelContent();
                return;
            }

            if (state.registrationPending) setRegistrationPending(false);

            const data = await fetchState();
            state.authenticated = true;
            state.apiKeySet = !!data.myUserID;
            state.lastPollTime = Date.now();
            state.serverOnline = true;
            state.myUserID = data.myUserID ? String(data.myUserID) : null;
            state.myFactionID = data.myFactionID ? String(data.myFactionID) : null;
            state.myFactionName = data.myFactionName || null;
            sanitizeOpponentFactions();
            state.myDestination = data.myDestination || null;
            state.myTravelArrival = data.myTravelArrival == null ? null : Number(data.myTravelArrival);
            state.watchedFactions = {};

            for (const fid in data.factions || {}) {
                state.watchedFactions[fid] = {
                    name: data.factions[fid].name || 'Faction ' + fid,
                    members: data.factions[fid].members || {}
                };
            }

            const incomingIndividuals = data.individuals || {};
            for (const xid of [...state.pendingTrackedIds]) {
                if (incomingIndividuals[xid]) {
                    state.pendingTrackedIds.delete(xid);
                } else {
                    incomingIndividuals[xid] = state.trackedIndividuals[xid] || {
                        playerId: xid,
                        playerName: 'User ' + xid,
                        status: 'idle',
                        destination: null,
                        origin: null,
                        flightType: null,
                        lookupDest: null,
                        travelStarted: null,
                        landedAt: null,
                        tbs: null,
                        tbs_human: null,
                        lastAction: null
                    };
                }
            }
            state.trackedIndividuals = incomingIndividuals;

            myBattleStats = null;
            const myId = String(state.myUserID || '');
            if (myId) {
                for (const fid in state.watchedFactions) {
                    const me = state.watchedFactions[fid]?.members?.[myId];
                    if (me?.tbs != null) {
                        myBattleStats = Number(me.tbs);
                        break;
                    }
                }
                if (!myBattleStats && state.trackedIndividuals[myId]?.tbs != null) myBattleStats = Number(state.trackedIndividuals[myId].tbs);
            }

            const notificationSources = { ...state.watchedFactions };
            const standaloneTracked = getStandaloneTrackedIndividuals();
            if (Object.keys(standaloneTracked).length) notificationSources.__tracked__ = { name: 'Tracked players', members: standaloneTracked };

            detectNewFlights(notificationSources);
            detectLandingAlerts(notificationSources);
            updateThreatOverlay();

            state.previousMembers = {};
            for (const fid in notificationSources) state.previousMembers[fid] = JSON.parse(JSON.stringify(notificationSources[fid]?.members || {}));

            try {
                await refreshAccessStatus(false);
                if (isAdminUser()) await refreshAdminRequests(false);
            } catch (e) {}

            const dot = document.getElementById('travel-tracker-status');
            if (dot) dot.className = state.apiKeySet ? 'tt-dot tt-dot--online' : 'tt-dot tt-dot--apikey';

            if (state.panelVisible) {
                const panel = document.getElementById('travel-panel');
                const scrollTop = panel ? panel.scrollTop : 0;
                updatePanelContent();
                if (panel) panel.scrollTop = scrollTop;
                updateLiveTimers();
            }
        } catch (e) {
            if (e.status === 401) {
                state.authenticated = false;
                state.apiKeySet = false;
                state.serverOnline = true;
            } else {
                state.serverOnline = false;
            }
            const dot = document.getElementById('travel-tracker-status');
            if (dot) dot.className = state.serverOnline ? 'tt-dot tt-dot--apikey' : 'tt-dot tt-dot--offline';
        }
    }

    function startPolling() {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = setInterval(pollServer, CLOUD_POLL_INTERVAL);
    }

    // ==================== UI ACTIONS ====================
    async function addFactionToWatch(fid) {
        if (!state.apiKeySet) {
            alert('Finish your Cloudflare tracker setup first.');
            return;
        }
        const name = scrapeFactionNameFromPage() || ('Faction ' + fid);
        try {
            await cloudRequest('POST', '/client/factions', { factionId: fid, factionName: name });
            await pollServer();
            state.selectedFactionId = fid;
            if (!state.panelVisible) createPanel();
            else updatePanelContent();
        } catch (e) {
            alert('Failed: ' + e.message);
        }
    }

    async function removeWatchedFaction(fid) {
        if (String(fid) === String(state.myFactionID)) return;
        try {
            await cloudRequest('DELETE', '/client/factions/' + encodeURIComponent(fid));
            if (state.selectedFactionId === fid) state.selectedFactionId = null;
            state.warFactions.delete(String(fid));
            saveOpponentFactions();
            await pollServer();
            if (state.panelVisible) updatePanelContent();
        } catch (e) {
            alert('Failed: ' + e.message);
        }
    }

    async function addTrackedPlayer(playerId) {
        if (!state.apiKeySet) {
            alert('Finish your Cloudflare tracker setup first.');
            return;
        }
        if (String(playerId) === String(state.myUserID)) {
            alert('You do not need to TRACK yourself.');
            return;
        }
        try {
            const result = await cloudRequest('POST', '/client/subscriptions', { playerId });
            const id = String(playerId);
            const p = result?.player || null;

            if (result?.initialized && p) {
                const destination = p.destination || null;
                const origin = p.origin || null;
                state.pendingTrackedIds.delete(id);
                state.trackedIndividuals[id] = {
                    playerId: id,
                    playerName: p.player_name || ('User ' + id),
                    factionId: p.faction_id || null,
                    status: p.status || 'idle',
                    rawStatus: p.raw_status || null,
                    destination,
                    origin,
                    flightType: p.flight_type || null,
                    lookupDest: destination === 'Torn' ? origin : (destination || origin || null),
                    travelStarted: p.travel_started == null ? null : Number(p.travel_started),
                    landedAt: p.landed_at == null ? null : Number(p.landed_at),
                    tbs: p.tbs == null ? null : Number(p.tbs),
                    tbs_human: p.tbs_human || null,
                    lastAction: p.last_action == null ? null : Number(p.last_action)
                };
            } else {
                state.pendingTrackedIds.add(id);
                if (!state.trackedIndividuals[id]) {
                    state.trackedIndividuals[id] = {
                        playerId: id,
                        playerName: 'User ' + id,
                        status: 'idle',
                        destination: null,
                        origin: null,
                        flightType: null,
                        lookupDest: null,
                        travelStarted: null,
                        landedAt: null,
                        tbs: null,
                        tbs_human: null,
                        lastAction: null
                    };
                }
            }

            if (state.panelVisible) updatePanelContent();
            await pollServer();
        } catch (e) {
            alert('Failed: ' + e.message);
        }
    }

    async function removeTrackedPlayer(playerId) {
        try {
            await cloudRequest('DELETE', '/client/subscriptions/' + encodeURIComponent(playerId));
            state.pendingTrackedIds.delete(String(playerId));
            delete state.trackedIndividuals[playerId];
            await pollServer();
            if (state.panelVisible) updatePanelContent();
            return true;
        } catch (e) {
            alert('Failed: ' + e.message);
            return false;
        }
    }

    async function runTrackedPlayerAction(playerId, actionMode, button = null) {
        const id = String(playerId || '').trim();
        const mode = String(actionMode || '').toLowerCase();

        if (!/^\d+$/.test(id)) {
            alert('Enter a valid Torn player ID.');
            return false;
        }

        if (mode !== 'track' && mode !== 'untrack') return false;
        if (state.trackedActionBusy.has(id)) return false;

        state.trackedActionBusy.add(id);

        const originalText = button?.textContent || '';
        if (button) {
            button.disabled = true;
            button.setAttribute('aria-busy', 'true');
            button.textContent = mode === 'untrack' ? 'UNTRACKING...' : 'TRACKING...';
        }

        try {
            if (mode === 'untrack') return await removeTrackedPlayer(id);
            return await addTrackedPlayer(id);
        } finally {
            state.trackedActionBusy.delete(id);
            if (button?.isConnected) {
                button.disabled = false;
                button.removeAttribute('aria-busy');
                button.textContent = originalText || (mode === 'untrack' ? 'UNTRACK' : 'TRACK');
            }
        }
    }

    function saveOpponentFactions() {
        GM_setValue('warFactions', JSON.stringify([...state.warFactions]));
    }

    function sanitizeOpponentFactions() {
        const ownId = String(state.myFactionID || '').trim();

        if (!ownId) return false;

        const changed = state.warFactions.delete(ownId);

        if (changed) saveOpponentFactions();

        return changed;
    }

    function isOpponentFaction(fid) {
        const id = String(fid || '').trim();

        if (!id) return false;
        if (id === String(state.myFactionID || '')) return false;

        return state.warFactions.has(id);
    }

    function toggleWarFaction(fid) {
        const id = String(fid || '').trim();

        if (!id) return;

        if (id === String(state.myFactionID || '')) {
            state.warFactions.delete(id);
            saveOpponentFactions();
            updateThreatOverlay();
            return;
        }

        if (state.warFactions.has(id)) state.warFactions.delete(id);
        else state.warFactions.add(id);

        saveOpponentFactions();
        updatePanelContent();
        updateThreatOverlay();
    }

    function detectWarFactionsFromPage() {
        if (window.location.href.includes('war.php') || window.location.href.includes('factions.php?step=war')) {
            document.querySelectorAll('.war-status, .war-declare, .faction-war').forEach(el => {
                const factionLink = el.querySelector('a[href*="factions.php?step=profile&ID="]');

                if (!factionLink) return;

                const fid = new URLSearchParams(factionLink.href.split('?')[1]).get('ID');

                if (!fid) return;
                if (String(fid) === String(state.myFactionID || '')) return;

                if (!state.warFactions.has(String(fid))) {
                    state.warFactions.add(String(fid));
                    saveOpponentFactions();
                }
            });
        }
    }

    // ==================== DESKTOP GUTTER LAYOUT ====================
    const TT_DESKTOP_GUTTER_MIN_WIDTH = 300;
    const TT_DESKTOP_PANEL_MAX_WIDTH = 440;
    const TT_DESKTOP_EDGE_GAP = 8;
    const TT_DESKTOP_SIDEBAR_GAP = 8;
    let ttLayoutWatchersInstalled = false;
    let ttSidebarResizeObserver = null;

    function getTrackerDesktopGutterLayout() {
        const sidebar = document.getElementById('sidebarroot');
        if (!sidebar || window.innerWidth < 900) return null;

        const rect = sidebar.getBoundingClientRect();
        const sidebarLeft = Math.round(rect.left);
        const usableWidth = sidebarLeft - TT_DESKTOP_EDGE_GAP - TT_DESKTOP_SIDEBAR_GAP;

        if (!Number.isFinite(sidebarLeft) || usableWidth < TT_DESKTOP_GUTTER_MIN_WIDTH) return null;

        const width = Math.min(TT_DESKTOP_PANEL_MAX_WIDTH, usableWidth);
        const left = Math.max(
            TT_DESKTOP_EDGE_GAP,
            sidebarLeft - TT_DESKTOP_SIDEBAR_GAP - width
        );

        return {
            left,
            width,
            sidebarLeft,
            top: TT_DESKTOP_EDGE_GAP,
            bottom: TT_DESKTOP_EDGE_GAP
        };
    }

    function applyFloatingIconPosition() {
        const icon = document.getElementById('travel-float-icon');
        if (!icon) return;

        const desktop = getTrackerDesktopGutterLayout();
        icon.style.right = 'auto';
        icon.style.left = desktop ? `${Math.round(desktop.left + 8)}px` : '6px';
        icon.style.bottom = desktop ? '20px' : '45px';
    }

    function syncTrackerPanelOverlay(useDesktopGutter) {
        let overlay = document.getElementById('travel-panel-overlay');

        if (useDesktopGutter) {
            overlay?.remove();
            return;
        }

        if (overlay) return;

        overlay = document.createElement('div');
        overlay.id = 'travel-panel-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.3);z-index:9998;';
        overlay.addEventListener('click', closePanel);
        document.body.appendChild(overlay);
    }

    function applyTrackerPanelLayout(panel, opening = false) {
        if (!panel) return false;

        const desktop = getTrackerDesktopGutterLayout();
        const useDesktopGutter = !!desktop;
        panel.dataset.ttLayout = useDesktopGutter ? 'desktop-gutter' : 'mobile-sheet';

        Object.assign(panel.style, {
            position: 'fixed',
            background: 'var(--tt-bg-elevated)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            padding: '16px 16px 20px 16px',
            zIndex: '999999',
            color: 'var(--tt-text-main)',
            display: 'flex',
            flexDirection: 'column',
            boxSizing: 'border-box',
            overflowY: 'auto',
            overflowX: 'hidden',
            overscrollBehavior: 'contain',
            WebkitOverflowScrolling: 'touch',
            scrollbarGutter: 'stable',
            transition: 'transform var(--tt-transition-med), opacity var(--tt-transition-fast)'
        });

        if (useDesktopGutter) {
            Object.assign(panel.style, {
                left: `${Math.round(desktop.left)}px`,
                right: 'auto',
                top: `${desktop.top}px`,
                bottom: `${desktop.bottom}px`,
                width: `${Math.round(desktop.width)}px`,
                height: `calc(100vh - ${desktop.top + desktop.bottom}px)`,
                maxHeight: 'none',
                borderRadius: '12px',
                border: '1px solid rgba(255,255,255,0.10)',
                boxShadow: '0 14px 36px rgba(0,0,0,0.72)',
                transform: opening ? 'translateX(-18px)' : 'translateX(0)',
                opacity: opening ? '0' : '1'
            });
        } else {
            Object.assign(panel.style, {
                left: '0',
                right: 'auto',
                top: 'auto',
                bottom: '0',
                width: '100vw',
                height: 'auto',
                maxHeight: '85vh',
                borderRadius: 'var(--tt-radius-lg) var(--tt-radius-lg) 0 0',
                border: 'none',
                boxShadow: 'var(--tt-shadow-strong)',
                transform: opening ? 'translateY(100%)' : 'translateY(0)',
                opacity: '1'
            });
        }

        syncTrackerPanelOverlay(useDesktopGutter);
        return useDesktopGutter;
    }

    function syncTrackerDesktopLayout() {
        applyFloatingIconPosition();
        const panel = document.getElementById('travel-panel');
        if (panel) applyTrackerPanelLayout(panel, false);
    }

    function installTrackerLayoutWatchers() {
        if (ttLayoutWatchersInstalled) return;
        ttLayoutWatchersInstalled = true;

        let resizeFrame = 0;
        const queueSync = () => {
            cancelAnimationFrame(resizeFrame);
            resizeFrame = requestAnimationFrame(syncTrackerDesktopLayout);
        };

        window.addEventListener('resize', queueSync, { passive: true });

        const observeSidebar = () => {
            const sidebar = document.getElementById('sidebarroot');
            if (!sidebar || typeof ResizeObserver !== 'function') return;
            ttSidebarResizeObserver?.disconnect();
            ttSidebarResizeObserver = new ResizeObserver(queueSync);
            ttSidebarResizeObserver.observe(sidebar);
        };

        observeSidebar();
        setTimeout(() => {
            observeSidebar();
            queueSync();
        }, 1200);
    }

    // ==================== FLOATING ICON ====================
    function injectFloatingIcon() {
        document.getElementById('individual-float-icon')?.remove();
        if (document.getElementById('travel-float-icon')) return;

        const icon = document.createElement('div');
        icon.id = 'travel-float-icon';
        icon.title = 'Doits Flight Tracker';

        Object.assign(icon.style, {
            position: 'fixed',
            bottom: '45px',
            right: 'auto',
            left: '6px',
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

        icon.innerHTML = '<span style="font-size:20px;line-height:1;">\u2708\uFE0F</span>';

        const dot = document.createElement('div');
        dot.id = 'travel-tracker-status';
        dot.className = 'tt-dot tt-dot--offline';
        dot.style.cssText = 'position:absolute;top:4px;right:8px;width:10px;height:10px;border-radius:50%;border:1px solid #000;';
        icon.appendChild(dot);

        icon.addEventListener('click', () => {
            if (state.panelVisible) {
                closePanel();
                return;
            }
            state.selectedFactionId = null;
            createPanel(state.panelMode || 'factions');
        });

        document.body.appendChild(icon);
        applyFloatingIconPosition();
        installTrackerLayoutWatchers();
    }

    // ==================== STYLES ====================
    function injectGlobalStyles() {
        document.getElementById('travel-tracker-global-styles')?.remove();

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

      #travel-float-icon { -webkit-tap-highlight-color:transparent; }
      .tt-panel { font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
      .tt-scrollbar::-webkit-scrollbar { width:4px; }
      .tt-scrollbar::-webkit-scrollbar-track { background:transparent; }
      .tt-scrollbar::-webkit-scrollbar-thumb { background:rgba(255,255,255,0.15);border-radius:2px; }

      .tt-chip { display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:600;letter-spacing:0.02em;text-transform:uppercase; }
      .tt-chip-soft { background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);color:var(--tt-text-soft); }
      .tt-chip-accent { background:var(--tt-accent-soft);border:1px solid rgba(33,150,243,0.5);color:#E3F2FD; }
      .tt-chip-success { background:rgba(76,175,80,0.15);border:1px solid rgba(76,175,80,0.5);color:#C8E6C9; }
      .tt-chip-warning { background:rgba(255,179,0,0.15);border:1px solid rgba(255,179,0,0.6);color:#FFE082; }
      .tt-chip-danger { background:rgba(239,83,80,0.15);border:1px solid rgba(239,83,80,0.6);color:#FFCDD2; }
      .tt-chip-purple { background:rgba(156,39,176,0.15);border:1px solid rgba(156,39,176,0.6);color:#E1BEE7; }

      .tt-tab-row { display:flex;gap:4px;padding:3px;background:rgba(255,255,255,0.04);border-radius:999px;border:1px solid rgba(255,255,255,0.06);flex:1; }
      .tt-tab { flex:1;border-radius:999px;padding:8px 4px;font-size:12px;font-weight:600;text-align:center;cursor:pointer;color:var(--tt-text-soft);border:none;background:transparent;transition:background var(--tt-transition-fast),color var(--tt-transition-fast);touch-action:manipulation; }
      .tt-tab.tt-active { background:rgba(255,255,255,0.1);color:var(--tt-text-main); }
      .tt-tab.tt-abroad { color:#4FC3F7; }
      .tt-tab.tt-abroad.tt-active { background:rgba(79,195,247,0.2);color:#E1F5FE; }

      .tt-row { display:flex;align-items:center;justify-content:space-between;gap:8px; }
      .tt-row-gap { display:flex;align-items:center;gap:6px;flex-wrap:wrap; }

      .tt-member-card { position:relative;overflow:hidden;background:var(--tt-bg-card);border-radius:var(--tt-radius-md);border:1px solid var(--tt-border-subtle);padding:12px 14px;margin-bottom:8px;box-shadow:var(--tt-shadow-soft);cursor:pointer;touch-action:manipulation; }
      .tt-member-card--same-dest { border-color:rgba(183,28,28,0.9);box-shadow:0 0 0 1px rgba(183,28,28,0.5),var(--tt-shadow-soft);background:radial-gradient(circle at 0 0,rgba(183,28,28,0.25),transparent 55%),var(--tt-bg-card); }
      .tt-member-card--self { border-color:#FFD700;box-shadow:0 0 12px #FFD70040,0 0 0 1px rgba(255,215,0,0.5),var(--tt-shadow-soft); }
      .tt-member-main { display:flex;justify-content:space-between;align-items:center;gap:6px; }
      .tt-member-name { font-size:15px;font-weight:600;color:var(--tt-text-main);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:55%; }
      .tt-member-name a { color:inherit;text-decoration:none; }
      .tt-member-name a:active { opacity:0.7; }
      .tt-member-route { font-size:13px;color:var(--tt-text-muted);text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:45%; }
      .tt-member-meta { display:flex;justify-content:space-between;align-items:center;margin-top:6px;font-size:12px;color:var(--tt-text-soft);flex-wrap:wrap;gap:4px; }

      .tt-progress-shell-new { margin-top:8px; }
      .tt-progress-flags-row { display:flex;align-items:center;gap:8px;justify-content:center; }
      .tt-circular-flag img { width:28px;height:28px;border-radius:50%;border:1px solid rgba(255,255,255,0.2);background:#1a1a1a;display:block; }
      .tt-progress-track-new { position:relative;flex:1;height:8px;background:rgba(255,255,255,0.08);border-radius:999px;overflow:visible;max-width:100%; }
      .tt-progress-fill-new { position:absolute;top:0;height:100%;border-radius:999px;transition:width 1s linear,background 0.2s; }
      .tt-progress-plane-new { position:absolute;top:50%;font-size:16px;filter:drop-shadow(0 1px 3px rgba(0,0,0,0.8));transition:left 1s linear,transform 0.2s;pointer-events:none;z-index:1;transform:translate(-50%,-50%) rotate(45deg); }
      .tt-progress-ghost-fill { position:absolute;top:0;height:100%;border-radius:999px;background:rgba(255,0,0,0.2);transition:width 1s linear,left 1s linear;opacity:0.6;pointer-events:none;z-index:0; }
      .tt-progress-ghost-plane { position:absolute;top:50%;font-size:14px;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.3));transition:left 1s linear,transform 0.2s;pointer-events:none;z-index:0;opacity:0.35;transform:translate(-50%,-50%) rotate(45deg);color:#ff4444; }

      .tt-section-title { font-size:14px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:var(--tt-text-soft); }
      .tt-faction-card { background:var(--tt-bg-card-soft);border-radius:var(--tt-radius-md);border:1px solid var(--tt-border-subtle);padding:14px 16px;margin-bottom:8px;cursor:pointer;transition:background var(--tt-transition-fast),border-color var(--tt-transition-fast);box-shadow:var(--tt-shadow-soft);display:flex;justify-content:space-between;align-items:center;touch-action:manipulation; }
      .tt-faction-card:active { opacity:0.7; }
      .tt-faction-name { font-size:15px;font-weight:600;color:var(--tt-text-main);white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
      .tt-faction-sub { font-size:12px;color:var(--tt-text-soft);margin-top:2px; }

      .tt-kbd { display:inline-flex;align-items:center;justify-content:center;padding:2px 6px;border-radius:4px;border:1px solid rgba(255,255,255,0.15);font-size:10px;font-family:monospace;background:rgba(0,0,0,0.4);color:var(--tt-text-soft); }
      .tt-footer { position:sticky;bottom:-16px;margin:12px -16px -18px -16px;padding:12px 16px 18px 16px;background:linear-gradient(to top,rgba(0,0,0,0.9),transparent);display:flex;justify-content:space-between;align-items:center;font-size:11px;color:var(--tt-text-soft); }

      .tt-dot { width:10px;height:10px;border-radius:50%;border:1px solid #000; }
      .tt-dot--online { background:var(--tt-success); }
      .tt-dot--offline { background:var(--tt-danger); }
      .tt-dot--apikey { background:var(--tt-warning); }
      .tt-dot--gist { background:#9C27B0; }

      .tt-watch-btn { background:none;border:1px solid rgba(255,255,255,0.15);border-radius:999px;color:#fff;cursor:pointer;padding:8px 14px;font-size:13px;font-weight:600;touch-action:manipulation; }
      .tt-watch-btn--active { background:rgba(76,175,80,0.25);border-color:rgba(76,175,80,0.6); }
      .tt-watch-btn:active { opacity:0.6; }

      .tt-war-toggle { font-size:11px;padding:6px 12px;border-radius:999px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.05);color:var(--tt-text-soft);cursor:pointer;touch-action:manipulation; }
      .tt-war-toggle.active { background:rgba(239,83,80,0.25);border-color:rgba(239,83,80,0.8);color:#FFCDD2; }
      .tt-war-toggle { min-width:88px; }
      .tt-war-toggle:active { opacity:0.6; }

      .tt-copy-all-btn { background:rgba(255,215,0,0.15);border:1px solid rgba(255,215,0,0.5);border-radius:50%;color:#FFE082;font-size:20px;width:44px;height:44px;padding:0;cursor:pointer;display:flex;align-items:center;justify-content:center;touch-action:manipulation; }
      .tt-copy-all-btn:active { opacity:0.6; }

      .tt-business-toggle { display:inline-flex;align-items:center;gap:3px;font-size:9px;color:var(--tt-text-soft);cursor:pointer;user-select:none; }
      .tt-business-toggle input[type="checkbox"] { margin:0;width:12px;height:12px;accent-color:#FFD700;cursor:pointer; }
      .tt-biz-window { margin-top:4px;font-size:11px;color:#00BCD4;font-weight:500; }

      .tt-abroad-filter-row { display:flex;gap:4px;padding:3px;margin-bottom:10px;background:rgba(255,255,255,0.04);border-radius:999px;border:1px solid rgba(255,255,255,0.06); }
      .tt-abroad-filter { flex:1;border:none;border-radius:999px;padding:7px 8px;font-size:11px;font-weight:700;background:transparent;color:var(--tt-text-soft);cursor:pointer;touch-action:manipulation; }
      .tt-abroad-filter.active { background:rgba(255,255,255,0.1);color:var(--tt-text-main); }
      .tt-abroad-filter.danger.active { background:rgba(239,83,80,0.25);color:#FFCDD2; }

      .tt-abroad-country { background:var(--tt-bg-card);border:1px solid var(--tt-border-subtle);border-radius:12px;margin-bottom:12px;overflow:hidden;box-shadow:var(--tt-shadow-soft);cursor:pointer;touch-action:manipulation;transition:border-color var(--tt-transition-fast),box-shadow var(--tt-transition-fast); }
      .tt-abroad-country:active { opacity:0.92; }
      .tt-abroad-country--risk { border-color:rgba(239,83,80,0.9);box-shadow:0 0 0 1px rgba(239,83,80,0.35),var(--tt-shadow-soft);background:radial-gradient(circle at 0 0,rgba(239,83,80,0.18),transparent 48%),var(--tt-bg-card); }
      .tt-abroad-country-header { padding:10px 12px;display:flex;align-items:center;justify-content:space-between;gap:8px;border-bottom:1px solid var(--tt-border-subtle);background:rgba(255,255,255,0.035); }
      .tt-abroad-country--risk .tt-abroad-country-header { background:rgba(239,83,80,0.16); }
      .tt-abroad-country-name { font-size:14px;font-weight:800;color:var(--tt-text-main);line-height:1.2; }
      .tt-abroad-summary { font-size:10px;color:var(--tt-text-soft);text-align:right;white-space:nowrap; }

      .tt-abroad-risk-banner { margin:10px 12px 0;padding:8px 10px;border-radius:8px;background:rgba(239,83,80,0.18);border:1px solid rgba(239,83,80,0.6);color:#FFCDD2;font-size:11px;font-weight:700;line-height:1.35; }

      .tt-abroad-side { padding:9px 10px 10px; }
      .tt-abroad-side + .tt-abroad-side { border-top:1px solid rgba(255,255,255,0.07); }

      .tt-abroad-side-title { display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:8px;cursor:pointer;user-select:none;touch-action:manipulation; }
      .tt-abroad-side-title--friendly { color:#C8E6C9; }
      .tt-abroad-side-title--enemy { color:#FFCDD2; }
      .tt-abroad-side-title-right { display:flex;align-items:center;gap:8px; }
      .tt-abroad-collapse-icon { font-size:11px;color:var(--tt-text-soft); }

      .tt-abroad-side.collapsed .tt-abroad-side-body { display:none; }

      .tt-abroad-subtitle { margin:8px 0 5px;font-size:10px;font-weight:800;color:var(--tt-text-soft);text-transform:uppercase;letter-spacing:0.05em; }

      .tt-abroad-person { display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.04); }
      .tt-abroad-person:last-child { border-bottom:none; }
      .tt-abroad-person-left { min-width:0;display:flex;align-items:center;gap:6px;flex-wrap:wrap; }
      .tt-abroad-name { font-size:13px;font-weight:700;color:var(--tt-text-main);text-decoration:none;min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
      .tt-abroad-meta { font-size:10px;color:var(--tt-text-soft);white-space:nowrap;text-align:right; }
      .tt-at-risk-indicator { display:inline-flex;align-items:center;justify-content:center;padding:2px 6px;border-radius:999px;background:rgba(239,83,80,0.16);border:1px solid rgba(239,83,80,0.55);color:#FFCDD2;font-size:9px;font-weight:800; }

      .tt-abroad-empty { padding:16px;border-radius:var(--tt-radius-md);border:1px dashed rgba(255,255,255,0.15);text-align:center;font-size:13px;color:var(--tt-text-soft); }


      .tt-tracked-card { background:var(--tt-bg-card-soft);border:1px solid var(--tt-border-subtle);border-radius:var(--tt-radius-md);padding:10px 12px;margin-bottom:7px;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center;box-shadow:var(--tt-shadow-soft); }
      .tt-tracked-name { color:var(--tt-text-main);font-size:13px;font-weight:700;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
      .tt-tracked-meta { margin-top:3px;color:var(--tt-text-soft);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
      .tt-tracked-stop { border:1px solid rgba(239,83,80,0.5);background:rgba(239,83,80,0.14);color:#FFCDD2;border-radius:999px;padding:5px 9px;font-size:10px;font-weight:700;cursor:pointer; }
      .tt-player-action { border:1px solid rgba(76,175,80,0.55);background:rgba(76,175,80,0.16);color:#C8E6C9;border-radius:999px;padding:7px 13px;font-size:11px;font-weight:800;cursor:pointer;touch-action:manipulation; }
      .tt-player-action--untrack { border-color:rgba(239,83,80,0.55);background:rgba(239,83,80,0.16);color:#FFCDD2; }
      .tt-player-action:active { opacity:0.65; }
      .tt-player-empty { padding:18px;border-radius:var(--tt-radius-md);border:1px dashed rgba(255,255,255,0.15);text-align:center;font-size:13px;color:var(--tt-text-soft); }
      .tt-main-mode-tabs { display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-top:10px;padding:3px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.07);border-radius:8px; }
      .tt-main-mode-tab { border:0;border-radius:5px;padding:8px 10px;background:transparent;color:var(--tt-text-soft);font-size:11px;font-weight:800;letter-spacing:0.04em;cursor:pointer;touch-action:manipulation; }
      .tt-main-mode-tab.active { background:rgba(255,255,255,0.11);color:var(--tt-text-main);box-shadow:inset 0 0 0 1px rgba(255,255,255,0.06); }
      .tt-main-mode-tab:active { opacity:0.7; }

      .tt-admin-entry { position:relative;border:1px solid rgba(255,179,0,0.45);background:rgba(255,179,0,0.10);color:#FFE082;border-radius:6px;padding:7px 9px;font-size:10px;font-weight:900;letter-spacing:0.04em;cursor:pointer;touch-action:manipulation; }
      .tt-admin-entry:active { opacity:0.65; }
      .tt-admin-entry--attention { border-color:rgba(239,83,80,0.9);background:rgba(239,83,80,0.18);color:#FFCDD2;animation:tt-admin-pulse 1.25s ease-in-out infinite; }
      .tt-admin-badge { display:inline-flex;align-items:center;justify-content:center;min-width:17px;height:17px;margin-left:5px;padding:0 4px;border-radius:4px;background:#EF5350;color:white;font-size:9px;font-weight:900;box-sizing:border-box; }
      @keyframes tt-admin-pulse { 0%,100%{box-shadow:0 0 0 0 rgba(239,83,80,0.15);} 50%{box-shadow:0 0 0 5px rgba(239,83,80,0.12);} }

      .tt-access-banner { margin:8px 0 0;padding:9px 10px;border:1px solid rgba(255,179,0,0.55);background:rgba(255,179,0,0.12);border-radius:8px;font-size:11px;line-height:1.4;color:#FFE082; }
      .tt-access-banner strong { color:#fff; }
      .tt-support-admin-link { color:#81D4FA;text-decoration:none;font-weight:800; }
      .tt-support-admin-link:active { opacity:0.65; }
      .tt-access-screen { padding:22px 8px 8px;text-align:center; }
      .tt-access-screen-icon { font-size:38px;line-height:1; }
      .tt-access-screen-title { margin-top:10px;font-size:18px;font-weight:900; }
      .tt-access-screen-copy { margin:8px auto 0;max-width:460px;font-size:13px;line-height:1.55;color:var(--tt-text-muted); }
      .tt-access-actions { display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:16px; }
      .tt-access-primary { border:1px solid rgba(76,175,80,0.6);background:rgba(76,175,80,0.16);color:#C8E6C9;border-radius:7px;padding:9px 12px;font-size:11px;font-weight:900;cursor:pointer; }
      .tt-access-secondary { border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.06);color:#fff;border-radius:7px;padding:9px 12px;font-size:11px;font-weight:800;cursor:pointer; }

      .tt-setup-shell { padding:16px 4px 6px;text-align:center; }
      .tt-setup-icon { font-size:38px;line-height:1; }
      .tt-setup-title { margin-top:9px;font-size:19px;font-weight:900;color:#fff; }
      .tt-setup-copy { margin:7px auto 0;max-width:430px;font-size:12px;line-height:1.5;color:var(--tt-text-muted); }
      .tt-setup-card { max-width:430px;margin:16px auto 0;padding:14px;text-align:left;background:var(--tt-bg-card);border:1px solid var(--tt-border-subtle);border-radius:10px;box-shadow:var(--tt-shadow-soft); }
      .tt-setup-label { display:block;margin:0 0 5px;font-size:10px;font-weight:900;letter-spacing:0.05em;text-transform:uppercase;color:var(--tt-text-soft); }
      .tt-setup-input { width:100%;box-sizing:border-box;border:1px solid rgba(255,255,255,0.14);border-radius:7px;background:rgba(0,0,0,0.35);color:#fff;padding:10px 11px;font-size:13px;outline:none; }
      .tt-setup-input:focus { border-color:rgba(33,150,243,0.7);box-shadow:0 0 0 2px rgba(33,150,243,0.12); }
      .tt-setup-help { margin-top:5px;font-size:10px;line-height:1.4;color:var(--tt-text-soft); }
      .tt-setup-error { min-height:16px;margin-top:9px;font-size:11px;line-height:1.4;color:#FFCDD2; }
      .tt-setup-submit { width:100%;margin-top:6px;border:1px solid rgba(76,175,80,0.6);background:rgba(76,175,80,0.18);color:#C8E6C9;border-radius:7px;padding:10px 12px;font-size:11px;font-weight:900;cursor:pointer; }
      .tt-setup-submit:disabled { opacity:0.55;cursor:default; }
      .tt-pending-box { max-width:440px;margin:14px auto 0;padding:13px 14px;border-radius:9px;background:rgba(255,179,0,0.10);border:1px solid rgba(255,179,0,0.45);text-align:left; }
      .tt-pending-line { display:flex;justify-content:space-between;gap:12px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.05);font-size:11px; }
      .tt-pending-line:last-child { border-bottom:0; }


      /* v18.2.6 - admin-matched universal onboarding */
      #travel-panel .tt-onboard-shell,
      #travel-panel .tt-onboard-shell * { box-sizing:border-box; }
      #travel-panel .tt-onboard-shell { min-height:100%;display:flex;flex-direction:column;text-align:left;color:#F5F5F5 !important;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif !important;font-size:12px !important;line-height:1.35 !important; }
      #travel-panel .tt-onboard-header { position:sticky;top:-16px;z-index:4;margin:-16px -16px 0;padding:14px 16px 13px;background:linear-gradient(to bottom,#050505 0%,#0B0B0B 78%,rgba(11,11,11,0.98) 100%) !important;border-bottom:1px solid rgba(255,255,255,0.08);display:flex;align-items:center;justify-content:space-between;gap:12px; }
      #travel-panel .tt-onboard-brand { min-width:0;display:flex;align-items:center;gap:10px; }
      #travel-panel .tt-onboard-mark { flex:0 0 auto;width:28px;height:28px;display:flex;align-items:center;justify-content:center;background:transparent !important;border:0 !important;border-radius:0 !important;color:#F5F5F5 !important;font-size:22px !important;line-height:1 !important; }
      #travel-panel .tt-onboard-brand-title { color:#FFFFFF !important;font-size:17px !important;font-weight:800 !important;line-height:1.1 !important;white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
      #travel-panel .tt-onboard-brand-sub { margin-top:2px;color:#8F8F8F !important;font-size:10px !important;font-weight:600 !important;line-height:1.2 !important; }
      #travel-panel .tt-onboard-header-actions { flex:0 0 auto;display:flex;align-items:center;gap:8px; }
      #travel-panel .tt-onboard-badge { min-width:62px;height:31px;padding:0 11px;display:inline-flex;align-items:center;justify-content:center;border-radius:7px !important;background:#171717 !important;border:1px solid #444 !important;color:#F5F5F5 !important;font-size:10px !important;font-weight:900 !important;letter-spacing:0.04em !important;line-height:1 !important; }
      #travel-panel .tt-onboard-badge--setup { border-color:#4A4A4A !important;color:#F5F5F5 !important; }
      #travel-panel .tt-onboard-badge--pending { border-color:rgba(255,179,0,0.58) !important;background:rgba(255,179,0,0.11) !important;color:#FFE082 !important; }
      #travel-panel .tt-onboard-badge--approved { border-color:rgba(76,175,80,0.58) !important;background:rgba(76,175,80,0.11) !important;color:#C8E6C9 !important; }
      #travel-panel .tt-onboard-badge--attention { border-color:rgba(239,83,80,0.62) !important;background:rgba(239,83,80,0.11) !important;color:#FFCDD2 !important; }
      #travel-panel button.tt-onboard-close { appearance:none !important;-webkit-appearance:none !important;width:34px;height:34px;margin:0;padding:0 !important;display:flex;align-items:center;justify-content:center;border:0 !important;background:transparent !important;color:#A8A8A8 !important;font-family:inherit !important;font-size:28px !important;font-weight:300 !important;line-height:1 !important;cursor:pointer;touch-action:manipulation; }
      #travel-panel button.tt-onboard-close:active { color:#FFFFFF !important;opacity:0.65; }
      #travel-panel .tt-onboard-body { width:100%;max-width:none;margin:0 auto;padding-top:17px; }
      #travel-panel .tt-onboard-section-head { display:flex;align-items:flex-end;justify-content:space-between;gap:10px;margin-bottom:10px; }
      #travel-panel .tt-onboard-eyebrow { margin:0;color:#CFCFCF !important;font-size:12px !important;font-weight:900 !important;letter-spacing:0.055em !important;line-height:1.2 !important;text-transform:uppercase; }
      #travel-panel .tt-onboard-title { margin:3px 0 0;color:#FFFFFF !important;font-size:15px !important;font-weight:800 !important;line-height:1.2 !important; }
      #travel-panel .tt-onboard-copy { margin:4px 0 0;color:#A8A8A8 !important;font-size:10px !important;font-weight:500 !important;line-height:1.45 !important;max-width:720px; }
      #travel-panel .tt-onboard-card { margin:0 0 10px;padding:13px;background:#1D1D1D !important;border:1px solid #383838 !important;border-radius:10px !important;box-shadow:0 4px 12px rgba(0,0,0,0.45) !important; }
      #travel-panel .tt-onboard-card--attention { border-color:rgba(239,83,80,0.48) !important;background:rgba(239,83,80,0.07) !important; }
      #travel-panel .tt-onboard-label { display:block;margin:0 0 7px;color:#D7D7D7 !important;font-size:10px !important;font-weight:900 !important;letter-spacing:0.065em !important;line-height:1.2 !important; }
      #travel-panel input.tt-onboard-input { appearance:none !important;-webkit-appearance:none !important;width:100% !important;height:44px !important;margin:0 !important;padding:0 12px !important;border:1px solid #515151 !important;border-radius:7px !important;background:#101010 !important;color:#FFFFFF !important;-webkit-text-fill-color:#FFFFFF !important;caret-color:#FFFFFF !important;font-family:inherit !important;font-size:13px !important;font-weight:600 !important;line-height:44px !important;outline:none !important;box-shadow:none !important; }
      #travel-panel input.tt-onboard-input::placeholder { color:#8B8B8B !important;-webkit-text-fill-color:#8B8B8B !important;opacity:1 !important; }
      #travel-panel input.tt-onboard-input:focus { border-color:#8A8A8A !important;box-shadow:0 0 0 2px rgba(255,255,255,0.07) !important; }
      #travel-panel .tt-onboard-info { margin-top:10px;padding:9px 10px;display:flex;align-items:flex-start;gap:9px;border:1px solid #333 !important;border-radius:7px !important;background:#151515 !important; }
      #travel-panel .tt-onboard-info-icon { flex:0 0 auto;width:18px;height:18px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:rgba(76,175,80,0.14) !important;border:1px solid rgba(76,175,80,0.42) !important;color:#C8E6C9 !important;font-size:10px !important;font-weight:900 !important;line-height:1 !important; }
      #travel-panel .tt-onboard-info-title { color:#E8E8E8 !important;font-size:9px !important;font-weight:900 !important;letter-spacing:0.05em !important;line-height:1.25 !important; }
      #travel-panel .tt-onboard-info-copy { margin-top:2px;color:#A8A8A8 !important;font-size:9px !important;font-weight:500 !important;line-height:1.4 !important; }
      #travel-panel .tt-onboard-error { min-height:16px;margin:8px 0 0;color:#FFCDD2 !important;font-size:10px !important;font-weight:700 !important;line-height:1.35 !important; }
      #travel-panel button.tt-onboard-primary { appearance:none !important;-webkit-appearance:none !important;width:100% !important;min-height:43px !important;margin:0 !important;padding:9px 12px !important;border:1px solid #555 !important;border-radius:7px !important;background:#292929 !important;color:#FFFFFF !important;-webkit-text-fill-color:#FFFFFF !important;font-family:inherit !important;font-size:11px !important;font-weight:900 !important;letter-spacing:0.045em !important;line-height:1.2 !important;text-align:center !important;text-shadow:none !important;box-shadow:none !important;cursor:pointer;touch-action:manipulation; }
      #travel-panel button.tt-onboard-primary--pending { border-color:rgba(255,179,0,0.62) !important;background:rgba(255,179,0,0.12) !important;color:#FFE082 !important;-webkit-text-fill-color:#FFE082 !important; }
      #travel-panel button.tt-onboard-primary--approved { border-color:rgba(76,175,80,0.62) !important;background:rgba(76,175,80,0.13) !important;color:#C8E6C9 !important;-webkit-text-fill-color:#C8E6C9 !important; }
      #travel-panel button.tt-onboard-primary--danger { border-color:rgba(239,83,80,0.62) !important;background:rgba(239,83,80,0.12) !important;color:#FFCDD2 !important;-webkit-text-fill-color:#FFCDD2 !important; }
      #travel-panel button.tt-onboard-primary:disabled { opacity:0.55 !important;cursor:default; }
      #travel-panel button.tt-onboard-primary:not(:disabled):active { background:#363636 !important;opacity:0.82; }
      #travel-panel .tt-onboard-security { margin-top:9px;color:#A0A0A0 !important;font-size:9px !important;font-weight:500 !important;line-height:1.42 !important; }
      #travel-panel .tt-onboard-secondary-row { margin-top:10px;padding:11px 12px;display:flex;align-items:center;justify-content:space-between;gap:12px;border:1px solid #353535 !important;border-radius:10px !important;background:#191919 !important;color:#BDBDBD !important;font-size:10px !important;font-weight:600 !important;line-height:1.35 !important; }
      #travel-panel button.tt-onboard-link-btn { appearance:none !important;-webkit-appearance:none !important;flex:0 0 auto;margin:0 !important;padding:7px 10px !important;border:1px solid #4B4B4B !important;border-radius:6px !important;background:#252525 !important;color:#FFFFFF !important;-webkit-text-fill-color:#FFFFFF !important;font-family:inherit !important;font-size:9px !important;font-weight:900 !important;letter-spacing:0.04em !important;line-height:1.1 !important;cursor:pointer;touch-action:manipulation; }
      #travel-panel button.tt-onboard-link-btn:active { background:#333 !important;opacity:0.8; }
      #travel-panel button.tt-onboard-legacy { appearance:none !important;-webkit-appearance:none !important;display:block;margin:8px 0 0 auto !important;padding:4px 0 !important;border:0 !important;background:transparent !important;color:#B0B0B0 !important;-webkit-text-fill-color:#B0B0B0 !important;font-family:inherit !important;font-size:9px !important;font-weight:700 !important;line-height:1.25 !important;text-decoration:underline !important;text-decoration-color:#666 !important;text-underline-offset:2px !important;cursor:pointer;touch-action:manipulation; }
      #travel-panel .tt-onboard-status-card { margin:0 0 10px;padding:3px 12px;background:#1D1D1D !important;border:1px solid #383838 !important;border-radius:10px !important;box-shadow:0 4px 12px rgba(0,0,0,0.45) !important; }
      #travel-panel .tt-onboard-status-row { min-height:39px;display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:1px solid rgba(255,255,255,0.07) !important;font-size:10px !important;line-height:1.25 !important; }
      #travel-panel .tt-onboard-status-row:last-child { border-bottom:0 !important; }
      #travel-panel .tt-onboard-status-row span { color:#A8A8A8 !important;font-weight:600 !important; }
      #travel-panel .tt-onboard-status-row strong { max-width:68%;color:#FFFFFF !important;font-size:10px !important;font-weight:800 !important;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
      #travel-panel .tt-onboard-status-row .tt-onboard-value--pending { color:#FFE082 !important; }
      #travel-panel .tt-onboard-status-row .tt-onboard-value--approved { color:#C8E6C9 !important; }
      #travel-panel .tt-onboard-actions { margin-top:0; }
      #travel-panel .tt-onboard-auto-note { margin-top:8px;padding:8px 10px;border:1px solid #303030 !important;border-radius:7px !important;background:#151515 !important;color:#A8A8A8 !important;font-size:9px !important;font-weight:500 !important;line-height:1.4 !important;display:flex;align-items:flex-start;gap:8px; }
      #travel-panel .tt-onboard-note-dot { width:7px;height:7px;margin-top:3px;flex:0 0 7px;border-radius:50%;background:#FFB300 !important;box-shadow:0 0 0 2px rgba(255,179,0,0.12); }
      #travel-panel .tt-onboard-note-dot--approved { background:#4CAF50 !important;box-shadow:0 0 0 2px rgba(76,175,80,0.12); }
      #travel-panel .tt-onboard-footer { position:sticky;bottom:-16px;margin:auto -16px -20px;padding:16px 16px 18px;background:linear-gradient(to top,rgba(0,0,0,0.95),rgba(0,0,0,0.55),transparent) !important;display:flex;align-items:center;justify-content:space-between;gap:8px;color:#8D8D8D !important;font-size:9px !important;font-weight:500 !important; }
      @media (max-width:520px) {
        #travel-panel .tt-onboard-header { padding-left:13px;padding-right:13px; }
        #travel-panel .tt-onboard-brand-title { font-size:16px !important; }
        #travel-panel .tt-onboard-secondary-row { align-items:flex-start;flex-direction:column;gap:8px; }
        #travel-panel button.tt-onboard-link-btn { width:100% !important; }
      }

      .tt-admin-tabs { display:grid;grid-template-columns:repeat(3,1fr);gap:4px;padding:3px;margin-top:10px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.07);border-radius:8px; }
      .tt-admin-tab { position:relative;border:0;border-radius:5px;padding:8px 5px;background:transparent;color:var(--tt-text-soft);font-size:10px;font-weight:900;letter-spacing:0.04em;cursor:pointer; }
      .tt-admin-tab.active { background:rgba(255,255,255,0.11);color:#fff; }
      .tt-admin-card { background:var(--tt-bg-card);border:1px solid var(--tt-border-subtle);border-radius:10px;padding:11px 12px;margin-bottom:8px;box-shadow:var(--tt-shadow-soft); }
      .tt-admin-card--attention { border-color:rgba(239,83,80,0.55);background:radial-gradient(circle at 0 0,rgba(239,83,80,0.12),transparent 50%),var(--tt-bg-card); }
      .tt-admin-card-title { font-size:14px;font-weight:800;color:#fff;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
      .tt-admin-card-sub { margin-top:3px;font-size:10px;color:var(--tt-text-soft);line-height:1.35; }
      .tt-admin-card-actions { display:flex;gap:6px;flex-wrap:wrap;margin-top:9px; }
      .tt-admin-action { border:1px solid rgba(255,255,255,0.16);background:rgba(255,255,255,0.05);color:#fff;border-radius:6px;padding:6px 8px;font-size:9px;font-weight:900;cursor:pointer;touch-action:manipulation; }
      .tt-admin-action--good { border-color:rgba(76,175,80,0.55);background:rgba(76,175,80,0.14);color:#C8E6C9; }
      .tt-admin-action--warn { border-color:rgba(255,179,0,0.55);background:rgba(255,179,0,0.14);color:#FFE082; }
      .tt-admin-action--danger { border-color:rgba(239,83,80,0.55);background:rgba(239,83,80,0.14);color:#FFCDD2; }
      .tt-admin-status { display:inline-flex;align-items:center;padding:2px 6px;border-radius:4px;font-size:9px;font-weight:900;text-transform:uppercase; }
      .tt-admin-status--active,.tt-admin-status--personal,.tt-admin-status--admin { background:rgba(76,175,80,0.14);border:1px solid rgba(76,175,80,0.45);color:#C8E6C9; }
      .tt-admin-status--grace,.tt-admin-status--pending { background:rgba(255,179,0,0.14);border:1px solid rgba(255,179,0,0.5);color:#FFE082; }
      .tt-admin-status--suspended,.tt-admin-status--disabled,.tt-admin-status--declined { background:rgba(239,83,80,0.14);border:1px solid rgba(239,83,80,0.5);color:#FFCDD2; }
      .tt-admin-empty { padding:18px;border:1px dashed rgba(255,255,255,0.15);border-radius:10px;text-align:center;color:var(--tt-text-soft);font-size:12px; }
      .tt-admin-code { margin-top:7px;padding:7px 8px;border:1px solid rgba(255,255,255,0.10);background:rgba(0,0,0,0.28);border-radius:6px;font-family:monospace;font-size:11px;color:#fff;word-break:break-all; }
      .tt-admin-section-head { display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:9px; }
      .tt-admin-section-title { font-size:13px;font-weight:900;text-transform:uppercase;letter-spacing:0.05em;color:var(--tt-text-muted); }

      @media (max-width:600px) {
        .tt-abroad-person { grid-template-columns:1fr;gap:3px;padding:7px 0; }
        .tt-abroad-meta { text-align:left;padding-left:0; }
        .tt-abroad-name { font-size:12px; }
      }
    `;

        document.head.appendChild(style);
    }

    function renderAdminEntryButton() {
        if (!isAdminUser()) return '';
        const count = Number(state.adminRequests?.pendingCount || 0);
        return `<button id="tt-admin-entry" class="tt-admin-entry ${count > 0 ? 'tt-admin-entry--attention' : ''}">ADMIN${count > 0 ? `<span class="tt-admin-badge">${count > 99 ? '99+' : count}</span>` : ''}</button>`;
    }

    function bindAdminEntryButton() {
        document.getElementById('tt-admin-entry')?.addEventListener('click', async e => {
            e.stopPropagation();
            state.panelMode = 'admin';
            state.selectedFactionId = null;
            updatePanelContent();
            await loadAdminPanelData(true);
        });
    }

    function renderAccessNotice() {
        const info = state.accessInfo;
        if (!info || info.accessType !== 'faction' || info.accessStatus !== 'grace') return '';

        const remaining = info.graceRemainingMs == null ? null : formatTime(info.graceRemainingMs);
        const request = info.latestRequest;
        const approval = info.personalAccessReady;
        let action = '';

        if (approval) action = ' Personal Access has been approved.';
        else if (request?.status === 'pending') action = ' Personal Access request pending.';

        const actions = approval
            ? '<div class="tt-admin-card-actions" style="margin-top:7px;"><button id="tt-activate-approved" class="tt-admin-action tt-admin-action--good">ACTIVATE PERSONAL ACCESS</button></div>'
            : request?.status === 'pending'
                ? ''
                : info.canRequestPersonal
                    ? '<div class="tt-admin-card-actions" style="margin-top:7px;"><button id="tt-request-personal" class="tt-admin-action tt-admin-action--good">REQUEST PERSONAL ACCESS</button><button id="tt-enter-personal-code" class="tt-admin-action">ENTER CODE</button></div>'
                    : '';

        return `<div class="tt-access-banner"><strong>FACTION ACCESS - GRACE</strong>${remaining ? ` - ${remaining} remaining` : ''}. Your tracker is still running. Contact ${getSupportAdminHtml()} if you should keep access.${action}${actions}</div>`;
    }

    function renderAccessRecoveryScreen() {
        const info = state.accessInfo || {};
        const status = String(info.accessStatus || 'suspended').toUpperCase();
        const pending = info.latestRequest?.status === 'pending';
        const ready = info.personalAccessReady === true;

        let statusCopy = '';
        if (ready) {
            statusCopy = '<strong style="color:#C8E6C9;">Personal Access has been approved.</strong> Activate it below to restore full tracking.';
        } else if (pending) {
            statusCopy = '<strong style="color:#FFE082;">Your Personal Access request is waiting for an administrator.</strong>';
        } else {
            statusCopy = `Contact ${getSupportAdminHtml()} if you should retain access, then request Personal Access below.`;
        }

        return `<div class="tt-access-screen">
          <div class="tt-access-screen-icon">&#128274;</div>
          <div class="tt-access-screen-title">FACTION ACCESS ${escapeHtml(status)}</div>
          <div class="tt-access-screen-copy">Your Torn account is no longer showing as a member of the faction that granted this tracker access. ${statusCopy}</div>
          <div class="tt-access-actions">
            ${ready ? '<button id="tt-activate-approved" class="tt-access-primary">ACTIVATE PERSONAL ACCESS</button>' : ''}
            ${!ready && !pending && info.canRequestPersonal ? '<button id="tt-request-personal" class="tt-access-primary">REQUEST PERSONAL ACCESS</button>' : ''}
            <button id="tt-enter-personal-code" class="tt-access-secondary">ENTER PERSONAL ACCESS CODE</button>
          </div>
          <div style="margin-top:16px;font-size:11px;color:var(--tt-text-soft);">Rejoining your registered faction automatically restores faction access.</div>
        </div>`;
    }

    function bindAccessRecoveryActions() {
        document.getElementById('tt-request-personal')?.addEventListener('click', requestPersonalAccess);
        document.getElementById('tt-activate-approved')?.addEventListener('click', activateApprovedPersonalAccess);
        document.getElementById('tt-enter-personal-code')?.addEventListener('click', activatePersonalAccessCode);
    }

    function formatAdminAge(timestamp) {
        if (timestamp == null) return '-';
        const ms = Math.max(0, Date.now() - Number(timestamp));
        if (ms < 60000) return '<1m';
        if (ms < 3600000) return Math.floor(ms / 60000) + 'm';
        if (ms < 86400000) return Math.floor(ms / 3600000) + 'h';
        return Math.floor(ms / 86400000) + 'd';
    }

    function renderAdminStatus(status, role = '') {
        const raw = String(role === 'admin' ? 'admin' : status || 'active').toLowerCase();
        const cls = ['active', 'personal', 'admin', 'grace', 'pending', 'suspended', 'disabled', 'declined'].includes(raw) ? raw : 'active';
        return `<span class="tt-admin-status tt-admin-status--${cls}">${escapeHtml(raw)}</span>`;
    }

    function renderAdminRequestsSection() {
        const requests = Array.isArray(state.adminRequests?.requests) ? state.adminRequests.requests : [];
        const pending = requests.filter(r => r.requestStatus === 'pending');
        const other = requests.filter(r => r.requestStatus !== 'pending').slice(0, 12);
        let html = `<div class="tt-admin-section-head"><div class="tt-admin-section-title">Personal Access Requests</div><button class="tt-admin-action" id="tt-admin-refresh">REFRESH</button></div>`;

        if (!pending.length) html += '<div class="tt-admin-empty">No pending Personal Access requests.</div>';

        for (const r of pending) {
            const name = escapeHtml(r.tornName || 'Unknown User');
            const status = String(r.accessStatus || r.requestedAccessStatus || '').toLowerCase();
            const grace = r.graceRemainingMs != null && status === 'grace' ? ` - ${formatTime(r.graceRemainingMs)} grace left` : '';
            const isNewRegistration = r.accessType === 'pending';
            const source = isNewRegistration
                ? (r.requestedFactionId ? `New registration - Faction ${r.requestedFactionId}` : 'New Personal registration')
                : (r.factionName || r.registeredFactionId || 'Faction access');
            const approveLabel = isNewRegistration ? 'APPROVE ACCESS' : 'SEND PERSONAL ACCESS';
            html += `<div class="tt-admin-card tt-admin-card--attention">
              <div class="tt-row"><div style="min-width:0;"><div class="tt-admin-card-title">${r.profileUrl ? `<a class="tt-support-admin-link" href="${escapeHtml(r.profileUrl)}" target="_blank">${name}</a>` : name}</div><div class="tt-admin-card-sub">${escapeHtml(source)} - requested ${formatAdminAge(r.requestedAt)} ago${grace}</div></div>${renderAdminStatus(status)}</div>
              <div class="tt-admin-card-actions"><button class="tt-admin-action tt-admin-action--good" data-admin-approve="${escapeHtml(r.requestId)}">${approveLabel}</button><button class="tt-admin-action tt-admin-action--danger" data-admin-decline="${escapeHtml(r.requestId)}">DECLINE</button></div>
            </div>`;
        }

        if (other.length) {
            html += '<div class="tt-admin-section-title" style="margin:14px 0 8px;">Recent</div>';
            for (const r of other) {
                html += `<div class="tt-admin-card"><div class="tt-row"><div style="min-width:0;"><div class="tt-admin-card-title">${escapeHtml(r.tornName || 'Unknown User')}</div><div class="tt-admin-card-sub">${escapeHtml(String(r.requestStatus || '').toUpperCase())} - ${formatAdminAge(r.requestedAt)} ago</div></div>${renderAdminStatus(r.accessStatus || 'active')}</div></div>`;
            }
        }

        return html;
    }

    function renderAdminUsersSection() {
        const users = Array.isArray(state.adminUsers) ? state.adminUsers : [];
        let html = `<div class="tt-admin-section-head"><div class="tt-admin-section-title">Users (${users.length})</div><button class="tt-admin-action" id="tt-admin-refresh">REFRESH</button></div>`;
        if (!users.length) return html + '<div class="tt-admin-empty">No tracker users found.</div>';

        for (const u of users) {
            const name = escapeHtml(u.tornName || u.label || 'Unconfigured User');
            const effectiveStatus = !u.accountActive ? 'disabled' : (u.role === 'admin' ? 'admin' : (u.accessType === 'personal' ? 'personal' : u.accessStatus));
            const faction = u.registeredFactionName || u.registeredFactionId || u.ownFactionId || 'No faction';
            const grace = u.graceRemainingMs != null && u.accessStatus === 'grace' ? ` - ${formatTime(u.graceRemainingMs)} left` : '';
            const lastSeen = u.lastSeenAt ? formatAdminAge(u.lastSeenAt) + ' ago' : 'Never';
            const canManage = u.role !== 'admin';

            html += `<div class="tt-admin-card ${u.pendingRequest ? 'tt-admin-card--attention' : ''}">
              <div class="tt-row"><div style="min-width:0;"><div class="tt-admin-card-title">${u.profileUrl ? `<a class="tt-support-admin-link" href="${escapeHtml(u.profileUrl)}" target="_blank">${name}</a>` : name}</div><div class="tt-admin-card-sub">${escapeHtml(String(faction))}${grace}<br>${u.watchedFactions} watched - ${u.trackedIndividuals} individual - last seen ${lastSeen}</div></div>${renderAdminStatus(effectiveStatus, u.role)}</div>
              <div class="tt-admin-card-actions">
                ${u.canSendPersonal && !u.personalAccessReady ? `<button class="tt-admin-action tt-admin-action--good" data-admin-personal="${escapeHtml(u.clientId)}">SEND PERSONAL ACCESS</button>` : ''}
                ${u.personalAccessReady ? '<span class="tt-admin-status tt-admin-status--personal">APPROVED</span>' : ''}
                ${canManage ? `<button class="tt-admin-action ${u.accountActive ? 'tt-admin-action--danger' : 'tt-admin-action--good'}" data-admin-user-status="${escapeHtml(u.clientId)}" data-active="${u.accountActive ? '0' : '1'}">${u.accountActive ? 'DISABLE' : 'ENABLE'}</button>` : ''}
              </div>
            </div>`;
        }
        return html;
    }

    function renderAdminFactionsSection() {
        const factions = Array.isArray(state.adminFactions) ? state.adminFactions : [];
        let html = `<div class="tt-admin-section-head"><div class="tt-admin-section-title">Registered Factions (${factions.length})</div><button class="tt-admin-action tt-admin-action--good" id="tt-admin-add-faction">ADD FACTION</button></div>`;
        if (!factions.length) return html + '<div class="tt-admin-empty">No registered factions.</div>';

        for (const f of factions) {
            html += `<div class="tt-admin-card">
              <div class="tt-row"><div style="min-width:0;"><div class="tt-admin-card-title">${escapeHtml(f.factionName || ('Faction ' + f.factionId))}</div><div class="tt-admin-card-sub">[${escapeHtml(f.factionId)}] - ${f.registeredUsers} users - ${f.graceUsers} grace - ${f.suspendedUsers} suspended</div></div>${renderAdminStatus(f.active ? (f.isPrimary ? 'admin' : 'active') : 'disabled')}</div>
              ${f.isPrimary ? '<div class="tt-admin-code">PRIMARY FACTION - automatic access, no code required</div>' : `<div class="tt-admin-code">${escapeHtml(f.accessCode || 'No access code available')}</div>`}
              <div class="tt-admin-card-actions">
                ${!f.isPrimary && f.accessCode ? `<button class="tt-admin-action" data-admin-copy-code="${escapeHtml(f.accessCode)}">COPY CODE</button>` : ''}
                ${!f.isPrimary ? `<button class="tt-admin-action tt-admin-action--warn" data-admin-regenerate="${escapeHtml(f.factionId)}">REGENERATE</button>` : ''}
                ${!f.isPrimary ? `<button class="tt-admin-action ${f.active ? 'tt-admin-action--danger' : 'tt-admin-action--good'}" data-admin-faction-status="${escapeHtml(f.factionId)}" data-active="${f.active ? '0' : '1'}">${f.active ? 'DISABLE' : 'ENABLE'}</button>` : ''}
              </div>
            </div>`;
        }
        return html;
    }

    function renderAdminPanel() {
        const pending = Number(state.adminRequests?.pendingCount || 0);
        let body = '';
        if (state.adminLoading && !state.adminUsers.length && !state.adminFactions.length) body = '<div class="tt-admin-empty">Loading admin data...</div>';
        else if (state.adminError) body = `<div class="tt-admin-empty">Admin data error: ${escapeHtml(state.adminError)}</div>`;
        else if (state.adminSection === 'users') body = renderAdminUsersSection();
        else if (state.adminSection === 'factions') body = renderAdminFactionsSection();
        else body = renderAdminRequestsSection();

        return `<div style="position:sticky;top:-16px;margin:-16px -16px 12px;padding:12px 16px 10px;background:#0B0B0B;z-index:3;border-radius:var(--tt-radius-lg) var(--tt-radius-lg) 0 0;">
          <div class="tt-row"><div class="tt-row-gap"><span style="font-size:22px;">&#9881;</span><div><div style="font-size:16px;font-weight:800;">Tracker Admin</div><div style="font-size:11px;color:var(--tt-text-soft);">Access and user management</div></div></div><div style="display:flex;align-items:center;gap:7px;"><button id="tt-admin-back" class="tt-admin-action">TRACKER</button><button id="tt-close-panel" style="background:none;border:none;color:var(--tt-text-soft);font-size:24px;cursor:pointer;padding:4px;">&#10005;</button></div></div>
          <div class="tt-admin-tabs"><button class="tt-admin-tab ${state.adminSection === 'requests' ? 'active' : ''}" data-admin-section="requests">REQUESTS${pending ? `<span class="tt-admin-badge">${pending}</span>` : ''}</button><button class="tt-admin-tab ${state.adminSection === 'users' ? 'active' : ''}" data-admin-section="users">USERS</button><button class="tt-admin-tab ${state.adminSection === 'factions' ? 'active' : ''}" data-admin-section="factions">FACTIONS</button></div>
        </div>${body}<div class="tt-footer"><div>Admin controls</div><div><span class="tt-kbd">v18.2.6</span></div></div>`;
    }

    async function adminRefreshAndRender() {
        await loadAdminPanelData(false);
        if (state.panelVisible && state.panelMode === 'admin') updatePanelContent();
    }

    function bindAdminPanel(panel) {
        document.getElementById('tt-close-panel')?.addEventListener('click', closePanel);
        document.getElementById('tt-admin-back')?.addEventListener('click', () => {
            state.panelMode = 'factions';
            updatePanelContent();
        });

        panel.querySelectorAll('[data-admin-section]').forEach(btn => {
            btn.addEventListener('click', () => {
                state.adminSection = btn.dataset.adminSection || 'requests';
                updatePanelContent();
            });
        });

        document.getElementById('tt-admin-refresh')?.addEventListener('click', adminRefreshAndRender);

        panel.querySelectorAll('[data-admin-approve]').forEach(btn => btn.addEventListener('click', async () => {
            if (!confirm('Send Personal Access to this user?')) return;
            try { await cloudRequest('POST', '/admin/access/requests/' + encodeURIComponent(btn.dataset.adminApprove) + '/approve', {}); await adminRefreshAndRender(); }
            catch (e) { alert('Approval failed: ' + e.message); }
        }));

        panel.querySelectorAll('[data-admin-decline]').forEach(btn => btn.addEventListener('click', async () => {
            if (!confirm('Decline this Personal Access request?')) return;
            try { await cloudRequest('POST', '/admin/access/requests/' + encodeURIComponent(btn.dataset.adminDecline) + '/decline', {}); await adminRefreshAndRender(); }
            catch (e) { alert('Decline failed: ' + e.message); }
        }));

        panel.querySelectorAll('[data-admin-personal]').forEach(btn => btn.addEventListener('click', async () => {
            if (!confirm('Send Personal Access to this user?')) return;
            try { await cloudRequest('POST', '/admin/access/users/' + encodeURIComponent(btn.dataset.adminPersonal) + '/personal', {}); await adminRefreshAndRender(); }
            catch (e) { alert('Personal Access failed: ' + e.message); }
        }));

        panel.querySelectorAll('[data-admin-user-status]').forEach(btn => btn.addEventListener('click', async () => {
            const active = btn.dataset.active === '1';
            if (!confirm((active ? 'Enable' : 'Disable') + ' this tracker user?')) return;
            try { await cloudRequest('POST', '/admin/access/users/' + encodeURIComponent(btn.dataset.adminUserStatus) + '/status', { active }); await adminRefreshAndRender(); }
            catch (e) { alert('User status change failed: ' + e.message); }
        }));

        document.getElementById('tt-admin-add-faction')?.addEventListener('click', async () => {
            const idInput = prompt('Enter Torn faction ID:', '');
            if (idInput === null) return;
            const factionId = idInput.trim();
            if (!/^\d+$/.test(factionId)) { alert('Enter a valid faction ID.'); return; }
            const nameInput = prompt('Optional faction name (leave blank to look it up):', '');
            if (nameInput === null) return;
            try { await cloudRequest('POST', '/admin/access/factions', { factionId, factionName: nameInput.trim() }); await adminRefreshAndRender(); }
            catch (e) { alert('Add faction failed: ' + e.message); }
        });

        panel.querySelectorAll('[data-admin-copy-code]').forEach(btn => btn.addEventListener('click', async () => {
            try { await navigator.clipboard.writeText(btn.dataset.adminCopyCode || ''); btn.textContent = 'COPIED'; setTimeout(() => { btn.textContent = 'COPY CODE'; }, 900); }
            catch (e) { alert('Could not copy code.'); }
        }));

        panel.querySelectorAll('[data-admin-regenerate]').forEach(btn => btn.addEventListener('click', async () => {
            if (!confirm('Regenerate this Faction Access Code? The old code will stop working immediately.')) return;
            try { await cloudRequest('POST', '/admin/access/factions/' + encodeURIComponent(btn.dataset.adminRegenerate) + '/regenerate', {}); await adminRefreshAndRender(); }
            catch (e) { alert('Regenerate failed: ' + e.message); }
        }));

        panel.querySelectorAll('[data-admin-faction-status]').forEach(btn => btn.addEventListener('click', async () => {
            const active = btn.dataset.active === '1';
            if (!confirm((active ? 'Enable' : 'Disable') + ' registration for this faction?')) return;
            try { await cloudRequest('POST', '/admin/access/factions/' + encodeURIComponent(btn.dataset.adminFactionStatus) + '/status', { active }); await adminRefreshAndRender(); }
            catch (e) { alert('Faction status change failed: ' + e.message); }
        }));
    }

    function renderMainModeTabs() {
        return `<div class="tt-main-mode-tabs">
            <button class="tt-main-mode-tab ${state.panelMode === 'factions' ? 'active' : ''}" data-panel-mode="factions">FACTIONS</button>
            <button class="tt-main-mode-tab ${state.panelMode === 'individuals' ? 'active' : ''}" data-panel-mode="individuals">INDIVIDUALS</button>
        </div>`;
    }

    function bindMainModeTabs(panel) {
        panel.querySelectorAll('.tt-main-mode-tab[data-panel-mode]').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                const mode = btn.dataset.panelMode;
                if (!mode || mode === state.panelMode) return;
                state.panelMode = mode;
                state.selectedFactionId = null;
                state.activeTab = 'all';
                updatePanelContent();
            });
        });
    }

    // ==================== PANEL ====================
    function createPanel(mode = 'factions') {
        const nextMode = mode === 'individuals' ? 'individuals' : (mode === 'admin' && isAdminUser() ? 'admin' : 'factions');
        const existing = document.getElementById('travel-panel');

        if (existing) {
            state.panelMode = nextMode;
            state.selectedFactionId = null;
            state.activeTab = 'all';
            applyTrackerPanelLayout(existing, false);
            updatePanelContent();
            startPanelInterval();
            return;
        }

        state.panelMode = nextMode;
        state.selectedFactionId = null;
        state.activeTab = 'all';

        const panel = document.createElement('div');
        panel.id = 'travel-panel';
        panel.className = 'tt-panel tt-scrollbar';
        applyTrackerPanelLayout(panel, true);

        panel.addEventListener('click', e => e.stopPropagation());
        document.body.appendChild(panel);

        requestAnimationFrame(() => {
            const desktop = panel.dataset.ttLayout === 'desktop-gutter';
            panel.style.transform = desktop ? 'translateX(0)' : 'translateY(0)';
            panel.style.opacity = '1';
        });

        state.panelVisible = true;
        updatePanelContent();
        startPanelInterval();
    }

    function closePanel() {
        const panel = document.getElementById('travel-panel');

        if (!panel) return;

        const desktop = panel.dataset.ttLayout === 'desktop-gutter';
        panel.style.transform = desktop ? 'translateX(-18px)' : 'translateY(100%)';
        if (desktop) panel.style.opacity = '0';

        let removed = false;
        const removePanel = () => {
            if (removed) return;
            removed = true;
            panel.remove();
        };

        panel.addEventListener('transitionend', removePanel, { once: true });
        setTimeout(removePanel, 450);

        document.getElementById('travel-panel-overlay')?.remove();

        state.panelVisible = false;
        state.selectedFactionId = null;

        if (state.panelInterval) {
            clearInterval(state.panelInterval);
            state.panelInterval = null;
        }
    }

    function updateLiveTimers() {
        if (!state.panelVisible) return;

        const now = Date.now();
        let phaseChanged = false;

        // Re-render once when a card crosses into the Landing phase, or when
        // the last estimated landing countdown reaches zero. This prevents
        // OUT 0:00 / Window: Landing-x from lingering between 5s server polls.
        document.querySelectorAll('#travel-panel .tt-member-card[data-flight-earliest][data-flight-phase]').forEach(card => {
            const earliest = Number(card.dataset.flightEarliest);
            const latest = Number(card.dataset.flightLatest);
            const phase = card.dataset.flightPhase;

            if (!Number.isFinite(earliest)) return;

            if (phase === 'traveling' && now >= earliest) phaseChanged = true;
            if (phase === 'landing-countdown' && Number.isFinite(latest) && now >= latest) phaseChanged = true;
        });

        if (phaseChanged) {
            const panel = document.getElementById('travel-panel');
            const scrollTop = panel ? panel.scrollTop : 0;

            updatePanelContent();

            const updatedPanel = document.getElementById('travel-panel');
            if (updatedPanel) updatedPanel.scrollTop = scrollTop;

            return;
        }

        document.querySelectorAll('#travel-panel .tt-live-countdown[data-target]').forEach(el => {
            const target = Number(el.dataset.target);
            if (!Number.isFinite(target)) return;
            el.textContent = formatTime(target - now);
        });

        document.querySelectorAll('#travel-panel .tt-live-elapsed[data-start]').forEach(el => {
            const start = Number(el.dataset.start);
            if (!Number.isFinite(start)) return;
            el.textContent = formatElapsed(Math.max(0, now - start));
        });

        document.querySelectorAll('#travel-panel .tt-live-window[data-earliest][data-latest]').forEach(el => {
            const earliest = Number(el.dataset.earliest);
            const latest = Number(el.dataset.latest);
            if (!Number.isFinite(earliest) || !Number.isFinite(latest)) return;

            const earliestRem = earliest - now;
            const latestRem = latest - now;

            if (latestRem <= 0) el.textContent = 'Landing';
            else if (earliestRem <= 0) el.textContent = `Landing-${formatTime(latestRem)}`;
            else el.textContent = `${formatTime(earliestRem)}-${formatTime(latestRem)}`;
        });
    }

    function startPanelInterval() {
        if (state.panelInterval) clearInterval(state.panelInterval);

        updateLiveTimers();

        state.panelInterval = setInterval(() => {
            if (state.panelVisible) {
                updateLiveTimers();
            } else {
                clearInterval(state.panelInterval);
                state.panelInterval = null;
            }
        }, PANEL_UPDATE_INTERVAL);
    }

    // ==================== ABROAD ====================
    function getMemberBS(member) {
        if (!member) return null;

        const xid = String(
            member.xid ??
            member.playerId ??
            member.player_id ??
            ''
        ).trim();

        if (xid) {
            for (const fid in state.watchedFactions || {}) {
                const canonical = state.watchedFactions[fid]?.members?.[xid];
                const canonicalBS = canonical?.tbs ?? canonical?.bs_estimate ?? null;

                if (canonicalBS != null && !isNaN(canonicalBS)) {
                    return Number(canonicalBS);
                }
            }

            const tracked = state.trackedIndividuals?.[xid];
            const trackedBS = tracked?.tbs ?? tracked?.bs_estimate ?? null;

            if (trackedBS != null && !isNaN(trackedBS)) {
                return Number(trackedBS);
            }
        }

        const bs = member.tbs ?? member.bs_estimate ?? null;

        return bs != null && !isNaN(bs) ? Number(bs) : null;
    }

    function applyCanonicalBS(member) {
        if (!member) return member;

        const bs = getMemberBS(member);

        if (bs != null) member.tbs = bs;

        return member;
    }

    function getAbroadCountry(member) {
        if (!member) return null;

        if (member.status === 'abroad') {
            return member.lookupDest || member.origin || null;
        }

        if (member.status === 'landed' && member.destination && member.destination !== 'Torn') {
            return member.destination;
        }

        if (member.status === 'traveling' && member.destination && member.destination !== 'Torn') {
            return member.destination;
        }

        return null;
    }

    function getAbroadPosition(member) {
        if (!member) return null;
        if (member.status === 'abroad') return 'present';
        if (member.status === 'landed' && member.destination && member.destination !== 'Torn') return 'present';
        if (member.status === 'traveling' && member.destination !== 'Torn') return 'inbound';

        return null;
    }

    function getEnemyFactionIds(fid) {
        sanitizeOpponentFactions();

        return [...state.warFactions]
            .map(String)
            .filter(otherFid =>
                otherFid !== String(fid || '') &&
                otherFid !== String(state.myFactionID || '') &&
                !!state.watchedFactions[otherFid]
            );
    }

    function buildAbroadData(fid) {
        const ownFaction = state.watchedFactions[fid];

        if (!ownFaction) return {};

        const countries = {};

        function ensureCountry(country) {
            if (!country) return null;

            if (!countries[country]) {
                countries[country] = {
                    friendlyPresent: [],
                    friendlyInbound: [],
                    enemyPresent: [],
                    enemyInbound: []
                };
            }

            return countries[country];
        }

        // Friendlies are always members of the selected own faction only.
        for (const xid in ownFaction.members || {}) {
            const member = ownFaction.members[xid];
            const country = getAbroadCountry(member);
            const position = getAbroadPosition(member);

            if (!country || !position) continue;

            const bucket = ensureCountry(country);
            const copy = applyCanonicalBS({ ...member, xid });

            if (position === 'present') bucket.friendlyPresent.push(copy);
            else bucket.friendlyInbound.push(copy);
        }

        // Enemies come ONLY from watched factions explicitly marked OPPONENT.
        for (const enemyFactionId of getEnemyFactionIds(fid)) {
            const enemyFaction = state.watchedFactions[enemyFactionId];

            if (!enemyFaction) continue;

            for (const xid in enemyFaction.members || {}) {
                const member = enemyFaction.members[xid];
                const country = getAbroadCountry(member);
                const position = getAbroadPosition(member);

                if (!country || !position) continue;

                const bucket = ensureCountry(country);
                const copy = applyCanonicalBS({
                    ...member,
                    xid,
                    factionId: String(enemyFactionId),
                    factionName: enemyFaction.name
                });

                if (position === 'present') bucket.enemyPresent.push(copy);
                else bucket.enemyInbound.push(copy);
            }
        }

        return countries;
    }

    function getAbroadZoneRisk(zone) {
        const friendlies = [...zone.friendlyPresent, ...zone.friendlyInbound];
        const enemies = [...zone.enemyPresent, ...zone.enemyInbound];

        const knownFriendlyBS = friendlies.map(getMemberBS).filter(v => v != null);
        const knownEnemyBS = enemies.map(getMemberBS).filter(v => v != null);

        const strongestFriendly = knownFriendlyBS.length > 0 ? Math.max(...knownFriendlyBS) : null;
        const strongestEnemy = knownEnemyBS.length > 0 ? Math.max(...knownEnemyBS) : null;

        const allFriendliesKnown = friendlies.length > 0 && knownFriendlyBS.length === friendlies.length;
        const outmatched = allFriendliesKnown && strongestEnemy != null && strongestFriendly != null && strongestEnemy > strongestFriendly;

        return {
            friendlies,
            enemies,
            strongestFriendly,
            strongestEnemy,
            outmatched
        };
    }

    function isFriendlyAtRisk(member, outmatched, enemies) {
        if (outmatched) return false;

        const bs = getMemberBS(member);

        if (bs == null) return false;

        return enemies.some(enemy => {
            const enemyBS = getMemberBS(enemy);

            return enemyBS != null && enemyBS > bs;
        });
    }

    function buildAbroadCountryCopyText(country, zone) {
        const risk = getAbroadZoneRisk(zone);
        const { friendlies, enemies, outmatched } = risk;
        const flag = FLAG_EMOJI[country] || '\uD83C\uDF0D';
        const friendlyKey = `${country}-friendly`;
        const enemyKey = `${country}-enemy`;
        const friendliesCollapsed = state.abroadCollapsedSections.has(friendlyKey);
        const enemiesCollapsed = state.abroadCollapsedSections.has(enemyKey);

        let text = `${flag} ${country}\n`;
        text += `Friendlies: ${friendlies.length} \u2022 Enemies: ${enemies.length}\n`;

        if (outmatched) {
            text += `\uD83D\uDEA8 OUTMATCHED \u2014 at least one enemy present or inbound to ${country} is stronger than every known friendly here.\n`;
        }

        if (!friendliesCollapsed) {
            text += '\n\uD83D\uDC65 FRIENDLIES\n';

            if (zone.friendlyPresent.length === 0 && zone.friendlyInbound.length === 0) text += 'None\n';

            if (zone.friendlyPresent.length > 0) {
                text += `Present (${zone.friendlyPresent.length}):\n`;

                for (const member of zone.friendlyPresent) {
                    const bs = getMemberBS(member);
                    const atRisk = isFriendlyAtRisk(member, outmatched, enemies);

                    text += `\u2022 ${member.playerName}`;
                    if (bs != null) text += ` \u2022 \u2694 ${formatBS(bs)}`;
                    if (atRisk) text += ' \u2022 \u26A0 AT RISK';
                    text += '\n';
                }
            }

            if (zone.friendlyInbound.length > 0) {
                text += `Inbound (${zone.friendlyInbound.length}):\n`;

                for (const member of zone.friendlyInbound) {
                    const bs = getMemberBS(member);
                    const arrival = getMemberArrivalWindow(member);
                    const atRisk = isFriendlyAtRisk(member, outmatched, enemies);

                    text += `\u2022 ${member.playerName}`;
                    if (bs != null) text += ` \u2022 \u2694 ${formatBS(bs)}`;
                    if (member.flightType) text += ` \u2022 ${member.flightType}`;
                    if (arrival) {
                        if (arrival.exact) {
                            const exactRem = Math.max(0, arrival.earliest - Date.now());
                            text += exactRem <= EXACT_LANDING_PHASE_MS ? ` \u2022 LANDING ${formatTime(exactRem)}` : ` \u2022 ${formatTime(exactRem)}`;
                        } else {
                            text += ` \u2022 ETA ${arrival.earliestText}\u2013${arrival.latestText}`;
                        }
                    }
                    if (atRisk) text += ' \u2022 \u26A0 AT RISK';
                    text += '\n';
                }
            }
        }

        if (!enemiesCollapsed) {
            text += '\n\u2620\uFE0F ENEMIES\n';

            if (zone.enemyPresent.length === 0 && zone.enemyInbound.length === 0) text += 'None\n';

            if (zone.enemyPresent.length > 0) {
                text += `Present (${zone.enemyPresent.length}):\n`;

                for (const member of zone.enemyPresent) {
                    const bs = getMemberBS(member);

                    text += `\u2022 ${member.playerName}`;
                    if (bs != null) text += ` \u2022 \u2694 ${formatBS(bs)}`;
                    if (member.factionName) text += ` \u2022 ${member.factionName}`;
                    text += '\n';
                }
            }

            if (zone.enemyInbound.length > 0) {
                text += `Inbound (${zone.enemyInbound.length}):\n`;

                for (const member of zone.enemyInbound) {
                    const bs = getMemberBS(member);
                    const arrival = getMemberArrivalWindow(member);

                    text += `\u2022 ${member.playerName}`;
                    if (bs != null) text += ` \u2022 \u2694 ${formatBS(bs)}`;
                    if (member.flightType) text += ` \u2022 ${member.flightType}`;
                    if (arrival) {
                        if (arrival.exact) {
                            const exactRem = Math.max(0, arrival.earliest - Date.now());
                            text += exactRem <= EXACT_LANDING_PHASE_MS ? ` \u2022 LANDING ${formatTime(exactRem)}` : ` \u2022 ${formatTime(exactRem)}`;
                        } else {
                            text += ` \u2022 ETA ${arrival.earliestText}\u2013${arrival.latestText}`;
                        }
                    }
                    if (member.factionName) text += ` \u2022 ${member.factionName}`;
                    text += '\n';
                }
            }
        }

        return text.trim();
    }

    function copyAbroadReport(fid) {
        const ownFaction = state.watchedFactions[fid];

        if (!ownFaction) {
            alert('No faction data available.');
            return;
        }

        const countries = buildAbroadData(fid);
        const countryNames = Object.keys(countries).sort((a, b) => a.localeCompare(b));

        if (countryNames.length === 0) {
            alert('No friendly or enemy members are abroad or inbound.');
            return;
        }

        let text = state.abroadView === 'danger'
            ? `Abroad Report \u2013 OUTMATCHED \u2013 ${ownFaction.name}\n\n`
            : `Abroad Report \u2013 All \u2013 ${ownFaction.name}\n\n`;

        let includedCountries = 0;

        for (const country of countryNames) {
            const zone = countries[country];
            const risk = getAbroadZoneRisk(zone);

            if (state.abroadView === 'danger' && !risk.outmatched) continue;

            includedCountries++;

            text += buildAbroadCountryCopyText(country, zone);
            text += '\n\n';
        }

        if (includedCountries === 0) {
            alert('No OUTMATCHED locations detected.');
            return;
        }

        navigator.clipboard.writeText(text.trim()).then(() => {
            const btn = document.getElementById('tt-copy-all-btn');

            if (btn) {
                const original = btn.style.background;

                btn.style.background = 'rgba(255,215,0,0.4)';

                setTimeout(() => {
                    btn.style.background = original || '';
                }, 500);
            }
        }).catch(() => {
            alert('Failed to copy Abroad report.');
        });
    }

    function renderAbroadPerson(member, isEnemy, outmatched, enemyPool) {
        const bsPill = renderBSPill(member);
        const bs = getMemberBS(member);
        const strongerEnemyExists = !isEnemy && !outmatched && bs != null && enemyPool.some(enemy => {
            const enemyBS = getMemberBS(enemy);

            return enemyBS != null && enemyBS > bs;
        });

        let statusText = '';

        if (member.status === 'traveling') {
            const arrival = getMemberArrivalWindow(member);

            if (arrival) {
                if (arrival.exact) {
                    const exactRem = Math.max(0, arrival.earliest - Date.now());
                    statusText = exactRem <= EXACT_LANDING_PHASE_MS
                        ? `Inbound \u2022 LANDING ${formatTime(exactRem)}`
                        : `Inbound \u2022 ${formatTime(exactRem)}`;
                } else {
                    statusText = `Inbound \u2022 ETA ${arrival.earliestText}\u2013${arrival.latestText}`;
                }
            } else {
                statusText = `Inbound \u2022 ${member.flightType || 'Flight'}`;
            }
        } else {
            statusText = 'Present';
        }

        return `<div class="tt-abroad-person">
            <div class="tt-abroad-person-left">
                <a class="tt-abroad-name" href="/profiles.php?XID=${member.xid}" target="_blank">${escapeHtml(member.playerName)}</a>
                ${bsPill}
                ${strongerEnemyExists ? '<span class="tt-at-risk-indicator">\u26A0 AT RISK</span>' : ''}
            </div>
            <div class="tt-abroad-meta">${escapeHtml(statusText)}</div>
        </div>`;
    }

    function renderAbroadSection(title, titleClass, present, inbound, isEnemy, outmatched, enemyPool, sectionKey) {
        if (present.length === 0 && inbound.length === 0) return '';

        const isCollapsed = state.abroadCollapsedSections.has(sectionKey);

        let html = `<div class="tt-abroad-side ${isCollapsed ? 'collapsed' : ''}" data-abroad-section="${escapeHtml(sectionKey)}">
            <div class="tt-abroad-side-title ${titleClass}">
                <span>${title}</span>
                <div class="tt-abroad-side-title-right">
                    <span>${present.length + inbound.length}</span>
                    <span class="tt-abroad-collapse-icon">${isCollapsed ? '\u25B6' : '\u25BC'}</span>
                </div>
            </div>
            <div class="tt-abroad-side-body">`;

        if (present.length > 0) {
            html += `<div class="tt-abroad-subtitle">Currently present (${present.length})</div>`;

            present.sort((a, b) => {
                const abs = getMemberBS(a);
                const bbs = getMemberBS(b);

                if (abs == null && bbs == null) return String(a.playerName || '').localeCompare(String(b.playerName || ''));
                if (abs == null) return 1;
                if (bbs == null) return -1;

                return bbs - abs;
            });

            for (const member of present) {
                html += renderAbroadPerson(member, isEnemy, outmatched, enemyPool);
            }
        }

        if (inbound.length > 0) {
            html += `<div class="tt-abroad-subtitle">Inbound (${inbound.length})</div>`;

            inbound.sort((a, b) => {
                const aa = getMemberArrivalWindow(a)?.earliest ?? Number.MAX_SAFE_INTEGER;
                const bb = getMemberArrivalWindow(b)?.earliest ?? Number.MAX_SAFE_INTEGER;

                return aa - bb;
            });

            for (const member of inbound) {
                html += renderAbroadPerson(member, isEnemy, outmatched, enemyPool);
            }
        }

        html += '</div></div>';

        return html;
    }

    function renderAbroadTab(fid) {
        const ownFaction = state.watchedFactions[fid];

        if (!ownFaction) return '<div class="tt-abroad-empty">No faction data available.</div>';

        const countries = buildAbroadData(fid);
        const countryNames = Object.keys(countries).sort((a, b) => a.localeCompare(b));

        let html = `
            <div class="tt-abroad-filter-row">
                <button class="tt-abroad-filter ${state.abroadView === 'all' ? 'active' : ''}" data-abroad-view="all">All</button>
                <button class="tt-abroad-filter danger ${state.abroadView === 'danger' ? 'active' : ''}" data-abroad-view="danger">\uD83D\uDEA8 OUTMATCHED</button>
            </div>
        `;

        if (countryNames.length === 0) {
            html += '<div class="tt-abroad-empty">No friendly or enemy members are currently abroad or inbound.</div>';
            return html;
        }

        let renderedCount = 0;

        for (const country of countryNames) {
            const zone = countries[country];
            const risk = getAbroadZoneRisk(zone);

            const friendlies = risk.friendlies;
            const enemies = risk.enemies;
            const outmatched = risk.outmatched;

            if (state.abroadView === 'danger' && !outmatched) continue;

            renderedCount++;

            const flag = FLAG_EMOJI[country] || '\uD83C\uDF0D';
            const friendlyCount = friendlies.length;
            const enemyCount = enemies.length;
            const countryCopyText = buildAbroadCountryCopyText(country, zone);

            html += `<div class="tt-abroad-country ${outmatched ? 'tt-abroad-country--risk' : ''}" data-abroad-copy="${escapeHtml(countryCopyText)}">
                <div class="tt-abroad-country-header">
                    <div class="tt-abroad-country-name">${flag} ${escapeHtml(country)}</div>
                    <div class="tt-abroad-summary">Friendly ${friendlyCount} \u2022 Enemy ${enemyCount}</div>
                </div>`;

            if (outmatched) {
                html += `<div class="tt-abroad-risk-banner">\uD83D\uDEA8 OUTMATCHED \u2014 at least one enemy present or inbound is stronger than every known friendly here.</div>`;
            }

            html += renderAbroadSection('\uD83D\uDC65 Friendlies', 'tt-abroad-side-title--friendly', zone.friendlyPresent, zone.friendlyInbound, false, outmatched, enemies, `${country}-friendly`);
            html += renderAbroadSection('\u2620\uFE0F Enemies', 'tt-abroad-side-title--enemy', zone.enemyPresent, zone.enemyInbound, true, outmatched, enemies, `${country}-enemy`);

            html += '</div>';
        }

        if (renderedCount === 0) {
            html += state.abroadView === 'danger'
                ? '<div class="tt-abroad-empty">No OUTMATCHED locations detected.</div>'
                : '<div class="tt-abroad-empty">No friendly or enemy members are currently abroad or inbound.</div>';
        }

        return html;
    }

    // ==================== INBOUND THREAT OVERLAY ====================
    function getMyThreatCountry() {
        if (state.myDestination) return state.myDestination;

        const myId = String(state.myUserID || getMyTornUserId() || '');

        if (!myId) return null;

        for (const fid in state.watchedFactions) {
            const faction = state.watchedFactions[fid];
            const me = faction?.members?.[myId];

            if (!me) continue;

            if (me.status === 'abroad' || me.status === 'landed') return getAbroadCountry(me);

            if (me.status === 'traveling' && me.destination && me.destination !== 'Torn') {
                return me.destination;
            }
        }

        return null;
    }

    function getInboundThreats() {
        if (THREAT_OVERLAY_DEBUG) {
            const now = THREAT_DEBUG_STARTED;

            return [
                {
                    xid: '99999901',
                    member: { playerName: 'SomePlayer', flightType: 'Private' },
                    bs: 2800000000,
                    factionName: 'Debug Enemy',
                    country: 'South Africa',
                    type: 'inbound',
                    earliest: now + (4 * 60 * 1000) + 32 * 1000,
                    latest: now + 6 * 60 * 1000
                },
                {
                    xid: '99999902',
                    member: { playerName: 'StrongEnemy', flightType: 'Private' },
                    bs: 4100000000,
                    factionName: 'Debug Enemy',
                    country: 'South Africa',
                    type: 'inbound',
                    earliest: now + 8 * 60 * 1000,
                    latest: now + 10 * 60 * 1000
                },
                {
                    xid: '99999903',
                    member: { playerName: 'AnotherEnemy', flightType: 'Personal' },
                    bs: 1900000000,
                    factionName: 'Debug Enemy',
                    country: 'South Africa',
                    type: 'inbound',
                    earliest: now + 12 * 60 * 1000,
                    latest: now + 14 * 60 * 1000
                }
            ];
        }

        const country = getMyThreatCountry();

        if (!country) return [];
        if (!myBattleStats || myBattleStats <= 0) return [];

        const threats = [];

        // Threats ONLY come from watched factions marked OPPONENT.
        for (const enemyFactionId of getEnemyFactionIds(state.myFactionID)) {
            const faction = state.watchedFactions[enemyFactionId];

            if (!faction) continue;

            for (const xid in faction.members || {}) {
                const member = faction.members[xid];

                if (!member) continue;

                const bs = getMemberBS(member);

                if (bs == null || bs <= myBattleStats) continue;

                if (member.status === 'abroad' || member.status === 'landed') {
                    const memberCountry = getAbroadCountry(member);

                    if (memberCountry !== country) continue;

                    threats.push({
                        xid,
                        member,
                        bs,
                        factionName: faction.name,
                        country,
                        type: 'present',
                        earliest: 0,
                        latest: 0
                    });

                    continue;
                }

                if (member.status !== 'traveling') continue;
                if (!member.destination || member.destination === 'Torn') continue;
                if (member.destination !== country) continue;

                const arrival = getMemberArrivalWindow({ ...member, xid });

                if (!arrival) continue;

                threats.push({
                    xid,
                    member,
                    bs,
                    factionName: faction.name,
                    country,
                    type: 'inbound',
                    earliest: arrival.earliest,
                    latest: arrival.latest
                });
            }
        }

        threats.sort((a, b) => {
            if (a.type === 'present' && b.type !== 'present') return -1;
            if (b.type === 'present' && a.type !== 'present') return 1;
            if (a.type === 'present' && b.type === 'present') return b.bs - a.bs;

            return a.earliest - b.earliest;
        });

        return threats;
    }

    function getThreatOverlayStatus(threats) {
        if (!threats.length) return null;

        const now = Date.now();
        const presentThreats = threats.filter(t => t.type === 'present');

        if (presentThreats.length > 0) {
            return {
                text: 'PRESENT',
                threat: presentThreats[0]
            };
        }

        const inbound = threats.filter(t => t.type === 'inbound');

        if (!inbound.length) return null;

        inbound.sort((a, b) => a.earliest - b.earliest);

        const threat = inbound[0];

        if (now >= threat.earliest) {
            return {
                text: 'LANDING',
                threat
            };
        }

        return {
            text: formatTime(threat.earliest - now),
            threat
        };
    }

    function injectThreatOverlayStyles() {
        if (document.getElementById('tt-threat-overlay-styles')) return;

        const style = document.createElement('style');

        style.id = 'tt-threat-overlay-styles';

        style.textContent = `
            #tt-threat-overlay {
                position:fixed;
                top:72px;
                left:8px;
                z-index:2147483646;
                font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
                color:#fff;
                user-select:none;
                -webkit-user-select:none;
                -webkit-tap-highlight-color:transparent;
                touch-action:manipulation;
            }

            #tt-threat-overlay.tt-threat-hidden {
                display:none;
            }

            .tt-threat-compact {
                display:flex;
                align-items:center;
                gap:6px;
                min-height:34px;
                padding:5px 10px;
                border-radius:3px;
                background:rgba(20,20,20,0.96);
                border:1px solid rgba(239,83,80,0.85);
                box-shadow:0 4px 16px rgba(0,0,0,0.55),0 0 10px rgba(239,83,80,0.18);
                cursor:pointer;
            }

            .tt-threat-icon {
                font-size:17px;
                line-height:1;
            }

            .tt-threat-time {
                font-size:13px;
                font-weight:800;
                font-family:monospace;
                white-space:nowrap;
                color:#fff;
            }

            .tt-threat-count {
                display:inline-flex;
                align-items:center;
                justify-content:center;
                min-width:18px;
                height:18px;
                padding:0 4px;
                border-radius:999px;
                background:rgba(239,83,80,0.22);
                border:1px solid rgba(239,83,80,0.55);
                color:#FFCDD2;
                font-size:9px;
                font-weight:800;
            }

            .tt-threat-details {
                display:none;
                margin-top:4px;
                min-width:185px;
                max-width:260px;
                padding:7px 9px;
                border-radius:3px;
                background:rgba(20,20,20,0.97);
                border:1px solid rgba(239,83,80,0.7);
                box-shadow:0 6px 18px rgba(0,0,0,0.65);
            }

            #tt-threat-overlay.tt-threat-expanded .tt-threat-details {
                display:block;
            }

            .tt-threat-player {
                display:flex;
                align-items:center;
                justify-content:space-between;
                gap:12px;
                padding:5px 2px;
                border-bottom:1px solid rgba(255,255,255,0.06);
            }

            .tt-threat-player:last-child {
                border-bottom:none;
            }

            .tt-threat-player-name {
                min-width:0;
                overflow:hidden;
                text-overflow:ellipsis;
                white-space:nowrap;
                font-size:12px;
                font-weight:700;
                color:#F5F5F5;
            }

            .tt-threat-player-bs {
                flex-shrink:0;
                font-size:11px;
                font-weight:800;
                color:#FFCDD2;
                white-space:nowrap;
            }

            .tt-threat-present .tt-threat-compact {
                border-color:#c62828;
                box-shadow:0 4px 16px rgba(0,0,0,0.55),0 0 13px rgba(198,40,40,0.35);
            }

            .tt-threat-landing .tt-threat-compact {
                border-color:#FFB300;
                box-shadow:0 4px 16px rgba(0,0,0,0.55),0 0 12px rgba(255,179,0,0.28);
            }

            @media (max-width:600px) {
                #tt-threat-overlay {
                    top:64px;
                    left:6px;
                }

                .tt-threat-compact {
                    min-height:31px;
                    padding:4px 8px;
                }

                .tt-threat-icon {
                    font-size:16px;
                }

                .tt-threat-time {
                    font-size:12px;
                }

                .tt-threat-details {
                    min-width:170px;
                    max-width:230px;
                }
            }
        `;

        document.head.appendChild(style);
    }

    function ensureThreatOverlay() {
        let overlay = document.getElementById('tt-threat-overlay');

        if (overlay) return overlay;

        overlay = document.createElement('div');

        overlay.id = 'tt-threat-overlay';
        overlay.className = 'tt-threat-hidden';

        overlay.innerHTML = `
            <div class="tt-threat-compact">
                <span class="tt-threat-icon">\uD83D\uDEA8</span>
                <span class="tt-threat-time">--:--</span>
                <span class="tt-threat-count" style="display:none;"></span>
            </div>
            <div class="tt-threat-details"></div>
        `;

        overlay.addEventListener('click', e => {
            e.stopPropagation();

            state.threatOverlayExpanded = !state.threatOverlayExpanded;

            updateThreatOverlay();
        });

        document.body.appendChild(overlay);

        return overlay;
    }

    function updateThreatOverlay() {
        const overlay = ensureThreatOverlay();
        const threats = getInboundThreats();

        if (!threats.length) {
            overlay.className = 'tt-threat-hidden';
            return;
        }

        const status = getThreatOverlayStatus(threats);

        if (!status) {
            overlay.className = 'tt-threat-hidden';
            return;
        }

        overlay.className = '';

        if (state.threatOverlayExpanded) {
            overlay.classList.add('tt-threat-expanded');
        }

        if (status.text === 'PRESENT') {
            overlay.classList.add('tt-threat-present');
        } else if (status.text === 'LANDING') {
            overlay.classList.add('tt-threat-landing');
        }

        const timeElement = overlay.querySelector('.tt-threat-time');
        const countElement = overlay.querySelector('.tt-threat-count');
        const detailsElement = overlay.querySelector('.tt-threat-details');

        if (timeElement) {
            timeElement.textContent = status.text;
        }

        if (countElement) {
            if (threats.length > 1) {
                countElement.style.display = 'inline-flex';
                countElement.textContent = `+${threats.length - 1}`;
            } else {
                countElement.style.display = 'none';
                countElement.textContent = '';
            }
        }

        if (detailsElement) {
            detailsElement.innerHTML = threats.map(threat => {
                return `<div class="tt-threat-player">
                    <span class="tt-threat-player-name">${escapeHtml(threat.member.playerName)}</span>
                    <span class="tt-threat-player-bs">\u2694 ${formatBS(threat.bs)}</span>
                </div>`;
            }).join('');
        }
    }

    function startThreatOverlay() {
        injectThreatOverlayStyles();
        ensureThreatOverlay();

        if (state.threatOverlayInterval) {
            clearInterval(state.threatOverlayInterval);
        }

        updateThreatOverlay();

        state.threatOverlayInterval = setInterval(() => {
            updateThreatOverlay();
        }, 1000);
    }

    function getTrackedPlayerSortValue(member) {
        if (!member) return 99;
        if (member.status === 'traveling') return 0;
        if (member.status === 'landed') return 1;
        if (member.status === 'abroad') return 2;
        return 3;
    }

    function renderIndividualStaticCard(member) {
        const m = member || {};
        const xid = String(m.xid || m.playerId || '');
        const bsPill = renderBSPill(m);
        const isAbroad = m.status === 'abroad';
        const location = isAbroad
            ? (getAbroadCountry(m) || m.origin || 'Abroad')
            : 'Torn';
        const statusLabel = isAbroad ? 'ABROAD' : 'TORN';
        const chipClass = isAbroad ? 'tt-chip-accent' : 'tt-chip-soft';

        return `<div class="tt-member-card">
      <div class="tt-member-main">
        <div class="tt-member-name"><a href="/profiles.php?XID=${xid}" target="_blank">${escapeHtml(m.playerName || ('User ' + xid))}</a></div>
        <div class="tt-member-route">${escapeHtml(isAbroad ? ('In ' + location) : location)}</div>
      </div>
      <div class="tt-member-meta">
        <span class="tt-chip ${chipClass}">${statusLabel}</span>
        <div class="tt-row-gap">${bsPill}<button class="tt-player-action tt-player-action--untrack" data-track-stop="${xid}">UNTRACK</button></div>
      </div>
    </div>`;
    }

    function renderIndividualTrackerPanel() {
        const trackedIds = Object.keys(state.trackedIndividuals || {});
        const currentPlayerId = isPlayerProfilePage() ? getCurrentPlayerIdFromUrl() : null;
        const currentIsSelf = !!(currentPlayerId && String(currentPlayerId) === String(state.myUserID));
        const currentTracked = !!(currentPlayerId && state.trackedIndividuals[currentPlayerId]);
        const actionHtml = currentIsSelf
            ? ''
            : `<button id="tt-individual-track-action" class="tt-player-action ${currentTracked ? 'tt-player-action--untrack' : ''}" data-player-id="${currentPlayerId || ''}" data-track-action="${currentTracked ? 'untrack' : 'track'}">${currentTracked ? 'UNTRACK' : 'TRACK'}</button>`;

        const headerHtml = `
      <div style="position:sticky;top:-16px;margin:-16px -16px 12px;padding:12px 16px 10px;background:#0B0B0B;z-index:3;border-radius:var(--tt-radius-lg) var(--tt-radius-lg) 0 0;">
        <div class="tt-row">
          <div class="tt-row-gap"><span style="font-size:22px;">\uD83D\uDC64</span><div><div style="font-size:16px;font-weight:700;">Tracked players</div><div style="font-size:12px;color:var(--tt-text-soft);">${trackedIds.length} player${trackedIds.length !== 1 ? 's' : ''} \u2022 Cloud</div></div></div>
          <div style="display:flex;gap:7px;align-items:center;">${renderAdminEntryButton()}<button id="tt-close-panel" style="background:none;border:none;color:var(--tt-text-soft);font-size:24px;cursor:pointer;padding:4px;touch-action:manipulation;">\u2715</button></div>
        </div>
        ${renderMainModeTabs()}
        ${renderAccessNotice()}
        <div style="margin-top:8px;display:flex;align-items:center;justify-content:space-between;gap:8px;">
          <div class="tt-chip tt-chip-soft"><span class="tt-dot tt-dot--online"></span><span style="margin-left:6px;font-size:11px;"> CLOUD</span></div>
          ${actionHtml}
        </div>
      </div>`;

        if (!trackedIds.length) {
            return headerHtml + `<div class="tt-player-empty">No individual players tracked.<br><span style="display:inline-block;margin-top:5px;font-size:11px;">Open a Torn player profile and use TRACK, or tap TRACK here and enter their player ID.</span></div><div class="tt-footer"><div>Individual tracker</div><div><span class="tt-kbd">v18.2.6</span><span style="margin-left:6px;font-size:11px;">FF BS</span></div></div>`;
        }

        const members = trackedIds.map(xid => ({ ...state.trackedIndividuals[xid], xid }));
        members.sort((a, b) => {
            const ap = getTrackedPlayerSortValue(a);
            const bp = getTrackedPlayerSortValue(b);
            if (ap !== bp) return ap - bp;
            if (a.status === 'traveling' && b.status === 'traveling') {
                const aa = getMemberArrivalWindow(a)?.earliest ?? Number.MAX_SAFE_INTEGER;
                const bb = getMemberArrivalWindow(b)?.earliest ?? Number.MAX_SAFE_INTEGER;
                if (aa !== bb) return aa - bb;
            }
            return String(a.playerName || '').localeCompare(String(b.playerName || ''));
        });

        const now = Date.now();
        let cards = '';

        for (const member of members) {
            if (member.status === 'traveling') {
                cards += renderTravelCard(member, now, {
                    allowBiz: false,
                    copyEnabled: false,
                    untrack: true
                });
            } else if (member.status === 'landed') {
                cards += renderLandedCard(member, { untrack: true });
            } else {
                cards += renderIndividualStaticCard(member);
            }
        }

        return headerHtml + cards + `<div class="tt-footer"><div>TRACK / UNTRACK only</div><div><span class="tt-kbd">v18.2.6</span><span style="margin-left:6px;font-size:11px;">FF BS</span></div></div>`;
    }

    function bindIndividualTrackerPanel(panel) {
        document.getElementById('tt-close-panel')?.addEventListener('click', closePanel);
        bindMainModeTabs(panel);
        bindAdminEntryButton();
        bindAccessRecoveryActions();

        const action = document.getElementById('tt-individual-track-action');
        if (action) {
            action.addEventListener('click', async e => {
                e.stopPropagation();

                let playerId = String(action.dataset.playerId || '').trim();

                if (!playerId) {
                    const entered = prompt('Enter Torn player ID to TRACK:', '');
                    if (entered === null) return;
                    playerId = entered.trim();
                }

                if (!/^\d+$/.test(playerId)) {
                    alert('Enter a valid Torn player ID.');
                    return;
                }

                if (String(playerId) === String(state.myUserID)) {
                    alert('You do not need to TRACK yourself.');
                    return;
                }

                const actionMode = String(action.dataset.trackAction || 'track').toLowerCase();
                await runTrackedPlayerAction(playerId, actionMode, action);
            });
        }

        panel.querySelectorAll('[data-track-stop]').forEach(btn => {
            btn.addEventListener('click', async e => {
                e.stopPropagation();
                const playerId = String(btn.dataset.trackStop || '').trim();
                if (playerId) await runTrackedPlayerAction(playerId, 'untrack', btn);
            });
        });
    }

    function renderUniversalSetupScreen() {
        return `<div class="tt-onboard-shell">
          <div class="tt-onboard-header">
            <div class="tt-onboard-brand">
              <div class="tt-onboard-mark">&#9992;&#65039;</div>
              <div>
                <div class="tt-onboard-brand-title">Doits Flight Tracker</div>
                <div class="tt-onboard-brand-sub">Secure Cloud access</div>
              </div>
            </div>
            <div class="tt-onboard-header-actions">
              <span class="tt-onboard-badge tt-onboard-badge--setup">SETUP</span>
              <button id="tt-close-setup" class="tt-onboard-close" aria-label="Close">&#10005;</button>
            </div>
          </div>

          <div class="tt-onboard-body">
            <div class="tt-onboard-section-head">
              <div>
                <div class="tt-onboard-eyebrow">CONNECT THIS INSTALLATION</div>
                <div class="tt-onboard-copy">Enter your Torn API key. That is the only setup step.</div>
              </div>
            </div>

            <div class="tt-onboard-card">
              <label class="tt-onboard-label" for="tt-registration-api-key">TORN API KEY</label>
              <input id="tt-registration-api-key" class="tt-onboard-input" type="password" maxlength="16" autocomplete="new-password" autocapitalize="off" spellcheck="false" placeholder="16-character API key">

              <div class="tt-onboard-info">
                <div class="tt-onboard-info-icon">&#10003;</div>
                <div>
                  <div class="tt-onboard-info-title">AUTOMATIC ACCOUNT CHECK</div>
                  <div class="tt-onboard-info-copy">Approved faction: instant access. Existing tracker account: this installation links automatically. Otherwise, an approval request is sent to the tracker admin.</div>
                </div>
              </div>

              <div id="tt-registration-error" class="tt-onboard-error"></div>
              <button id="tt-register-universal" class="tt-onboard-primary">CONNECT ACCOUNT</button>
              <div class="tt-onboard-security">No Client ID or tracker secret to copy. Your Torn identity and faction are verified from the API key. The key must also be registered with FFScouter.</div>
            </div>

            <div class="tt-onboard-auto-note"><span class="tt-onboard-note-dot tt-onboard-note-dot--approved"></span><span>Returning user? Use the same Torn API key and this installation will be linked to your existing tracker account automatically.</span></div>
            <button id="tt-register-invite" class="tt-onboard-legacy">Legacy invite / recovery</button>
          </div>

          <div class="tt-onboard-footer"><span>One-key setup</span><span class="tt-kbd">v18.2.6</span></div>
        </div>`;
    }

    function bindUniversalSetupScreen() {
        document.getElementById('tt-register-universal')?.addEventListener('click', registerUniversalTracker);
        document.getElementById('tt-register-invite')?.addEventListener('click', registerWithInvite);
        document.getElementById('tt-close-setup')?.addEventListener('click', closePanel);

        document.getElementById('tt-registration-api-key')?.addEventListener('keydown', e => {
            if (e.key === 'Enter') registerUniversalTracker();
        });
    }

    function renderPendingRegistrationScreen() {
        const info = state.accessInfo || {};
        const name = escapeHtml(info.tornName || state.trackerLabel || 'Torn user');
        const tornId = escapeHtml(info.tornUserId || state.myUserID || '');
        const factionName = escapeHtml(
            info.factionName ||
            info.registeredFactionName ||
            state.myFactionName ||
            info.registeredFactionId ||
            state.myFactionID ||
            'No faction'
        );
        const ready = info.personalAccessReady === true;
        const requestStatus = String(info.latestRequest?.status || (ready ? 'approved' : 'pending')).toLowerCase();

        if (state.registrationAccessLost) {
            return `<div class="tt-onboard-shell">
              <div class="tt-onboard-header">
                <div class="tt-onboard-brand">
                  <div class="tt-onboard-mark">&#9992;&#65039;</div>
                  <div><div class="tt-onboard-brand-title">Doits Flight Tracker</div><div class="tt-onboard-brand-sub">Secure Cloud access</div></div>
                </div>
                <div class="tt-onboard-header-actions"><span class="tt-onboard-badge tt-onboard-badge--attention">ACCESS</span><button id="tt-close-panel" class="tt-onboard-close" aria-label="Close">&#10005;</button></div>
              </div>

              <div class="tt-onboard-body">
                <div class="tt-onboard-section-head"><div><div class="tt-onboard-eyebrow">ACCESS NEEDS ATTENTION</div><div class="tt-onboard-copy">This registration is no longer active. It may have been declined or disabled.</div></div></div>
                <div class="tt-onboard-card tt-onboard-card--attention">
                  <div class="tt-onboard-info" style="margin-top:0;">
                    <div class="tt-onboard-info-icon" style="border-color:rgba(239,83,80,0.5) !important;background:rgba(239,83,80,0.12) !important;color:#FFCDD2 !important;">!</div>
                    <div><div class="tt-onboard-info-title">REGISTRATION NOT ACTIVE</div><div class="tt-onboard-info-copy">Contact the tracker admin if you believe you should have access, or start over with a new registration.</div></div>
                  </div>
                  <div style="height:10px;"></div>
                  <button id="tt-registration-reset" class="tt-onboard-primary tt-onboard-primary--danger">START OVER</button>
                </div>
              </div>

              <div class="tt-onboard-footer"><span>Access required</span><span class="tt-kbd">v18.2.6</span></div>
            </div>`;
        }

        return `<div class="tt-onboard-shell">
          <div class="tt-onboard-header">
            <div class="tt-onboard-brand">
              <div class="tt-onboard-mark">&#9992;&#65039;</div>
              <div><div class="tt-onboard-brand-title">Doits Flight Tracker</div><div class="tt-onboard-brand-sub">Secure Cloud access</div></div>
            </div>
            <div class="tt-onboard-header-actions"><span class="tt-onboard-badge ${ready ? 'tt-onboard-badge--approved' : 'tt-onboard-badge--pending'}">${ready ? 'APPROVED' : 'PENDING'}</span><button id="tt-close-panel" class="tt-onboard-close" aria-label="Close">&#10005;</button></div>
          </div>

          <div class="tt-onboard-body">
            <div class="tt-onboard-section-head">
              <div>
                <div class="tt-onboard-eyebrow">${ready ? 'ACCESS APPROVED' : 'AWAITING APPROVAL'}</div>
                <div class="tt-onboard-copy">${ready ? 'Your Personal Access has been approved. Activate it to enter the tracker.' : 'Your Torn account and faction have been verified. Your request is with the tracker admin.'}</div>
              </div>
            </div>

            <div class="tt-onboard-status-card">
              <div class="tt-onboard-status-row"><span>User</span><strong>${name}</strong></div>
              ${tornId ? `<div class="tt-onboard-status-row"><span>Torn ID</span><strong>${tornId}</strong></div>` : ''}
              <div class="tt-onboard-status-row"><span>Faction</span><strong>${factionName}</strong></div>
              <div class="tt-onboard-status-row"><span>Request</span><strong class="${ready ? 'tt-onboard-value--approved' : 'tt-onboard-value--pending'}">${escapeHtml(requestStatus.toUpperCase())}</strong></div>
            </div>

            <div class="tt-onboard-actions">
              ${ready ? '<button id="tt-activate-approved" class="tt-onboard-primary tt-onboard-primary--approved">ACTIVATE ACCESS</button>' : '<button id="tt-registration-check" class="tt-onboard-primary tt-onboard-primary--pending">CHECK STATUS</button>'}
            </div>
            <div class="tt-onboard-auto-note"><span class="tt-onboard-note-dot ${ready ? 'tt-onboard-note-dot--approved' : ''}"></span><span>${ready ? 'Approval received. You can connect now.' : 'Status refreshes automatically every 30 seconds.'}</span></div>
          </div>

          <div class="tt-onboard-footer"><span>${ready ? 'Approved' : 'Personal Access request'}</span><span class="tt-kbd">v18.2.6</span></div>
        </div>`;
    }

    function bindPendingRegistrationScreen() {
        document.getElementById('tt-registration-check')?.addEventListener('click', refreshPendingRegistrationStatus);
        document.getElementById('tt-activate-approved')?.addEventListener('click', () => activateApprovedPersonalAccess({ silent: false }));
        document.getElementById('tt-close-panel')?.addEventListener('click', closePanel);
        document.getElementById('tt-registration-reset')?.addEventListener('click', () => {
            if (!confirm('Forget this pending tracker registration and start over?')) return;
            clearTrackerCredentials();
            updatePanelContent();
        });
    }

    // ==================== MAIN RENDER ====================
    function updatePanelContent() {
        const panel = document.getElementById('travel-panel');

        if (!panel) return;

        if (!hasTrackerCredentials()) {
            panel.innerHTML = renderUniversalSetupScreen();
            bindUniversalSetupScreen();
            return;
        }

        if (state.registrationPending || state.accessInfo?.accessType === 'pending' || state.accessInfo?.accessStatus === 'pending') {
            panel.innerHTML = renderPendingRegistrationScreen();
            bindPendingRegistrationScreen();
            return;
        }

        if (!state.serverOnline) {
            panel.innerHTML = `<div style="text-align:center;padding:32px 16px;"><div style="font-size:40px;">\u26A0\uFE0F</div><div style="font-weight:700;font-size:18px;margin:8px 0;">Cloud tracker unavailable</div><div style="font-size:14px;color:var(--tt-text-soft);">Your private Cloudflare tracker could not be reached.</div><button id="retry-poll" class="tt-watch-btn" style="margin-top:16px;">Retry</button></div>`;
            document.getElementById('retry-poll')?.addEventListener('click', () => pollServer().then(updatePanelContent));
            return;
        }

        if (!state.authenticated) {
            panel.innerHTML = `<div style="text-align:center;padding:32px 16px;"><div style="font-size:40px;">\uD83D\uDD12</div><div style="font-weight:700;font-size:18px;margin:8px 0;">Tracker login rejected</div><div style="font-size:13px;color:var(--tt-text-soft);">The saved tracker credentials are no longer valid.</div><button id="tt-forget-account" class="tt-watch-btn" style="margin-top:16px;">Forget account</button></div>`;
            document.getElementById('tt-forget-account')?.addEventListener('click', () => { if (confirm('Forget this linked tracker account from this browser?')) { clearTrackerCredentials(); updatePanelContent(); } });
            return;
        }

        if (!state.apiKeySet) {
            panel.innerHTML = `<div style="text-align:center;padding:32px 16px;"><div style="font-size:40px;">\uD83D\uDD11</div><div style="font-weight:700;font-size:18px;margin:8px 0;">Finish tracker setup</div><div style="font-size:13px;color:var(--tt-text-soft);line-height:1.5;">Add one Torn API key that is registered with FFScouter. The raw key will not be retained by this userscript.</div><button id="set-api-key" class="tt-watch-btn" style="margin-top:16px;">Add API key</button></div>`;
            document.getElementById('set-api-key')?.addEventListener('click', configureTrackerApiKey);
            return;
        }

        if (state.accessInfo?.accessType === 'faction' && state.accessInfo?.accessStatus === 'suspended') {
            panel.innerHTML = `<div class="tt-row" style="margin-bottom:4px;"><div style="font-weight:800;font-size:16px;">Flight Tracker</div><button id="tt-close-panel" style="background:none;border:none;color:var(--tt-text-soft);font-size:24px;cursor:pointer;padding:4px;">\u2715</button></div>` + renderAccessRecoveryScreen();
            document.getElementById('tt-close-panel')?.addEventListener('click', closePanel);
            bindAccessRecoveryActions();
            return;
        }

        if (state.panelMode === 'admin' && isAdminUser()) {
            panel.innerHTML = renderAdminPanel();
            bindAdminPanel(panel);
            return;
        }

        if (state.panelMode === 'individuals') {
            panel.innerHTML = renderIndividualTrackerPanel();
            bindIndividualTrackerPanel(panel);
            updateLiveTimers();
            return;
        }

        const fids = Object.keys(state.watchedFactions);

        const isOwnFactionSelected = !!(
            state.selectedFactionId &&
            state.myFactionID &&
            String(state.selectedFactionId) === String(state.myFactionID)
        );

        let tabsHtml = '';

        if (state.selectedFactionId) {
            let tabItems = `
                <button class="tt-tab ${state.activeTab === 'all' ? 'tt-active' : ''}" data-tab="all">All</button>
                <button class="tt-tab ${state.activeTab === 'outbound' ? 'tt-active' : ''}" data-tab="outbound">Out</button>
                <button class="tt-tab ${state.activeTab === 'return' ? 'tt-active' : ''}" data-tab="return">Return</button>
            `;

            if (isOwnFactionSelected) {
                tabItems += `<button class="tt-tab tt-abroad ${state.activeTab === 'abroad' ? 'tt-active' : ''}" data-tab="abroad">\uD83C\uDF0D Abroad</button>`;
            }

            tabsHtml = `<div class="tt-tab-row">${tabItems}</div>`;
        }

        const copyAllBtnHtml = state.selectedFactionId ? `<button id="tt-copy-all-btn" class="tt-copy-all-btn" title="Copy current view as text">\uD83D\uDCCB</button>` : '';
        const modeLabel = 'Cloud';

        const headerHtml = `
      <div style="position:sticky;top:-16px;margin:-16px -16px 10px;padding:12px 16px 10px;background:#0B0B0B;z-index:3;border-radius:var(--tt-radius-lg) var(--tt-radius-lg) 0 0;">
        <div class="tt-row">
          <div class="tt-row-gap"><span style="font-size:22px;">\u2708\uFE0F</span><div><div style="font-size:16px;font-weight:700;">Travel tracker</div><div style="font-size:12px;color:var(--tt-text-soft);">${fids.length} faction${fids.length !== 1 ? 's' : ''} \u2022 ${modeLabel}</div></div></div>
          <div style="display:flex;gap:8px;align-items:center;">${copyAllBtnHtml}${renderAdminEntryButton()}<button id="tt-close-panel" style="background:none;border:none;color:var(--tt-text-soft);font-size:24px;cursor:pointer;padding:4px;touch-action:manipulation;">\u2715</button></div>
        </div>
        ${renderMainModeTabs()}
        ${renderAccessNotice()}
        <div style="margin-top:8px;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
          ${tabsHtml}
          <div class="tt-chip tt-chip-soft"><span class="tt-dot tt-dot--online"></span><span style="margin-left:6px;font-size:11px;"> ${modeLabel}</span></div>
        </div>
      </div>`;

        let bodyHtml;

        if (state.selectedFactionId && state.watchedFactions[state.selectedFactionId]) {
            if (state.activeTab === 'abroad' && isOwnFactionSelected) {
                bodyHtml = `<div style="margin-top:4px;">
                    <div class="tt-row" style="margin-bottom:8px;">
                        <button id="tt-back-to-list" style="background:none;border:none;color:var(--tt-text-soft);cursor:pointer;display:flex;align-items:center;gap:6px;font-size:16px;touch-action:manipulation;"><span style="font-size:20px;">\u2190</span><span>Factions</span></button>
                        <div style="text-align:right;">
                            <div style="font-size:16px;font-weight:700;">Abroad</div>
                            <div style="font-size:11px;color:var(--tt-text-soft);">Present + inbound</div>
                        </div>
                    </div>
                    ${renderAbroadTab(state.selectedFactionId)}
                </div>`;
            } else {
                bodyHtml = renderFactionMembers(state.selectedFactionId);
            }
        } else {
            bodyHtml = renderFactionList();
        }

        panel.innerHTML = headerHtml + bodyHtml + `<div class="tt-footer"><div><span style="font-weight:600;">Legend</span><span style="margin-left:6px;font-size:11px;"><span style="color:var(--tt-accent);">\u25A0</span> Out <span style="color:var(--tt-purple);margin-left:6px;">\u25A0</span> Return <span style="color:var(--tt-warning);margin-left:6px;">\u25A0</span> Landing</span></div><div><span class="tt-kbd">v18.2.6</span><span style="margin-left:6px;font-size:11px;">FF BS</span></div></div>`;

        document.getElementById('tt-close-panel')?.addEventListener('click', closePanel);
        bindMainModeTabs(panel);
        bindAdminEntryButton();
        bindAccessRecoveryActions();

        const copyAllBtn = document.getElementById('tt-copy-all-btn');

        if (copyAllBtn) {
            copyAllBtn.addEventListener('click', () => {
                if (
                    state.activeTab === 'abroad' &&
                    state.selectedFactionId &&
                    state.myFactionID &&
                    String(state.selectedFactionId) === String(state.myFactionID)
                ) {
                    copyAbroadReport(state.selectedFactionId);
                    return;
                }

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

                if (flying.length === 0) {
                    alert('No traveling members to copy.');
                    return;
                }

                let text = `Travel Tracker Report \u2013 ${f.name}\n`;

                const outCount = flying.filter(m => m.destination !== 'Torn').length;
                const retCount = flying.filter(m => m.destination === 'Torn').length;

                text += `Out: ${outCount}  Return: ${retCount}  Total flying: ${flying.length}\n\n`;

                flying.forEach((m, idx) => {
                    const isCommercial = m.flightType === 'Commercial';
                    const exactArrival = getMemberExactArrival(m);
                    const hasExactArrival = exactArrival != null;
                    const bizKey = `${m.xid}:${m.travelStarted}`;
                    const isBusiness = !hasExactArrival && (state.businessFlights[bizKey] || false);
                    const arrival = getMemberArrivalWindow(m);
                    const elapsed = now - m.travelStarted;
                    const bs = m.tbs || m.bs_estimate || null;
                    const bsFormatted = bs ? formatBS(bs) : null;
                    const flightTypeLabel = m.flightType || 'Flight';
                    const earliestRem = arrival ? Math.max(0, arrival.earliest - now) : 0;
                    const latestRem = arrival ? Math.max(0, arrival.latest - now) : 0;
                    const exactRemRaw = arrival?.exact ? arrival.earliest - now : null;
                    const isLanding = !!arrival && (arrival.exact ? exactRemRaw <= EXACT_LANDING_PHASE_MS : now >= arrival.earliest);

                    text += `${idx + 1}. \u2708\uFE0F ${m.playerName} \u2192 ${FLAG_EMOJI[m.destination] || ''} ${m.destination}\n`;

                    if (bsFormatted) text += `   BS: ${bsFormatted} | Flight: ${flightTypeLabel}\n`;
                    else text += `   Flight: ${flightTypeLabel}\n`;

                    text += `   Flying for ${formatElapsed(elapsed)}\n`;

                    if (!arrival) {
                        text += '   Arrival: unavailable\n';
                    } else if (arrival.exact) {
                        if (exactRemRaw <= 0) text += '   LANDED\n';
                        else if (isLanding) text += `   LANDING: ${formatTime(exactRemRaw)}\n`;
                        else text += `   ${m.destination === 'Torn' ? 'RET' : 'OUT'}: ${formatTime(exactRemRaw)}\n`;
                    } else if (isLanding) {
                        text += latestRem > 0 ? `   LANDING: ${formatTime(latestRem)}\n` : '   LANDING\n';
                    } else {
                        text += `   Window: ${formatTime(earliestRem)}-${formatTime(latestRem)}\n`;
                        text += `   ETA: ${arrival.earliestText}-${arrival.latestText}\n`;
                    }

                    if (isBusiness && isCommercial && !isLanding) {
                        const businessBase = BUSINESS_DURATIONS[m.lookupDest] || (DEFAULT_DURATIONS[m.lookupDest]?.[m.flightType] * 0.30);
                        const bizFastestETA = m.travelStarted + businessBase * 0.97 * 60000 - DETECT_DELAY;
                        const bizSlowestETA = m.travelStarted + businessBase * 1.03 * 60000;

                        text += `   Business: ${formatTime(Math.max(0, bizFastestETA - now))}-${formatTime(Math.max(0, bizSlowestETA - now))}\n`;
                    }

                    text += '\n';
                });

                navigator.clipboard.writeText(text).then(() => {
                    const btn = document.getElementById('tt-copy-all-btn');

                    if (btn) {
                        btn.style.background = 'rgba(255,215,0,0.4)';

                        setTimeout(() => {
                            btn.style.background = '';
                        }, 500);
                    }
                }).catch(() => alert('Failed to copy'));
            });
        }

        panel.querySelectorAll('.tt-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const t = tab.dataset.tab;

                if (t && t !== state.activeTab) {
                    state.activeTab = t;

                    updatePanelContent();
                }
            });
        });

        panel.querySelectorAll('.tt-abroad-filter').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();

                const view = btn.dataset.abroadView;

                if (!view || view === state.abroadView) return;

                state.abroadView = view;

                updatePanelContent();
            });
        });

        panel.querySelectorAll('.tt-abroad-side-title').forEach(header => {
            header.addEventListener('click', e => {
                e.stopPropagation();

                const section = header.closest('.tt-abroad-side');

                if (!section) return;

                const sectionKey = section.dataset.abroadSection;

                if (!sectionKey) return;

                if (state.abroadCollapsedSections.has(sectionKey)) {
                    state.abroadCollapsedSections.delete(sectionKey);
                } else {
                    state.abroadCollapsedSections.add(sectionKey);
                }

                updatePanelContent();
            });
        });

        panel.querySelectorAll('.tt-abroad-country[data-abroad-copy]').forEach(card => {
            card.addEventListener('click', function (e) {
                if (e.target.closest('a') || e.target.closest('button') || e.target.closest('input') || e.target.closest('label') || e.target.closest('.tt-abroad-side-title')) return;

                const text = this.dataset.abroadCopy;

                if (!text) return;

                navigator.clipboard.writeText(text).then(() => {
                    const originalBorder = this.style.borderColor;
                    const originalBoxShadow = this.style.boxShadow;

                    this.style.borderColor = '#FFD700';
                    this.style.boxShadow = '0 0 0 1px rgba(255,215,0,0.75), var(--tt-shadow-soft)';

                    setTimeout(() => {
                        this.style.borderColor = originalBorder || '';
                        this.style.boxShadow = originalBoxShadow || '';
                    }, 600);
                }).catch(() => {});
            });
        });

        panel.querySelectorAll('.tt-faction-card').forEach(card => {
            card.addEventListener('click', e => {
                if (e.target.closest('.tt-war-toggle') || e.target.closest('.tt-watch-btn')) return;

                state.selectedFactionId = card.dataset.fid;

                updatePanelContent();
            });
        });

        document.getElementById('tt-back-to-list')?.addEventListener('click', () => {
            state.selectedFactionId = null;

            updatePanelContent();
        });

        document.getElementById('tt-stop-watch-faction')?.addEventListener('click', e => {
            const fid = e.target.dataset.fid;

            if (fid) removeWatchedFaction(fid);
        });

        const watchBtn = document.getElementById('tt-watch-faction-header');

        if (watchBtn) {
            watchBtn.addEventListener('click', async e => {
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
            btn.addEventListener('click', e => {
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

                        setTimeout(() => {
                            this.style.borderColor = orig || '';
                        }, 600);
                    }).catch(() => {});
                }
            });
        });
    }

    function renderFactionList() {
        sanitizeOpponentFactions();

        const fids = Object.keys(state.watchedFactions);
        let html = '<div style="margin-top:6px;">';
        const currentFid = getCurrentFactionIdFromUrl();

        if (isFactionProfilePage() && currentFid) {
            const isWatched = !!state.watchedFactions[currentFid];
            const isOwn = String(currentFid) === String(state.myFactionID);
            const watchDisabled = isOwn ? 'disabled' : '';

            html += `<div class="tt-row" style="margin-bottom:10px;">
        <div class="tt-section-title">Watched factions</div>
        <button id="tt-watch-faction-header" class="tt-watch-btn ${isWatched ? 'tt-watch-btn--active' : ''}" ${watchDisabled}>
          ${isOwn ? 'OWN \u2713' : (isWatched ? 'WATCHING \u2713' : 'WATCH')}
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
                const isOwn = String(fid) === String(state.myFactionID);
                const isOpponent = isOpponentFaction(fid);

                html += `<div class="tt-faction-card" data-fid="${fid}">
          <div style="flex:1;min-width:0;">
            <div class="tt-faction-name">${escapeHtml(f.name)}${isOwn ? ' \u2B50' : ''}</div>
            <div class="tt-faction-sub">Out:${out} Ret:${ret} Landed:${landed}</div>
          </div>
          <div class="tt-row-gap">
            ${!isOwn ? `<button class="tt-war-toggle ${isOpponent ? 'active' : ''}" data-fid="${fid}" style="margin-right:6px;">${isOpponent ? '\u2713 OPPONENT' : 'OPPONENT'}</button>` : ''}
            <span style="font-size:18px;color:var(--tt-text-soft);">\u203A</span>
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
        const isOwn = String(fid) === String(state.myFactionID);
        const flying = [];
        const landed = [];

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
          <span style="font-size:20px;">\u2190</span><span>Factions</span>
        </button>
        <div style="text-align:right;">
          <div style="font-size:16px;font-weight:700;">
            <a href="/factions.php?step=profile&ID=${fid}" target="_blank" style="color:inherit;text-decoration:none;">
              ${escapeHtml(f.name)} ${isOwn ? ' \u2B50' : ''}
            </a>
          </div>
          <div style="font-size:12px;color:var(--tt-text-soft);">
            Out: ${outCount} \u2022 Ret: ${retCount} \u2022 Landed: ${landed.length}
          </div>
        </div>
      </div>
      <div class="tt-row" style="margin-bottom:10px;flex-wrap:wrap;gap:6px;">
        <div class="tt-chip tt-chip-accent">
          <span style="width:8px;height:8px;border-radius:50%;background:var(--tt-accent);display:inline-block;"></span>
          OUT
        </div>
        <div class="tt-chip tt-chip-purple">
          <span style="width:8px;height:8px;border-radius:50%;background:var(--tt-purple);display:inline-block;"></span>
          RET
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

    function renderLandedCard(m, options = {}) {
        const bsPill = renderBSPill(m);
        const elapsed = Date.now() - m.landedAt;
        const elapsedStr = formatElapsed(elapsed);
        const route = m.destination === 'Torn' ? '\u2190 ' + m.origin : m.origin + ' \u2192 ' + m.destination;
        const untrackHtml = options.untrack ? `<button class="tt-player-action tt-player-action--untrack" data-track-stop="${m.xid}">UNTRACK</button>` : '';

        return `<div class="tt-member-card" style="background:radial-gradient(circle at 0 0, rgba(76,175,80,0.2), transparent 55%), var(--tt-bg-card);border-color:rgba(76,175,80,0.7);">
      <div class="tt-member-main"><div class="tt-member-name"><a href="/profiles.php?XID=${m.xid}" target="_blank">${escapeHtml(m.playerName)}</a></div><div class="tt-member-route">${escapeHtml(route)}</div></div>
      <div class="tt-member-meta">
        <span class="tt-chip tt-chip-success"><span style="font-size:12px;">LANDED</span><span style="font-family:monospace;font-size:11px;margin-left:4px;">${formatWallClock(m.landedAt)}</span></span>
        <div class="tt-row-gap">${bsPill}<span style="font-size:12px;color:var(--tt-text-soft);">${m.flightType}</span>${untrackHtml}</div>
      </div>
      <div style="margin-top:4px;font-size:11px;color:var(--tt-text-soft);text-align:right;">Elapsed: ${elapsedStr}</div>
    </div>`;
    }

    function renderTravelCard(m, now, options = {}) {
        const allowBiz = options.allowBiz !== false;
        const copyEnabled = options.copyEnabled !== false;
        const untrackHtml = options.untrack ? `<button class="tt-player-action tt-player-action--untrack" data-track-stop="${m.xid}">UNTRACK</button>` : '';
        const isYou = String(m.xid) === String(state.myUserID);
        const isCommercial = m.flightType === 'Commercial';
        const exactArrival = getMemberExactArrival(m);
        const hasExactArrival = exactArrival != null;
        const exactRemRaw = hasExactArrival ? exactArrival - now : null;

        // A tracker user's Torn .until is authoritative. At zero they are presented as LANDED
        // immediately, without waiting for the next faction-status poll.
        if (hasExactArrival && exactRemRaw <= 0) {
            return renderLandedCard({ ...m, status: 'landed', landedAt: exactArrival }, options);
        }

        const bizKey = `${m.xid}:${m.travelStarted}`;
        const isBusiness = allowBiz && isCommercial && !hasExactArrival && (state.businessFlights[bizKey] || false);
        const baseDur = DEFAULT_DURATIONS[m.lookupDest]?.[m.flightType] || 120;
        const businessBase = isCommercial ? (BUSINESS_DURATIONS[m.lookupDest] || baseDur * 0.30) : baseDur;
        const fastestDur = getFastestDuration(m.lookupDest, m.flightType);
        const slowestDur = getSlowestDuration(m.lookupDest, m.flightType);
        const bizFastestDur = businessBase * 0.97;
        const bizSlowestDur = businessBase * 1.03;

        let fastestETA;
        let slowestETA;
        let bizFastestETA;
        let bizSlowestETA;

        if (hasExactArrival) {
            fastestETA = exactArrival;
            slowestETA = exactArrival;
            bizFastestETA = exactArrival;
            bizSlowestETA = exactArrival;
        } else {
            fastestETA = Number(m.travelStarted) + fastestDur * 60000 - DETECT_DELAY;
            slowestETA = Number(m.travelStarted) + slowestDur * 60000;
            bizFastestETA = Number(m.travelStarted) + bizFastestDur * 60000 - DETECT_DELAY;
            bizSlowestETA = Number(m.travelStarted) + bizSlowestDur * 60000;
        }

        const fastestRemRaw = fastestETA - now;
        const slowestRemRaw = slowestETA - now;
        const fastestRem = Math.max(0, fastestRemRaw);
        const slowestRem = Math.max(0, slowestRemRaw);
        const bizFastestRem = Math.max(0, bizFastestETA - now);
        const bizSlowestRem = Math.max(0, bizSlowestETA - now);
        const elapsed = Math.max(0, now - Number(m.travelStarted || now));
        const total = hasExactArrival && Number(m.travelStarted) > 0 && exactArrival > Number(m.travelStarted)
            ? exactArrival - Number(m.travelStarted)
            : baseDur * 60000;
        const pct = total > 0 ? Math.min(100, (elapsed / total) * 100) : 100;
        const isLanding = hasExactArrival
            ? exactRemRaw <= EXACT_LANDING_PHASE_MS
            : fastestRemRaw <= 0;
        const isReturn = m.destination === 'Torn';
        const bizTotal = businessBase * 60000;
        const bizPct = bizTotal > 0 ? Math.min(100, (elapsed / bizTotal) * 100) : 0;
        const bizPlaneLeft = isReturn ? (100 - bizPct) : bizPct;
        const bizFillStyle = isReturn ? `right:0;left:auto;width:${bizPct}%;` : `left:0;right:auto;width:${bizPct}%;`;
        const barColor = isLanding ? '#FFB300' : isReturn ? '#9C27B0' : (pct > 90 ? '#FFB300' : '#2196F3');
        const barWidth = isLanding ? 100 : pct;
        const chipClass = isLanding ? 'tt-chip-warning' : isReturn ? 'tt-chip-purple' : 'tt-chip-accent';
        const chipLabel = isLanding ? 'LANDING' : (isReturn ? 'RET' : 'OUT');
        const bsPill = renderBSPill(m);
        const route = isReturn ? '\u2190 ' + m.origin : m.origin + ' \u2192 ' + m.destination;
        const cardClasses = ['tt-member-card'];
        const locallySameDestination = !!(state.myDestination && m.destination !== 'Torn' && m.destination === state.myDestination && !isYou);

        if (locallySameDestination) cardClasses.push('tt-member-card--same-dest');
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
        const clipLines = [`\u2708\uFE0F ${m.playerName} \u2192 ${flagEmoji} ${m.destination}`];
        const bsFormatted = (m.tbs || m.bs_estimate) ? formatBS(m.tbs || m.bs_estimate) : null;

        if (bsFormatted) clipLines.push(`BS: ${bsFormatted} | Flight: ${m.flightType}`);
        else clipLines.push(`Flight: ${m.flightType}`);

        clipLines.push(`Flying for ${formatElapsed(elapsed)}`);

        if (hasExactArrival) {
            clipLines.push(isLanding
                ? `LANDING: ${formatTime(Math.max(0, exactRemRaw))}`
                : `${isReturn ? 'RET' : 'OUT'}: ${formatTime(Math.max(0, exactRemRaw))}`);
        } else if (isLanding) {
            clipLines.push(slowestRemRaw > 0 ? `Landing: ${formatTime(slowestRem)}` : 'Landing');
        } else {
            clipLines.push(`Window: ${formatTime(fastestRem)}-${formatTime(slowestRem)}`);
            clipLines.push(`ETA: ${formatArrivalClock(fastestETA)}-${formatArrivalClock(slowestETA)}`);
        }

        if (isBusiness && isCommercial) {
            if (isLanding) clipLines.push('Business: landed');
            else clipLines.push(`Business: ${formatTime(bizFastestRem)}-${formatTime(bizSlowestRem)}`);
        }

        const clipText = clipLines.join('\n');
        let ghostHtml = '';

        if (isBusiness && isCommercial) {
            const ghostPlaneTransform = isReturn ? 'translateX(-50%) translateY(-50%) scaleX(-1) rotate(45deg)' : 'translateX(-50%) translateY(-50%) rotate(45deg)';

            ghostHtml = `
        <div class="tt-progress-ghost-fill" style="${bizFillStyle}"></div>
        <div class="tt-progress-ghost-plane" style="left:${bizPlaneLeft}%; transform:${ghostPlaneTransform};">\u2708\uFE0F</div>
      `;
        }

        let bizWindowHtml = '';

        if (isBusiness && isCommercial) {
            if (isLanding) {
                bizWindowHtml = `<div class="tt-biz-window">Business: landed</div>`;
            } else {
                bizWindowHtml = `<div class="tt-biz-window">Business: <span class="tt-live-window" data-earliest="${bizFastestETA}" data-latest="${bizSlowestETA}">${formatTime(bizFastestRem)}-${formatTime(bizSlowestRem)}</span></div>`;
            }
        }

        let bizToggleHtml = '';

        if (allowBiz && isCommercial && !hasExactArrival) {
            bizToggleHtml = `
        <label class="tt-business-toggle" style="margin-left:8px;">
          <input type="checkbox" ${isBusiness ? 'checked' : ''} data-bizkey="${bizKey}">
          Biz
        </label>
      `;
        }

        let chipCountdownHtml = '';

        if (hasExactArrival) {
            chipCountdownHtml = `<span class="tt-live-countdown" data-target="${exactArrival}" style="font-family:monospace;font-size:11px;margin-left:4px;">${formatTime(Math.max(0, exactRemRaw))}</span>`;
        } else if (!isLanding) {
            chipCountdownHtml = `<span class="tt-live-countdown" data-target="${fastestETA}" style="font-family:monospace;font-size:11px;margin-left:4px;">${formatTime(fastestRem)}</span>`;
        } else if (slowestRemRaw > 0) {
            chipCountdownHtml = `<span class="tt-live-countdown" data-target="${slowestETA}" style="font-family:monospace;font-size:11px;margin-left:4px;">${formatTime(slowestRem)}</span>`;
        }

        let secondaryTimingHtml = '';

        if (!hasExactArrival && !isLanding) {
            secondaryTimingHtml = `<span style="margin-left:8px;">Window: <span class="tt-live-window" data-earliest="${fastestETA}" data-latest="${slowestETA}" style="font-weight:700;color:#FFD700;">${formatTime(fastestRem)}-${formatTime(slowestRem)}</span></span>`;
        }

        const phase = isLanding
            ? ((hasExactArrival || slowestRemRaw > 0) ? 'landing-countdown' : 'landing')
            : 'traveling';
        const phaseEarliest = hasExactArrival ? exactArrival - EXACT_LANDING_PHASE_MS : fastestETA;
        const phaseLatest = hasExactArrival ? exactArrival : slowestETA;
        const clipAttribute = copyEnabled ? ` data-clip-text="${escapeHtml(clipText)}"` : '';

        return `<div class="${cardClasses.join(' ')}" data-flight-earliest="${phaseEarliest}" data-flight-latest="${phaseLatest}" data-flight-phase="${phase}"${clipAttribute}>
      <div class="tt-member-main">
        <div class="tt-member-name">
          <a href="/profiles.php?XID=${m.xid}" target="_blank">${escapeHtml(m.playerName)}</a>
        </div>
        <div class="tt-member-route">${escapeHtml(route)}</div>
      </div>
      <div class="tt-member-meta">
        <span class="tt-chip ${chipClass}"><span style="font-size:11px;">${chipLabel}</span>${chipCountdownHtml}</span>
        <div class="tt-row-gap">
          ${bsPill}
          <span style="font-size:12px;color:var(--tt-text-soft);">${m.flightType}</span>
          ${bizToggleHtml}
          ${untrackHtml}
        </div>
      </div>
      <div style="margin-top:4px;font-size:12px;color:${isLanding ? 'var(--tt-warning)' : 'var(--tt-text-soft)'};text-align:left;">
        <span>Elapsed: <span class="tt-live-elapsed" data-start="${m.travelStarted}" style="font-weight:700;color:#fff;">${formatElapsed(elapsed)}</span></span>
        ${secondaryTimingHtml}
      </div>
      ${bizWindowHtml}
      <div class="tt-progress-shell-new">
        <div class="tt-progress-flags-row">
          <div class="tt-circular-flag"><img src="/images/v2/travel_agency/flags/fl_torn.svg" alt="Torn"></div>
          <div class="tt-progress-track-new">
            <div class="tt-progress-fill-new" style="${fillStyle}"></div>
            <div class="tt-progress-plane-new" style="left:${planeLeft}%; transform:${planeTransform};">\u2708\uFE0F</div>
            ${ghostHtml}
          </div>
          <div class="tt-circular-flag"><img src="${abroadFlagUrl}" alt="Abroad"></div>
        </div>
      </div>
    </div>`;
    }

    // ==================== INIT ====================
    function init() {
        injectGlobalStyles();
        injectThreatOverlayStyles();
        requestNotificationPermission();
        cleanupNotifiedFlights();
        cleanupNotifiedLandings();

        window.addEventListener('myfactionUpdated', event => {
            const faction = event.detail || getMyFactionDetails();

            state.myFactionID = faction?.id ? String(faction.id) : null;
            state.myFactionName = faction?.name || null;
            sanitizeOpponentFactions();

            if (state.panelVisible) updatePanelContent();

            updateThreatOverlay();
        });

        const savedWar = GM_getValue('warFactions', null);

        if (savedWar) {
            try {
                const parsed = JSON.parse(savedWar);

                if (Array.isArray(parsed)) {
                    state.warFactions = new Set(parsed.map(String));
                }
            } catch (e) {}
        }

        pollServer().finally(() => {
            startPolling();
        });

        injectFloatingIcon();
        startThreatOverlay();
        detectWarFactionsFromPage();

        let lastUrl = window.location.href;

        new MutationObserver(() => {
            if (window.location.href !== lastUrl) {
                lastUrl = window.location.href;

                detectWarFactionsFromPage();

                pollServer().then(() => { if (state.panelVisible) updatePanelContent(); });
            }
        }).observe(document, {
            subtree: true,
            childList: true
        });

        document.addEventListener('change', function (e) {
            if (e.target.matches('.tt-business-toggle input[type="checkbox"]')) {
                const key = e.target.dataset.bizkey;

                if (key) {
                    state.businessFlights[key] = e.target.checked;

                    updatePanelContent();
                }
            }
        });
    }

    init();
})();
