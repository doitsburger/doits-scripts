// ==UserScript==
// @name         1 Doits FF Target Finder + Abroad Cache + Mugginator + No Faction
// @namespace    http://tampermonkey.net/
// @version      6.4
// @description  Target finder; abroad cache, arrival filter, mini‑profile, Mugginator, excludes faction members
// @author       FFScouter
// @match        https://www.torn.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @connect      ffscouter.com
// @connect      api.torn.com
// ==/UserScript==

(function() {
    'use strict';

    const PDA_API_KEY = "###PDA-APIKEY###";
    const FACTION_MEDICAL_URL = "https://www.torn.com/factions.php?step=your&type=1#/tab=armoury&start=0&sub=medical";
    const isMobile = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);

    const CACHE_KEY = 'ffs_abroad_cache';
    const CACHE_TS_KEY = 'ffs_abroad_cache_ts';
    const LAST_FF_UPDATE_KEY = 'ffs_abroad_last_ff_update';
    const FULL_FF_INTERVAL = 30 * 60 * 1000; // 30 min

    // Faction exclusion
    const FACTION_MEMBERS_KEY = 'ffs_faction_members';
    const FACTION_MEMBERS_TS_KEY = 'ffs_faction_members_ts';
    const FACTION_REFRESH_MS = 5 * 60 * 1000; // 5 minutes

    const defaultConfig = {
        apiKey: '',
        target: { minFF: 1.50, maxFF: 3.00 },
        factionlessOnly: false,
        inactiveOnly: true,
        openInNewTab: true,
        verifyStatus: false,
        hasUsedTap: false,
        hasUsedHold: false,
        buttonPosition: isMobile ? { right: 2, top: 218, isPercent: false } : { right: 0, top: 27, isPercent: true },
        buttonVisible: true,
        abroadFilters: {
            activities: ["online", "idle", "offline"],
            onlyOkay: false
        },
        mugginatorEnabled: false
    };

    function getConfig() {
        const saved = GM_getValue('ffscouter_config');
        if (saved) {
            try {
                let config = JSON.parse(saved);
                if (config.easy || config.good) {
                    config = { ...defaultConfig, apiKey: config.apiKey || '', target: { minFF: config.easy?.minFF??1.5, maxFF: config.good?.maxFF??3.0 }, factionlessOnly: config.factionlessOnly??false, inactiveOnly: config.inactiveOnly??true, openInNewTab: config.openInNewTab??true, verifyStatus: config.verifyStatus??false, hasUsedTap: config.hasUsedTap??false, hasUsedHold: config.hasUsedHold??false, buttonPosition: config.buttonPosition||defaultConfig.buttonPosition, buttonVisible: config.buttonVisible??true, abroadFilters: config.abroadFilters||defaultConfig.abroadFilters, mugginatorEnabled: config.mugginatorEnabled || false };
                    saveConfig(config);
                    return config;
                }
                if (!config.target) config.target = defaultConfig.target;
                if (!config.abroadFilters) config.abroadFilters = defaultConfig.abroadFilters;
                if (config.mugginatorEnabled === undefined) config.mugginatorEnabled = false;
                delete config.fightOverlayEnabled;
                return config;
            } catch (e) { return defaultConfig; }
        }
        return defaultConfig;
    }

    function saveConfig(config) { GM_setValue('ffscouter_config', JSON.stringify(config)); }

    function getApiKey() {
        const config = getConfig();
        if (config.apiKey && /^[a-zA-Z0-9]{16}$/.test(config.apiKey)) return { key: config.apiKey, source: 'manual' };
        return { key: PDA_API_KEY, source: 'pda' };
    }

    function getUserTravelStatus() {
        const abroad = document.body.dataset.abroad === "true";
        const traveling = document.body.dataset.traveling === "true";
        const country = document.body.dataset.country || null;
        return { isTraveling: abroad || traveling, country, traveling };
    }

    // ----- Faction exclusion: fetch my faction members -----
    let myFactionId = null;
    async function getMyFactionId() {
        if (myFactionId) return myFactionId;
        const { key } = getApiKey();
        if (!key) return null;
        try {
            const resp = await new Promise(resolve => {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: `https://api.torn.com/v2/user/?selections=profile&key=${key}`,
                    timeout: 5000,
                    onload: r => resolve(r),
                    onerror: () => resolve(null),
                    ontimeout: () => resolve(null)
                });
            });
            if (resp) {
                const data = JSON.parse(resp.responseText);
                if (!data.error && data.faction?.faction_id) {
                    myFactionId = data.faction.faction_id;
                    return myFactionId;
                }
            }
        } catch (e) {}
        return null;
    }

    async function fetchMyFactionMembers() {
        const fid = await getMyFactionId();
        if (!fid) return [];

        const { key } = getApiKey();
        if (!key) return [];

        try {
            const resp = await new Promise(resolve => {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: `https://api.torn.com/v2/faction/${fid}/members?striptags=true&key=${key}`,
                    timeout: 10000,
                    onload: r => resolve(r),
                    onerror: () => resolve(null),
                    ontimeout: () => resolve(null)
                });
            });
            if (resp) {
                const data = JSON.parse(resp.responseText);
                if (!data.error && data.members) {
                    return data.members.map(m => m.id.toString());
                }
            }
        } catch (e) {}
        return [];
    }

    async function updateMyFactionMembers() {
        try {
            const ids = await fetchMyFactionMembers();
            if (ids.length > 0) {
                GM_setValue(FACTION_MEMBERS_KEY, JSON.stringify(ids));
                GM_setValue(FACTION_MEMBERS_TS_KEY, Date.now());
                console.log(`Faction members updated: ${ids.length} IDs`);
            }
        } catch (e) {
            console.warn('Faction members fetch failed:', e.message);
        }
    }

    function getCachedFactionMembers() {
        const ts = GM_getValue(FACTION_MEMBERS_TS_KEY, 0);
        if (Date.now() - ts > FACTION_REFRESH_MS) return []; // stale, will refetch
        try {
            return JSON.parse(GM_getValue(FACTION_MEMBERS_KEY, '[]'));
        } catch (e) { return []; }
    }

    // Filter out faction members from player array
    function removeFactionMembers(players) {
        const factionMembers = new Set(getCachedFactionMembers());
        if (factionMembers.size === 0) return players; // no data yet
        return players.filter(p => !factionMembers.has(p.id.toString()));
    }

    // Hospital check (also updates faction ID and members)
    async function checkUserInHospital() {
        const { key } = getApiKey();
        if (key) {
            try {
                const resp = await new Promise(resolve => {
                    GM_xmlhttpRequest({
                        method: 'GET',
                        url: `https://api.torn.com/v2/user/?selections=basic&key=${key}`,
                        timeout: 5000,
                        onload: r => resolve(r),
                        onerror: () => resolve(null),
                        ontimeout: () => resolve(null)
                    });
                });
                if (resp) {
                    const data = JSON.parse(resp.responseText);
                    if (!data.error) return data.status?.state === 'Hospital';
                }
            } catch {}
        }
        const h = document.querySelector('a[href="/index.php"][aria-label^="Hospital:"]');
        return h && h.offsetParent !== null;
    }

    // ----- Abroad scraping (unchanged) -----
    async function scrapeAllAbroadPlayers() {
        const baseUrl = '/index.php?page=people';
        const players = [];
        let totalPeople = 0;

        const fetchPage = async (start = 0) => {
            let html;
            if (window.location.href.includes('index.php?page=people') && start === 0) {
                const urlParams = new URLSearchParams(window.location.search);
                const currentStart = parseInt(urlParams.get('start')) || 0;
                if (currentStart > 0) {
                    const resp = await fetch(`${baseUrl}&start=0`, { credentials: 'include' });
                    html = await resp.text();
                } else {
                    html = document.documentElement.outerHTML;
                }
            } else {
                const resp = await fetch(`${baseUrl}&start=${start}`, { credentials: 'include' });
                html = await resp.text();
            }

            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');

            if (totalPeople === 0) {
                const msg = doc.querySelector('.info-msg .msg.right-round');
                if (msg) {
                    const match = msg.textContent.match(/([\d,]+)\s+People/);
                    if (match) totalPeople = parseInt(match[1].replace(/,/g, ''));
                }
                if (totalPeople === 0) {
                    const pagination = doc.querySelector('.gallery-wrapper.pagination');
                    if (pagination) {
                        const lastLink = pagination.querySelector('a.last');
                        if (lastLink) {
                            const lastStart = parseInt(new URLSearchParams(lastLink.href.split('?')[1]).get('start'));
                            if (!isNaN(lastStart)) totalPeople = lastStart + 50;
                        }
                    }
                }
            }

            const rows = doc.querySelectorAll('ul.users-list li');
            rows.forEach(row => {
                const userLink = row.querySelector('a.user.name[href*="/profiles.php?XID="]');
                if (!userLink) return;
                const idMatch = userLink.href.match(/XID=(\d+)/);
                if (!idMatch) return;
                const id = parseInt(idMatch[1]);
                const name = userLink.textContent.trim();

                let activity = "offline";
                const iconLi = row.querySelector('ul#iconTray.singleicon li');
                if (iconLi) {
                    const title = iconLi.getAttribute('title') || '';
                    if (/online/i.test(title)) activity = "online";
                    else if (/idle/i.test(title)) activity = "idle";
                }

                let isOkay = true;
                const statusSpan = row.querySelector('.status span:last-child');
                if (statusSpan && statusSpan.className.includes('user-red-status')) isOkay = false;

                players.push({ id, name, activity, isOkay, ff: null, bs: null });
            });
        };

        await fetchPage(0);
        if (totalPeople > 50) {
            const totalPages = Math.ceil(totalPeople / 50);
            const promises = [];
            for (let page = 1; page < totalPages; page++) {
                promises.push(fetchPage(page * 50));
            }
            await Promise.all(promises);
        }

        const ownIdMatch = document.body.innerHTML.match(/XID=(\d+)/);
        const ownId = ownIdMatch ? parseInt(ownIdMatch[1]) : null;
        return players.filter(p => p.id !== ownId);
    }

    // ----- FFScouter API (unchanged) -----
    async function fetchFFScouterStats(targetIds) {
        const { key } = getApiKey();
        return new Promise((resolve, reject) => {
            const params = new URLSearchParams({ key, targets: targetIds.join(',') });
            GM_xmlhttpRequest({
                method: 'GET',
                url: `https://ffscouter.com/api/v1/get-stats?${params.toString()}`,
                headers: { 'Accept': 'application/json' },
                timeout: 15000,
                onload: r => {
                    if (r.status === 200) {
                        try { resolve(JSON.parse(r.responseText)); } catch (e) { reject(new Error('Invalid JSON')); }
                    } else reject(new Error(`HTTP ${r.status}`));
                },
                onerror: reject
            });
        });
    }

    async function enrichWithFFBS(players) {
        const ids = players.map(p => p.id.toString());
        const uniqueIds = [...new Set(ids)];
        const batchSize = 50;
        const statsMap = {};
        for (let i = 0; i < uniqueIds.length; i += batchSize) {
            const batch = uniqueIds.slice(i, i + batchSize);
            try {
                const stats = await fetchFFScouterStats(batch);
                for (const stat of stats) {
                    const pid = stat.player_id?.toString();
                    if (pid) {
                        statsMap[pid] = {
                            fair_fight: stat.fair_fight ?? null,
                            bs_human: stat.bs_estimate_human ?? null,
                            bs: stat.bs_estimate ?? null
                        };
                    }
                }
                if (i + batchSize < uniqueIds.length) await new Promise(r => setTimeout(r, 2000));
            } catch (e) { console.warn('FFScouter batch failed:', e.message); }
        }
        for (const p of players) {
            const s = statsMap[p.id.toString()];
            if (s) {
                p.ff = s.fair_fight;
                p.bs = s.bs_human || (s.bs ? formatBS(s.bs) : null);
            }
        }
    }

    function formatBS(n) {
        if (n === null || n === undefined || isNaN(n)) return 'N/A';
        if (n >= 1e9) return (n/1e9).toFixed(1) + 'b';
        if (n >= 1e6) return (n/1e6).toFixed(1) + 'm';
        if (n >= 1e3) return (n/1e3).toFixed(1) + 'k';
        return n.toString();
    }

    // ----- Cache management -----
    function loadCache() {
        try { return JSON.parse(GM_getValue(CACHE_KEY, '[]')); } catch (e) { return []; }
    }
    function saveCache(players) {
        GM_setValue(CACHE_KEY, JSON.stringify(players));
        GM_setValue(CACHE_TS_KEY, Date.now());
    }

    function mergeArrivals(oldPlayers, newPlayers) {
        const oldMap = new Map(oldPlayers.map(p => [p.id, p]));
        const now = Date.now();
        for (const p of newPlayers) {
            const old = oldMap.get(p.id);
            if (old) {
                p.arrivedAt = old.arrivedAt || null;
            } else {
                p.arrivedAt = now;
            }
        }
        return newPlayers;
    }

    // ----- Background update (new arrivals only FF/BS, removes faction members) -----
    let updateInProgress = false;
    async function updateAbroadCache() {
        if (updateInProgress) return;
        updateInProgress = true;
        try {
            if (!getUserTravelStatus().isTraveling) {
                saveCache([]);
                return;
            }

            console.log('Background: scraping abroad players...');
            let scrapedPlayers = await scrapeAllAbroadPlayers();
            // Remove faction members
            scrapedPlayers = removeFactionMembers(scrapedPlayers);
            console.log(`After faction filter: ${scrapedPlayers.length} players`);

            const oldCache = loadCache();
            const oldMap = new Map(oldCache.map(p => [p.id, p]));

            const lastFullUpdate = GM_getValue(LAST_FF_UPDATE_KEY, 0);
            const needFullRefresh = (Date.now() - lastFullUpdate) > FULL_FF_INTERVAL || oldCache.length === 0;

            const newPlayers = [];
            for (const p of scrapedPlayers) {
                if (!oldMap.has(p.id)) newPlayers.push(p);
            }

            if (needFullRefresh) {
                console.log('Full FF/BS refresh...');
                await enrichWithFFBS(scrapedPlayers);
                GM_setValue(LAST_FF_UPDATE_KEY, Date.now());
            } else if (newPlayers.length > 0) {
                console.log(`Fetching FF/BS for ${newPlayers.length} new arrivals...`);
                await enrichWithFFBS(newPlayers);
            }

            const now = Date.now();
            for (const p of scrapedPlayers) {
                const old = oldMap.get(p.id);
                if (old) {
                    if (!needFullRefresh) {
                        p.ff = old.ff;
                        p.bs = old.bs;
                    }
                    p.arrivedAt = old.arrivedAt;
                } else {
                    p.arrivedAt = now;
                }
            }

            saveCache(scrapedPlayers);
            console.log(`Cache updated: ${scrapedPlayers.length} players (${newPlayers.length} new)`);
        } catch (e) {
            console.error('Background update failed:', e);
        } finally {
            updateInProgress = false;
        }
    }

    let pollInterval = null;
    function startBackgroundPoll() {
        updateAbroadCache();
        if (pollInterval) clearInterval(pollInterval);
        pollInterval = setInterval(() => {
            if (getUserTravelStatus().isTraveling) updateAbroadCache();
        }, 30000);
    }

    // ----- Filters -----
    function filterAbroadPlayers(players, filters, ffRange, maxArrivalMinutes = null) {
        return players.filter(p => {
            if (filters.activities.length > 0 && !filters.activities.includes(p.activity)) return false;
            if (filters.onlyOkay && !p.isOkay) return false;
            if (p.ff === null) return false;
            if (ffRange.min !== undefined && p.ff < ffRange.min) return false;
            if (ffRange.max !== undefined && p.ff > ffRange.max) return false;
            if (maxArrivalMinutes !== null) {
                if (!p.arrivedAt) return false;
                const minsSinceArrival = (Date.now() - p.arrivedAt) / 60000;
                if (minsSinceArrival > maxArrivalMinutes) return false;
            }
            return true;
        });
    }

    // ----- FFScouter API (for non-abroad) -----
    async function fetchFFScouterTarget(settings, config) {
        const { key, source } = getApiKey();
        const params = new URLSearchParams({
            key, minff: settings.minFF, maxff: settings.maxFF,
            inactiveonly: config.inactiveOnly ? 1 : 0,
            factionless: config.factionlessOnly ? 1 : 0,
            limit: 50
        });
        return new Promise(resolve => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: `https://ffscouter.com/api/v1/get-targets?${params.toString()}`,
                timeout: 10000,
                onload: r => {
                    try {
                        const d = JSON.parse(r.responseText);
                        if (d.error) resolve({ success: false, error: d.error, apiSource: source });
                        else resolve({ success: true, targets: d.targets || [] });
                    } catch { resolve({ success: false, error: 'Parse error' }); }
                },
                onerror: () => resolve({ success: false, error: 'Request failed' }),
                ontimeout: () => resolve({ success: false, error: 'Timeout' })
            });
        });
    }

    // ----- Main target fetch (Mugginator uses normal FF range) -----
    async function fetchTarget() {
        if (await checkUserInHospital()) {
            showToast('You are in hospital – redirecting to faction medical', 'warning', 3000);
            setTimeout(() => { window.location.href = FACTION_MEDICAL_URL; }, 800);
            return;
        }

        const travel = getUserTravelStatus();
        if (travel.isTraveling) {
            const allPlayers = loadCache();
            if (allPlayers.length === 0) {
                showToast('No cached players. Try again soon.', 'error');
                return;
            }
            const config = getConfig();

            if (config.mugginatorEnabled) {
                // Mugginator mode: new arrivals (<5 min), your normal FF range, lowest FF first
                const ffRange = { min: config.target.minFF, max: config.target.maxFF };
                const filtered = filterAbroadPlayers(allPlayers, config.abroadFilters, ffRange, 3);
                if (filtered.length === 0) {
                    showToast('No Mugginator targets (new arrivals, your FF range).', 'error');
                    return;
                }
                filtered.sort((a, b) => a.ff - b.ff);
                const target = filtered[0];
                const url = `https://www.torn.com/page.php?sid=attack&user2ID=${target.id}`;
                showToast(`Mugginator: ${target.name} [${target.id}] • FF ${target.ff.toFixed(2)} • ${target.activity}`, 'success');
                if (config.openInNewTab) window.open(url, '_blank');
                else window.location.href = url;
                return;
            }

            // Normal abroad mode
            const ffRange = { min: config.target.minFF, max: config.target.maxFF };
            const filtered = filterAbroadPlayers(allPlayers, config.abroadFilters, ffRange);
            if (filtered.length === 0) {
                showToast('No players match your filters.', 'error');
                return;
            }
            const target = filtered[Math.floor(Math.random() * filtered.length)];
            const url = `https://www.torn.com/page.php?sid=attack&user2ID=${target.id}`;
            showToast(`${target.name} [${target.id}] • FF ${target.ff.toFixed(2)} • ${target.activity}`, 'success');
            if (config.openInNewTab) window.open(url, '_blank');
            else window.location.href = url;
            return;
        }

        // Normal FFScouter flow (home)
        const config = getConfig();
        const settings = config.target;
        showToast('Finding target...', 'info');
        const result = await fetchFFScouterTarget(settings, config);
        if (!result.success) {
            if (result.apiSource === 'pda' && result.error?.toLowerCase().includes('key')) {
                showToast('API key required – not using Torn PDA?', 'error');
                setTimeout(() => promptApiKey(), 1000);
            } else {
                showToast(`Error: ${result.error}`, 'error');
            }
            return;
        }
        const targets = result.targets;
        if (!targets?.length) {
            showToast('No targets found with current filters', 'error');
            return;
        }
        const target = targets[Math.floor(Math.random() * targets.length)];
        const url = `https://www.torn.com/page.php?sid=attack&user2ID=${target.player_id}`;
        showToast(`${target.name} [${target.player_id}] • Lvl ${target.level} • FF ${target.fair_fight.toFixed(2)}`, 'success');
        if (config.openInNewTab) window.open(url, '_blank');
        else window.location.href = url;
    }

    // ----- Abroad players panel (mini‑profile on click) -----
    function showAbroadPlayersPanel(maxArrivalMinutes = null) {
        const players = loadCache();
        if (players.length === 0) {
            showToast('No cached abroad players. Wait for update.', 'error');
            return;
        }
        const config = getConfig();
        const filters = config.abroadFilters;
        const ffRange = { min: config.target.minFF, max: config.target.maxFF };

        const filtered = filterAbroadPlayers(players, filters, ffRange, maxArrivalMinutes);

        const existing = document.querySelector('.ffs-debug-overlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.className = 'ffs-overlay ffs-debug-overlay';
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);z-index:999999;display:flex;justify-content:center;align-items:center;font-family:Arial,Helvetica,sans-serif;backdrop-filter:blur(3px);';

        const panel = document.createElement('div');
        panel.style.cssText = 'background:linear-gradient(180deg,#2d2d2d,#1a1a1a);border-radius:8px;width:90vw;max-width:600px;max-height:80vh;overflow-y:auto;box-shadow:0 10px 40px rgba(0,0,0,0.5);color:#ddd;padding:16px;';

        const arrivalOptions = [
            { label: 'All', value: null },
            { label: 'Last 5 min', value: 5 },
            { label: 'Last 10 min', value: 10 },
            { label: 'Last 15 min', value: 15 },
            { label: 'Last 30 min', value: 30 },
            { label: 'Last 60 min', value: 60 }
        ];

        panel.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                <h2 style="margin:0;font-size:16px;">Abroad Players (${filtered.length}/${players.length})</h2>
                <button id="close-debug" style="background:none;border:none;color:#888;font-size:20px;cursor:pointer;">✕</button>
            </div>
            <div style="margin-bottom:8px;display:flex;align-items:center;gap:8px;">
                <label style="font-size:12px;color:#aaa;">Arrivals:</label>
                <select id="arrival-filter" style="padding:4px;background:#222;border:1px solid #555;color:#fff;border-radius:4px;font-size:12px;">
                    ${arrivalOptions.map(opt => `<option value="${opt.value ?? ''}" ${opt.value === maxArrivalMinutes ? 'selected' : ''}>${opt.label}</option>`).join('')}
                </select>
            </div>
            <div id="player-list" style="max-height:50vh;overflow-y:auto;background:#111;padding:10px;border-radius:6px;border:1px solid #333;font-family:monospace;font-size:12px;line-height:1.6;">
                ${filtered.length ? filtered.map(p => {
                    let arrivalStr = p.arrivedAt ? `🕒${formatElapsed(Date.now()-p.arrivedAt)} ago` : '';
                    return `<span class="player-entry" data-player-id="${p.id}">
                        <a class="player-name" href="#" style="color:#ccc;text-decoration:none;">${p.name}</a>
                        <span style="color:#888;">[${p.id}]</span>
                        <span style="color:#6af;">FF:${p.ff.toFixed(2)}</span>
                        <span style="color:#6c6;">${p.bs||'BS:N/A'}</span>
                        <span style="color:#aaa;">${p.activity}</span>
                        <span style="color:#ffa;">${arrivalStr}</span>
                    </span><br>`;
                }).join('') : '<div style="color:#c66;">No players match filters.</div>'}
            </div>
        `;
        overlay.appendChild(panel);
        document.body.appendChild(overlay);

        panel.querySelector('#close-debug').addEventListener('click', () => overlay.remove());
        overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

        panel.querySelector('#arrival-filter').addEventListener('change', function() {
            const val = this.value === '' ? null : parseInt(this.value);
            overlay.remove();
            showAbroadPlayersPanel(val);
        });

        panel.querySelector('#player-list').addEventListener('click', function(e) {
            const nameLink = e.target.closest('.player-name');
            if (!nameLink) return;
            e.preventDefault();
            e.stopPropagation();

            const playerEntry = nameLink.closest('.player-entry');
            const playerId = playerEntry ? playerEntry.dataset.playerId : null;
            if (!playerId) return;

            const realLink = document.querySelector(`ul.users-list a.user.name[href*="/profiles.php?XID=${playerId}"]`);
            if (realLink) {
                realLink.click();
            } else {
                window.open(`/profiles.php?XID=${playerId}`, '_blank');
            }
        });
    }

    function formatElapsed(ms) {
        const s = Math.floor(ms/1000);
        const m = Math.floor(s/60);
        const h = Math.floor(m/60);
        if (h > 0) return `${h}h${m%60}m`;
        if (m > 0) return `${m}m`;
        return `${s}s`;
    }

    // ----- UI (Toast, Settings, Button) -----
    function showToast(msg, type = 'info', dur = 3000) {
        const old = document.querySelector('.ffs-toast');
        if (old) old.remove();
        const t = document.createElement('div');
        t.className = `ffs-toast ffs-toast-${type}`;
        t.textContent = msg;
        document.body.appendChild(t);
        setTimeout(() => { t.style.animation = 'ffs-slide-in 0.3s ease reverse'; setTimeout(() => t.remove(), 300); }, dur);
    }

    function promptApiKey() {
        const config = getConfig();
        const cur = config.apiKey || '';
        const k = prompt("Enter your FF Scouter API Key (16 chars):\n\nLeave empty for Torn PDA auto key.\nGet key: torn.com/preferences.php#tab=api\nRegister: ffscouter.com", cur);
        if (k === null) return;
        const t = k.trim();
        if (t === '') { config.apiKey = ''; saveConfig(config); showToast('Using automatic API key', 'success'); return; }
        if (!/^[a-zA-Z0-9]{16}$/.test(t)) { showToast('Invalid key format', 'error'); return; }
        config.apiKey = t;
        saveConfig(config);
        showToast('API key saved!', 'success');
    }

    // Settings popup (includes Mugginator toggle with updated description)
    function showConfigPopup() {
        const existing = document.querySelector('.ffs-overlay');
        if (existing) existing.remove();
        const config = getConfig();
        const { source } = getApiKey();
        const isManual = source === 'manual';
        const overlay = document.createElement('div');
        overlay.className = 'ffs-overlay';
        overlay.innerHTML = `
        <div class="ffs-popup">
            <div class="ffs-header">
                <div class="ffs-header-title">
                    <svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
                    <h2>FF Scouter Settings</h2>
                </div>
                <button class="ffs-close" id="ffs-close">✕</button>
            </div>
            <div class="ffs-content">
                <div class="ffs-api-banner ${isManual?'manual':'auto'}" id="ffs-api-btn">
                    <svg viewBox="0 0 24 24"><path d="M12.65 10C11.83 7.67 9.61 6 7 6c-3.31 0-6 2.69-6 6s2.69 6 6 6c2.61 0 4.83-1.67 5.65-4H17v4h4v-4h2v-4H12.65zM7 14c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z"/></svg>
                    <div class="ffs-api-banner-text"><div class="ffs-api-banner-title">${isManual?'Manual API Key':'Automatic (Torn PDA)'}</div><div class="ffs-api-banner-sub">${isManual?'Click to change or use automatic':'Click to set manual key instead'}</div></div>
                    <span class="ffs-api-badge">${isManual?'Manual':'Auto'}</span>
                </div>
                <div class="ffs-target-card">
                    <div class="ffs-card-header"><div class="ffs-card-icon">🎯</div><div class="ffs-card-title"><h3>Target Settings</h3><span>${isMobile?'Tap button to find':'Press F1 to find'}</span></div></div>
                    <div class="ffs-card-body">
                        <div class="ffs-input-row"><span class="ffs-input-label">Fair Fight</span><div class="ffs-input-group"><input type="number" class="ffs-input" id="ffs-minff" value="${config.target.minFF}" step="0.1" min="1" max="3"><span class="ffs-input-sep">→</span><input type="number" class="ffs-input" id="ffs-maxff" value="${config.target.maxFF}" step="0.1" min="1" max="3"></div></div>
                    </div>
                    <div class="ffs-card-count loading" id="ffs-count"><div class="ffs-count-spinner"></div><span>Checking available targets...</span></div>
                </div>
                <div class="ffs-options">
                    <div class="ffs-options-header">FFScouter Filters</div>
                    <label class="ffs-option"><div class="ffs-toggle"><input type="checkbox" id="ffs-inactive" ${config.inactiveOnly?'checked':''}><span class="ffs-toggle-slider"></span></div><div class="ffs-option-text"><div class="ffs-option-title">Inactive Only</div><div class="ffs-option-desc">Target players inactive 14+ days</div></div></label>
                    <label class="ffs-option"><div class="ffs-toggle"><input type="checkbox" id="ffs-factionless" ${config.factionlessOnly?'checked':''}><span class="ffs-toggle-slider"></span></div><div class="ffs-option-text"><div class="ffs-option-title">Factionless Only</div><div class="ffs-option-desc">Target players without a faction</div></div></label>
                    <label class="ffs-option"><div class="ffs-toggle"><input type="checkbox" id="ffs-verify" ${config.verifyStatus?'checked':''}><span class="ffs-toggle-slider"></span></div><div class="ffs-option-text"><div class="ffs-option-title">Verify Status</div><div class="ffs-option-desc">Check target is okay <span class="ffs-option-warn">(slower)</span></div></div></label>
                </div>
                <div class="ffs-options">
                    <div class="ffs-options-header">Abroad Filters</div>
                    <div class="ffs-option" style="flex-direction:column;align-items:flex-start;">
                        <div style="font-size:12px;color:#ddd;margin-bottom:8px;">Activity</div>
                        <div style="display:flex;gap:16px;">
                            <label style="display:flex;align-items:center;gap:4px;"><input type="checkbox" class="abroad-activity" value="online" ${config.abroadFilters.activities.includes('online')?'checked':''}> Online</label>
                            <label style="display:flex;align-items:center;gap:4px;"><input type="checkbox" class="abroad-activity" value="idle" ${config.abroadFilters.activities.includes('idle')?'checked':''}> Idle</label>
                            <label style="display:flex;align-items:center;gap:4px;"><input type="checkbox" class="abroad-activity" value="offline" ${config.abroadFilters.activities.includes('offline')?'checked':''}> Offline</label>
                        </div>
                    </div>
                    <label class="ffs-option"><div class="ffs-toggle"><input type="checkbox" id="abroad-onlyokay" ${config.abroadFilters.onlyOkay?'checked':''}><span class="ffs-toggle-slider"></span></div><div class="ffs-option-text"><div class="ffs-option-title">Only Okay</div><div class="ffs-option-desc">Skip hospitalised players</div></div></label>
                    <div class="ffs-option" style="flex-direction:column;align-items:flex-start;">
                        <div style="font-size:12px;color:#ddd;margin-bottom:4px;">FF Range (applied from Target Settings)</div>
                    </div>
                    <!-- Mugginator toggle -->
                    <label class="ffs-option"><div class="ffs-toggle"><input type="checkbox" id="mugginator" ${config.mugginatorEnabled?'checked':''}><span class="ffs-toggle-slider"></span></div><div class="ffs-option-text"><div class="ffs-option-title">Mugginator</div><div class="ffs-option-desc">New arrivals (&lt;5 min), uses your normal FF range, attacks lowest FF first</div></div></label>
                </div>
                <div class="ffs-options">
                    <div class="ffs-options-header">Behaviour</div>
                    <label class="ffs-option"><div class="ffs-toggle"><input type="checkbox" id="ffs-newtab" ${config.openInNewTab?'checked':''}><span class="ffs-toggle-slider"></span></div><div class="ffs-option-text"><div class="ffs-option-title">Open in New Tab</div><div class="ffs-option-desc">Open attack page in a new browser tab</div></div></label>
                    <div class="ffs-option" id="ffs-move-btn" style="cursor:pointer;"><div style="width:40px;height:22px;display:flex;align-items:center;justify-content:center;"><span style="font-size:18px;">📍</span></div><div class="ffs-option-text"><div class="ffs-option-title">Move Button</div><div class="ffs-option-desc">Drag the floating button to a new position</div></div></div>
                    <div class="ffs-option" id="show-abroad-btn" style="cursor:pointer;"><div style="width:40px;height:22px;display:flex;align-items:center;justify-content:center;"><span style="font-size:18px;">📋</span></div><div class="ffs-option-text"><div class="ffs-option-title">Show Abroad Players</div><div class="ffs-option-desc">View cached players with arrival filter</div></div></div>
                </div>
            </div>
            <div class="ffs-footer">
                <button class="ffs-btn ffs-btn-secondary" id="ffs-cancel">Cancel</button>
                <button class="ffs-btn ffs-btn-primary" id="ffs-save">Save Settings</button>
            </div>
            <div class="ffs-kbd-hints">
                <div class="ffs-kbd-hint"><span class="ffs-kbd">F1</span> Find Target</div>
                <div class="ffs-kbd-hint"><span class="ffs-kbd">F2</span> Settings</div>
                <div class="ffs-kbd-hint"><span class="ffs-kbd">F3</span> API Key</div>
            </div>
        </div>`;
        document.body.appendChild(overlay);

        // Settings logic (unchanged)
        let countDeb = null;
        function fetchTargetCount(settings, inactiveOnly, factionlessOnly) {
            const { key } = getApiKey();
            const p = new URLSearchParams({ key, minff: settings.minFF, maxff: settings.maxFF, inactiveonly: inactiveOnly?1:0, factionless: factionlessOnly?1:0, limit:50 });
            return new Promise(resolve => {
                GM_xmlhttpRequest({ method:'GET', url:`https://ffscouter.com/api/v1/get-targets?${p}`, timeout:10000,
                    onload: r => {
                        try { const d=JSON.parse(r.responseText); if(d.error) resolve({success:false,error:d.error}); else resolve({success:true,count:d.targets?.length||0}); }
                        catch { resolve({success:false,error:'Parse error'}); }
                    },
                    onerror:()=>resolve({success:false,error:'Request failed'}),
                    ontimeout:()=>resolve({success:false,error:'Timeout'})
                });
            });
        }
        function updateCount(r) {
            const el = document.getElementById('ffs-count');
            if (!el) return;
            if (!r.success) { el.className='ffs-card-count error'; el.innerHTML=`<span class="ffs-count-num">!</span> <span>${r.error}</span>`; return; }
            const c = r.count;
            let cls = 'good', txt = 'targets available';
            if (c===0) { cls='error'; txt='No targets found'; }
            else if (c<10) { cls='warning'; txt = c===1?'target available (very low!)':'targets available (low!)'; }
            else if (c===50) txt='targets available (max)';
            el.className=`ffs-card-count ${cls}`;
            el.innerHTML=`<span class="ffs-count-num">${c}</span> <span>${txt}</span>`;
        }
        function setLoading() { const el=document.getElementById('ffs-count'); if(el){ el.className='ffs-card-count loading'; el.innerHTML='<div class="ffs-count-spinner"></div><span>Checking...</span>'; } }
        function getForm() { return { minFF: parseFloat(document.getElementById('ffs-minff').value)||1, maxFF: parseFloat(document.getElementById('ffs-maxff').value)||3 }; }
        function getFilters() { return { inactiveOnly: document.getElementById('ffs-inactive').checked, factionlessOnly: document.getElementById('ffs-factionless').checked }; }
        async function refresh() { setLoading(); const s = getForm(), f = getFilters(); const res = await fetchTargetCount(s, f.inactiveOnly, f.factionlessOnly); updateCount(res); }
        function debounce() { clearTimeout(countDeb); countDeb = setTimeout(refresh, 300); }
        document.getElementById('ffs-minff').addEventListener('blur', debounce);
        document.getElementById('ffs-maxff').addEventListener('blur', debounce);
        document.getElementById('ffs-minff').addEventListener('keydown', e=>{ if(e.key==='Enter') e.target.blur(); });
        document.getElementById('ffs-maxff').addEventListener('keydown', e=>{ if(e.key==='Enter') e.target.blur(); });
        document.getElementById('ffs-inactive').addEventListener('change', debounce);
        document.getElementById('ffs-factionless').addEventListener('change', debounce);
        refresh();

        const close = () => { clearTimeout(countDeb); overlay.remove(); };
        overlay.addEventListener('click', e=>{ if(e.target===overlay) close(); });
        document.getElementById('ffs-close').addEventListener('click', close);
        document.getElementById('ffs-cancel').addEventListener('click', close);
        document.getElementById('ffs-api-btn').addEventListener('click', ()=>{ close(); promptApiKey(); });
        document.getElementById('ffs-move-btn').addEventListener('click', ()=>{ close(); setTimeout(enterRepositionMode,100); });
        document.getElementById('show-abroad-btn').addEventListener('click', () => { close(); showAbroadPlayersPanel(); });

        document.getElementById('ffs-save').addEventListener('click', () => {
            const cur = getConfig();
            const activities = [];
            document.querySelectorAll('.abroad-activity:checked').forEach(cb => activities.push(cb.value));
            const newConfig = {
                apiKey: cur.apiKey,
                target: {
                    minFF: parseFloat(document.getElementById('ffs-minff').value)||1.50,
                    maxFF: parseFloat(document.getElementById('ffs-maxff').value)||3.00
                },
                inactiveOnly: document.getElementById('ffs-inactive').checked,
                factionlessOnly: document.getElementById('ffs-factionless').checked,
                verifyStatus: document.getElementById('ffs-verify').checked,
                openInNewTab: document.getElementById('ffs-newtab').checked,
                hasUsedTap: cur.hasUsedTap,
                hasUsedHold: cur.hasUsedHold,
                buttonPosition: cur.buttonPosition,
                buttonVisible: cur.buttonVisible,
                abroadFilters: {
                    activities: activities.length ? activities : ["online","idle","offline"],
                    onlyOkay: document.getElementById('abroad-onlyokay').checked
                },
                mugginatorEnabled: document.getElementById('mugginator').checked
            };
            if (newConfig.target.minFF > newConfig.target.maxFF) {
                showToast('Min FF cannot exceed Max', 'error');
                return;
            }
            saveConfig(newConfig);
            showToast('Settings saved!', 'success');
        });
        const esc = e=>{ if(e.key==='Escape') { close(); document.removeEventListener('keydown', esc); } };
        document.addEventListener('keydown', esc);
    }

    // ----- Floating button & reposition (unchanged) -----
    let isRepositioning = false, originalPosition = null;
    function enterRepositionMode() {
        if (isRepositioning) return;
        isRepositioning = true;
        const container = document.querySelector('.ffs-fab-container');
        const config = getConfig();
        originalPosition = { ...config.buttonPosition };
        container.classList.add('repositioning');
        const bar = document.createElement('div');
        bar.className = 'ffs-reposition-bar';
        bar.innerHTML = `
            <div class="ffs-reposition-text"><span>Drag</span> the button to move it</div>
            <div class="ffs-reposition-btns">
                <button class="ffs-reposition-btn reset">Reset</button>
                <button class="ffs-reposition-btn cancel">Cancel</button>
                <button class="ffs-reposition-btn confirm">Save</button>
            </div>`;
        document.body.appendChild(bar);
        let isDragging = false, startX, startY, startLeft, startTop;
        const getPos = () => { const r = container.getBoundingClientRect(); return { left: r.left, top: r.top }; };
        const onStart = e => {
            e.preventDefault();
            isDragging = true; container.classList.add('dragging');
            const p = getPos(); startLeft = p.left; startTop = p.top;
            startX = e.touches ? e.touches[0].clientX : e.clientX;
            startY = e.touches ? e.touches[0].clientY : e.clientY;
        };
        const onMove = e => {
            if (!isDragging) return;
            e.preventDefault();
            const cx = e.touches ? e.touches[0].clientX : e.clientX;
            const cy = e.touches ? e.touches[0].clientY : e.clientY;
            let left = startLeft + (cx - startX), top = startTop + (cy - startY);
            const w = 28, h = 40, pad = 2;
            left = Math.max(pad, Math.min(window.innerWidth - w - pad, left));
            top = Math.max(pad, Math.min(window.innerHeight - h - pad, top));
            container.style.left = left + 'px'; container.style.top = top + 'px';
            container.style.right = 'auto'; container.style.transform = 'none';
        };
        const onEnd = () => { if (isDragging) { isDragging = false; container.classList.remove('dragging'); } };
        container.addEventListener('mousedown', onStart);
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onEnd);
        container.addEventListener('touchstart', onStart, { passive: false });
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('touchend', onEnd);
        const cleanup = () => {
            container.removeEventListener('mousedown', onStart);
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onEnd);
            container.removeEventListener('touchstart', onStart);
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('touchend', onEnd);
            document.removeEventListener('keydown', escHandler);
            bar.remove();
            container.classList.remove('repositioning', 'dragging');
            isRepositioning = false;
        };
        const savePos = () => {
            const rect = container.getBoundingClientRect();
            const cfg = getConfig();
            if (cfg.buttonPosition.isPercent) {
                cfg.buttonPosition = {
                    right: (window.innerWidth - rect.right) / window.innerWidth * 100,
                    top: (rect.top / window.innerHeight) * 100,
                    isPercent: true
                };
            } else {
                cfg.buttonPosition = {
                    right: window.innerWidth - rect.right,
                    top: rect.top,
                    isPercent: false
                };
            }
            saveConfig(cfg);
            applyButtonPosition();
            cleanup();
            showToast('Button position saved!', 'success');
        };
        const cancel = () => { applyButtonPosition(originalPosition); cleanup(); };
        const reset = () => {
            const cfg = getConfig();
            cfg.buttonPosition = isMobile ? { right: 2, top: 218, isPercent: false } : { right: 0, top: 27, isPercent: true };
            saveConfig(cfg);
            applyButtonPosition();
            cleanup();
            showToast('Button position reset!', 'info');
        };
        bar.querySelector('.confirm').addEventListener('click', savePos);
        bar.querySelector('.cancel').addEventListener('click', cancel);
        bar.querySelector('.reset').addEventListener('click', reset);
        const escHandler = e => { if (e.key === 'Escape') cancel(); };
        document.addEventListener('keydown', escHandler);
    }

    function applyButtonPosition(customPos) {
        const container = document.querySelector('.ffs-fab-container');
        if (!container) return;
        const pos = customPos || getConfig().buttonPosition;
        container.style.left = 'auto'; container.style.bottom = 'auto'; container.style.transform = 'none';
        if (pos.isPercent) {
            container.style.right = pos.right + '%';
            container.style.top = pos.top + '%';
            container.style.transform = 'translateY(-50%)';
        } else {
            container.style.right = pos.right + 'px';
            container.style.top = pos.top + 'px';
        }
    }

    function updateButtonVisibility() {
        const container = document.querySelector('.ffs-fab-container');
        if (container) container.classList.toggle('hidden', !getConfig().buttonVisible);
    }

    function injectSettingsToggle() {
        const menu = document.querySelector('ul.settings-menu');
        if (!menu || document.getElementById('ffs-button-state')) return;
        const config = getConfig();
        const li = document.createElement('li');
        li.className = 'setting ffs-torn-toggle';
        li.innerHTML = `
            <label for="ffs-button-state" class="setting-container">
                <div class="icon-wrapper">
                    <svg viewBox="0 0 24 24" width="22" height="22"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
                </div>
                <span class="setting-name">FF Scouter</span>
                <div class="choice-container">
                    <input id="ffs-button-state" class="checkbox-css dark-bg" type="checkbox" ${config.buttonVisible ? 'checked' : ''}>
                    <label class="marker-css" for="ffs-button-state"></label>
                </div>
            </label>`;
        const settingsLink = menu.querySelector('li.link a[href="/preferences.php"]');
        if (settingsLink?.parentElement) menu.insertBefore(li, settingsLink.parentElement);
        else {
            const logoutLink = menu.querySelector('li.link a[href^="/logout.php"]');
            if (logoutLink?.parentElement) menu.insertBefore(li, logoutLink.parentElement);
            else menu.appendChild(li);
        }
        document.getElementById('ffs-button-state').addEventListener('change', e => {
            const cfg = getConfig();
            cfg.buttonVisible = e.target.checked;
            saveConfig(cfg);
            updateButtonVisibility();
            showToast(e.target.checked ? 'FF Scouter button visible' : 'Button hidden – re-enable from profile menu', 'info');
        });
    }

    function createFloatingButton() {
        const container = document.createElement('div');
        container.className = 'ffs-fab-container';
        const config = getConfig();
        const showHint = !config.hasUsedTap || !config.hasUsedHold;
        container.innerHTML = `
            <div class="ffs-fab" title="Tap: Find Target • Hold: Settings">
                <svg class="ffs-fab-progress" viewBox="0 0 52 52"><circle cx="26" cy="26" r="24"/></svg>
                <span style="font-size: 18px; line-height: 1;">🎯</span>
                <div class="ffs-fab-hint ${showHint ? 'show animate' : ''}" id="ffs-hint">
                    <div class="ffs-hint-row"><span class="ffs-hint-action">Tap</span><span class="ffs-hint-result good">🎯 Find Target</span></div>
                    <div class="ffs-hint-row"><span class="ffs-hint-action">Hold</span><span class="ffs-hint-result menu">⚙️ Settings</span></div>
                </div>
            </div>`;
        document.body.appendChild(container);
        applyButtonPosition();
        updateButtonVisibility();

        const fab = container.querySelector('.ffs-fab');
        const hint = document.getElementById('ffs-hint');
        let hintTimeout;
        function shouldShowHints() { return !getConfig().hasUsedTap || !getConfig().hasUsedHold; }
        const hideHint = () => hint.classList.remove('show', 'animate');
        const displayHint = (animate) => { if (shouldShowHints()) { hint.classList.add('show'); if (animate) hint.classList.add('animate'); } };
        if (showHint) hintTimeout = setTimeout(hideHint, isMobile ? 8000 : 6000);
        if (!isMobile) {
            fab.addEventListener('mouseenter', () => { if (shouldShowHints()) { clearTimeout(hintTimeout); displayHint(false); } });
            fab.addEventListener('mouseleave', () => { if (!fab.classList.contains('pressing')) hideHint(); });
        }
        let pressTimer, isLongPress;
        const startPress = e => {
            if (isRepositioning) return;
            e.preventDefault();
            clearTimeout(hintTimeout);
            hideHint();
            isLongPress = false;
            fab.classList.add('pressing');
            pressTimer = setTimeout(() => {
                isLongPress = true;
                fab.classList.remove('pressing');
                showConfigPopup();
                const cfg = getConfig();
                if (!cfg.hasUsedHold) { cfg.hasUsedHold = true; saveConfig(cfg); }
            }, 500);
        };
        const endPress = e => {
            if (isRepositioning) return;
            e.preventDefault();
            fab.classList.remove('pressing');
            clearTimeout(pressTimer);
            if (!isLongPress) {
                const cfg = getConfig();
                if (!cfg.hasUsedTap) { cfg.hasUsedTap = true; saveConfig(cfg); }
                fetchTarget();
            }
        };
        const cancelPress = () => { if (isRepositioning) return; fab.classList.remove('pressing'); clearTimeout(pressTimer); };
        fab.addEventListener('mousedown', startPress);
        fab.addEventListener('mouseup', endPress);
        fab.addEventListener('mouseleave', cancelPress);
        fab.addEventListener('touchstart', startPress, { passive: false });
        fab.addEventListener('touchend', endPress, { passive: false });
        fab.addEventListener('touchcancel', cancelPress);
        fab.addEventListener('contextmenu', e => e.preventDefault());
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', e => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
        if (isRepositioning) return;
        switch (e.key) {
            case 'F1': e.preventDefault(); fetchTarget(); break;
            case 'F2': e.preventDefault(); showConfigPopup(); break;
            case 'F3': e.preventDefault(); promptApiKey(); break;
        }
    });

    // Full CSS (unchanged)
    GM_addStyle(`
        .ffs-overlay{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);z-index:999999;display:flex;justify-content:center;align-items:center;font-family:Arial,Helvetica,sans-serif;backdrop-filter:blur(3px);}
        .ffs-popup{background:linear-gradient(180deg,#2d2d2d 0%,#1a1a1a 100%);border-radius:8px;width:380px;max-width:95vw;max-height:90vh;overflow-y:auto;box-shadow:0 10px 40px rgba(0,0,0,0.5),0 0 0 1px rgba(255,255,255,0.1);color:#ddd;}
        .ffs-popup::-webkit-scrollbar{width:8px;}
        .ffs-popup::-webkit-scrollbar-track{background:#1a1a1a;}
        .ffs-popup::-webkit-scrollbar-thumb{background:#444;border-radius:4px;}
        .ffs-header{background:linear-gradient(180deg,#3d3d3d 0%,#2a2a2a 100%);padding:16px 20px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #444;position:sticky;top:0;z-index:10;}
        .ffs-header-title{display:flex;align-items:center;gap:10px;}
        .ffs-header-title svg{width:22px;height:22px;fill:#6ac46a;}
        .ffs-header h2{margin:0!important;color:#fff;font-size:15px;font-weight:600;letter-spacing:0.5px;}
        .ffs-close{background:rgba(255,255,255,0.1);border:none;color:#888;font-size:18px;cursor:pointer;padding:0;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;transition:all 0.2s;}
        .ffs-close:hover{background:rgba(255,100,100,0.2);color:#f66;}
        .ffs-content{padding:16px;}
        .ffs-api-banner{display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:6px;margin-bottom:16px;cursor:pointer;transition:all 0.2s;}
        .ffs-api-banner svg{width:20px;height:20px;flex-shrink:0;}
        .ffs-api-banner-text{flex:1;}
        .ffs-api-banner-title{font-size:12px;font-weight:600;margin-bottom:2px;}
        .ffs-api-banner-sub{font-size:10px;opacity:0.7;}
        .ffs-api-banner.manual{background:linear-gradient(135deg,rgba(106,196,106,0.15) 0%,rgba(80,150,80,0.1) 100%);border:1px solid rgba(106,196,106,0.3);}
        .ffs-api-banner.manual svg{fill:#6c6;}
        .ffs-api-banner.manual:hover{background:linear-gradient(135deg,rgba(106,196,106,0.25) 0%,rgba(80,150,80,0.15) 100%);}
        .ffs-api-banner.auto{background:linear-gradient(135deg,rgba(106,150,196,0.15) 0%,rgba(80,120,150,0.1) 100%);border:1px solid rgba(106,150,196,0.3);}
        .ffs-api-banner.auto svg{fill:#6af;}
        .ffs-api-banner.auto:hover{background:linear-gradient(135deg,rgba(106,150,196,0.25) 0%,rgba(80,120,150,0.15) 100%);}
        .ffs-api-badge{background:rgba(255,255,255,0.1);padding:3px 8px;border-radius:10px;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;}
        .ffs-api-banner.auto .ffs-api-badge{background:rgba(106,170,255,0.2);color:#6af;}
        .ffs-api-banner.manual .ffs-api-badge{background:rgba(106,196,106,0.2);color:#6c6;}
        .ffs-target-card{background:rgba(0,0,0,0.2);border:1px solid #333;border-radius:6px;margin-bottom:12px;overflow:hidden;}
        .ffs-card-header{display:flex;align-items:center;gap:10px;padding:10px 14px;background:rgba(255,255,255,0.03);border-bottom:1px solid #333;}
        .ffs-card-icon{width:32px;height:32px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:16px;background:linear-gradient(135deg,#4a7c4a 0%,#3a5c3a 100%);}
        .ffs-card-title{flex:1;}
        .ffs-card-title h3{margin:0!important;font-size:13px;font-weight:600;color:#eee;}
        .ffs-card-title span{font-size:10px;color:#777;}
        .ffs-card-body{padding:12px 14px;display:flex;flex-direction:column;gap:10px;}
        .ffs-input-row{display:flex;align-items:center;gap:10px;}
        .ffs-input-label{font-size:11px;color:#999;width:55px;flex-shrink:0;}
        .ffs-input-group{display:flex;align-items:center;gap:6px;flex:1;}
        .ffs-input{flex:1;padding:8px 10px;border:1px solid #444;border-radius:4px;background:#252525;color:#fff;font-size:13px;text-align:center;transition:all 0.2s;}
        .ffs-input:focus{outline:none;border-color:#6ac46a;background:#2a2a2a;box-shadow:0 0 0 2px rgba(106,196,106,0.1);}
        .ffs-input-sep{color:#555;font-size:11px;}
        .ffs-card-count{padding:6px 14px;background:rgba(0,0,0,0.2);border-top:1px solid #333;font-size:11px;color:#888;display:flex;align-items:center;gap:6px;}
        .ffs-card-count.loading{color:#666;}
        .ffs-card-count.error{color:#c66;}
        .ffs-card-count.warning{color:#c96;}
        .ffs-card-count.good{color:#6a6;}
        .ffs-count-num{font-weight:600;color:#aaa;}
        .ffs-card-count.warning .ffs-count-num{color:#fc6;}
        .ffs-card-count.good .ffs-count-num{color:#6c6;}
        .ffs-card-count.error .ffs-count-num{color:#c66;}
        .ffs-count-spinner{width:12px;height:12px;border:2px solid #444;border-top-color:#888;border-radius:50%;animation:ffs-spin 0.8s linear infinite;}
        @keyframes ffs-spin{to{transform:rotate(360deg);}}
        .ffs-options{background:rgba(0,0,0,0.2);border:1px solid #333;border-radius:6px;overflow:hidden;margin-bottom:16px;}
        .ffs-options-header{padding:10px 14px;background:rgba(255,255,255,0.03);border-bottom:1px solid #333;font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:0.5px;}
        .ffs-option{display:flex;align-items:center;padding:12px 14px;border-bottom:1px solid #2a2a2a;cursor:pointer;transition:background 0.15s;}
        .ffs-option:last-child{border-bottom:none;}
        .ffs-option:hover{background:rgba(255,255,255,0.02);}
        .ffs-option-text{flex:1;margin-left:12px;}
        .ffs-option-title{font-size:12px;color:#ddd;}
        .ffs-option-desc{font-size:10px;color:#666;margin-top:2px;}
        .ffs-option-warn{color:#c96;}
        .ffs-toggle{position:relative;width:40px;height:22px;flex-shrink:0;}
        .ffs-toggle input{opacity:0;width:0;height:0;}
        .ffs-toggle-slider{position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background:#3a3a3a;border-radius:22px;transition:0.2s;border:1px solid #444;}
        .ffs-toggle-slider:before{position:absolute;content:"";height:16px;width:16px;left:2px;bottom:2px;background:#888;border-radius:50%;transition:0.2s;}
        .ffs-toggle input:checked+.ffs-toggle-slider{background:#4a7c4a;border-color:#5a5;}
        .ffs-toggle input:checked+.ffs-toggle-slider:before{transform:translateX(18px);background:#fff;}
        .ffs-footer{display:flex;gap:10px;padding:16px;background:rgba(0,0,0,0.2);border-top:1px solid #333;}
        .ffs-btn{flex:1;padding:12px 20px;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;transition:all 0.2s;}
        .ffs-btn-primary{background:linear-gradient(180deg,#5a9 0%,#4a8 100%);color:#fff;box-shadow:0 2px 8px rgba(90,170,150,0.3);}
        .ffs-btn-primary:hover{background:linear-gradient(180deg,#6ba 0%,#5a9 100%);transform:translateY(-1px);box-shadow:0 4px 12px rgba(90,170,150,0.4);}
        .ffs-btn-secondary{background:#333;color:#aaa;border:1px solid #444;}
        .ffs-btn-secondary:hover{background:#3a3a3a;color:#ddd;}
        .ffs-kbd-hints{display:${isMobile?'none':'flex'};justify-content:center;gap:16px;padding:12px;background:rgba(0,0,0,0.3);border-top:1px solid #333;}
        .ffs-kbd-hint{display:flex;align-items:center;gap:6px;font-size:10px;color:#666;}
        .ffs-kbd{background:#333;padding:3px 6px;border-radius:3px;font-family:monospace;font-size:10px;color:#999;border:1px solid #444;}
        .ffs-toast{position:fixed;bottom:${isMobile?'80px':'20px'};right:20px;left:${isMobile?'20px':'auto'};padding:14px 18px;border-radius:8px;color:#fff;font-size:13px;font-weight:500;z-index:9999999;animation:ffs-slide-in 0.3s ease;box-shadow:0 4px 20px rgba(0,0,0,0.4);max-width:${isMobile?'none':'320px'};}
        .ffs-toast-success{background:linear-gradient(135deg,#4a7c4a 0%,#3a5c3a 100%);}
        .ffs-toast-error{background:linear-gradient(135deg,#7c4a4a 0%,#5c3a3a 100%);}
        .ffs-toast-info{background:linear-gradient(135deg,#4a5c7c 0%,#3a4a5c 100%);}
        .ffs-toast-warning{background:linear-gradient(135deg,#7c6a4a 0%,#5c4a3a 100%);}
        @keyframes ffs-slide-in{from{transform:translateY(20px);opacity:0;}to{transform:translateY(0);opacity:1;}}
        .ffs-fab-container{position:fixed;z-index:10000;display:flex;flex-direction:column;align-items:center;gap:6px;}
        .ffs-fab-container.hidden{display:none!important;}
        .ffs-fab{width:28px;height:40px;border-radius:25px;background:rgba(15,15,18,0.85);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,0.2);box-shadow:0 4px 12px rgba(0,0,0,0.5);color:white;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:transform 0.2s,background 0.2s;outline:none;font-size:18px;font-weight:bold;position:relative;user-select:none;-webkit-tap-highlight-color:transparent;}
        .ffs-fab:hover{transform:translateY(-2px);background:rgba(25,25,28,0.9);}
        .ffs-fab:active{transform:scale(0.95);}
        .ffs-fab svg.ffs-fab-progress{position:absolute;top:-4px;left:-4px;width:calc(100% + 8px);height:calc(100% + 8px);transform:rotate(-90deg);opacity:0;transition:opacity 0.1s;}
        .ffs-fab svg.ffs-fab-progress circle{fill:none;stroke:#fff;stroke-width:3;stroke-dasharray:160;stroke-dashoffset:160;stroke-linecap:round;}
        .ffs-fab.pressing svg.ffs-fab-progress{opacity:1;}
        .ffs-fab.pressing svg.ffs-fab-progress circle{animation:ffs-progress-fill 0.5s ease-out forwards;}
        @keyframes ffs-progress-fill{to{stroke-dashoffset:0;}}
        .ffs-fab-hint{position:absolute;right:calc(100% + 12px);top:50%;transform:translateY(-50%);background:#222;color:#ddd;padding:10px 14px;border-radius:8px;font-size:12px;white-space:nowrap;box-shadow:0 4px 15px rgba(0,0,0,0.5);opacity:0;pointer-events:none;transition:opacity 0.3s;border:1px solid #444;}
        .ffs-fab-hint::after{content:'';position:absolute;right:-6px;top:50%;transform:translateY(-50%);border:6px solid transparent;border-left-color:#444;}
        .ffs-fab-hint.show{opacity:1;}
        .ffs-fab-hint.animate{animation:ffs-hint-bounce 0.5s ease;}
        @keyframes ffs-hint-bounce{0%,100%{transform:translateY(-50%) translateX(0);}50%{transform:translateY(-50%) translateX(-5px);}}
        .ffs-hint-row{display:flex;align-items:center;gap:10px;padding:4px 0;}
        .ffs-hint-action{background:#333;padding:2px 8px;border-radius:4px;font-size:10px;color:#999;min-width:40px;text-align:center;}
        .ffs-hint-result{color:#ddd;}
        .ffs-hint-result.good{color:#fc6;}
        .ffs-hint-result.menu{color:#aaa;}
        .ffs-fab-container.repositioning{cursor:grab;z-index:9999999;}
        .ffs-fab-container.repositioning.dragging{cursor:grabbing;}
        .ffs-fab-container.repositioning .ffs-fab{animation:ffs-pulse 1.5s ease-in-out infinite;border-color:#6af;background:rgba(15,15,18,0.95);}
        @keyframes ffs-pulse{0%,100%{box-shadow:0 0 0 0 rgba(102,170,255,0.5),0 4px 15px rgba(0,0,0,0.4);}50%{box-shadow:0 0 0 10px rgba(102,170,255,0),0 4px 15px rgba(0,0,0,0.4);}}
        .ffs-reposition-bar{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#1c1c1c;border:1px solid #444;border-radius:12px;padding:12px 20px;display:flex;align-items:center;gap:16px;z-index:99999999;box-shadow:0 8px 30px rgba(0,0,0,0.6);font-family:Arial,Helvetica,sans-serif;}
        .ffs-reposition-text{color:#ddd;font-size:13px;}
        .ffs-reposition-text span{color:#6af;font-weight:600;}
        .ffs-reposition-btns{display:flex;gap:8px;}
        .ffs-reposition-btn{padding:8px 16px;border:none;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;transition:all 0.2s;}
        .ffs-reposition-btn.confirm{background:linear-gradient(180deg,#5a9 0%,#4a8 100%);color:#fff;}
        .ffs-reposition-btn.confirm:hover{background:linear-gradient(180deg,#6ba 0%,#5a9 100%);}
        .ffs-reposition-btn.cancel{background:#333;color:#aaa;border:1px solid #444;}
        .ffs-reposition-btn.cancel:hover{background:#3a3a3a;color:#ddd;}
        .ffs-reposition-btn.reset{background:transparent;color:#888;padding:8px 12px;}
        .ffs-reposition-btn.reset:hover{color:#c66;}
        .ffs-torn-toggle .icon-wrapper svg{fill:#6ac46a;}
    `);

    // Init
    const observer = new MutationObserver(() => injectSettingsToggle());
    observer.observe(document.body, { childList: true, subtree: true });
    createFloatingButton();
    injectSettingsToggle();

    // Start faction member update (and background poll)
    updateMyFactionMembers();
    setInterval(updateMyFactionMembers, FACTION_REFRESH_MS);
    startBackgroundPoll();

    console.log('FF Scouter v6.4 – faction exclusion added');
})();
