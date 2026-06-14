// ==UserScript==
// @name         1 TERMUX Flight Tracker (Local Server Client) - v12.3 Tabs Revamp
// @namespace    https://github.com/your-repo
// @version      12.3
// @description  Premium UI client with Outbound/Return tabs, clickable names, and browser notifications
// @author       Doitsburger
// @match        https://www.torn.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  const SERVER_URL = 'http://127.0.0.1:3000';
  const POLL_INTERVAL_MS = 1000;
  const PANEL_UPDATE_INTERVAL = 1000;

  const DEFAULT_DURATIONS = {
    "Mexico": { "Commercial": 26, "Personal": 18, "Private": 13 },
    "Cayman Islands": { "Commercial": 35, "Personal": 25, "Private": 18 },
    "Canada": { "Commercial": 41, "Personal": 29, "Private": 20 },
    "Hawaii": { "Commercial": 134, "Personal": 94, "Private": 67 },
    "United Kingdom": { "Commercial": 159, "Personal": 111, "Private": 80 },
    "Argentina": { "Commercial": 167, "Personal": 117, "Private": 83 },
    "Switzerland": { "Commercial": 175, "Personal": 123, "Private": 88 },
    "Japan": { "Commercial": 225, "Personal": 158, "Private": 113 },
    "China": { "Commercial": 242, "Personal": 169, "Private": 121 },
    "UAE": { "Commercial": 271, "Personal": 190, "Private": 135 },
    "South Africa": { "Commercial": 297, "Personal": 208, "Private": 149 }
  };

  let state = {
    apiKeySet: false,
    watchedFactions: {},
    selectedFactionId: null,
    panelVisible: false,
    panelInterval: null,
    myUserID: null,
    myDestination: null,
    friendlyAbroad: [],
    lastPollTime: 0,
    serverOnline: false,
    activeTab: 'all',                   // 'all' | 'outbound' | 'return'
    previousMembers: {},
    notifiedFlights: {}
  };

  // ---------- DESIGN SYSTEM / HELPERS ----------

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

      #travel-float-icon {
        -webkit-tap-highlight-color: transparent;
      }

      .tt-panel {
        font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      }

      .tt-scrollbar::-webkit-scrollbar {
        width: 6px;
      }
      .tt-scrollbar::-webkit-scrollbar-track {
        background: transparent;
      }
      .tt-scrollbar::-webkit-scrollbar-thumb {
        background: rgba(255,255,255,0.12);
        border-radius: 3px;
      }

      .tt-chip {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 2px 8px;
        border-radius: 999px;
        font-size: 10px;
        font-weight: 600;
        letter-spacing: 0.02em;
        text-transform: uppercase;
      }

      .tt-chip-soft {
        background: rgba(255,255,255,0.04);
        border: 1px solid rgba(255,255,255,0.08);
        color: var(--tt-text-soft);
      }

      .tt-chip-accent {
        background: var(--tt-accent-soft);
        border: 1px solid rgba(33,150,243,0.6);
        color: #E3F2FD;
      }

      .tt-chip-success {
        background: rgba(76,175,80,0.16);
        border: 1px solid rgba(76,175,80,0.6);
        color: #C8E6C9;
      }

      .tt-chip-warning {
        background: rgba(255,179,0,0.16);
        border: 1px solid rgba(255,179,0,0.7);
        color: #FFE082;
      }

      .tt-chip-danger {
        background: rgba(239,83,80,0.16);
        border: 1px solid rgba(239,83,80,0.7);
        color: #FFCDD2;
      }

      .tt-chip-purple {
        background: rgba(156,39,176,0.16);
        border: 1px solid rgba(156,39,176,0.7);
        color: #E1BEE7;
      }

      .tt-tab-row {
        display: flex;
        gap: 6px;
        padding: 4px;
        background: rgba(255,255,255,0.03);
        border-radius: 999px;
        border: 1px solid rgba(255,255,255,0.06);
      }

      .tt-tab {
        flex: 1;
        border-radius: 999px;
        padding: 4px 0;
        font-size: 11px;
        font-weight: 600;
        text-align: center;
        cursor: pointer;
        color: var(--tt-text-soft);
        border: none;
        background: transparent;
        transition: background var(--tt-transition-fast), color var(--tt-transition-fast), transform 0.12s ease-out;
      }

      .tt-tab.tt-active {
        background: rgba(255,255,255,0.08);
        color: var(--tt-text-main);
        transform: translateY(-1px);
      }

      .tt-pill-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 18px;
        padding: 0 6px;
        border-radius: 999px;
        font-size: 10px;
        font-weight: 600;
        background: rgba(255,255,255,0.08);
        color: var(--tt-text-main);
      }

      .tt-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
      }

      .tt-row-gap {
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .tt-member-card {
        background: var(--tt-bg-card);
        border-radius: var(--tt-radius-md);
        border: 1px solid var(--tt-border-subtle);
        padding: 8px 10px 8px 10px;
        margin-bottom: 6px;
        box-shadow: var(--tt-shadow-soft);
      }

      .tt-member-card--same-dest {
        border-color: rgba(183,28,28,0.9);
        box-shadow: 0 0 0 1px rgba(183,28,28,0.6), var(--tt-shadow-soft);
        background: radial-gradient(circle at 0 0, rgba(183,28,28,0.35), transparent 55%), var(--tt-bg-card);
      }

      .tt-member-main {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
      }

      .tt-member-name {
        font-size: 13px;
        font-weight: 600;
        color: var(--tt-text-main);
        max-width: 52%;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .tt-member-name a {
        color: inherit;
        text-decoration: none;
      }
      .tt-member-name a:hover {
        text-decoration: underline;
      }

      .tt-member-route {
        font-size: 11px;
        color: var(--tt-text-muted);
        text-align: right;
        max-width: 48%;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .tt-member-meta {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-top: 4px;
        font-size: 10px;
        color: var(--tt-text-soft);
      }

      .tt-progress-shell {
        position: relative;
        height: 30px;
        margin-top: 6px;
      }

      .tt-progress-labels {
        position: absolute;
        top: -2px;
        left: 0;
        right: 0;
        font-size: 9px;
        color: var(--tt-text-soft);
        display: flex;
        justify-content: space-between;
        padding: 0 4px;
      }

      .tt-progress-track {
        position: absolute;
        top: 14px;
        left: 0;
        right: 0;
        height: 6px;
        background: rgba(255,255,255,0.06);
        border-radius: 999px;
        overflow: hidden;
      }

      .tt-progress-fill {
        position: absolute;
        top: 0;
        height: 100%;
        border-radius: 999px;
        transition: width 1s linear, background var(--tt-transition-fast);
      }

      .tt-progress-node {
        position: absolute;
        top: 9px;
        width: 12px;
        height: 12px;
        border-radius: 50%;
        border: 2px solid #111;
        box-shadow: 0 0 0 1px rgba(0,0,0,0.6);
      }

      .tt-progress-plane {
        position: absolute;
        top: 10px;
        font-size: 13px;
        filter: drop-shadow(0 1px 2px rgba(0,0,0,0.7));
        transition: left 1s linear, transform var(--tt-transition-fast);
      }

      .tt-section-title {
        font-size: 13px;
        font-weight: 600;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--tt-text-soft);
      }

      .tt-faction-card {
        background: var(--tt-bg-card-soft);
        border-radius: var(--tt-radius-md);
        border: 1px solid var(--tt-border-subtle);
        padding: 10px 12px;
        margin-bottom: 6px;
        cursor: pointer;
        transition: background var(--tt-transition-fast), border-color var(--tt-transition-fast), transform 0.12s ease-out;
        box-shadow: var(--tt-shadow-soft);
      }

      .tt-faction-card:hover {
        background: rgba(255,255,255,0.04);
        border-color: var(--tt-border-strong);
        transform: translateY(-1px);
      }

      .tt-faction-name {
        font-size: 13px;
        font-weight: 600;
        color: var(--tt-text-main);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .tt-faction-name a {
        color: inherit;
        text-decoration: none;
      }
      .tt-faction-name a:hover {
        text-decoration: underline;
      }

      .tt-faction-sub {
        font-size: 10px;
        color: var(--tt-text-soft);
        margin-top: 2px;
      }

      .tt-kbd {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 1px 5px;
        border-radius: 4px;
        border: 1px solid rgba(255,255,255,0.18);
        font-size: 9px;
        font-family: "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
        background: rgba(0,0,0,0.4);
        color: var(--tt-text-soft);
      }

      .tt-footer {
        position: sticky;
        bottom: -16px;
        margin: 10px -16px -16px -16px;
        padding: 8px 16px 14px 16px;
        background: linear-gradient(to top, rgba(0,0,0,0.9), transparent);
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: 10px;
        color: var(--tt-text-soft);
      }

      .tt-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        border: 1px solid #000;
      }

      .tt-dot--online {
        background: var(--tt-success);
      }
      .tt-dot--offline {
        background: var(--tt-danger);
      }
      .tt-dot--apikey {
        background: var(--tt-warning);
      }
    `;
    document.head.appendChild(style);
  }

  function escapeHtml(text) {
    if (!text) return '';
    return text.replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\"/g, '&quot;');
  }

  function getFastestDuration(destination, flightType) {
    const base = DEFAULT_DURATIONS[destination]?.[flightType];
    if (base) return base * 0.97;
    return 10;
  }

  function getSlowestDuration(destination, flightType) {
    const base = DEFAULT_DURATIONS[destination]?.[flightType];
    if (base) return base * 1.03;
    return 10;
  }

  function formatTime(ms) {
    if (ms <= 0) return '0:00';
    const totalSeconds = Math.floor(ms / 1000);
    const hrs = Math.floor(totalSeconds / 3600);
    const mins = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;
    if (hrs > 0) return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  function formatWallClock(timestamp) {
    const d = new Date(timestamp);
    return d.toTimeString().split(' ')[0];
  }

  function isFactionProfilePage() {
    return /\/factions\.php\?step=profile/i.test(window.location.href);
  }

  function getCurrentFactionIdFromUrl() {
    const params = new URLSearchParams(window.location.search);
    return params.get('ID');
  }

  function scrapeFactionNameFromPage() {
    const el = document.querySelector('.title-black.hospital-dark.top-round.m-top10');
    if (!el) return null;
    const clone = el.cloneNode(true);
    const respect = clone.querySelector('.bold.f-title-respect');
    if (respect) respect.remove();
    const text = clone.textContent.trim().replace(/\s+/g, ' ').trim();
    return text.length > 0 && text.length < 100 ? text : null;
  }

  // ---------- NOTIFICATIONS ----------
  function requestNotificationPermission() {
    if (Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }

  function sendBrowserNotification(title, body) {
    if (Notification.permission === 'granted') {
      new Notification(title, { body, icon: 'https://www.torn.com/favicon.ico' });
    }
  }

  function detectNewFlights(currentFactions) {
    for (const fid in currentFactions) {
      const currentMembers = currentFactions[fid]?.members || {};
      const prevMembers = state.previousMembers[fid] || {};

      for (const xid in currentMembers) {
        const curr = currentMembers[xid];
        const prev = prevMembers[xid];

        if (curr && curr.status === 'traveling' && (!prev || prev.status !== 'traveling')) {
          const flightKey = `${fid}:${xid}:${curr.destination}:${curr.travelStarted}`;
          if (!state.notifiedFlights[flightKey]) {
            state.notifiedFlights[flightKey] = true;

            // Periodic cleanup
            const keys = Object.keys(state.notifiedFlights);
            if (keys.length > 100) {
              const cutoff = Date.now() - 24 * 3600 * 1000;
              for (const k of keys) {
                if (state.notifiedFlights[k] && parseInt(k.split(':')[3]) < cutoff) {
                  delete state.notifiedFlights[k];
                }
              }
            }

            if (curr.sameDestination) {
              sendBrowserNotification('Enemy inbound!', `${curr.playerName} is flying to your location (${curr.destination})`);
            } else if (state.friendlyAbroad.includes(curr.destination)) {
              sendBrowserNotification('Enemy toward friendlies!', `${curr.playerName} is flying to ${curr.destination}, where friendlies are abroad`);
            }
          }
        }
      }
    }
  }

  // ---------- LOCAL SERVER API ----------

  function serverRequest(method, path, data) {
    return new Promise((resolve, reject) => {
      const url = `${SERVER_URL}${path}`;
      const options = {
        method: method,
        url: url,
        headers: { 'Accept': 'application/json' },
        onload: (resp) => {
          if (resp.status >= 200 && resp.status < 300) {
            try { resolve(JSON.parse(resp.responseText)); } catch (e) { resolve({}); }
          } else {
            reject(new Error(`HTTP ${resp.status}`));
          }
        },
        onerror: reject
      };
      if (data) {
        options.headers['Content-Type'] = 'application/json';
        options.data = JSON.stringify(data);
      }
      GM_xmlhttpRequest(options);
    });
  }

  async function pollServer() {
    try {
      const prevFactions = {};
      for (const fid in state.watchedFactions) {
        prevFactions[fid] = {
          members: JSON.parse(JSON.stringify(state.watchedFactions[fid]?.members || {}))
        };
      }

      const data = await serverRequest('GET', '/api/state');
      state.apiKeySet = data.apiKeySet;
      state.myUserID = data.myUserID;
      state.myDestination = data.myDestination;
      state.friendlyAbroad = data.friendlyAbroad || [];
      state.lastPollTime = Date.now();
      state.serverOnline = true;

      if (data.factions) {
        state.watchedFactions = {};
        for (const fid in data.factions) {
          state.watchedFactions[fid] = {
            name: data.factions[fid].name || `Faction ${fid}`,
            members: data.factions[fid].members || {}
          };
        }
      }

      detectNewFlights(state.watchedFactions);

      state.previousMembers = {};
      for (const fid in state.watchedFactions) {
        state.previousMembers[fid] = {
          members: JSON.parse(JSON.stringify(state.watchedFactions[fid]?.members || {}))
        };
      }

      const dot = document.getElementById('travel-tracker-status');
      if (dot) {
        dot.classList.remove('tt-dot--offline', 'tt-dot--apikey', 'tt-dot--online');
        if (!state.apiKeySet) dot.classList.add('tt-dot--apikey');
        else dot.classList.add('tt-dot--online');
      }
    } catch (e) {
      state.serverOnline = false;
      const dot = document.getElementById('travel-tracker-status');
      if (dot) {
        dot.classList.remove('tt-dot--online', 'tt-dot--apikey');
        dot.classList.add('tt-dot--offline');
      }
      console.warn('Travel Tracker: server unreachable', e.message);
    }
  }

  function promptForApiKey() {
    const key = prompt('Enter your Torn API key (stored on local server):', '');
    if (key && key.trim()) {
      serverRequest('POST', '/api/apikey', { key: key.trim() })
        .then(() => alert('API key saved to local server. Server will begin scanning shortly.'))
        .catch(err => alert('Failed to save API key: ' + err.message));
      return true;
    }
    return false;
  }

  async function addFactionToWatch(fid) {
    if (!state.apiKeySet) {
      if (!promptForApiKey()) return;
      await new Promise(r => setTimeout(r, 1500));
    }
    let name = scrapeFactionNameFromPage();
    if (!name) name = `Faction ${fid}`;
    try {
      await serverRequest('POST', '/api/watch', { fid, name });
      updateButtonOnPage(fid);
      state.selectedFactionId = fid;
      if (!state.panelVisible) createPanel();
      else updatePanelContent();
    } catch (e) {
      console.error('Failed to watch faction:', e.message);
      alert('Failed to watch faction. Is the local server running in Termux?');
    }
  }

  function removeWatchedFaction(fid) {
    serverRequest('DELETE', `/api/watch/${fid}`)
      .then(() => {
        if (state.selectedFactionId === fid) state.selectedFactionId = null;
        updatePanelContent();
        if (isFactionProfilePage() && getCurrentFactionIdFromUrl() === fid) {
          updateButtonOnPage(fid);
        }
      })
      .catch(err => console.error('Failed to remove faction:', err.message));
  }

  // ---------- UI: FLOATING ICON ----------

  function injectFloatingIcon() {
    if (document.getElementById('travel-float-icon')) return;

    const icon = document.createElement('div');
    icon.id = 'travel-float-icon';
    icon.style.cssText = `
      position: fixed;
      bottom: 82px;
      right: 10px;
      width: 46px;
      height: 46px;
      border-radius: 999px;
      background: radial-gradient(circle at 30% 0, rgba(255,255,255,0.16), transparent 55%), rgba(18,18,18,0.96);
      border: 1px solid rgba(255,255,255,0.12);
      box-shadow: 0 10px 26px rgba(0,0,0,0.75);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      z-index: 10000;
      color: #fff;
      font-size: 22px;
      backdrop-filter: blur(18px);
      -webkit-backdrop-filter: blur(18px);
      transition: transform 0.12s ease-out, box-shadow 0.12s ease-out, background 0.18s ease-out;
    `;

    const inner = document.createElement('div');
    inner.style.cssText = `display:flex; align-items:center; justify-content:center; gap:4px;`;
    inner.innerHTML = `<span style="font-size:18px;">✈️</span>`;

    const dot = document.createElement('div');
    dot.id = 'travel-tracker-status';
    dot.className = 'tt-dot tt-dot--offline';
    dot.style.cssText = `position:absolute; top:4px; right:4px;`;

    icon.appendChild(inner);
    icon.appendChild(dot);

    icon.addEventListener('mousedown', () => {
      icon.style.transform = 'translateY(1px) scale(0.97)';
      icon.style.boxShadow = '0 4px 14px rgba(0,0,0,0.8)';
    });
    icon.addEventListener('mouseup', () => {
      icon.style.transform = 'translateY(0) scale(1)';
      icon.style.boxShadow = '0 10px 26px rgba(0,0,0,0.75)';
    });
    icon.addEventListener('mouseleave', () => {
      icon.style.transform = 'translateY(0) scale(1)';
      icon.style.boxShadow = '0 10px 26px rgba(0,0,0,0.75)';
    });

    icon.addEventListener('click', () => {
      if (state.panelVisible) closePanel();
      else {
        state.selectedFactionId = null;
        createPanel();
      }
    });

    document.body.appendChild(icon);
  }

  // ---------- UI: PANEL LIFECYCLE ----------

  function createPanel() {
    const oldPanel = document.getElementById('travel-panel');
    if (oldPanel) {
      closePanel();
      return;
    }

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
    startPanelInterval();
  }

  function closePanel() {
    const panel = document.getElementById('travel-panel');
    if (!panel) return;
    panel.style.transform = 'translate(-50%, 100%)';
    panel.addEventListener('transitionend', function handler() {
      panel.removeEventListener('transitionend', handler);
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

  // ---------- UI: PANEL CONTENT ----------

  function updatePanelContent() {
    const panel = document.getElementById('travel-panel');
    if (!panel) return;

    if (!state.serverOnline) {
      panel.innerHTML = `
        <div style="display:flex; flex-direction:column; align-items:center; text-align:center; padding:24px 8px 10px 8px;">
          <div style="font-size:32px; margin-bottom:8px;">⚠️</div>
          <div style="font-weight:600; margin-bottom:4px;">Local server offline</div>
          <div style="font-size:11px; color:var(--tt-text-soft); margin-bottom:12px;">
            Check Termux and ensure your tracker server is running at<br>
            <span style="font-family:monospace; font-size:10px;">http://127.0.0.1:3000</span>
          </div>
          <button id="retry-poll" style="padding:6px 16px; border-radius:999px; border:none; background:var(--tt-accent); color:#fff; font-size:12px; font-weight:600; cursor:pointer; box-shadow:0 4px 12px rgba(33,150,243,0.45);">
            Retry connection
          </button>
        </div>
      `;
      document.getElementById('retry-poll')?.addEventListener('click', () => {
        pollServer().then(() => updatePanelContent());
      });
      return;
    }

    if (!state.apiKeySet) {
      panel.innerHTML = `
        <div style="display:flex; flex-direction:column; align-items:center; text-align:center; padding:24px 8px 10px 8px;">
          <div style="font-size:32px; margin-bottom:8px;">🔑</div>
          <div style="font-weight:600; margin-bottom:4px;">API key required</div>
          <div style="font-size:11px; color:var(--tt-text-soft); margin-bottom:12px;">
            Your API key is stored only on your local Termux server.<br>
            This client never sends it anywhere else.
          </div>
          <button id="set-api-key" style="padding:6px 16px; border-radius:999px; border:none; background:var(--tt-accent); color:#fff; font-size:12px; font-weight:600; cursor:pointer; box-shadow:0 4px 12px rgba(33,150,243,0.45);">
            Set API key
          </button>
        </div>
      `;
      document.getElementById('set-api-key')?.addEventListener('click', promptForApiKey);
      return;
    }

    const fids = Object.keys(state.watchedFactions);
    const totalTravelling = fids.reduce((acc, fid) => {
      const faction = state.watchedFactions[fid];
      const members = faction.members || {};
      const count = Object.values(members).filter(m => m.status === 'traveling' || m.status === 'landed').length;
      return acc + count;
    }, 0);

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
          <button id="tt-close-panel" style="background:none; border:none; color:var(--tt-text-soft); font-size:16px; cursor:pointer; padding:4px;">✕</button>
        </div>
        <div style="margin-top:8px; display:flex; justify-content:space-between; align-items:center; gap:8px;">
          <div class="tt-tab-row" style="flex:1;">
            <button class="tt-tab ${state.activeTab === 'all' ? 'tt-active' : ''}" data-tab="all">All</button>
            <button class="tt-tab ${state.activeTab === 'outbound' ? 'tt-active' : ''}" data-tab="outbound">Outbound</button>
            <button class="tt-tab ${state.activeTab === 'return' ? 'tt-active' : ''}" data-tab="return">Return</button>
          </div>
          <div class="tt-chip tt-chip-soft">
            <span class="tt-dot ${state.serverOnline ? (state.apiKeySet ? 'tt-dot--online' : 'tt-dot--apikey') : 'tt-dot--offline'}"></span>
            <span style="margin-left:4px; font-size:9px;">${state.serverOnline ? (state.apiKeySet ? 'Live' : 'API') : 'Offline'}</span>
          </div>
        </div>
      </div>
    `;

    let bodyHtml = '';
    if (state.selectedFactionId && state.watchedFactions[state.selectedFactionId]) {
      bodyHtml += renderFactionMembers(state.selectedFactionId);
    } else {
      bodyHtml += renderFactionList();
    }

    const footerHtml = `
      <div class="tt-footer">
        <div>
          <span style="font-weight:600;">Legend</span>
          <span style="margin-left:6px; font-size:9px;">
            <span style="color:var(--tt-accent);">■</span> Outbound
            <span style="margin-left:4px; color:var(--tt-purple);">■</span> Return
            <span style="margin-left:4px; color:var(--tt-warning);">■</span> Landing
          </span>
        </div>
        <div>
          <span class="tt-kbd">Termux</span>
          <span style="margin-left:4px; font-size:9px;">Local only</span>
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
      const fid = card.getAttribute('data-fid');
      card.addEventListener('click', () => {
        state.selectedFactionId = fid;
        updatePanelContent();
      });
    });

    document.getElementById('tt-back-to-list')?.addEventListener('click', () => {
      state.selectedFactionId = null;
      updatePanelContent();
    });
    document.getElementById('tt-stop-watch-faction')?.addEventListener('click', (e) => {
      const fid = e.target.getAttribute('data-fid');
      if (fid) removeWatchedFaction(fid);
    });
  }

  function renderFactionList() {
    const fids = Object.keys(state.watchedFactions);
    let html = `<div style="margin-top:4px;">`;
    html += `<div class="tt-section-title" style="margin-bottom:6px;">Watched factions</div>`;

    if (fids.length === 0) {
      html += `
        <div style="padding:14px 10px; border-radius:var(--tt-radius-md); border:1px dashed rgba(255,255,255,0.18); background:rgba(255,255,255,0.02); font-size:11px; color:var(--tt-text-soft); text-align:center;">
          No factions watched yet.<br>
          Visit a faction profile and use the <span style="font-weight:600;">WATCH</span> button on the banner.
        </div>
      `;
    } else {
      for (const fid of fids) {
        const faction = state.watchedFactions[fid];
        const name = faction.name || `Faction ${fid}`;
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
                <div class="tt-faction-name">${escapeHtml(name)}</div>
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

    html += `</div>`;
    return html;
  }

  function renderFactionMembers(fid) {
    const faction = state.watchedFactions[fid];
    const name = faction.name || `Faction ${fid}`;
    const members = faction.members || {};
    const now = Date.now();

    const inflight = [];
    const landed = [];
    for (const xid in members) {
      const m = members[xid];
      if (!m.xid) m.xid = xid; // ensure xid is set
      if (m.status === 'traveling') inflight.push(m);
      else if (m.status === 'landed') landed.push(m);
    }

    inflight.sort((a, b) => {
      const fastA = getFastestDuration(a.lookupDest, a.flightType) * 60000 + a.travelStarted;
      const fastB = getFastestDuration(b.lookupDest, b.flightType) * 60000 + b.travelStarted;
      return fastA - fastB;
    });
    landed.sort((a, b) => b.landedAt - a.landedAt);

    let allToShow = [];
    if (state.activeTab === 'all') {
      allToShow = [...landed, ...inflight]; // landed at top, then outbound+return
    } else if (state.activeTab === 'outbound') {
      allToShow = inflight.filter(m => m.destination !== 'Torn');
    } else if (state.activeTab === 'return') {
      allToShow = inflight.filter(m => m.destination === 'Torn');
    }

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
              <a href="/factions.php?step=profile&ID=${fid}" target="_blank" style="color: inherit; text-decoration: none;" title="Open faction page">${escapeHtml(name)}</a>
            </div>
            <div style="font-size:10px; color:var(--tt-text-soft);">
              Out: ${outboundCount} • Ret: ${returnCount} • Landed: ${landed.length}
            </div>
          </div>
        </div>
        <div class="tt-row" style="margin-bottom:8px;">
          <div class="tt-chip tt-chip-accent">
            <span style="width:6px; height:6px; border-radius:50%; background:var(--tt-accent);"></span>
            <span>Outbound</span>
          </div>
          <div class="tt-chip tt-chip-purple">
            <span style="width:6px; height:6px; border-radius:50%; background:var(--tt-purple);"></span>
            <span>Return</span>
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
        const xid = m.xid || '';

        if (isLanded) {
          html += renderLandedCard(m, routeText, xid);
        } else {
          html += renderTravelCard(m, routeText, now, isReturn, xid);
        }
      }
    }

    html += `</div>`;
    return html;
  }

  function renderLandedCard(m, routeText, xid) {
    const landedTimeStr = formatWallClock(m.landedAt);
    return `
      <div class="tt-member-card" style="background:radial-gradient(circle at 0 0, rgba(76,175,80,0.35), transparent 55%), var(--tt-bg-card); border-color:rgba(76,175,80,0.8);">
        <div class="tt-member-main">
          <div class="tt-member-name"><a href="/profiles.php?XID=${xid}" target="_blank">${escapeHtml(m.playerName)}</a></div>
          <div class="tt-member-route">${escapeHtml(routeText)}</div>
        </div>
        <div class="tt-member-meta">
          <span class="tt-chip tt-chip-success">
            <span style="font-size:11px;">LANDED</span>
            <span style="font-family:monospace; font-size:10px;">${landedTimeStr}</span>
          </span>
          <span style="font-size:10px; color:var(--tt-text-soft);">${m.flightType}</span>
        </div>
      </div>
    `;
  }

  function renderTravelCard(m, routeText, now, isReturn, xid) {
    const fastestDuration = getFastestDuration(m.lookupDest, m.flightType);
    const slowestDuration = getSlowestDuration(m.lookupDest, m.flightType);
    const fastestETA = m.travelStarted + fastestDuration * 60000;
    const slowestETA = m.travelStarted + slowestDuration * 60000;
    const fastestRemaining = Math.max(0, fastestETA - now);
    const slowestRemaining = Math.max(0, slowestETA - now);
    const avgDuration = DEFAULT_DURATIONS[m.lookupDest]?.[m.flightType] || 120;
    const avgETA = m.travelStarted + avgDuration * 60000;
    const total = avgETA - m.travelStarted;
    const percent = total > 0 ? Math.min(100, ((now - m.travelStarted) / total) * 100) : 100;

    const isLanding = fastestRemaining <= 0;
    let statusText, barColor, barWidth, chipClass;
    if (isLanding) {
      statusText = `Landing • latest ${formatTime(slowestRemaining)}`;
      barColor = '#FFB300';
      barWidth = 100;
      chipClass = 'tt-chip-warning';
    } else {
      statusText = `${formatTime(fastestRemaining)} • window ${formatTime(fastestRemaining)}–${formatTime(slowestRemaining)}`;
      barColor = isReturn ? '#9C27B0' : (percent > 90 ? '#FFB300' : '#2196F3');
      barWidth = percent;
      chipClass = isReturn ? 'tt-chip-purple' : 'tt-chip-accent';
    }

    const planeLeft = isReturn ? (100 - barWidth) : barWidth;
    const clampedPlaneLeft = Math.max(4, Math.min(96, planeLeft));
    const planeTransform = isReturn
      ? 'translateX(-50%) scaleX(-1) rotate(45deg)'
      : 'translateX(-50%) rotate(45deg)';

    const boxClasses = ['tt-member-card'];
    if (m.sameDestination) boxClasses.push('tt-member-card--same-dest');

    const fillStyle = isReturn
      ? `right:0; left:auto; width:${barWidth}%; background:${barColor};`
      : `left:0; right:auto; width:${barWidth}%; background:${barColor};`;

    const directionLabel = isReturn ? 'Return' : 'Outbound';

    return `
      <div class="${boxClasses.join(' ')}">
        <div class="tt-member-main">
          <div class="tt-member-name"><a href="/profiles.php?XID=${xid}" target="_blank">${escapeHtml(m.playerName)}</a></div>
          <div class="tt-member-route">${escapeHtml(routeText)}</div>
        </div>
        <div class="tt-member-meta">
          <span class="tt-chip ${chipClass}">
            <span style="font-size:10px;">${directionLabel}</span>
            <span style="font-family:monospace; font-size:10px;">${formatTime(fastestRemaining)}</span>
          </span>
          <span style="font-size:10px; color:var(--tt-text-soft);">${m.flightType}</span>
        </div>
        <div style="margin-top:4px; font-size:10px; color:${isLanding ? 'var(--tt-warning)' : 'var(--tt-text-soft)'}; text-align:center;">
          ${statusText}
        </div>
        <div class="tt-progress-shell">
          <div class="tt-progress-labels">
            <span>${isReturn ? 'Arr' : 'Dep'}</span>
            <span>${isReturn ? 'Dep' : 'Arr'}</span>
          </div>
          <div class="tt-progress-track">
            <div class="tt-progress-fill" style="${fillStyle}"></div>
          </div>
          <div class="tt-progress-node" style="${isReturn ? 'right:0;' : 'left:0;'} background:${isReturn ? barColor : (isLanding ? '#FFB300' : '#333')};"></div>
          <div class="tt-progress-node" style="${isReturn ? 'left:0;' : 'right:0;'} background:${isReturn ? (isLanding ? '#FFB300' : '#333') : barColor};"></div>
          <div class="tt-progress-plane" style="left:${clampedPlaneLeft}%; transform:${planeTransform};">✈️</div>
        </div>
      </div>
    `;
  }

  // ---------- PAGE BUTTON ----------

  function updateButtonOnPage(fid) {
    const btn = document.getElementById('travel-tracker-btn');
    if (!btn) return;
    const isWatched = !!state.watchedFactions[fid];
    btn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="6 5 28 28" style="vertical-align: middle; margin-right: 4px;">
        <path d="M23,23.5a2,2,0,1,1,2,2A2,2,0,0,1,23,23.5Zm-10,0a2,2,0,1,1,2,2A2,2,0,0,1,13,23.5Zm1-7a2.15,2.15,0,0,0-2,2v5a3.23,3.23,0,0,0,3,3,3.23,3.23,0,0,0,3-3v-2h1v-1h2v1h1v2a3.23,3.23,0,0,0,3,3,3.23,3.23,0,0,0,3-3v-5a2.15,2.15,0,0,0-2-2v-2a1.08,1.08,0,0,0-1-1v-1h1v-2H22v2h1v1l-3,1.69L17,13.5v-1h1v-2H14v2h1v1a1.08,1.08,0,0,0-1,1Z" fill="white"></path>
      </svg>${isWatched ? 'WATCHING' : 'WATCH'}
    `;
    btn.style.background = isWatched ? '#4CAF50' : '#2196F3';
  }

  function createWatchButton() {
    const fid = getCurrentFactionIdFromUrl();
    if (!fid) return null;
    const isWatched = !!state.watchedFactions[fid];
    const btn = document.createElement('button');
    btn.id = 'travel-tracker-btn';
    btn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="6 5 28 28" style="vertical-align: middle; margin-right: 4px;">
        <path d="M23,23.5a2,2,0,1,1,2,2A2,2,0,0,1,23,23.5Zm-10,0a2,2,0,1,1,2,2A2,2,0,0,1,13,23.5Zm1-7a2.15,2.15,0,0,0-2,2v5a3.23,3.23,0,0,0,3,3,3.23,3.23,0,0,0,3-3v-2h1v-1h2v1h1v2a3.23,3.23,0,0,0,3,3,3.23,3.23,0,0,0,3-3v-5a2.15,2.15,0,0,0-2-2v-2a1.08,1.08,0,0,0-1-1v-1h1v-2H22v2h1v1l-3,1.69L17,13.5v-1h1v-2H14v2h1v1a1.08,1.08,0,0,0-1,1Z" fill="white"></path>
      </svg>${isWatched ? 'WATCHING' : 'WATCH'}
    `;
    btn.style.cssText = `
      position: absolute; top: 4px; right: 4px; padding: 4px 10px; font-size: 12px; font-weight: bold;
      border: none; border-radius: 999px; cursor: pointer; color: #fff; z-index: 10;
      background: ${isWatched ? '#4CAF50' : '#2196F3'}; box-shadow: 0 0 4px rgba(0,0,0,0.5);
      display: flex; align-items: center; gap: 4px;
    `;
    btn.addEventListener('click', () => {
      if (!isWatched) addFactionToWatch(fid);
      else {
        state.selectedFactionId = fid;
        if (!state.panelVisible) createPanel(); else updatePanelContent();
      }
    });
    return btn;
  }

  function injectPageButton() {
    if (!isFactionProfilePage()) return;
    const oldBtn = document.getElementById('travel-tracker-btn');
    if (oldBtn) oldBtn.remove();
    const container = document.querySelector('.f-img-wrap.left');
    if (!container) return;
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    const btn = createWatchButton();
    if (btn) container.appendChild(btn);
  }

  // ---------- INIT ----------

  function init() {
    injectGlobalStyles();
    requestNotificationPermission();
    pollServer();
    setInterval(pollServer, POLL_INTERVAL_MS);
    injectFloatingIcon();
    if (isFactionProfilePage()) setTimeout(injectPageButton, 500);
  }

  init();
})();
