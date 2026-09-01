// ==UserScript==
// @name         Battle Stats Support - Intelligent Strategy Planner
// @namespace    https://torn.com/
// @version      6.1.0
// @description  Intelligent Torn battle-stat planner with dynamic combat styles, perk-aware gym gains, future gym routing and specialist planning
// @match        https://www.torn.com/*
// @grant        GM_xmlhttpRequest
// @connect      api.torn.com
// ==/UserScript==

(function () {
    'use strict';

    const REFRESH_MS = 60000;
    const API_KEY_STORAGE = 'torn_api_key';
    const SETTINGS_STORAGE = 'bs_strategy_settings_v6';
    const LEGACY_SETTINGS_STORAGE = 'bs_strategy_settings_v5';
    const OBSERVED_GYM_STORAGE = 'bs_strategy_observed_gym_v5';
    const OWNED_SPECIALISTS_STORAGE = 'bs_strategy_owned_specialists_v5';
    const GYM_CACHE_STORAGE = 'bs_strategy_gym_cache_v5';
    const PUSH_STORAGE = 'bs_strategy_push_v6';
    const GYM_CACHE_MS = 6 * 60 * 60 * 1000;
    const PERKS_CACHE_MS = 5 * 60 * 1000;
    const DRUGS_CACHE_MS = 30 * 60 * 1000;
    const WIKI_GYM_SOURCE = 'Torn Wiki · Gym';
    const STATS = ['strength', 'speed', 'defense', 'dexterity'];
    const LABELS = { strength: 'Strength', speed: 'Speed', defense: 'Defense', dexterity: 'Dexterity' };

    const STANDARD_GYMS = [
        gym('Premier Fitness', 'lightweight', 5, 2.0, 2.0, 2.0, 2.0, 200),
        gym('Average Joes', 'lightweight', 5, 2.4, 2.4, 2.8, 2.4, 500),
        gym("Woody's Workout", 'lightweight', 5, 2.8, 3.2, 3.0, 2.8, 1000),
        gym('Beach Bods', 'lightweight', 5, 3.2, 3.2, 3.2, 0, 2000),
        gym('Silver Gym', 'lightweight', 5, 3.4, 3.6, 3.4, 3.2, 2750),
        gym('Pour Femme', 'lightweight', 5, 3.4, 3.6, 3.6, 3.8, 3000),
        gym('Davies Den', 'lightweight', 5, 3.7, 0, 3.7, 3.7, 3500),
        gym('Global Gym', 'lightweight', 5, 4.0, 4.0, 4.0, 4.0, 4000),
        gym('Knuckle Heads', 'middleweight', 10, 4.8, 4.4, 4.0, 4.2, 6000),
        gym('Pioneer Fitness', 'middleweight', 10, 4.4, 4.5, 4.8, 4.4, 7000),
        gym('Anabolic Anomalies', 'middleweight', 10, 5.0, 4.5, 5.2, 4.5, 8000),
        gym('Core', 'middleweight', 10, 5.0, 5.2, 5.0, 5.0, 11000),
        gym('Racing Fitness', 'middleweight', 10, 5.0, 5.4, 4.8, 5.2, 12420),
        gym('Complete Cardio', 'middleweight', 10, 5.5, 5.8, 5.5, 5.2, 18000),
        gym('Legs, Bums and Tums', 'middleweight', 10, 0, 5.6, 5.6, 5.8, 18100),
        gym('Deep Burn', 'middleweight', 10, 6.0, 6.0, 6.0, 6.0, 24140),
        gym('Apollo Gym', 'heavyweight', 10, 6.0, 6.2, 6.4, 6.2, 31260),
        gym('Gun Shop', 'heavyweight', 10, 6.6, 6.4, 6.2, 6.2, 36610),
        gym('Force Training', 'heavyweight', 10, 6.4, 6.6, 6.4, 6.8, 46640),
        gym("Cha Cha's", 'heavyweight', 10, 6.4, 6.4, 6.8, 7.0, 56520),
        gym('Atlas', 'heavyweight', 10, 7.0, 6.4, 6.4, 6.6, 67775),
        gym('Last Round', 'heavyweight', 10, 6.8, 6.6, 7.0, 6.6, 84535),
        gym('The Edge', 'heavyweight', 10, 6.8, 7.0, 7.0, 6.8, 106305),
        gym("George's", 'heavyweight', 10, 7.3, 7.3, 7.3, 7.3, null)
    ];

    const SPECIALIST_GYMS = [
        gym('Balboas Gym', 'specialist', 25, 0, 0, 7.5, 7.5, null),
        gym('Frontline Fitness', 'specialist', 25, 7.5, 7.5, 0, 0, null),
        gym('Gym 3000', 'specialist', 50, 8.0, 0, 0, 0, null),
        gym('Mr. Isoyamas', 'specialist', 50, 0, 0, 8.0, 0, null),
        gym('Total Rebound', 'specialist', 50, 0, 8.0, 0, 0, null),
        gym('Elites', 'specialist', 50, 0, 0, 0, 8.0, null),
        gym('The Sports Science Lab', 'specialist', 25, 9.0, 9.0, 9.0, 9.0, null),
        gym('Fight Club', 'specialist', 10, 10.0, 10.0, 10.0, 10.0, null)
    ];

    const SPECIALIST_RULES = {
        'Balboas Gym': { type: 'pairDefense', prereq: "Cha Cha's", factor: 1.25, trains: ['defense', 'dexterity'] },
        'Frontline Fitness': { type: 'pairOffense', prereq: "Cha Cha's", factor: 1.25, trains: ['strength', 'speed'] },
        'Gym 3000': { type: 'single', stat: 'strength', prereq: "George's", factor: 1.25, trains: ['strength'] },
        'Mr. Isoyamas': { type: 'single', stat: 'defense', prereq: "George's", factor: 1.25, trains: ['defense'] },
        'Total Rebound': { type: 'single', stat: 'speed', prereq: "George's", factor: 1.25, trains: ['speed'] },
        'Elites': { type: 'single', stat: 'dexterity', prereq: "George's", factor: 1.25, trains: ['dexterity'] },
        'The Sports Science Lab': { type: 'drugLimited', prereq: 'Last Round', trains: STATS.slice() },
        'Fight Club': { type: 'invite', prereq: null, trains: STATS.slice() }
    };

    const STYLE_OPTIONS = [
        ['balanced', 'Balanced · Generalist'],
        ['offensiveHybrid', 'Offensive Hybrid'],
        ['defensiveHybrid', 'Defensive Hybrid'],
        ['glassCannon', 'Glass Cannon'],
        ['defenseAnchor', 'Defense Anchor'],
        ['evasionAnchor', 'Evasion Anchor'],
        ['powerAnchor', 'Power Anchor'],
        ['precisionAnchor', 'Precision Anchor'],
        ['baldr', 'Baldr · Classic Ratio'],
        ['custom', 'Custom Build']
    ];

    const PHILOSOPHY_OPTIONS = [
        ['combat', 'Combat First'],
        ['hybrid', 'Hybrid'],
        ['gym', 'Gym Efficiency']
    ];

    let API_KEY = getApiKey();
    let settings = loadSettings();
    let latest = null;
    let gymCatalog = mergeGymCatalog([]);
    let gymCatalogSource = 'Wiki fallback';
    let isFetching = false;
    let perkCache = { savedAt: 0, data: null };
    let drugCache = { savedAt: 0, data: null };

    function gym(name, gymClass, energy, strength, speed, defense, dexterity, nextEnergy) {
        return { id: null, name, class: gymClass, energy, modifiers: { strength, speed, defense, dexterity }, nextEnergy, note: null };
    }

    function getApiKey() {
        let key = localStorage.getItem(API_KEY_STORAGE);
        if (!key) {
            key = prompt('Enter your Torn API key (Limited access is required for battle stats):');
            if (key) localStorage.setItem(API_KEY_STORAGE, key.trim());
        }
        return key ? key.trim() : '';
    }

    function defaultSettings() {
        return {
            style: 'glassCannon',
            philosophy: 'hybrid',
            lead: 'strength',
            highestStandardGym: '',
            customRatios: { strength: 40, speed: 30, defense: 20, dexterity: 10 },
            customTrainable: { strength: true, speed: true, defense: true, dexterity: true }
        };
    }

    function loadSettings() {
        const defaults = defaultSettings();
        try {
            const current = localStorage.getItem(SETTINGS_STORAGE);
            const legacy = localStorage.getItem(LEGACY_SETTINGS_STORAGE);
            const raw = JSON.parse(current || legacy || '{}');
            const merged = {
                ...defaults,
                ...raw,
                customRatios: { ...defaults.customRatios, ...(raw.customRatios || {}) },
                customTrainable: { ...defaults.customTrainable, ...(raw.customTrainable || {}) }
            };
            if (!current && legacy) localStorage.setItem(SETTINGS_STORAGE, JSON.stringify(merged));
            return merged;
        } catch (e) {
            return defaults;
        }
    }

    function saveSettings(next) {
        settings = next;
        localStorage.setItem(SETTINGS_STORAGE, JSON.stringify(settings));
        localStorage.removeItem(PUSH_STORAGE);
    }

    function apiRequest(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                headers: { Authorization: `ApiKey ${API_KEY}` },
                onload(response) {
                    try {
                        const data = JSON.parse(response.responseText);
                        if (response.status >= 400 || data.error) reject(new Error(data.error?.error || data.error?.message || `HTTP ${response.status}`));
                        else resolve(data);
                    } catch (e) {
                        reject(e);
                    }
                },
                onerror: reject,
                ontimeout: () => reject(new Error('Request timed out'))
            });
        });
    }

    function legacyRequest(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                onload(response) {
                    try {
                        const data = JSON.parse(response.responseText);
                        if (data.error) reject(new Error(data.error.error || 'Legacy API error'));
                        else resolve(data);
                    } catch (e) {
                        reject(e);
                    }
                },
                onerror: reject
            });
        });
    }

    async function fetchBattleStats() {
        try {
            const data = await apiRequest('https://api.torn.com/v2/user/battlestats');
            const b = data.battlestats;
            return {
                strength: { base: Number(b.strength.value) || 0, mod: Number(b.strength.modifier) || 0 },
                speed: { base: Number(b.speed.value) || 0, mod: Number(b.speed.modifier) || 0 },
                defense: { base: Number(b.defense.value) || 0, mod: Number(b.defense.modifier) || 0 },
                dexterity: { base: Number(b.dexterity.value) || 0, mod: Number(b.dexterity.modifier) || 0 },
                total: Number(b.total) || 0,
                source: 'v2'
            };
        } catch (v2Error) {
            const data = await legacyRequest(`https://api.torn.com/user/?selections=battlestats&key=${encodeURIComponent(API_KEY)}`);
            return {
                strength: { base: Number(data.strength) || 0, mod: Number(data.strength_modifier) || 0 },
                speed: { base: Number(data.speed) || 0, mod: Number(data.speed_modifier) || 0 },
                defense: { base: Number(data.defense) || 0, mod: Number(data.defense_modifier) || 0 },
                dexterity: { base: Number(data.dexterity) || 0, mod: Number(data.dexterity_modifier) || 0 },
                total: Number(data.total) || 0,
                source: 'v1 fallback'
            };
        }
    }

    async function fetchActiveGym() {
        try {
            const data = await apiRequest('https://api.torn.com/v2/user/gym');
            return data.gym ? { id: data.gym.id, name: data.gym.name } : null;
        } catch (e) {
            return null;
        }
    }


    async function fetchBars() {
        try {
            const data = await apiRequest('https://api.torn.com/v2/user/bars');
            return data.bars || null;
        } catch (e) {
            return null;
        }
    }

    async function fetchPerksCached(force = false) {
        if (!force && perkCache.data && Date.now() - perkCache.savedAt < PERKS_CACHE_MS) return perkCache.data;
        try {
            const data = await apiRequest('https://api.torn.com/v2/user/perks');
            perkCache = { savedAt: Date.now(), data: data.perks || null };
            return perkCache.data;
        } catch (e) {
            return perkCache.data;
        }
    }

    async function fetchDrugStatsCached(force = false) {
        if (!force && drugCache.data && Date.now() - drugCache.savedAt < DRUGS_CACHE_MS) return drugCache.data;
        try {
            const data = await apiRequest('https://api.torn.com/v2/user/personalstats?cat=drugs');
            drugCache = { savedAt: Date.now(), data: data.personalstats?.drugs || null };
            return drugCache.data;
        } catch (e) {
            return drugCache.data;
        }
    }

    async function loadGymCatalog() {
        try {
            const cached = JSON.parse(localStorage.getItem(GYM_CACHE_STORAGE) || 'null');
            if (cached && Date.now() - cached.savedAt < GYM_CACHE_MS && Array.isArray(cached.gyms)) {
                gymCatalogSource = 'Cached API';
                return mergeGymCatalog(cached.gyms.map(normalizeApiGym));
            }
        } catch (e) {}
        try {
            const data = await apiRequest('https://api.torn.com/v2/torn/gyms');
            const gyms = Array.isArray(data.gyms) ? data.gyms : [];
            localStorage.setItem(GYM_CACHE_STORAGE, JSON.stringify({ savedAt: Date.now(), gyms }));
            gymCatalogSource = 'Live API';
            return mergeGymCatalog(gyms.map(normalizeApiGym));
        } catch (e) {
            gymCatalogSource = 'Wiki fallback';
            return mergeGymCatalog([]);
        }
    }

    function normalizeApiGym(g) {
        const mods = {};
        STATS.forEach(stat => {
            const raw = Number(g.modifiers?.[stat]) || 0;
            mods[stat] = raw > 10 ? raw / 10 : raw;
        });
        return { id: g.id, name: g.name, class: g.class || '', energy: Number(g.energy_cost) || 0, modifiers: mods, nextEnergy: null, note: g.note || null };
    }

    function mergeGymCatalog(apiGyms) {
        const map = new Map(apiGyms.map(g => [g.name, g]));
        return [...STANDARD_GYMS, ...SPECIALIST_GYMS].map(fallback => {
            const live = map.get(fallback.name);
            return live ? { ...fallback, ...live, nextEnergy: fallback.nextEnergy } : { ...fallback };
        });
    }

    async function fetchAll(forceCatalog = false) {
        if (!API_KEY || isFetching) return;
        isFetching = true;
        if (!latest) renderLoading();
        try {
            if (forceCatalog) localStorage.removeItem(GYM_CACHE_STORAGE);
            const [statsResult, gymResult, catalogResult, barsResult, perksResult, drugsResult] = await Promise.allSettled([
                fetchBattleStats(),
                fetchActiveGym(),
                loadGymCatalog(),
                fetchBars(),
                fetchPerksCached(forceCatalog),
                fetchDrugStatsCached(forceCatalog)
            ]);
            if (statsResult.status !== 'fulfilled') throw statsResult.reason;
            gymCatalog = catalogResult.status === 'fulfilled' ? catalogResult.value : mergeGymCatalog([]);
            const activeGym = gymResult.status === 'fulfilled' ? gymResult.value : null;
            const bars = barsResult.status === 'fulfilled' ? barsResult.value : null;
            const perks = perksResult.status === 'fulfilled' ? perksResult.value : null;
            const drugs = drugsResult.status === 'fulfilled' ? drugsResult.value : null;
            latest = {
                stats: statsResult.value,
                activeGym,
                bars,
                perks,
                trainingBonuses: parseTrainingBonuses(perks),
                drugs,
                error: null
            };
            observeGymProgress(activeGym);
            renderMain();
        } catch (e) {
            latest = { ...(latest || {}), error: e?.message || 'Unable to load battle stats.' };
            renderError(latest.error);
        } finally {
            isFetching = false;
        }
    }

    function observeGymProgress(activeGym) {
        if (!activeGym?.name) return;
        const standardIndex = STANDARD_GYMS.findIndex(g => g.name === activeGym.name);
        if (standardIndex >= 0) {
            const old = Number(localStorage.getItem(OBSERVED_GYM_STORAGE));
            if (!Number.isFinite(old) || standardIndex > old) localStorage.setItem(OBSERVED_GYM_STORAGE, String(standardIndex));
        }
        if (SPECIALIST_RULES[activeGym.name]) {
            const owned = getOwnedSpecialists();
            if (!owned.includes(activeGym.name)) {
                owned.push(activeGym.name);
                localStorage.setItem(OWNED_SPECIALISTS_STORAGE, JSON.stringify(owned));
            }
        }
    }

    function getOwnedSpecialists() {
        try {
            const data = JSON.parse(localStorage.getItem(OWNED_SPECIALISTS_STORAGE) || '[]');
            return Array.isArray(data) ? data : [];
        } catch (e) {
            return [];
        }
    }


    function setOwnedSpecialists(names) {
        const valid = [...new Set((Array.isArray(names) ? names : []).filter(name => SPECIALIST_RULES[name]))];
        localStorage.setItem(OWNED_SPECIALISTS_STORAGE, JSON.stringify(valid));
    }

    function getProgressIndex(activeGym) {
        if (settings.highestStandardGym) {
            const i = STANDARD_GYMS.findIndex(g => g.name === settings.highestStandardGym);
            if (i >= 0) return i;
        }
        let observed = Number(localStorage.getItem(OBSERVED_GYM_STORAGE));
        if (!Number.isFinite(observed)) observed = -1;
        const activeStandard = STANDARD_GYMS.findIndex(g => g.name === activeGym?.name);
        let inferred = Math.max(observed, activeStandard);
        const rule = SPECIALIST_RULES[activeGym?.name];
        if (rule?.prereq) inferred = Math.max(inferred, STANDARD_GYMS.findIndex(g => g.name === rule.prereq));
        return Math.max(0, inferred);
    }

    function statValues(stats) {
        const out = {};
        STATS.forEach(s => out[s] = stats[s].base);
        return out;
    }

    function totalBase(values) {
        return STATS.reduce((sum, s) => sum + values[s], 0);
    }

    function calcEff(base, mod) {
        return Math.round(base * (1 + (Number(mod) || 0) / 100));
    }


    function parseTrainingBonuses(perks) {
        const categories = ['faction', 'job', 'property', 'education', 'enhancer', 'book', 'stock', 'merit'];
        const categoryPct = {};
        const entries = [];
        categories.forEach(category => {
            categoryPct[category] = { strength: 0, speed: 0, defense: 0, dexterity: 0 };
            const list = Array.isArray(perks?.[category]) ? perks[category] : [];
            list.forEach(raw => {
                const text = String(raw || '').trim();
                const lower = text.toLowerCase();
                if (!lower.includes('gym') || !lower.includes('gain')) return;
                const match = text.match(/([+-]?\d+(?:\.\d+)?)\s*%/);
                if (!match) return;
                const amount = Number(match[1]);
                if (!Number.isFinite(amount)) return;
                const targets = [];
                if (lower.includes('strength')) targets.push('strength');
                if (lower.includes('speed')) targets.push('speed');
                if (lower.includes('defense') || lower.includes('defence')) targets.push('defense');
                if (lower.includes('dexterity')) targets.push('dexterity');
                if (!targets.length) STATS.forEach(stat => targets.push(stat));
                targets.forEach(stat => categoryPct[category][stat] += amount);
                entries.push({ category, text, amount, stats: targets.slice() });
            });
        });
        const byStat = {};
        STATS.forEach(stat => {
            let factor = 1;
            const parts = [];
            categories.forEach(category => {
                const amount = categoryPct[category][stat];
                if (!amount) return;
                factor *= 1 + amount / 100;
                parts.push({ category, amount });
            });
            byStat[stat] = { factor, equivalentPct: (factor - 1) * 100, parts };
        });
        return { byStat, entries, categoryPct };
    }

    function trainingBonusFactor(stat) {
        return latest?.trainingBonuses?.byStat?.[stat]?.factor || 1;
    }

    function trainingBonusPct(stat) {
        return latest?.trainingBonuses?.byStat?.[stat]?.equivalentPct || 0;
    }

    function currentHappy() {
        return Number(latest?.bars?.happy?.current) || 0;
    }

    function estimateGymGain(stat, gym, values, energy = null) {
        if (!gym || !values || !(gym.modifiers?.[stat] > 0)) return null;
        const happy = currentHappy();
        if (!happy) return null;
        const a = 3.480061091e-7;
        const b = 250;
        const c = 3.091619094e-6;
        const d = 6.82775184551527e-5;
        const e = -0.0301431777;
        const trainEnergy = Number(energy ?? gym.energy) || 0;
        if (trainEnergy <= 0) return null;
        const bracket = (a * Math.log(happy + b) + c) * values[stat] + d * (happy + b) + e;
        const gain = trainingBonusFactor(stat) * (gym.modifiers[stat] || 0) * trainEnergy * bracket;
        return Number.isFinite(gain) ? Math.max(0, gain) : null;
    }

    function estimateGainPer100E(stat, gym, values) {
        return estimateGymGain(stat, gym, values, 100);
    }

    function effectiveGymIndex(stat, gym) {
        if (!gym) return 0;
        return (gym.modifiers?.[stat] || 0) * trainingBonusFactor(stat);
    }

    function formatNumber(value) {
        return Math.round(Number(value) || 0).toLocaleString();
    }


    function formatEstimate(value) {
        value = Number(value);
        if (!Number.isFinite(value)) return 'Unknown';
        if (Math.abs(value) >= 1000) return Math.round(value).toLocaleString();
        if (Math.abs(value) >= 100) return value.toFixed(1);
        return value.toFixed(2);
    }

    function formatShort(value) {
        value = Number(value) || 0;
        if (Math.abs(value) >= 1e9) return `${(value / 1e9).toFixed(2)}b`;
        if (Math.abs(value) >= 1e6) return `${(value / 1e6).toFixed(2)}m`;
        if (Math.abs(value) >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
        return Math.round(value).toLocaleString();
    }

    function pct(value) {
        return `${(value * 100).toFixed(1)}%`;
    }

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function normalizeRatios(raw) {
        const safe = {};
        let sum = 0;
        STATS.forEach(s => {
            safe[s] = Math.max(0, Number(raw[s]) || 0);
            sum += safe[s];
        });
        if (sum <= 0) return { strength: .25, speed: .25, defense: .25, dexterity: .25 };
        STATS.forEach(s => safe[s] /= sum);
        return safe;
    }

    function anchorRatios(highStat, lowStat, philosophy) {
        const other = STATS.filter(s => s !== highStat && s !== lowStat);
        const raw = {};
        if (philosophy === 'gym') {
            STATS.forEach(s => raw[s] = 0);
            raw[highStat] = 100;
            raw[lowStat] = 28;
            other.forEach(s => raw[s] = 80);
        } else if (philosophy === 'hybrid') {
            STATS.forEach(s => raw[s] = 0);
            raw[highStat] = 45;
            raw[lowStat] = 5;
            other.forEach(s => raw[s] = 25);
        } else {
            STATS.forEach(s => raw[s] = 0);
            raw[highStat] = 55;
            raw[lowStat] = 5;
            other.forEach(s => raw[s] = 20);
        }
        return normalizeRatios(raw);
    }

    function baldrPlan(lead) {
        const pair = { strength: 'speed', speed: 'strength', defense: 'dexterity', dexterity: 'defense' }[lead];
        const raw = { strength: 72, speed: 72, defense: 72, dexterity: 72 };
        raw[lead] = 100;
        raw[pair] = 80;
        const pairGym = ['strength', 'speed'].includes(lead) ? 'Frontline Fitness' : 'Balboas Gym';
        const singleGym = { strength: 'Gym 3000', speed: 'Total Rebound', defense: 'Mr. Isoyamas', dexterity: 'Elites' }[lead];
        return { ratios: normalizeRatios(raw), trainable: allTrainable(), lead, specialists: [pairGym, singleGym] };
    }

    function allTrainable() {
        return { strength: true, speed: true, defense: true, dexterity: true };
    }

    function getStylePlan() {
        const p = settings.philosophy;
        if (settings.style === 'balanced') return { id: 'balanced', name: 'Balanced · Generalist', desc: 'Flexible all-stat combat growth.', ratios: normalizeRatios({ strength: 25, speed: 25, defense: 25, dexterity: 25 }), trainable: allTrainable(), lead: settings.lead, specialists: [] };
        if (settings.style === 'offensiveHybrid') return { id: 'offensiveHybrid', name: 'Offensive Hybrid', desc: 'Offense-led without fully sacrificing survivability.', ratios: normalizeRatios({ strength: 40, speed: 30, defense: 15, dexterity: 15 }), trainable: allTrainable(), lead: 'strength', specialists: ['Frontline Fitness'] };
        if (settings.style === 'defensiveHybrid') return { id: 'defensiveHybrid', name: 'Defensive Hybrid', desc: 'Defense and evasion weighted without dumping offense.', ratios: normalizeRatios({ strength: 20, speed: 20, defense: 30, dexterity: 30 }), trainable: allTrainable(), lead: 'defense', specialists: ['Balboas Gym'] };
        if (settings.style === 'glassCannon') return { id: 'glassCannon', name: 'Glass Cannon', desc: 'Maximum offensive pressure. Defense and Dexterity are passive.', ratios: normalizeRatios({ strength: 60, speed: 30, defense: 5, dexterity: 5 }), trainable: { strength: true, speed: true, defense: false, dexterity: false }, lead: 'strength', specialists: ['Frontline Fitness', 'Gym 3000'] };
        if (settings.style === 'defenseAnchor') return { id: 'defenseAnchor', name: 'Defense Anchor', desc: 'Defense-dominant three-stat build with Dexterity intentionally passive.', ratios: anchorRatios('defense', 'dexterity', p), trainable: { strength: true, speed: true, defense: true, dexterity: false }, lead: 'defense', specialists: ['Frontline Fitness', 'Mr. Isoyamas'] };
        if (settings.style === 'evasionAnchor') return { id: 'evasionAnchor', name: 'Evasion Anchor', desc: 'Dexterity-dominant three-stat build with Defense intentionally passive.', ratios: anchorRatios('dexterity', 'defense', p), trainable: { strength: true, speed: true, defense: false, dexterity: true }, lead: 'dexterity', specialists: ['Frontline Fitness', 'Elites'] };
        if (settings.style === 'powerAnchor') return { id: 'powerAnchor', name: 'Power Anchor', desc: 'Strength-dominant three-stat build with Speed intentionally passive.', ratios: anchorRatios('strength', 'speed', p), trainable: { strength: true, speed: false, defense: true, dexterity: true }, lead: 'strength', specialists: ['Balboas Gym', 'Gym 3000'] };
        if (settings.style === 'precisionAnchor') return { id: 'precisionAnchor', name: 'Precision Anchor', desc: 'Speed-dominant three-stat build with Strength intentionally passive.', ratios: anchorRatios('speed', 'strength', p), trainable: { strength: false, speed: true, defense: true, dexterity: true }, lead: 'speed', specialists: ['Balboas Gym', 'Total Rebound'] };
        if (settings.style === 'baldr') {
            const b = baldrPlan(settings.lead);
            return { id: 'baldr', name: `Baldr · ${LABELS[settings.lead]} Lead`, desc: 'Classic two-specialist-gym ratio using a lead stat and paired secondary stat.', ...b };
        }
        const ratios = normalizeRatios(settings.customRatios);
        const trainable = { ...settings.customTrainable };
        if (!STATS.some(s => trainable[s])) STATS.forEach(s => trainable[s] = true);
        return { id: 'custom', name: 'Custom Build', desc: 'Your own ratios and passive-stat rules.', ratios, trainable, lead: settings.lead, specialists: [] };
    }

    function effectiveTargets(plan, values) {
        const total = totalBase(values);
        const targets = {};
        let passiveReserved = 0;
        let trainRatioSum = 0;
        STATS.forEach(s => {
            if (plan.trainable[s]) trainRatioSum += plan.ratios[s];
            else {
                const currentShare = total ? values[s] / total : 0;
                targets[s] = Math.min(plan.ratios[s], currentShare);
                passiveReserved += targets[s];
            }
        });
        const remaining = Math.max(0, 1 - passiveReserved);
        const trainables = STATS.filter(s => plan.trainable[s]);
        STATS.forEach(s => {
            if (!plan.trainable[s]) return;
            targets[s] = trainRatioSum > 0 ? remaining * (plan.ratios[s] / trainRatioSum) : remaining / Math.max(1, trainables.length);
        });
        return targets;
    }

    function gainNeededForShare(current, total, targetShare) {
        if (targetShare <= 0 || targetShare >= 1) return 0;
        const gain = ((targetShare * total) - current) / (1 - targetShare);
        return Math.max(0, Math.ceil(gain));
    }

    function getGymByName(name) {
        return gymCatalog.find(g => g.name === name) || null;
    }

    function getActiveGymDetails(activeGym) {
        if (!activeGym) return null;
        return gymCatalog.find(g => g.id != null && String(g.id) === String(activeGym.id)) || getGymByName(activeGym.name) || { ...activeGym, energy: 0, modifiers: { strength: 0, speed: 0, defense: 0, dexterity: 0 } };
    }

    function bestStandardGymForStat(stat, progressIndex) {
        let best = null;
        for (let i = 0; i <= progressIndex && i < STANDARD_GYMS.length; i++) {
            const g = getGymByName(STANDARD_GYMS[i].name) || STANDARD_GYMS[i];
            if ((g.modifiers[stat] || 0) > (best?.modifiers[stat] || 0)) best = g;
        }
        return best;
    }

    function specialistCheck(name, values, progressIndex, activeGymName) {
        const rule = SPECIALIST_RULES[name];
        if (!rule) return null;
        const prereqIndex = rule.prereq ? STANDARD_GYMS.findIndex(g => g.name === rule.prereq) : -1;
        let prereqMet = !rule.prereq || progressIndex >= prereqIndex;
        if (activeGymName === name) prereqMet = true;
        if (rule.type === 'drugLimited') {
            const xanax = Number(latest?.drugs?.xanax);
            const ecstasy = Number(latest?.drugs?.ecstasy);
            const known = Number.isFinite(xanax) && Number.isFinite(ecstasy);
            const combinedDrugs = known ? xanax + ecstasy : null;
            const drugMet = known ? combinedDrugs <= 150 : null;
            return { name, prereqMet, prereqIndex, met: drugMet, bufferMet: null, ratio: null, rule, conditional: true, combinedDrugs, drugKnown: known };
        }
        if (rule.type === 'invite') return { name, prereqMet: false, prereqIndex: -1, met: null, bufferMet: null, ratio: null, rule, conditional: true };
        let ratio = 0;
        if (rule.type === 'pairOffense') ratio = (values.strength + values.speed) / Math.max(1, values.defense + values.dexterity);
        if (rule.type === 'pairDefense') ratio = (values.defense + values.dexterity) / Math.max(1, values.strength + values.speed);
        if (rule.type === 'single') {
            const others = STATS.filter(s => s !== rule.stat).map(s => values[s]).sort((a, b) => b - a);
            ratio = values[rule.stat] / Math.max(1, others[0]);
        }
        return { name, prereqMet, prereqIndex, met: ratio >= rule.factor, bufferMet: ratio >= 1.27, ratio, rule, conditional: false };
    }

    function getRelevantConstraintChecks(plan, values, progressIndex, activeGymName) {
        const names = new Set(plan.specialists || []);
        if (SPECIALIST_RULES[activeGymName]) names.add(activeGymName);
        return [...names].map(name => specialistCheck(name, values, progressIndex, activeGymName)).filter(Boolean);
    }

    function chooseSupportStat(options, plan, values, targets, progressIndex) {
        const allowed = options.filter(s => plan.trainable[s]);
        if (!allowed.length) return null;
        return allowed.sort((a, b) => {
            const total = totalBase(values);
            const aDef = targets[a] - values[a] / total;
            const bDef = targets[b] - values[b] / total;
            if (Math.abs(bDef - aDef) > .005) return bDef - aDef;
            const ga = bestStandardGymForStat(a, progressIndex)?.modifiers[a] || 0;
            const gb = bestStandardGymForStat(b, progressIndex)?.modifiers[b] || 0;
            return gb - ga;
        })[0];
    }

    function urgentSpecialistSupport(plan, values, targets, progressIndex, activeGymName) {
        const checks = getRelevantConstraintChecks(plan, values, progressIndex, activeGymName);
        const planningWindow = settings.philosophy === 'gym' ? 4 : settings.philosophy === 'hybrid' ? 2 : 0;
        for (const check of checks) {
            const isActive = activeGymName === check.name;
            const distance = check.prereqIndex >= 0 ? check.prereqIndex - progressIndex : 99;
            const approaching = !check.prereqMet && distance >= 0 && distance <= planningWindow;
            const shouldProtect = isActive || (settings.philosophy !== 'combat' && (check.prereqMet || approaching));
            if (!shouldProtect || check.conditional) continue;
            const targetFactor = isActive || settings.philosophy === 'gym' ? 1.27 : 1.26;
            if (check.ratio >= targetFactor) continue;
            const r = check.rule;
            let stat = null;
            let gain = 0;
            if (r.type === 'pairOffense') {
                stat = chooseSupportStat(['strength', 'speed'], plan, values, targets, progressIndex);
                gain = Math.ceil(targetFactor * (values.defense + values.dexterity) - (values.strength + values.speed));
            } else if (r.type === 'pairDefense') {
                stat = chooseSupportStat(['defense', 'dexterity'], plan, values, targets, progressIndex);
                gain = Math.ceil(targetFactor * (values.strength + values.speed) - (values.defense + values.dexterity));
            } else if (r.type === 'single') {
                stat = plan.trainable[r.stat] ? r.stat : null;
                const second = Math.max(...STATS.filter(s => s !== r.stat).map(s => values[s]));
                gain = Math.ceil(targetFactor * second - values[r.stat]);
            }
            if (stat && gain > 0) {
                const mode = isActive ? 'SPECIALIST PROTECTION' : approaching ? 'FUTURE GYM PREP' : 'GYM PREPARATION';
                const timing = approaching ? ` ${check.name} is ${distance} standard-gym step${distance === 1 ? '' : 's'} away by prerequisite.` : '';
                return { stat, gain, target: values[stat] + gain, mode, reason: `${check.name} needs a ${targetFactor.toFixed(2)}× safety relationship.${timing} Build the buffer before training against it.`, specialist: check.name };
            }
        }
        return null;
    }

    function stageEnergyEstimate(progressIndex, targetIndex) {
        if (targetIndex <= progressIndex) return 0;
        let energy = 0;
        for (let i = progressIndex; i < targetIndex && i < STANDARD_GYMS.length; i++) energy += Number(STANDARD_GYMS[i].nextEnergy) || 0;
        return energy;
    }

    function futureStandardOpportunity(stat, progressIndex, currentBest) {
        const base = currentBest?.modifiers[stat] || 0;
        const options = [];
        for (let i = progressIndex + 1; i < STANDARD_GYMS.length; i++) {
            const g = getGymByName(STANDARD_GYMS[i].name) || STANDARD_GYMS[i];
            const mod = g.modifiers[stat] || 0;
            if (mod <= base + .09) continue;
            const distance = i - progressIndex;
            options.push({ type: 'standard', gym: g, index: i, distance, improvement: mod - base, energyEstimate: stageEnergyEstimate(progressIndex, i) });
        }
        if (!options.length) return null;
        return options.sort((a, b) => (b.improvement / Math.max(1, b.distance + .5)) - (a.improvement / Math.max(1, a.distance + .5)))[0];
    }

    function futureSpecialistOpportunities(stat, plan, values, progressIndex, activeGymName, currentBest) {
        const base = currentBest?.modifiers?.[stat] || 0;
        const names = new Set(plan.specialists || []);
        const ssl = specialistCheck('The Sports Science Lab', values, progressIndex, activeGymName);
        if (ssl?.met !== false) names.add('The Sports Science Lab');
        const owned = new Set(getOwnedSpecialists());
        const out = [];
        names.forEach(name => {
            if (name === 'Fight Club') return;
            const rule = SPECIALIST_RULES[name];
            const g = getGymByName(name);
            if (!rule || !g || !(g.modifiers?.[stat] > base + .09)) return;
            const check = specialistCheck(name, values, progressIndex, activeGymName);
            if (!check) return;
            if (check.conditional && check.met === false) return;
            const prereqIndex = check.prereqIndex >= 0 ? check.prereqIndex : progressIndex;
            const distance = Math.max(0, prereqIndex - progressIndex);
            const ratioReady = check.conditional ? check.met !== false : check.met;
            const usableNow = owned.has(name) && check.prereqMet && ratioReady;
            if (usableNow) return;
            out.push({
                type: 'specialist', gym: g, check, distance, improvement: (g.modifiers[stat] || 0) - base,
                energyEstimate: distance > 0 ? stageEnergyEstimate(progressIndex, prereqIndex) : 0,
                ratioReady, prereqMet: check.prereqMet, owned: owned.has(name)
            });
        });
        return out.sort((a, b) => {
            const aScore = a.improvement / Math.max(1, a.distance + .5);
            const bScore = b.improvement / Math.max(1, b.distance + .5);
            return bScore - aScore;
        });
    }

    function futureTrainingOpportunity(stat, plan, values, progressIndex, activeGymName, currentBest) {
        const options = [];
        const standard = futureStandardOpportunity(stat, progressIndex, currentBest);
        if (standard) options.push(standard);
        options.push(...futureSpecialistOpportunities(stat, plan, values, progressIndex, activeGymName, currentBest));
        if (!options.length) return null;
        return options.sort((a, b) => {
            const aScore = a.improvement / Math.max(1, a.distance + .5);
            const bScore = b.improvement / Math.max(1, b.distance + .5);
            return bScore - aScore;
        })[0];
    }

    function knownBestGymForStat(stat, values, progressIndex, activeGymName) {
        let best = bestStandardGymForStat(stat, progressIndex);
        const owned = getOwnedSpecialists();
        owned.forEach(name => {
            const check = specialistCheck(name, values, progressIndex, activeGymName);
            const g = getGymByName(name);
            if (g && check?.prereqMet && check?.met && (g.modifiers[stat] || 0) > (best?.modifiers[stat] || 0)) best = g;
        });
        const active = getActiveGymDetails(latest?.activeGym);
        if (active && (active.modifiers?.[stat] || 0) > (best?.modifiers[stat] || 0)) best = active;
        return best;
    }

    function specialistSynergy(stat, plan, values, progressIndex, activeGymName) {
        let score = 0;
        (plan.specialists || []).forEach(name => {
            const rule = SPECIALIST_RULES[name];
            if (!rule?.trains.includes(stat)) return;
            const check = specialistCheck(name, values, progressIndex, activeGymName);
            if (check?.prereqMet && check.met) score += 1;
            else if (check?.prereqMet) score += .5;
            else {
                const reqIndex = rule.prereq ? STANDARD_GYMS.findIndex(g => g.name === rule.prereq) : 99;
                if (reqIndex - progressIndex <= 2) score += .25;
            }
        });
        return Math.min(1, score);
    }

    function styleSignature(plan) {
        return JSON.stringify({ style: settings.style, philosophy: settings.philosophy, lead: settings.lead, ratios: plan.ratios, trainable: plan.trainable });
    }

    function getStoredPush(plan, values) {
        try {
            const push = JSON.parse(localStorage.getItem(PUSH_STORAGE) || 'null');
            if (!push || push.signature !== styleSignature(plan) || !plan.trainable[push.stat]) return null;
            if (values[push.stat] >= push.target) {
                localStorage.removeItem(PUSH_STORAGE);
                return null;
            }
            return push;
        } catch (e) {
            return null;
        }
    }

    function createGrowthPush(plan, values, progressIndex) {
        let stat = plan.lead && plan.trainable[plan.lead] ? plan.lead : null;
        if (!stat) {
            const choices = STATS.filter(s => plan.trainable[s]);
            stat = choices.sort((a, b) => (bestStandardGymForStat(b, progressIndex)?.modifiers[b] || 0) - (bestStandardGymForStat(a, progressIndex)?.modifiers[a] || 0))[0];
        }
        const target = Math.ceil(values[stat] * 1.05);
        const push = { signature: styleSignature(plan), stat, target };
        localStorage.setItem(PUSH_STORAGE, JSON.stringify(push));
        return push;
    }

    function safetyCapForGain(stat, values, gain, checks, activeGymName) {
        let cap = gain;
        let specialist = null;
        checks.forEach(check => {
            const isActive = activeGymName === check.name;
            const protect = isActive || (settings.philosophy !== 'combat' && check.prereqMet);
            if (!protect || !check.met || check.conditional) return;
            const r = check.rule;
            let safe = Infinity;
            if (r.type === 'pairOffense' && ['defense', 'dexterity'].includes(stat)) safe = (values.strength + values.speed) / r.factor - (values.defense + values.dexterity);
            if (r.type === 'pairDefense' && ['strength', 'speed'].includes(stat)) safe = (values.defense + values.dexterity) / r.factor - (values.strength + values.speed);
            if (r.type === 'single' && stat !== r.stat) safe = values[r.stat] / r.factor - values[stat];
            if (Number.isFinite(safe) && safe < cap) {
                cap = Math.max(0, Math.floor(safe * .98));
                specialist = check.name;
            }
        });
        return { gain: cap, specialist };
    }

    function buildRecommendation(plan, values, activeGym, progressIndex) {
        const total = totalBase(values);
        const targets = effectiveTargets(plan, values);
        const support = urgentSpecialistSupport(plan, values, targets, progressIndex, activeGym?.name);
        if (support) return enrichRecommendation(support, plan, values, targets, progressIndex, activeGym);

        const storedPush = getStoredPush(plan, values);
        if (storedPush) {
            return enrichRecommendation({ stat: storedPush.stat, gain: storedPush.target - values[storedPush.stat], target: storedPush.target, mode: 'GROWTH LEVEL', reason: 'The build is aligned. Complete the active +5% growth level, then the planner will rebalance around it.' }, plan, values, targets, progressIndex, activeGym);
        }

        const candidates = STATS.filter(s => plan.trainable[s]).map(stat => {
            const gain = gainNeededForShare(values[stat], total, targets[stat]);
            const bestGym = knownBestGymForStat(stat, values, progressIndex, activeGym?.name);
            const future = futureTrainingOpportunity(stat, plan, values, progressIndex, activeGym?.name, bestGym);
            return { stat, gain, bestGym, future };
        }).filter(c => c.gain > 0);

        if (!candidates.length) {
            const push = createGrowthPush(plan, values, progressIndex);
            return enrichRecommendation({ stat: push.stat, gain: push.target - values[push.stat], target: push.target, mode: 'NEXT GROWTH LEVEL', reason: 'Your current shape is aligned. Push the lead stat by 5%, then let the other trainable stats catch back up.' }, plan, values, targets, progressIndex, activeGym);
        }

        const maxGain = Math.max(...candidates.map(c => c.gain), 1);
        const weights = settings.philosophy === 'combat'
            ? { need: 1.00, efficiency: .10, future: .05, specialist: .05 }
            : settings.philosophy === 'gym'
                ? { need: .80, efficiency: .35, future: .25, specialist: .30 }
                : { need: 1.00, efficiency: .20, future: .15, specialist: .15 };

        candidates.forEach(c => {
            const need = c.gain / maxGain;
            const eff = clamp(effectiveGymIndex(c.stat, c.bestGym) / 9, 0, 1.4);
            const futurePenalty = c.future ? clamp((c.future.improvement / 2) * (1 / Math.max(1, c.future.distance)), 0, .6) : 0;
            const spec = specialistSynergy(c.stat, plan, values, progressIndex, activeGym?.name);
            const lead = c.stat === plan.lead ? .03 : 0;
            c.score = weights.need * need + weights.efficiency * eff - weights.future * futurePenalty + weights.specialist * spec + lead;
        });

        candidates.sort((a, b) => b.score - a.score);
        let chosen = candidates[0];
        const checks = getRelevantConstraintChecks(plan, values, progressIndex, activeGym?.name);
        const cap = safetyCapForGain(chosen.stat, values, chosen.gain, checks, activeGym?.name);
        if (cap.gain <= 0) {
            const alternative = candidates.slice(1).find(c => safetyCapForGain(c.stat, values, c.gain, checks, activeGym?.name).gain > 0);
            if (alternative) chosen = alternative;
        }
        const finalCap = safetyCapForGain(chosen.stat, values, chosen.gain, checks, activeGym?.name);
        let gain = Math.max(1, finalCap.gain > 0 ? finalCap.gain : chosen.gain);
        let reason = `${LABELS[chosen.stat]} is below its dynamic ${pct(targets[chosen.stat])} build target.`;
        if (chosen.future && settings.philosophy !== 'combat') {
            const futureName = chosen.future.gym?.name;
            if (futureName && chosen.future.distance <= 2) reason += ` A stronger ${LABELS[chosen.stat]} gym is approaching, so this checkpoint avoids over-correcting before ${futureName}.`;
        }
        if (finalCap.specialist && gain < chosen.gain) reason += ` Stop at this checkpoint to preserve ${finalCap.specialist}.`;
        return enrichRecommendation({ stat: chosen.stat, gain, target: values[chosen.stat] + gain, mode: 'TRAIN NEXT', reason, cappedBy: finalCap.specialist }, plan, values, targets, progressIndex, activeGym);
    }

    function enrichRecommendation(rec, plan, values, targets, progressIndex, activeGym) {
        const stat = rec.stat;
        const currentGym = getActiveGymDetails(activeGym);
        const bestGym = knownBestGymForStat(stat, values, progressIndex, activeGym?.name);
        const future = futureTrainingOpportunity(stat, plan, values, progressIndex, activeGym?.name, bestGym);
        const currentMod = currentGym?.modifiers?.[stat] || 0;
        const bestMod = bestGym?.modifiers?.[stat] || 0;
        const bonusPct = trainingBonusPct(stat);
        const currentIndex = effectiveGymIndex(stat, currentGym);
        const bestIndex = effectiveGymIndex(stat, bestGym);
        const currentGain100 = estimateGainPer100E(stat, currentGym, values);
        const bestGain100 = estimateGainPer100E(stat, bestGym, values);
        let gymAdvice = 'No gym multiplier data available.';
        if (bestGym) {
            if (!currentGym) gymAdvice = `Best known usable option: ${bestGym.name} (${bestMod.toFixed(1)}).`;
            else if (currentGym.name !== bestGym.name && bestMod > currentMod + .09) gymAdvice = `Switch to ${bestGym.name} for ${LABELS[stat]} if available: ${currentMod.toFixed(1)} → ${bestMod.toFixed(1)} gym multiplier.`;
            else gymAdvice = `${currentGym.name}: ${currentMod.toFixed(1)} ${LABELS[stat]} multiplier at ${currentGym.energy || '?'}E per train.`;
        }
        let futureAdvice = null;
        if (future) {
            const current = bestMod || 0;
            const futureMod = future.gym.modifiers[stat] || 0;
            const improvementPct = current > 0 ? ((futureMod / current) - 1) * 100 : 0;
            const path = future.energyEstimate > 0 ? ` · up to ~${formatNumber(future.energyEstimate)}E across full remaining Wiki stage estimates` : '';
            const condition = future.type === 'specialist' && future.check
                ? future.check.conditional
                    ? future.check.met === false ? ' · currently ineligible' : ' · eligibility condition tracked'
                    : future.ratioReady ? ' · stat shape ready' : ' · stat shape still needed'
                : '';
            futureAdvice = `${future.gym.name} raises ${LABELS[stat]} ${current.toFixed(1)} → ${futureMod.toFixed(1)}${improvementPct > 0 ? ` (+${improvementPct.toFixed(0)}%)` : ''}${path}${condition}.`;
        }
        return {
            ...rec,
            target: rec.target || values[stat] + rec.gain,
            plan,
            targets,
            currentGym,
            bestGym,
            future,
            gymAdvice,
            futureAdvice,
            bonusPct,
            currentIndex,
            bestIndex,
            currentGain100,
            bestGain100
        };
    }

    function buildPlannerModel() {
        const values = statValues(latest.stats);
        const plan = getStylePlan();
        const progressIndex = getProgressIndex(latest.activeGym);
        const targets = effectiveTargets(plan, values);
        const recommendation = buildRecommendation(plan, values, latest.activeGym, progressIndex);
        const checkNames = new Set(plan.specialists || []);
        const ssl = specialistCheck('The Sports Science Lab', values, progressIndex, latest.activeGym?.name);
        if (ssl?.met !== false) checkNames.add('The Sports Science Lab');
        const checks = [...checkNames].map(name => specialistCheck(name, values, progressIndex, latest.activeGym?.name)).filter(Boolean);
        return { values, total: totalBase(values), plan, progressIndex, targets, recommendation, checks };
    }

    function specialistStatus(check) {
        const owned = getOwnedSpecialists().includes(check.name);
        if (check.name === 'Fight Club') return 'INVITE ONLY';
        if (check.name === 'The Sports Science Lab') {
            if (!check.drugKnown) return 'DRUG DATA UNKNOWN';
            if (check.met === false) return 'INELIGIBLE';
            if (!check.prereqMet) return 'FUTURE';
            if (owned) return 'READY';
            return 'ELIGIBLE';
        }
        if (!check.prereqMet) return 'FUTURE';
        if (!check.met) return 'SHAPE NEEDED';
        if (owned) return 'READY';
        return 'RATIO READY';
    }

    function specialistStatusColor(status) {
        if (['READY', 'RATIO READY', 'ELIGIBLE'].includes(status)) return '#4caf50';
        if (['SHAPE NEEDED', 'DRUG DATA UNKNOWN'].includes(status)) return '#ff9800';
        if (status === 'INELIGIBLE') return '#f44336';
        return '#777';
    }

    function renderLoading() {
        const panel = document.getElementById('battle-overlay-panel');
        if (!panel) return;
        panel.innerHTML = `<div style="padding:28px 10px;text-align:center;color:#aaa;font-family:Arial,sans-serif;"><div style="font-size:18px;font-weight:800;color:#fff;">Battle Strategy</div><div style="margin-top:8px;font-size:12px;">Loading stats and gym intelligence…</div></div>`;
    }

    function renderError(message) {
        const panel = document.getElementById('battle-overlay-panel');
        if (!panel) return;
        panel.innerHTML = `<div style="font-family:Arial,sans-serif;color:#fff;"><div style="display:flex;justify-content:space-between;align-items:center;"><b>Battle Strategy</b><button id="bs-close" style="${buttonCss()}">×</button></div><div style="margin-top:16px;padding:12px;background:#2a1717;border:1px solid #5a2525;border-radius:8px;color:#ffb4b4;">${escapeHtml(message)}</div><div style="display:flex;gap:8px;margin-top:12px;"><button id="bs-retry" style="${buttonCss(true)}">Retry</button><button id="bs-api" style="${buttonCss()}">Change API Key</button></div></div>`;
        document.getElementById('bs-close').onclick = closeOverlay;
        document.getElementById('bs-retry').onclick = () => fetchAll(true);
        document.getElementById('bs-api').onclick = changeApiKey;
    }

    function renderMain() {
        if (!latest?.stats) return renderLoading();
        const panel = document.getElementById('battle-overlay-panel');
        const m = buildPlannerModel();
        const r = m.recommendation;
        const activeGym = getActiveGymDetails(latest.activeGym);
        const nextStandard = m.progressIndex < STANDARD_GYMS.length - 1 ? STANDARD_GYMS[m.progressIndex + 1] : null;
        const currentStageEnergy = STANDARD_GYMS[m.progressIndex]?.nextEnergy || null;
        const philosophyName = PHILOSOPHY_OPTIONS.find(x => x[0] === settings.philosophy)?.[1] || settings.philosophy;
        const totalEff = STATS.reduce((sum, stat) => sum + calcEff(latest.stats[stat].base, latest.stats[stat].mod), 0);
        const happyCurrent = currentHappy();
        const happyMaximum = Number(latest?.bars?.happy?.maximum) || 0;
        const owned = new Set(getOwnedSpecialists());
        const perkEntries = latest?.trainingBonuses?.entries || [];
        const bestPerStat = {};
        STATS.forEach(stat => bestPerStat[stat] = knownBestGymForStat(stat, m.values, m.progressIndex, latest.activeGym?.name));

        let html = `<div style="font-family:Arial,sans-serif;color:#fff;">
            <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;">
                <div><div style="font-size:18px;font-weight:800;">Battle Strategy</div><div style="font-size:10px;letter-spacing:.7px;color:#777;margin-top:2px;">${escapeHtml(m.plan.name.toUpperCase())} · ${escapeHtml(philosophyName.toUpperCase())}</div></div>
                <div style="display:flex;gap:5px;"><button id="bs-settings" title="Strategy settings" style="${buttonCss()}">⚙</button><button id="bs-close" title="Close" style="${buttonCss()}">×</button></div>
            </div>
            <div style="font-size:11px;color:#888;margin-top:7px;line-height:1.35;">${escapeHtml(m.plan.desc)}</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:13px;">`;

        STATS.forEach(stat => {
            const base = m.values[stat];
            const share = base / m.total;
            const target = m.targets[stat];
            const active = r.stat === stat;
            const trainable = m.plan.trainable[stat];
            const eff = calcEff(base, latest.stats[stat].mod);
            const bonus = trainingBonusPct(stat);
            const status = active ? `↑ +${formatShort(r.gain)}` : trainable ? 'HOLD' : share > m.plan.ratios[stat] ? 'PASSIVE · ABOVE REF' : 'PASSIVE';
            html += `<div style="background:${active ? '#17242c' : '#1a1a1a'};border:1px solid ${active ? '#03a9f4' : '#292929'};border-radius:9px;padding:10px;min-width:0;">
                <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;"><b style="font-size:16px;line-height:1.15;">${active ? '↑ ' : ''}${LABELS[stat]}</b><b style="font-size:12px;color:${active ? '#03a9f4' : '#aaa'};">${pct(share)}</b></div>
                <div style="font-size:18px;font-weight:800;color:#f2f2f2;margin-top:7px;line-height:1.15;">${formatNumber(base)}</div>
                <div style="font-size:10px;color:#777;margin-top:2px;">BASE</div>
                <div style="font-size:15px;font-weight:800;color:${latest.stats[stat].mod >= 0 ? '#4caf50' : '#f44336'};margin-top:6px;line-height:1.15;">${formatNumber(eff)}</div>
                <div style="font-size:9px;color:#666;margin-top:1px;">EFFECTIVE</div>
                <div style="font-size:9px;color:${bonus > 0 ? '#8bc34a' : '#666'};margin-top:2px;">Gym bonus ${bonus >= 0 ? '+' : ''}${bonus.toFixed(1)}%</div>
                <div style="display:flex;justify-content:space-between;gap:6px;margin-top:7px;padding-top:6px;border-top:1px solid #2c2c2c;font-size:9px;color:#707070;"><span>${trainable ? 'TARGET' : 'REF'} ${pct(trainable ? target : m.plan.ratios[stat])}</span><span style="color:${active ? '#03a9f4' : '#777'};font-weight:700;">${status}</span></div>
            </div>`;
        });

        html += `</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px;">
                <div style="background:#171717;border:1px solid #292929;border-radius:9px;padding:11px 9px;text-align:center;min-width:0;"><div style="font-size:10px;letter-spacing:.6px;color:#777;font-weight:700;">TOTAL BASE</div><b style="display:block;margin-top:4px;font-size:19px;line-height:1.15;overflow-wrap:anywhere;">${formatNumber(m.total)}</b></div>
                <div style="background:#171717;border:1px solid #292929;border-radius:9px;padding:11px 9px;text-align:center;min-width:0;"><div style="font-size:10px;letter-spacing:.6px;color:#777;font-weight:700;">TOTAL EFFECTIVE</div><b style="display:block;margin-top:4px;font-size:19px;line-height:1.15;color:#03a9f4;overflow-wrap:anywhere;">${formatNumber(totalEff)}</b></div>
            </div>
            <div style="margin-top:11px;background:#14191c;border:1px solid #27333a;border-radius:10px;padding:13px;text-align:center;">
                <div style="font-size:9px;letter-spacing:1px;color:#777;">${escapeHtml(r.mode)}</div>
                <div style="font-size:20px;font-weight:900;color:#03a9f4;margin-top:4px;">↑ TRAIN ${LABELS[r.stat].toUpperCase()}</div>
                <div style="font-size:26px;font-weight:900;margin-top:5px;">+${formatNumber(r.gain)}</div>
                <div style="font-size:10px;color:#777;margin-top:1px;">Stop / reassess at ${formatNumber(r.target)}</div>
                <div style="font-size:11px;line-height:1.4;color:#aaa;margin-top:8px;">${escapeHtml(r.reason)}</div>
            </div>
            <div style="margin-top:10px;background:#171717;border:1px solid #292929;border-radius:9px;padding:11px;">
                <div style="font-size:10px;letter-spacing:.8px;color:#777;font-weight:700;">TRAINING DECISION</div>
                ${infoRow('Train at', r.bestGym ? `${r.bestGym.name} · ${(r.bestGym.modifiers[r.stat] || 0).toFixed(1)} ${LABELS[r.stat].slice(0,3).toUpperCase()}` : 'Unknown')}
                ${infoRow('Active gym', activeGym ? `${activeGym.name} · ${(activeGym.modifiers?.[r.stat] || 0).toFixed(1)}` : 'Not detected')}
                ${infoRow('Detected gym bonus', `${r.bonusPct >= 0 ? '+' : ''}${r.bonusPct.toFixed(1)}% effective`)}
                ${infoRow('Happiness', happyCurrent ? `${formatNumber(happyCurrent)}${happyMaximum ? ` / ${formatNumber(happyMaximum)}` : ''}` : 'Not detected')}
                ${r.bestGain100 != null ? infoRow('Est. gain / 100E', `~${formatEstimate(r.bestGain100)} ${LABELS[r.stat]}`) : ''}
                <div style="margin-top:7px;padding-top:7px;border-top:1px solid #292929;font-size:10px;color:#9b9b9b;line-height:1.45;">${escapeHtml(r.gymAdvice)}</div>
            </div>
            <div style="margin-top:10px;background:#171717;border:1px solid #292929;border-radius:9px;padding:11px;">
                <div style="font-size:10px;letter-spacing:.8px;color:#777;font-weight:700;">FUTURE GYM PATH</div>
                ${nextStandard ? infoRow('Next standard', `${nextStandard.name}${currentStageEnergy ? ` · full stage ~${formatNumber(currentStageEnergy)}E` : ''}`) : infoRow('Standard path', "George's reached / inferred")}
                ${r.future ? infoRow('Strategic opportunity', `${r.future.gym.name} · ${(r.future.gym.modifiers[r.stat] || 0).toFixed(1)} ${LABELS[r.stat].slice(0,3).toUpperCase()}`) : infoRow('Strategic opportunity', 'No stronger known compatible gym ahead')}
                ${r.futureAdvice ? `<div style="margin-top:7px;padding-top:7px;border-top:1px solid #292929;font-size:10px;color:#c5a765;line-height:1.45;">${escapeHtml(r.futureAdvice)}</div>` : ''}
                <div style="font-size:9px;color:#626262;margin-top:7px;line-height:1.4;">Progression energy is based on Torn Wiki full-stage estimates. Your exact remaining Gym EXP is not exposed by the current API, so actual remaining energy may be lower.</div>
            </div>`;

        if (m.checks.length) {
            html += `<div style="margin-top:10px;background:#171717;border:1px solid #292929;border-radius:9px;padding:11px;"><div style="font-size:10px;letter-spacing:.8px;color:#777;font-weight:700;">SPECIALIST ROADMAP</div>`;
            m.checks.forEach(check => {
                const status = specialistStatus(check);
                let detail = '';
                if (check.name === 'The Sports Science Lab') {
                    detail = check.drugKnown ? ` · Xanax + Ecstasy ${formatNumber(check.combinedDrugs)} / 150 max` : ' · drug count unavailable';
                } else if (check.ratio != null) {
                    detail = ` · ${check.ratio.toFixed(2)}× / 1.25×`;
                }
                const ownedMark = owned.has(check.name) ? ' · OWNED' : '';
                html += `<div style="display:flex;justify-content:space-between;gap:10px;padding:7px 0;border-bottom:1px solid #242424;font-size:10px;"><span style="color:#aaa;">${escapeHtml(check.name)}${escapeHtml(detail)}${escapeHtml(ownedMark)}</span><b style="color:${specialistStatusColor(status)};white-space:nowrap;">${status}</b></div>`;
            });
            html += `<div style="font-size:9px;color:#666;margin-top:7px;line-height:1.4;">The planner protects or prepares known specialist stat relationships when your selected philosophy values gym efficiency.</div></div>`;
        }

        html += `<details style="margin-top:10px;background:#151515;border:1px solid #292929;border-radius:9px;padding:10px;">
                <summary style="cursor:pointer;font-size:10px;font-weight:700;color:#888;letter-spacing:.7px;">BEST KNOWN GYM BY STAT</summary>
                <div style="margin-top:7px;">${STATS.map(stat => {
                    const g = bestPerStat[stat];
                    return infoRow(LABELS[stat], g ? `${g.name} · ${(g.modifiers[stat] || 0).toFixed(1)} · index ${effectiveGymIndex(stat, g).toFixed(2)}` : 'Unknown');
                }).join('')}</div>
            </details>
            <details style="margin-top:8px;background:#151515;border:1px solid #292929;border-radius:9px;padding:10px;">
                <summary style="cursor:pointer;font-size:10px;font-weight:700;color:#888;letter-spacing:.7px;">DETECTED TRAINING BONUSES</summary>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:8px;">${STATS.map(stat => `<div style="background:#1b1b1b;border:1px solid #262626;border-radius:6px;padding:7px;font-size:9px;color:#777;"><b style="display:block;color:#aaa;font-size:10px;">${LABELS[stat]}</b>${trainingBonusPct(stat) >= 0 ? '+' : ''}${trainingBonusPct(stat).toFixed(1)}%</div>`).join('')}</div>
                ${perkEntries.length ? `<div style="margin-top:8px;font-size:9px;color:#777;line-height:1.45;">${perkEntries.slice(0, 10).map(entry => `<div style="padding:3px 0;border-top:1px solid #222;"><b style="color:#888;">${escapeHtml(entry.category.toUpperCase())}</b> · ${escapeHtml(entry.text)}</div>`).join('')}${perkEntries.length > 10 ? `<div style="margin-top:4px;color:#555;">+${perkEntries.length - 10} more detected gym-gain perks</div>` : ''}</div>` : `<div style="margin-top:8px;font-size:9px;color:#666;">No percentage-based gym-gain perk strings were detected from the API.</div>`}
                <div style="font-size:9px;color:#555;margin-top:7px;line-height:1.4;">Gain estimates use the current Torn Wiki gym formula, base battle stat, current Happiness, gym multiplier and detected gym-gain perks. Treat the result as an estimate rather than an exact train result.</div>
            </details>
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:10px;font-size:9px;color:#555;"><span>Gym source: ${escapeHtml(gymCatalogSource)} / ${escapeHtml(WIKI_GYM_SOURCE)} · Stats: ${escapeHtml(latest.stats.source)}</span><button id="bs-refresh" style="${buttonCss()}">Refresh</button></div>
        </div>`;

        panel.innerHTML = html;
        document.getElementById('bs-close').onclick = closeOverlay;
        document.getElementById('bs-settings').onclick = renderSettings;
        document.getElementById('bs-refresh').onclick = () => fetchAll(true);
    }

    function infoRow(label, value) {
        return `<div style="display:flex;justify-content:space-between;gap:10px;margin-top:7px;font-size:10px;"><span style="color:#666;">${escapeHtml(label)}</span><span style="color:#aaa;text-align:right;">${escapeHtml(value)}</span></div>`;
    }

    function renderSettings() {
        const panel = document.getElementById('battle-overlay-panel');
        const styleOpts = STYLE_OPTIONS.map(([id, name]) => `<option value="${id}" ${settings.style === id ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('');
        const philosophyOpts = PHILOSOPHY_OPTIONS.map(([id, name]) => `<option value="${id}" ${settings.philosophy === id ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('');
        const leadOpts = STATS.map(s => `<option value="${s}" ${settings.lead === s ? 'selected' : ''}>${LABELS[s]}</option>`).join('');
        const gymOpts = [`<option value="" ${!settings.highestStandardGym ? 'selected' : ''}>Auto / inferred</option>`, ...STANDARD_GYMS.map(g => `<option value="${escapeAttr(g.name)}" ${settings.highestStandardGym === g.name ? 'selected' : ''}>${escapeHtml(g.name)}</option>`)].join('');
        const progressIndex = latest ? getProgressIndex(latest.activeGym) : 0;
        const inferredName = STANDARD_GYMS[progressIndex]?.name || 'Unknown';
        const ownedSpecialists = new Set(getOwnedSpecialists());
        const specialistOptions = SPECIALIST_GYMS.filter(g => g.name !== 'Fight Club');
        panel.innerHTML = `<div style="font-family:Arial,sans-serif;color:#fff;">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;"><div><div style="font-size:17px;font-weight:800;">Strategy Settings</div><div style="font-size:10px;color:#777;margin-top:2px;">Choose how you want the planner to think.</div></div><button id="bs-back" style="${buttonCss()}">←</button></div>
            <label style="${labelCss()}">Combat style<select id="bs-style" style="${selectCss()}">${styleOpts}</select></label>
            <label style="${labelCss()}">Training philosophy<select id="bs-philosophy" style="${selectCss()}">${philosophyOpts}</select></label>
            <div id="bs-lead-wrap"><label style="${labelCss()}">Lead stat<select id="bs-lead" style="${selectCss()}">${leadOpts}</select></label><div style="font-size:9px;color:#666;margin-top:4px;">Used by Baldr and as the preferred growth leader when a build reaches alignment.</div></div>
            <label style="${labelCss()}">Highest standard gym unlocked<select id="bs-progress" style="${selectCss()}">${gymOpts}</select></label>
            <div style="font-size:9px;color:#666;margin-top:4px;line-height:1.4;">Current inference: ${escapeHtml(inferredName)}. The API exposes your active gym, not your entire unlocked list, so this override improves future-gym planning.</div>
            <div style="margin-top:13px;padding-top:11px;border-top:1px solid #292929;">
                <div style="font-size:10px;color:#777;font-weight:700;letter-spacing:.7px;">SPECIALIST MEMBERSHIPS OWNED</div>
                <div style="font-size:9px;color:#666;margin:4px 0 7px;line-height:1.4;">The script remembers any specialist gym it sees active. Tick others you already own so they can be used in best-gym calculations.</div>
                ${specialistOptions.map((g, index) => `<label style="display:flex;align-items:center;gap:7px;padding:5px 0;font-size:10px;color:#aaa;"><input id="bs-owned-${index}" type="checkbox" ${ownedSpecialists.has(g.name) ? 'checked' : ''}>${escapeHtml(g.name)}</label>`).join('')}
            </div>
            <div id="bs-custom" style="margin-top:13px;padding-top:11px;border-top:1px solid #292929;">
                <div style="font-size:10px;color:#777;font-weight:700;letter-spacing:.7px;">CUSTOM BUILD</div>
                <div style="font-size:9px;color:#666;margin:4px 0 8px;">Ratios are normalized automatically. Untick a stat to make it passive.</div>
                ${STATS.map(s => `<div style="display:grid;grid-template-columns:1fr 74px 70px;gap:7px;align-items:center;margin-top:6px;font-size:11px;"><span>${LABELS[s]}</span><input id="bs-ratio-${s}" type="number" min="0" max="100" step="1" value="${Number(settings.customRatios[s]) || 0}" style="${inputCss()}"><label style="display:flex;align-items:center;gap:5px;color:#888;"><input id="bs-train-${s}" type="checkbox" ${settings.customTrainable[s] ? 'checked' : ''}>Train</label></div>`).join('')}
            </div>
            <div style="margin-top:14px;background:#171717;border:1px solid #292929;border-radius:8px;padding:10px;font-size:10px;color:#888;line-height:1.45;"><b style="color:#bbb;">Combat First</b> follows your desired fighting shape most closely.<br><b style="color:#bbb;">Hybrid</b> balances shape, gym multipliers and specialist safety.<br><b style="color:#bbb;">Gym Efficiency</b> gives more weight to specialist access and upcoming gym advantages.</div>
            <div style="display:flex;gap:8px;margin-top:13px;"><button id="bs-save" style="${buttonCss(true)};flex:1;">Save & Recalculate</button><button id="bs-api" style="${buttonCss()}">API Key</button></div>
        </div>`;
        const styleEl = document.getElementById('bs-style');
        const leadWrap = document.getElementById('bs-lead-wrap');
        const custom = document.getElementById('bs-custom');
        const syncVisibility = () => {
            leadWrap.style.display = ['baldr', 'custom', 'balanced'].includes(styleEl.value) ? 'block' : 'none';
            custom.style.display = styleEl.value === 'custom' ? 'block' : 'none';
        };
        styleEl.onchange = syncVisibility;
        syncVisibility();
        document.getElementById('bs-back').onclick = renderMain;
        document.getElementById('bs-api').onclick = changeApiKey;
        document.getElementById('bs-save').onclick = () => {
            const next = {
                ...settings,
                style: styleEl.value,
                philosophy: document.getElementById('bs-philosophy').value,
                lead: document.getElementById('bs-lead').value,
                highestStandardGym: document.getElementById('bs-progress').value,
                customRatios: {},
                customTrainable: {}
            };
            STATS.forEach(s => {
                next.customRatios[s] = clamp(Number(document.getElementById(`bs-ratio-${s}`).value) || 0, 0, 100);
                next.customTrainable[s] = document.getElementById(`bs-train-${s}`).checked;
            });
            if (!STATS.some(s => next.customTrainable[s])) {
                alert('Custom build needs at least one trainable stat.');
                return;
            }
            const owned = specialistOptions.filter((g, index) => document.getElementById(`bs-owned-${index}`).checked).map(g => g.name);
            if (latest?.activeGym?.name && SPECIALIST_RULES[latest.activeGym.name] && !owned.includes(latest.activeGym.name)) owned.push(latest.activeGym.name);
            setOwnedSpecialists(owned);
            saveSettings(next);
            renderMain();
        };
    }

    function changeApiKey() {
        if (!confirm('Remove the saved Torn API key and enter a new one?')) return;
        localStorage.removeItem(API_KEY_STORAGE);
        API_KEY = getApiKey();
        if (API_KEY) fetchAll(true);
    }

    function buttonCss(primary = false) {
        return `border:1px solid ${primary ? '#0277a8' : '#373737'};background:${primary ? '#032a3a' : '#181818'};color:${primary ? '#7bd4ff' : '#aaa'};min-height:30px;padding:5px 9px;border-radius:6px;cursor:pointer;font-size:11px;font-weight:700;box-sizing:border-box;`;
    }

    function selectCss() {
        return 'width:100%;margin-top:5px;background:#151515;color:#eee;border:1px solid #363636;border-radius:6px;padding:9px;font-size:13px;box-sizing:border-box;';
    }

    function inputCss() {
        return 'width:100%;background:#151515;color:#eee;border:1px solid #363636;border-radius:5px;padding:7px;font-size:12px;box-sizing:border-box;';
    }

    function labelCss() {
        return 'display:block;margin-top:12px;font-size:10px;color:#888;font-weight:700;letter-spacing:.3px;';
    }

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
    }

    function escapeAttr(value) {
        return escapeHtml(value).replace(/'/g, '&#39;');
    }

    function createUI() {
        if (!document.getElementById('battle-overlay-bg')) {
            const bg = document.createElement('div');
            bg.id = 'battle-overlay-bg';
            bg.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,.58);z-index:99998;';
            bg.onclick = closeOverlay;
            document.body.appendChild(bg);
        }
        if (!document.getElementById('battle-overlay-panel')) {
            const panel = document.createElement('div');
            panel.id = 'battle-overlay-panel';
            panel.style.cssText = 'display:none;position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:min(92%,430px);max-height:88vh;overflow-y:auto;box-sizing:border-box;background:#111;border:1px solid #292929;border-radius:12px;padding:16px;color:#fff;z-index:99999;box-shadow:0 14px 45px rgba(0,0,0,.62);';
            document.body.appendChild(panel);
        }
        if (!document.getElementById('battle-toggle')) {
            const btn = document.createElement('div');
            btn.id = 'battle-toggle';
            btn.textContent = 'S';
            btn.title = 'Battle Strategy';
            btn.style.cssText = 'position:fixed;bottom:400px;right:2px;width:28px;height:40px;background:#03a9f4;color:#fff;display:flex;align-items:center;justify-content:center;border-radius:6px;font:700 18px Arial,sans-serif;cursor:pointer;z-index:99999;box-shadow:0 0 10px rgba(0,0,0,.4);user-select:none;';
            btn.onclick = toggleOverlay;
            document.body.appendChild(btn);
        }
    }

    function toggleOverlay() {
        const bg = document.getElementById('battle-overlay-bg');
        const panel = document.getElementById('battle-overlay-panel');
        if (panel.style.display === 'block') return closeOverlay();
        bg.style.display = 'block';
        panel.style.display = 'block';
        if (latest?.stats) renderMain();
        else fetchAll();
    }

    function closeOverlay() {
        const bg = document.getElementById('battle-overlay-bg');
        const panel = document.getElementById('battle-overlay-panel');
        if (bg) bg.style.display = 'none';
        if (panel) panel.style.display = 'none';
    }

    function init() {
        createUI();
        fetchAll();
        setInterval(fetchAll, REFRESH_MS);
    }

    init();
})();
