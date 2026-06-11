// ==UserScript==
// @name         1 Doits FF Scouter
// @namespace    https://github.com/doitsburger/doits-scripts
// @version      2.0.1
// @description  Scouter tool for FF and BS Estimates on Torn. Attack button in status, extra row clean, destinations panel, sorting on your faction page, and last action sorting.
// @author       rDacted, Weav3r, GFOUR - modded by Doitsburger
// @match        https://www.torn.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=torn.com
// @updateURL    https://raw.githubusercontent.com/doitsburger/doits-scripts/main/ff-scouter/doitsburgers-ff-scouter.user.js
// @downloadURL  https://raw.githubusercontent.com/doitsburger/doits-scripts/main/ff-scouter/doitsburgers-ff-scouter.user.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// ==/UserScript==

/**

· FF Scouter - Overhauled Version 2.0.0
·
· Changelog from 1.5.4:
· · Complete structural refactor with modular function organization
· · Added robust error handling with try-catch guards on all API calls
· · Added fetch timeouts and retry logic for network resilience
· · Improved JSON parse safety with fallback defaults
· · Added window.FFSCOUTER debug hooks for development inspection
· · Enhanced observer lifecycle management to prevent memory leaks
· · Modernized ES6+ patterns (async/await, optional chaining, nullish coalescing)
· · Improved CSS with better theme compatibility and accessibility
· · Added defensive DOM guards against unexpected page mutations
· · Preserved all original behavior, API interactions, and user-facing features
· · Added comprehensive JSDoc comments for major functions
· · Improved sort stability and debounced re-sort operations
· · Better handling of TornPDA compatibility layer
· · Enhanced toast notification system with accessibility labels
· · Fixed potential race conditions in API call sequencing
· · Added non-invasive debug inspection via window.FFSCOUTER
·
· Configuration keys (stored via GM_setValue):
· limited_key      - FF Scouter API key from ffscouter.com
· torn_api_key     - Torn limited API key
· ff_show_extra_rows - Boolean toggle for extra info rows
· ff_scouter_sort_mode - Profile page sort mode
· ff_scouter_sort_mode_war - War page sort mode
  */

(function() {
    'use strict';

    // =========================================================================
    // SECTION: Version & Constants
    // =========================================================================
    const FF_VERSION = '2.0.0';
    const API_INTERVAL = 30000;          // ms between faction data refreshes
    const API_TIMEOUT = 15000;           // ms timeout for API requests
    const MAX_RETRIES = 2;               // max retries for failed API calls
    const CACHE_TTL = 60 * 60 * 1000;    // 1 hour cache TTL
    const STALE_CACHE_AGE = 7 * 24 * 60 * 60; // 7 days in seconds
    const BASE_URL = 'https://ffscouter.com';
    const BLUE_ARROW = 'https://raw.githubusercontent.com/rDacted2/fair_fight_scouter/main/images/blue-arrow.svg';
    const GREEN_ARROW = 'https://raw.githubusercontent.com/rDacted2/fair_fight_scouter/main/images/green-arrow.svg';
    const RED_ARROW = 'https://raw.githubusercontent.com/rDacted2/fair_fight_scouter/main/images/red-arrow.svg';

    // =========================================================================
    // SECTION: Color & Country Configuration
    // =========================================================================
    const FF_COLORS = {
        '0-2': '#87CEEB',
        '2-4': '#28c628',
        '4-5': '#AA7DCE',
        '5+': '#c62828'
    };

    const COUNTRY_LIST = [
        { name: 'Mexico',              city: 'Ciudad Juárez',   flag: '/images/v2/travel_agency/flags/fl_mexico.svg' },
        { name: 'Cayman Islands',      city: 'George Town',     flag: '/images/v2/travel_agency/flags/fl_cayman_islands.svg' },
        { name: 'Canada',              city: 'Toronto',         flag: '/images/v2/travel_agency/flags/fl_canada.svg' },
        { name: 'Hawaii',              city: 'Honolulu',        flag: '/images/v2/travel_agency/flags/fl_hawaii.svg' },
        { name: 'United Kingdom',      city: 'London',          flag: '/images/v2/travel_agency/flags/fl_uk.svg' },
        { name: 'Argentina',           city: 'Buenos Aires',    flag: '/images/v2/travel_agency/flags/fl_argentina.svg' },
        { name: 'Switzerland',         city: 'Zurich',          flag: '/images/v2/travel_agency/flags/fl_switzerland.svg' },
        { name: 'Japan',               city: 'Tokyo',           flag: '/images/v2/travel_agency/flags/fl_japan.svg' },
        { name: 'China',               city: 'Beijing',         flag: '/images/v2/travel_agency/flags/fl_china.svg' },
        { name: 'United Arab Emirates',city: 'Dubai',           flag: '/images/v2/travel_agency/flags/fl_uae.svg' },
        { name: 'South Africa',        city: 'Johannesburg',    flag: '/images/v2/travel_agency/flags/fl_south_africa.svg' }
    ];

    const COUNTRY_FLAG_MAP = {
        'United Kingdom': '🇬🇧', 'UK': '🇬🇧',
        'Switzerland': '🇨🇭',
        'Argentina': '🇦🇷',
        'Japan': '🇯🇵',
        'South Africa': '🇿🇦',
        'United Arab Emirates': '🇦🇪', 'UAE': '🇦🇪',
        'Canada': '🇨🇦',
        'Mexico': '🇲🇽',
        'Cayman Islands': '🇰🇾',
        'Hawaii': '🇺🇸',
        'China': '🇨🇳'
    };

    // Build a lookup that maps any short/alternate form to the full name
    const COUNTRY_NAME_MAP = {};
    COUNTRY_LIST.forEach(c => {
        const full = c.name;
        COUNTRY_NAME_MAP[full.toLowerCase()] = full;
        const shortForms = {
            'United Kingdom': ['uk', 'united kingdom', 'england', 'great britain'],
            'United Arab Emirates': ['uae', 'united arab emirates', 'emirates'],
            'Cayman Islands': ['cayman', 'cayman islands'],
            'South Africa': ['south africa', 'sa'],
            'Switzerland': ['switzerland', 'swiss'],
            'Argentina': ['argentina'],
            'Mexico': ['mexico'],
            'Canada': ['canada'],
            'Hawaii': ['hawaii'],
            'Japan': ['japan'],
            'China': ['china']
        };
        const aliases = shortForms[full] || [];
        aliases.forEach(alias => { COUNTRY_NAME_MAP[alias.toLowerCase()] = full; });
    });

    // =========================================================================
    // SECTION: SVG Templates
    // =========================================================================
    const tornSymbol = `
<svg class="torn-symbol" viewBox="0 0 24 24" aria-hidden="true">
  <circle cx="12" cy="12" r="11"
          fill="url(#metalGradient)"
          stroke="#000"
          stroke-width="1.2"/>
  <circle cx="12" cy="12" r="9"
          fill="none"
          stroke="rgba(0,0,0,0.45)"
          stroke-width="1.2"/>
  <ellipse cx="12" cy="8" rx="7" ry="3"
           fill="rgba(255,255,255,0.22)"/>
  <text x="12" y="15.5"
        text-anchor="middle"
        font-family="Arial"
        font-weight="900"
        font-size="13"
        fill="#000">T</text>
  <defs>
    <linearGradient id="metalGradient" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%"   stop-color="#f2f2f2"/>
      <stop offset="40%"  stop-color="#8c8c8c"/>
      <stop offset="70%"  stop-color="#3a3a3a"/>
      <stop offset="100%" stop-color="#bfbfbf"/>
    </linearGradient>
  </defs>
</svg>`;

    function createPlaneSvg(isReturning) {
        const returningClass = isReturning ? ' returning' : '';
        return `<svg class="plane-svg${returningClass}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 576 512" aria-hidden="true">
        <path d="M482.3 192c34.2 0 93.7 29 93.7 64c0 36-59.5 64-93.7 64l-116.6 0L265.2 495.9c-5.7 10-16.3 16.1-27.8 16.1l-56.2 0c-10.6 0-18.3-10.2-15.4-20.4l49-171.6L112 320 68.8 377.6c-3 4 0 6.4-12.8 6.4l-42 0c-7.8 0-14-6.3-14-14c0-1.3 .2-2.6 .5-3.9L32 256 .5 145.9c-.4-1.3-.5-2.6-.5-3.9c0-7.8 6.3-14 14-14l42 0c5 0 9.8 2.4 12.8 6.4L112 192l102.9 0-49-171.6C162.9 10.2 170.6 0 181.2 0l56.2 0c11.5 0 22.1 6.2 27.8 16.1L365.7 192l116.6 0z"/>
    </svg>`;
    }

    // =========================================================================
    // SECTION: State Variables
    // =========================================================================
    const memberCountdowns = {};
    let apiCallInProgressCount = 0;

    let currentSortMode = 'none';
    let warSortMode = 'none';

    // Load saved sort modes (with validation)
    (function loadSavedSortModes() {
        const validModes = ['bs-high-low', 'bs-low-high', 'hospital-priority', 'okay-priority', 'traveling', 'last-action'];
        try {
            const savedProfile = GM_getValue('ff_scouter_sort_mode', 'none');
            const savedWar = GM_getValue('ff_scouter_sort_mode_war', 'none');
            currentSortMode = validModes.includes(savedProfile) ? savedProfile : 'none';
            warSortMode = validModes.includes(savedWar) ? savedWar : 'none';
        } catch (e) {
            console.warn('[FF Scouter] Could not load sort modes:', e);
        }
    })();

    let showExtraRows = true;

    // Original order tracking for sort stability
    const profileOriginalOrderMap = new Map();
    const warOriginalOrderMaps = { your: new Map(), enemy: new Map() };
    let nextProfileOriginalOrder = 0;
    let nextWarOriginalOrder = { your: 0, enemy: 0 };

    // Sort application guards
    let isApplyingProfileSort = false;
    let isApplyingWarSort = false;
    let profileSortTimeout = null;
    let warSortTimeout = null;

    // Observer references for cleanup
    let profileSortObserver = null;
    let warYourSortObserver = null;
    let warEnemySortObserver = null;

    // Interval references for cleanup
    let profileStatusInterval = null;
    let profileTimerInterval = null;
    let mainFactionStatusInterval = null;
    let mainFactionTimerInterval = null;
    let warStatusInterval = null;
    let attackBoxObserver = null;

    // Info line & attack overlay state
    let infoLineObserver = null;
    let currentAttackTargetId = null;
    let lastAttackUrl = '';
    let attackPageWatchInterval = null;
    let currentMainPageKey = '';
    let lastKnownPageUrl = location.href;

    // Page lifecycle keys
    let currentProfilePageKey = '';
    let currentMainFactionPageKey = '';
    let currentWarPageKey = '';

    // API & storage adapter references
    let rD_xmlhttpRequest;
    let rD_setValue;
    let rD_getValue;
    let rD_deleteValue;
    let rD_registerMenuCommand;
    let key = null;      // FF Scouter limited API key
    let tornKey = null;  // Torn API key
    let info_line = null;
    let userFactionId = null;

    // =========================================================================
    // SECTION: CSS Injection
    // =========================================================================
    GM_addStyle(`
    .table-cell { overflow: hidden; }

    /* FF Scouter indicator on honor bars / member names */
    .ff-scouter-indicator {
        position: relative;
        display: block;
        padding: 0;
    }

    .ff-scouter-vertical-line-low-upper,
    .ff-scouter-vertical-line-low-lower,
    .ff-scouter-vertical-line-high-upper,
    .ff-scouter-vertical-line-high-lower {
        content: '';
        position: absolute;
        width: 2px;
        height: 30%;
        background-color: black;
        margin-left: -1px;
    }

    .ff-scouter-vertical-line-low-upper {
        top: 0;
        left: calc(var(--arrow-width) / 2 + 33 * (100% - var(--arrow-width)) / 100);
    }

    .ff-scouter-vertical-line-low-lower {
        bottom: 0;
        left: calc(var(--arrow-width) / 2 + 33 * (100% - var(--arrow-width)) / 100);
    }

    .ff-scouter-vertical-line-high-upper {
        top: 0;
        left: calc(var(--arrow-width) / 2 + 66 * (100% - var(--arrow-width)) / 100);
    }

    .ff-scouter-vertical-line-high-lower {
        bottom: 0;
        left: calc(var(--arrow-width) / 2 + 66 * (100% - var(--arrow-width)) / 100);
    }

    .ff-scouter-arrow {
        position: absolute;
        transform: translate(-50%, -50%);
        padding: 0;
        top: 0;
        left: calc(var(--arrow-width) / 2 + var(--band-percent) * (100% - var(--arrow-width)) / 100);
        width: var(--arrow-width);
        object-fit: cover;
        pointer-events: none;
    }

    .ff-scouter-bs-estimate {
        position: absolute;
        bottom: -5px;
        left: 50%;
        transform: translateX(-50%);
        font-size: 8px;
        font-weight: bold;
        line-height: 1;
        white-space: nowrap;
        padding: 1px 2px;
        border-radius: 2px;
        pointer-events: none;
        z-index: 10;
        text-shadow: 0px 0px 1px rgba(0, 0, 0, 0.3);
    }

    .last-action-row {
        font-size: 11px;
        color: inherit;
        font-style: normal;
        font-weight: normal;
        text-align: center;
        margin-left: 8px;
        margin-bottom: 2px;
        margin-top: -2px;
        display: block;
    }

    /* Travel status display */
    .travel-status {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 2px;
        min-width: 0;
        overflow: hidden;
    }

    .torn-symbol {
        width: 16px;
        height: 16px;
        fill: #FFD700 !important;
        vertical-align: middle;
        flex-shrink: 0;
    }

    .plane-svg {
        width: 14px;
        height: 14px;
        fill: #4CAF50 !important;
        vertical-align: middle;
        flex-shrink: 0;
    }

    .plane-svg.returning {
        fill: #FF5722 !important;
        transform: scaleX(-1);
    }

    .country-abbr {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        min-width: 0;
        flex: 0 1 auto;
        vertical-align: bottom;
    }

    /* Mini FF badge on hover profiles */
    .ff-scouter-mini-ff {
        font-size: 10px;
        font-weight: bold;
        margin: 2px 0;
        padding: 2px 4px;
        border-radius: 3px;
        display: inline-block;
    }

    /* Status column */
    .table-cell.status {
        min-width: 110px;
        max-width: 200px;
        resize: horizontal;
        overflow: auto;
        position: relative;
    }

    .hospital-abroad-icon {
        position: absolute;
        top: 0px;
        right: 0px;
        font-size: 9px;
        line-height: 1;
        pointer-events: none;
        z-index: 2;
    }

    /* Faction profile status */
    .faction-profile-status {
        display: flex !important;
        align-items: center;
        justify-content: space-between;
        width: 100%;
        flex-wrap: nowrap !important;
        gap: 4px;
        min-height: 20px;
    }

    .faction-status-okay { color: #28a745; }
    .faction-status-traveling { color: #40a2e8; }
    .faction-status-abroad { color: #ffc107; }
    .faction-status-hospital { color: #dc3545; }
    .faction-status-jail { color: #6f42c1; }

    .faction-status-countdown {
        font-weight: bold;
        font-size: 12px;
        background: rgba(0, 0, 0, 0.1);
        padding: 1px 2px;
        border-radius: 3px;
        margin-left: 2px;
        min-width: 60px;
        text-align: center;
    }

    .status-text-container {
        flex: 1;
        text-align: center;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .status-text { font-weight: bold; }

    .status-attack-btn {
        margin-right: 2px;
        flex-shrink: 0;
        text-decoration: none;
        font-size: 16px;
        font-weight: bold;
        color: inherit;
        opacity: 0.8;
        transition: opacity 0.2s;
    }

    .status-attack-btn:hover { opacity: 1; }

    /* Extra info row */
    .ff-scouter-extra-row {
        background-color: var(--extra-row-bg, #353535);
        border-bottom: 1px solid #000000;
        padding: 2px 0;
        font-size: 11px;
        color: #6c757d;
        display: none;
    }

    .table-row[data-ff-scouter-extra] + .ff-scouter-extra-row {
        display: block !important;
    }

    .ff-scouter-extra-content {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 0 5px;
    }

    .ff-scouter-last-action {
        font-size: 11px;
        font-style: italic;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .ff-scouter-ff-right {
        font-size: 11px;
        font-weight: bold;
        text-align: right;
        white-space: nowrap;
        margin-left: 10px;
    }

    /* Sort panel & button */
    .ff-scouter-sort-panel {
        position: fixed;
        bottom: 141px;
        right: 2px;
        z-index: 100000;
        background: rgba(40, 40, 40, 0.95);
        border: 1px solid #555;
        border-radius: 8px;
        padding: 8px;
        display: none;
        flex-direction: column;
        gap: 5px;
        min-width: 120px;
        box-shadow: 0 4px 15px rgba(0,0,0,0.4);
    }

    .ff-scouter-sort-panel.visible { display: flex; }

    .ff-scouter-sort-btn {
        background: #28a745;
        color: white;
        border: 2px solid #3b82f6;
        border-radius: 28px;
        width: 28px;
        height: 40px;
        font-size: 25px;
        font-weight: bold;
        cursor: pointer;
        box-shadow: 0 2px 10px rgba(0,0,0,0.3);
        display: none;
        align-items: center;
        justify-content: center;
        transition: all 0.3s ease;
        position: fixed;
        bottom: 133px;
        right: 2px;
        z-index: 10001;
        padding: 0;
        line-height: 1;
    }

    .ff-scouter-sort-btn:hover {
        transform: scale(1.1);
        box-shadow: 0 4px 15px rgba(0,0,0,0.4);
    }

    .ff-scouter-sort-btn.visible { display: flex; }

    .ff-scouter-sort-option {
        background: #444;
        color: white;
        border: none;
        border-radius: 4px;
        padding: 6px 10px;
        font-size: 12px;
        cursor: pointer;
        text-align: left;
        transition: background 0.2s ease;
    }

    .ff-scouter-sort-option:hover { background: #555; }

    .ff-scouter-sort-option.active {
        background: #28a745;
        font-weight: bold;
    }

    /* Hide extra rows toggle */
    body.ff-hide-extra .last-action-row,
    body.ff-hide-extra .ff-scouter-extra-row,
    body.ff-hide-extra .table-row[data-ff-scouter-extra] + .ff-scouter-extra-row {
        display: none !important;
    }

    /* Destinations panel */
    .destinations-panel {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: linear-gradient(180deg, #2d2d2d 0%, #1a1a1a 100%);
        border-radius: 8px;
        width: 450px;
        max-width: 95vw;
        max-height: 80vh;
        overflow-y: auto;
        box-shadow: 0 10px 40px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.1);
        color: #ddd;
        z-index: 1000000;
        padding: 0;
        font-family: Arial, Helvetica, sans-serif;
    }

    .destinations-header {
        background: linear-gradient(180deg, #3d3d3d 0%, #2a2a2a 100%);
        padding: 16px 20px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        border-bottom: 1px solid #444;
        position: sticky;
        top: 0;
        z-index: 10;
    }

    .destinations-header h2 {
        margin: 0 !important;
        color: #fff;
        font-size: 15px;
        font-weight: 600;
    }

    .destinations-close {
        background: rgba(255,255,255,0.1);
        border: none;
        color: #888;
        font-size: 18px;
        cursor: pointer;
        width: 28px;
        height: 28px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
    }

    .destinations-close:hover {
        background: rgba(255,100,100,0.2);
        color: #f66;
    }

    .destinations-toolbar {
        padding: 12px 16px;
        border-bottom: 1px solid #333;
        display: flex;
        justify-content: space-between;
        align-items: center;
        background: rgba(0,0,0,0.2);
    }

    .destinations-toggle {
        display: flex;
        gap: 8px;
        background: #2a2a2a;
        padding: 3px;
        border-radius: 20px;
        border: 1px solid #444;
    }

    .toggle-btn {
        padding: 6px 12px;
        border: none;
        border-radius: 16px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        background: transparent;
        color: #888;
        transition: all 0.2s;
    }

    .toggle-btn.active {
        background: #4a7c4a;
        color: white;
    }

    .refresh-btn {
        background: #3a3a3a;
        border: 1px solid #555;
        color: #ddd;
        padding: 6px 12px;
        border-radius: 16px;
        font-size: 12px;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 5px;
    }

    .refresh-btn:hover { background: #4a4a4a; }

    .refresh-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }

    .destinations-content { padding: 16px; }

    .destination-group {
        margin-bottom: 12px;
        border: 1px solid #333;
        border-radius: 6px;
        overflow: hidden;
    }

    .group-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 10px 12px;
        background: rgba(255,255,255,0.03);
        cursor: pointer;
        user-select: none;
    }

    .group-header:hover { background: rgba(255,255,255,0.08); }

    .group-header .group-name {
        font-weight: bold;
        color: #eee;
    }

    .group-header .group-count {
        background: #333;
        padding: 2px 8px;
        border-radius: 12px;
        font-size: 11px;
        color: #aaa;
    }

    .group-header .collapse-icon {
        font-size: 12px;
        color: #888;
        margin-left: 8px;
    }

    .group-members {
        padding: 4px 8px;
        background: rgba(0,0,0,0.2);
    }

    .destination-group.collapsed .group-members { display: none; }

    .member-item {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 4px 8px;
        margin: 2px 0;
        background: rgba(255,255,255,0.02);
        border-radius: 4px;
    }

    .member-name.enemy,
    .member-name.friendly,
    .member-name.neutral { color: #ddd; }

    .member-status {
        font-size: 11px;
        color: #888;
    }

    .loading, .error, .no-data {
        text-align: center;
        padding: 20px;
        color: #888;
    }

    .error { color: #f66; }

    .location-tag {
        font-size: 10px;
        background: #333;
        padding: 2px 6px;
        border-radius: 10px;
        color: #aaa;
    }

    /* Attack box */
    #ff-scouter-attack-box {
        position: relative;
        top: auto;
        left: auto;
        z-index: auto;
        background: transparent;
        border: none;
        border-radius: 0;
        padding: 0;
        margin-top: 4px;
        margin-bottom: 4px;
        box-shadow: none;
        backdrop-filter: none;
        -webkit-backdrop-filter: none;
        white-space: nowrap;
        pointer-events: none;
        display: flex;
        align-items: center;
        gap: 6px;
        width: fit-content;
        color: #ddd;
        font-size: 12px;
        line-height: 1.2;
        font-weight: 700;
    }

    #ff-scouter-attack-box[data-mounted-mode="fixed"] {
        position: fixed;
        top: 52px;
        left: 8px;
        background: transparent;
    }

    #ff-scouter-attack-box .ff-label {
        font-weight: 700;
        color: #ddd;
    }

    #ff-scouter-attack-box .ff-value {
        font-weight: 700;
        color: #fff;
    }

    #ff-scouter-attack-box .ff-pill {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 2px 8px;
        border-radius: 999px;
        font-weight: 700;
        line-height: 1;
        box-shadow: inset 0 0 0 1px rgba(255,255,255,0.08);
    }

    #ff-scouter-attack-box .ff-sep {
        opacity: 0.45;
        font-weight: 400;
    }
`);

    // =========================================================================
    // SECTION: Theme Detection & Adaptation
    // =========================================================================

    /**
 * Detect current page theme (dark/light) and update CSS custom property.
 * Reads computed body background color to determine brightness.
 */
    function updateThemeColors() {
        try {
            const bodyBg = window.getComputedStyle(document.body).backgroundColor;
            const rgb = bodyBg.match(/\d+/g);
            if (rgb && rgb.length >= 3) {
                const brightness = (parseInt(rgb[0]) * 299 + parseInt(rgb[1]) * 587 + parseInt(rgb[2]) * 114) / 1000;
                const isDark = brightness < 128;
                const newBg = isDark ? '#2A2A2A' : '#EEEEEE';
                document.documentElement.style.setProperty('--extra-row-bg', newBg);
            } else {
                document.documentElement.style.setProperty('--extra-row-bg', '#353535');
            }
        } catch (e) {
            // Fallback if body not yet available
            document.documentElement.style.setProperty('--extra-row-bg', '#353535');
        }
    }

    if (document.body) {
        updateThemeColors();
    } else {
        document.addEventListener('DOMContentLoaded', updateThemeColors, { once: true });
    }

    const themeObserver = new MutationObserver(() => {
        updateThemeColors();
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });

    // =========================================================================
    // SECTION: Singleton Guard
    // =========================================================================
    const singleton = document.getElementById('ff-scouter-run-once');
    if (singleton) {
        console.log('[FF Scouter] Already running, skipping duplicate initialization.');
        return;
    }
    console.log(`[FF Scouter] Version ${FF_VERSION} starting`);

    // =========================================================================
    // SECTION: API & Storage Adapter Initialization
    // =========================================================================

    /**
 * Initialize the API and storage adapters.
 * Detects TornPDA environment and uses appropriate fallbacks.
 */
    function initAdapters() {
        const apikey = '###PDA-APIKEY###';
        if (apikey[0] !== '#') {
            console.log('[FF Scouter] Adding modifications to support TornPDA');
            rD_xmlhttpRequest = function(details) {
                if (details.method.toLowerCase() === 'get') {
                    return PDA_httpGet(details.url)
                        .then(details.onload)
                        .catch(details.onerror || ((e) => console.error('[FF Scouter] PDA GET error:', e)));
                } else if (details.method.toLowerCase() === 'post') {
                    return PDA_httpPost(details.url, details.headers || {}, details.body || details.data || '')
                        .then(details.onload)
                        .catch(details.onerror || ((e) => console.error('[FF Scouter] PDA POST error:', e)));
                }
            };
            rD_setValue = function(name, value) {
                return localStorage.setItem(name, value);
            };
            rD_getValue = function(name, defaultValue) {
                return localStorage.getItem(name) ?? defaultValue;
            };
            rD_deleteValue = function(name) {
                return localStorage.removeItem(name);
            };
            rD_registerMenuCommand = function() {};
            rD_setValue('limited_key', apikey);
        } else {
            rD_xmlhttpRequest = GM_xmlhttpRequest;
            rD_setValue = GM_setValue;
            rD_getValue = GM_getValue;
            rD_deleteValue = GM_deleteValue;
            rD_registerMenuCommand = GM_registerMenuCommand;
        }

        key = rD_getValue('limited_key', null);
        tornKey = rD_getValue('torn_api_key', null);
        showExtraRows = rD_getValue('ff_show_extra_rows', true) === true;
    }

    initAdapters();

    // =========================================================================
    // SECTION: API Key Prompting
    // =========================================================================

    /**
 * Prompt user for FF Scouter limited API key if not set.
 * Runs after a short delay to allow page to render.
 */
    setTimeout(function() {
        if (!key) {
            const userKey = prompt(
                'FF Scouter: API Key Required\n\n' +
                'Please enter your limited API key from ffscouter.com\n' +
                'This key is required for the script to work.',
                ''
            );
            if (userKey && userKey.trim()) {
                rD_setValue('limited_key', userKey.trim());
                key = userKey.trim();
                alert('API key saved! The page will now reload.');
                window.location.reload();
            } else if (userKey === null) {
                alert('FF Scouter cannot work without an API key.\n' +
                      'You can add it later via Tampermonkey menu > \'Enter Limited API Key\'');
            }
        }
    }, 2000);

    // Prompt for Torn API key if FF Scouter key is set but Torn key is missing
    // Prompt for Torn API key if FF Scouter key is set but Torn key is missing
if (!tornKey && key) {
    const input = prompt(
        'FF Scouter: Torn API Key Required\n\n' +
        'Please enter your Torn Public API key (from torn.com).\n' +
        'This is needed for faction member data.',
        ''
    );
    if (input && input.trim()) {
        rD_setValue('torn_api_key', input.trim());
        tornKey = input.trim();
    }
}

    // =========================================================================
    // SECTION: Menu Commands
    // =========================================================================
    rD_registerMenuCommand('Enter Limited API Key', () => {
        const userInput = prompt('Enter Limited API Key', rD_getValue('limited_key', ''));
        if (userInput !== null) {
            rD_setValue('limited_key', userInput);
            key = userInput;
            window.location.reload();
        }
    });

    rD_registerMenuCommand('Enter Torn API Key', () => {
    const userInput = prompt('Enter your Torn Public API key (from torn.com)', rD_getValue('torn_api_key', ''));
    if (userInput !== null) {
        rD_setValue('torn_api_key', userInput.trim());
        tornKey = userInput.trim();
        window.location.reload();
    }
});

    // =========================================================================
    // SECTION: Utility Functions
    // =========================================================================

    /**
 * Safely parse JSON with fallback.
 * @param {string} str - JSON string to parse
 * @param {*} fallback - Fallback value on parse error
 * @returns {*} Parsed object or fallback
 */
    function safeJSONParse(str, fallback = null) {
        if (!str) return fallback;
        try {
            return JSON.parse(str);
        } catch (e) {
            return fallback;
        }
    }

    /**
 * Format milliseconds into HH:MM:SS display string.
 * @param {number} ms - Milliseconds
 * @returns {string} Formatted time string
 */
    function formatTime(ms) {
        const totalSeconds = Math.max(0, Math.floor(ms / 1000));
        const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
        const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
        const seconds = String(totalSeconds % 60).padStart(2, '0');
        return `${hours}:${minutes}:${seconds}`;
    }

    /**
 * Format large battle stat numbers into human-readable form.
 * @param {number} value - Raw battle stat value
 * @returns {string|null} Formatted string or null
 */
    function formatBattleStats(value) {
        if (!value && value !== 0) return null;
        if (value >= 1e9) return (value / 1e9).toFixed(2).replace(/\.00$/, '') + 'b';
        if (value >= 1e6) return (value / 1e6).toFixed(2).replace(/\.00$/, '') + 'm';
        if (value >= 1e3) return (value / 1e3).toFixed(2).replace(/\.00$/, '') + 'k';
        return value.toString();
    }

    /**
 * Format FF value for display in extra rows.
 * @param {number} ffValue - Fair Fight value
 * @returns {string} Formatted string
 */
    function formatFFForExtraRow(ffValue) {
        if (ffValue > 10) {
            return '<strong>HIGH</strong>';
        }
        return ffValue.toFixed(1);
    }

    /**
 * Get color hex for a given FF value range.
 * @param {number} value - FF value
 * @returns {string} Hex color code
 */
    function getFFColour(value) {
        if (value <= 2.5) return FF_COLORS['0-2'];
        if (value <= 3.8) return FF_COLORS['2-4'];
        if (value <= 4.5) return FF_COLORS['4-5'];
        return FF_COLORS['5+'];
    }

    /**
 * Determine contrasting text color (black or white) for a given background hex.
 * @param {string} hex - Background color in hex format (#RRGGBB)
 * @returns {string} 'black' or 'white'
 */
    function getContrastColor(hex) {
        if (!hex || hex.length < 7) return 'white';
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        const brightness = (r * 0.299 + g * 0.587 + b * 0.114);
        return (brightness > 126) ? 'black' : 'white';
    }

    /**
 * Convert FF value to a percentage position on the gauge (0-100).
 * @param {number} ff - Fair Fight value
 * @returns {number} Percentage position
 */
    function ffToPercent(ff) {
        const low_ff = 2;
        const high_ff = 4;
        const low_mid_percent = 33;
        const mid_high_percent = 66;
        ff = Math.min(ff, 8);
        if (ff < low_ff) {
            return (ff - 1) / (low_ff - 1) * low_mid_percent;
        } else if (ff < high_ff) {
            return (((ff - low_ff) / (high_ff - low_ff)) * (mid_high_percent - low_mid_percent)) + low_mid_percent;
        } else {
            return (((ff - high_ff) / (8 - high_ff)) * (100 - mid_high_percent)) + mid_high_percent;
        }
    }

    /**
 * Abbreviate country name to short code.
 * @param {string} name - Full country name
 * @returns {string} Abbreviated code
 */
    function abbreviateCountry(name) {
        if (!name) return '';
        let clean = name.replace(/\s+(airstrip|City|Islands?)/i, '').trim();
        const key = clean.toLowerCase();
        const map = {
            'united kingdom': 'UK', 'uk': 'UK', 'england': 'UK',
            'cayman islands': 'CAY', 'cayman': 'CAY',
            'mexico': 'MEX', 'argentina': 'ARG', 'canada': 'CAN',
            'hawaii': 'HI', 'switzerland': 'SWITZ',
            'south africa': 'SA', 'china': 'CHI', 'japan': 'JAP',
            'united arab emirates': 'UAE', 'uae': 'UAE', 'emirates': 'UAE'
        };
        return map[key] || clean.substring(0, 3).toUpperCase();
    }

    /**
 * Standardize a country name to its full form from COUNTRY_LIST.
 * @param {string} name - Raw country name
 * @returns {string} Standardized full country name
 */
    function standardizeCountryName(name) {
        if (!name) return '';
        const lower = name.trim().toLowerCase();
        return COUNTRY_NAME_MAP[lower] || name.trim();
    }

    /**
 * Copy text to the clipboard using a fallback method.
 * @param {string} text - Text to copy
 * @returns {Promise} Resolves when copied
 */
    function copyToClipboard(text) {
        // Modern async clipboard API
        if (navigator.clipboard && window.isSecureContext) {
            return navigator.clipboard.writeText(text);
        }
        // Fallback for older browsers
        return new Promise((resolve, reject) => {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            try {
                document.execCommand('copy');
                resolve();
            } catch (e) {
                reject(e);
            } finally {
                document.body.removeChild(textarea);
            }
        });
    }

    /**
 * Get flag URL for a full country name.
 * @param {string} countryFullName - Full country name
 * @returns {string|null} Flag URL or null
 */
    function getFlagUrl(countryFullName) {
        const entry = COUNTRY_LIST.find(c => c.name === countryFullName);
        return entry ? entry.flag : null;
    }

    // =========================================================================
    // SECTION: URL & Page Detection Helpers
    // =========================================================================

    /**
 * Check if current page is an attack page.
 * @returns {boolean}
 */
    function isAttackPage() {
        return /(?:loader|page)\.php\?sid=attack&user2ID=\d+/.test(window.location.href);
    }

    /**
 * Extract attack target ID from URL.
 * @returns {string|null}
 */
    function getAttackTargetIdFromUrl() {
        const match = window.location.href.match(/[?&]user2ID=(\d+)/);
        return match ? match[1] : null;
    }

    /**
 * Extract profile target ID from URL.
 * @returns {string|null}
 */
    function getProfileTargetIdFromUrl() {
        const match = window.location.href.match(/profiles\.php\?XID=(\d+)/);
        return match ? match[1] : null;
    }

    /**
 * Extract player ID from a DOM element (looks for profile links).
 * @param {Element} element - DOM element
 * @returns {string|null} Player ID or null
 */
    function getPlayerIdInElement(element) {
        if (!element) return null;
        // Check parent href
        const parentHref = element.parentElement?.href;
        if (parentHref) {
            const match = parentHref.match(/.*XID=(?<target_id>\d+)/);
            if (match) return match.groups.target_id;
        }
        // Check child anchors
        const anchors = element.getElementsByTagName('a');
        for (const anchor of anchors) {
            const m = anchor.href.match(/.*XID=(?<target_id>\d+)/);
            if (m) return m.groups.target_id;
        }
        // Check if element itself is an anchor
        if (element.nodeName.toLowerCase() === 'a') {
            const m = element.href.match(/.*XID=(?<target_id>\d+)/);
            if (m) return m.groups.target_id;
        }
        return null;
    }

    /**
 * Get player ID from a table row element.
 * @param {Element} row - Table row element
 * @returns {string|null} Player ID or null
 */
    function getPlayerIdFromRow(row) {
        if (!row) return null;
        const profileLink = row.querySelector('a[href*="profiles.php?XID="]');
        if (!profileLink) return null;
        const match = profileLink.href.match(/XID=(\d+)/);
        return match ? match[1] : null;
    }

    /**
 * Get faction ID from a DOM element's href.
 * @param {Element} el - DOM element
 * @returns {string|null} Faction ID or null
 */
    function getFactionIdFromElement(el) {
        if (!el) return null;
        const directHref = el.href || el.getAttribute?.('href') || '';
        let match = directHref.match(/ID=(\d+)/);
        if (match) return match[1];
        const link = el.querySelector?.('a[href*="factions.php"][href*="ID="]');
        if (link) {
            match = link.href.match(/ID=(\d+)/);
            if (match) return match[1];
        }
        return null;
    }

    /**
 * Get the user's own faction ID from page data (no API call).
 * @returns {number|null}
 */
    function getUserFactionIdFromPage() {
        try {
            const tornDataEl = document.getElementById('torn-data');
            if (!tornDataEl) return null;
            const data = JSON.parse(tornDataEl.textContent);
            return data?.user?.faction?.faction_id || null;
        } catch (e) {
            console.warn('[FF Scouter] Could not parse torn-data JSON', e);
            return null;
        }
    }

    // =========================================================================
    // SECTION: Cache Management
    // =========================================================================

    /**
 * Get cached FF response for a player ID.
 * @param {string} targetId - Player ID
 * @returns {Object|null} Cached response or null
 */
    function getFairFightResponse(targetId) {
        const cached = rD_getValue(String(targetId), null);
        const parsed = safeJSONParse(cached, null);
        if (parsed && parsed.expiry > Date.now()) {
            return parsed;
        }
        return null;
    }

    /**
 * Find which player IDs are not in cache or have expired cache.
 * @param {number[]} playerIds - Array of player IDs
 * @returns {number[]} IDs that need fetching
 */
    function getCacheMisses(playerIds) {
        const unknownIds = [];
        for (const pid of playerIds) {
            const cached = rD_getValue(String(pid), null);
            const parsed = safeJSONParse(cached, null);
            if (!parsed ||
                parsed.expiry < Date.now() ||
                (parsed.age && parsed.age > STALE_CACHE_AGE)) {
                unknownIds.push(pid);
            }
        }
        return unknownIds;
    }

    // =========================================================================
    // SECTION: FF Scouter API Interaction
    // =========================================================================

    /**
 * Update FF cache by fetching unknown player stats from ffscouter.com.
 * Includes retry logic and timeout handling.
 * @param {number[]} playerIds - Array of player IDs to check
 * @param {Function} callback - Called after cache update completes
 * @param {number} [retryCount=0] - Current retry attempt
 */
    function updateFFCache(playerIds, callback, retryCount = 0) {
        if (!key) return;

        const uniqueIds = [...new Set(playerIds)];
        const unknownIds = getCacheMisses(uniqueIds);

        if (unknownIds.length === 0) {
            callback(playerIds);
            return;
        }

        const playerIdList = unknownIds.join(',');
        const url = `${BASE_URL}/api/v1/get-stats?key=${encodeURIComponent(key)}&targets=${encodeURIComponent(playerIdList)}`;

        rD_xmlhttpRequest({
            method: 'GET',
            url: url,
            timeout: API_TIMEOUT,
            onload: function(response) {
                try {
                    if (response.status === 200) {
                        const ffResponse = JSON.parse(response.responseText);
                        if (ffResponse && ffResponse.error) {
                            showToast(ffResponse.error);
                            return;
                        }
                        const expiry = Date.now() + CACHE_TTL;
                        ffResponse.forEach(result => {
                            if (!result || !result.player_id) return;
                            if (result.fair_fight === null &&
                                result.bs_estimate === null &&
                                result.bs_estimate_human === null &&
                                result.last_updated === null) {
                                rD_setValue(String(result.player_id), JSON.stringify({
                                    no_data: true,
                                    expiry: expiry
                                }));
                            } else {
                                rD_setValue(String(result.player_id), JSON.stringify({
                                    value: result.fair_fight,
                                    last_updated: result.last_updated,
                                    expiry: expiry,
                                    bs_estimate: result.bs_estimate,
                                    bs_estimate_human: result.bs_estimate_human
                                }));
                            }
                        });
                        callback(playerIds);
                    } else {
                        let errMsg = 'API request failed.';
                        try {
                            const err = JSON.parse(response.responseText);
                            errMsg = err && err.error ? err.error : errMsg;
                        } catch (_) { /* use default */ }
                        showToast(errMsg);
                    }
                } catch (e) {
                    console.error('[FF Scouter] Error processing API response:', e);
                    // Retry on parse error if retries remain
                    if (retryCount < MAX_RETRIES) {
                        setTimeout(() => updateFFCache(playerIds, callback, retryCount + 1), 1000 * (retryCount + 1));
                    }
                }
            },
            onerror: function(e) {
                console.error('[FF Scouter] API request error:', e);
                if (retryCount < MAX_RETRIES) {
                    setTimeout(() => updateFFCache(playerIds, callback, retryCount + 1), 2000 * (retryCount + 1));
                }
            },
            onabort: function(e) {
                console.error('[FF Scouter] API request aborted:', e);
            },
            ontimeout: function(e) {
                console.error('[FF Scouter] API request timed out:', e);
                if (retryCount < MAX_RETRIES) {
                    setTimeout(() => updateFFCache(playerIds, callback, retryCount + 1), 2000 * (retryCount + 1));
                }
            }
        });
    }

    // =========================================================================
    // SECTION: Toast Notification
    // =========================================================================

    /**
 * Display a temporary toast notification at the bottom of the screen.
 * @param {string} message - Message to display
 */
    function showToast(message) {
        try {
            const existing = document.getElementById('ffscouter-toast');
            if (existing) existing.remove();

            const toast = document.createElement('div');
            toast.id = 'ffscouter-toast';
            toast.setAttribute('role', 'alert');
            toast.setAttribute('aria-live', 'polite');
            toast.style.cssText = 'position:fixed;bottom:30px;left:50%;transform:translateX(-50%);' +
                'background:#c62828;color:#fff;padding:8px 16px;border-radius:8px;font-size:14px;' +
                'box-shadow:0 2px 12px rgba(0,0,0,0.2);z-index:2147483647;opacity:1;' +
                'transition:opacity 0.5s;display:flex;align-items:center;gap:10px;';

            const closeBtn = document.createElement('span');
            closeBtn.textContent = '\u00D7';
            closeBtn.style.cssText = 'cursor:pointer;margin-left:8px;font-weight:bold;font-size:18px;';
            closeBtn.setAttribute('aria-label', 'Close');
            closeBtn.onclick = () => toast.remove();

            const msg = document.createElement('span');
            if (message === 'Invalid API key. Please sign up at ffscouter.com to use this service') {
                msg.innerHTML = 'FairFight Scouter: Invalid API key. Please sign up at <a href="https://ffscouter.com" target="_blank" style="color:#fff;text-decoration:underline;font-weight:bold;">ffscouter.com</a> to use this service';
            } else {
                msg.textContent = `FairFight Scouter: ${message}`;
            }

            toast.appendChild(msg);
            toast.appendChild(closeBtn);
            document.body.appendChild(toast);

            setTimeout(() => {
                if (toast.parentNode) {
                    toast.style.opacity = '0';
                    setTimeout(() => { if (toast.parentNode) toast.remove(); }, 500);
                }
            }, 4000);
        } catch (e) {
            console.error('[FF Scouter] Error showing toast:', e);
        }
    }

    // =========================================================================
    // SECTION: Info Line (Profile Page FF Display)
    // =========================================================================

    /**
 * Find the best mount target for the info line element.
 * @returns {Object|null} Target info with type and element
 */
    function getInfoMountTarget() {
        const attackingHeader = Array.from(document.querySelectorAll('h4'))
        .find(h => h.textContent && h.textContent.trim().toLowerCase() === 'attacking');

        if (attackingHeader && attackingHeader.parentNode && attackingHeader.parentNode.parentNode) {
            return { type: 'after-parent', el: attackingHeader.parentNode.parentNode };
        }

        const firstVisibleH4 = Array.from(document.querySelectorAll('h4'))
        .find(h => h.textContent && h.offsetParent !== null);

        if (firstVisibleH4) {
            const linksTopWrap = firstVisibleH4.parentNode?.querySelector('.links-top-wrap');
            if (linksTopWrap && linksTopWrap.parentNode) {
                return { type: 'after-node', el: linksTopWrap };
            }
            return { type: 'after-node', el: firstVisibleH4 };
        }

        return null;
    }

    /**
 * Ensure the info line element is created and mounted in the DOM.
 * @returns {Element|null} The info line element
 */
    function ensureInfoLineMounted() {
        if (!info_line) {
            info_line = document.createElement('div');
            info_line.id = 'ff-scouter-run-once';
            info_line.style.cssText = 'display:block;clear:both;margin:5px 0;';
            info_line.addEventListener('click', () => {
                if (key === null) {
                    const limitedKey = prompt('Enter Limited API Key', rD_getValue('limited_key', ''));
                    if (limitedKey) {
                        rD_setValue('limited_key', limitedKey);
                        key = limitedKey;
                        window.location.reload();
                    }
                }
            });
        }

        const target = getInfoMountTarget();
        if (!target) return info_line;

        try {
            if (target.type === 'after-parent') {
                if (info_line.parentNode !== target.el.parentNode || info_line.previousElementSibling !== target.el) {
                    target.el.insertAdjacentElement('afterend', info_line);
                }
            } else if (target.type === 'after-node') {
                if (info_line.parentNode !== target.el.parentNode || info_line.previousElementSibling !== target.el) {
                    target.el.insertAdjacentElement('afterend', info_line);
                }
            }
        } catch (e) {
            console.warn('[FF Scouter] Could not mount info line:', e);
        }

        return info_line;
    }

    /**
 * Set a plain text message in the info line.
 * @param {string} message - Text message
 * @param {boolean} [error=false] - Whether this is an error message
 */
    function setMessage(message, error = false) {
        ensureInfoLineMounted();
        if (!info_line) return;
        while (info_line.firstChild) {
            info_line.removeChild(info_line.firstChild);
        }
        const textNode = document.createTextNode(message);
        info_line.style.color = error ? 'red' : '';
        info_line.appendChild(textNode);
    }

    /**
 * Build detailed FF message HTML for info line display.
 * @param {Object} ffResponse - FF response object
 * @param {string} playerId - Player ID
 * @returns {string} HTML string
 */
    function getDetailedMessage(ffResponse, playerId) {
        if (ffResponse.no_data) {
            return `<span style="font-weight:bold;margin-right:6px;">FairFight:</span><span style="background:#444;color:#fff;font-weight:bold;padding:2px 2px;border-radius:4px;display:inline-block;">No data</span>`;
        }
        const ffString = `${ffResponse.value.toFixed(2)}`;
        const bgColor = getFFColour(ffResponse.value);
        const textColor = getContrastColor(bgColor);

        let statDetails = '';
        if (ffResponse.bs_estimate_human) {
            const bsColor = getFFColour(ffResponse.value);
            statDetails = `<span style="font-size:11px;font-weight:normal;margin-left:8px;vertical-align:middle;color:#cccccc;font-style:italic;">Est. TBS: <span style="font-weight:bold;color:${bsColor}">${ffResponse.bs_estimate_human}</span></span>`;
        }

        return `<span style="font-weight:bold;margin-right:6px;">FF:</span><span style="background:${bgColor};color:${textColor};font-weight:bold;padding:2px 2px;border-radius:4px;display:inline-block;">${ffString}</span>${statDetails}`;
    }

    /**
 * Display FF info in the info line.
 * @param {Object} ffResponse - FF response
 * @param {string} playerId - Player ID
 */
    function setFairFight(ffResponse, playerId) {
        ensureInfoLineMounted();
        if (!info_line) return;
        info_line.innerHTML = getDetailedMessage(ffResponse, playerId);
    }

    // =========================================================================
    // SECTION: Attack Box (Attack Page FF Display)
    // =========================================================================

    /**
 * Get the "Attacking" header element on attack pages.
 * @returns {Element|null}
 */
    function getAttackHeader() {
        const headings = Array.from(document.querySelectorAll('h4'));
        return headings.find(h => h.textContent && h.textContent.trim().toLowerCase() === 'attacking') || null;
    }

    /**
 * Mount the attack box element in the appropriate location.
 * @returns {Element} The attack box element
 */
    function mountAttackBox() {
        let box = document.getElementById('ff-scouter-attack-box');
        if (!box) {
            box = document.createElement('div');
            box.id = 'ff-scouter-attack-box';
        }

        const header = getAttackHeader();

        if (header) {
            if (box.parentNode === header.parentNode && box.previousElementSibling === header) {
                box.dataset.mountedMode = 'inline';
                return box;
            }
            header.insertAdjacentElement('afterend', box);
            box.dataset.mountedMode = 'inline';
        } else {
            if (box.parentNode !== document.body) {
                document.body.appendChild(box);
            }
            box.dataset.mountedMode = 'fixed';
        }

        return box;
    }

    /**
 * Get or create the attack box element.
 * @returns {Element}
 */
    function getOrCreateAttackBox() {
        return mountAttackBox();
    }

    /**
 * Render FF/BS info into the attack box.
 * @param {Object|null} ffResponse - FF response or null
 * @param {string} playerId - Player ID
 */
    function renderAttackBox(ffResponse, playerId) {
        const box = getOrCreateAttackBox();
        if (!box) return;

        if (!ffResponse) {
            box.innerHTML = `<span class="ff-label">FF</span><span class="ff-value">Loading...</span>`;
            return;
        }

        if (ffResponse.no_data) {
            box.innerHTML = `<span class="ff-label">FF</span><span class="ff-value">No data</span>`;
            return;
        }

        const ffString = `${ffResponse.value.toFixed(2)}`;
        let bsText = 'N/A';
        if (ffResponse.bs_estimate_human) {
            bsText = ffResponse.bs_estimate_human;
        } else if (ffResponse.bs_estimate) {
            bsText = formatBattleStats(ffResponse.bs_estimate);
        }

        const ffBg = getFFColour(ffResponse.value);
        const ffText = getContrastColor(ffBg);

        box.innerHTML = `
        <span class="ff-label">FF</span>
        <span class="ff-value">${ffString}</span>
        <span class="ff-sep">\u2022</span>
        <span class="ff-label">BS</span>
        <span class="ff-pill" style="background:${ffBg};color:${ffText};">${bsText}</span>
    `;
    }

    /**
 * Ensure attack box persists after page mutations.
 * @param {string} targetId - Attack target ID
 */
    function ensureAttackBoxPersistence(targetId) {
        if (!isAttackPage()) return;

        const box = mountAttackBox();
        const cached = getFairFightResponse(targetId);

        if (cached) {
            renderAttackBox(cached, targetId);
        } else if (!box.innerHTML) {
            box.innerHTML = `<span class="ff-label">FF</span><span class="ff-value">Loading...</span>`;
        }
    }

    /**
 * Bootstrap the attack overlay on attack pages.
 * @param {boolean} [forceRefresh=false] - Force refresh of data
 */
    function bootstrapAttackOverlay(forceRefresh = false) {
        if (!isAttackPage()) {
            currentAttackTargetId = null;
            return;
        }

        const targetId = getAttackTargetIdFromUrl();
        if (!targetId) return;

        const urlChanged = window.location.href !== lastAttackUrl;
        const targetChanged = targetId !== currentAttackTargetId;

        if (!forceRefresh && !urlChanged && !targetChanged) {
            const cached = getFairFightResponse(targetId);
            if (cached) {
                renderAttackBox(cached, targetId);
            } else {
                mountAttackBox();
            }
            return;
        }

        currentAttackTargetId = targetId;
        lastAttackUrl = window.location.href;

        mountAttackBox();
        ensureAttackBoxPersistence(targetId);

        const cached = getFairFightResponse(targetId);
        if (cached) {
            renderAttackBox(cached, targetId);
        } else {
            const box = getOrCreateAttackBox();
            if (box) {
                box.innerHTML = `<span class="ff-label">FF</span><span class="ff-value">Loading...</span>`;
            }
            updateFFCache([targetId], function() {
                const refreshed = getFairFightResponse(targetId);
                if (refreshed) {
                    renderAttackBox(refreshed, targetId);
                }
            });
        }
    }

    /**
 * Display fair fight data for a given target.
 * @param {string} targetId - Target player ID
 * @param {string} playerId - Player ID (for display context)
 */
    function displayFairFight(targetId, playerId) {
        const response = getFairFightResponse(targetId);
        if (!response) return;

        if (isAttackPage()) {
            renderAttackBox(response, playerId);
        } else {
            setFairFight(response, playerId);
        }
    }

    // =========================================================================
    // SECTION: Page Bootstrap (Profile / Main)
    // =========================================================================

    /**
 * Bootstrap FF display for the current page (profile or attack).
 * @param {boolean} [force=false] - Force refresh
 */
    function bootstrapCurrentPageFF(force = false) {
        if (isAttackPage()) {
            bootstrapAttackOverlay(force);
            return;
        }

        const profileTargetId = getProfileTargetIdFromUrl();
        if (!profileTargetId) {
            currentMainPageKey = '';
            return;
        }

        const keyForPage = `profile:${profileTargetId}`;
        if (!force && currentMainPageKey === keyForPage && info_line && document.body.contains(info_line)) {
            const cached = getFairFightResponse(profileTargetId);
            if (cached) setFairFight(cached, profileTargetId);
            return;
        }

        currentMainPageKey = keyForPage;
        ensureInfoLineMounted();

        const cached = getFairFightResponse(profileTargetId);
        if (cached) {
            setFairFight(cached, profileTargetId);
        } else {
            setMessage('Loading...');
            updateFFCache([profileTargetId], function() {
                const refreshed = getFairFightResponse(profileTargetId);
                if (refreshed) {
                    setFairFight(refreshed, profileTargetId);
                }
            });
        }
    }

    // =========================================================================
    // SECTION: Info Line & Attack Overlay Watchers
    // =========================================================================

    function startInfoLineWatcher() {
        if (infoLineObserver) infoLineObserver.disconnect();

        infoLineObserver = new MutationObserver(() => {
            if (getProfileTargetIdFromUrl() || isAttackPage()) {
                if (!info_line || !document.body.contains(info_line)) {
                    ensureInfoLineMounted();
                    bootstrapCurrentPageFF();
                }
            }
        });

        infoLineObserver.observe(document.body, { childList: true, subtree: true });
    }

    function startAttackOverlayWatcher() {
        if (attackPageWatchInterval) return;

        attackPageWatchInterval = setInterval(() => {
            if (isAttackPage()) {
                bootstrapAttackOverlay();
            } else {
                currentAttackTargetId = null;
                lastAttackUrl = '';
            }
        }, 500);
    }

    // =========================================================================
    // SECTION: Cleanup Helpers
    // =========================================================================

    function cleanupProfilePage() {
        if (profileSortObserver) { profileSortObserver.disconnect(); profileSortObserver = null; }
        if (profileStatusInterval) { clearInterval(profileStatusInterval); profileStatusInterval = null; }
        if (profileTimerInterval) { clearInterval(profileTimerInterval); profileTimerInterval = null; }
    }

    function cleanupMainFactionPage() {
        if (profileSortObserver) { profileSortObserver.disconnect(); profileSortObserver = null; }
        if (mainFactionStatusInterval) { clearInterval(mainFactionStatusInterval); mainFactionStatusInterval = null; }
        if (mainFactionTimerInterval) { clearInterval(mainFactionTimerInterval); mainFactionTimerInterval = null; }
    }

    function cleanupWarPage() {
        if (warYourSortObserver) { warYourSortObserver.disconnect(); warYourSortObserver = null; }
        if (warEnemySortObserver) { warEnemySortObserver.disconnect(); warEnemySortObserver = null; }
        if (warStatusInterval) { clearInterval(warStatusInterval); warStatusInterval = null; }
    }

    // =========================================================================
    // SECTION: Initial Page Bootstrap
    // =========================================================================

    ensureInfoLineMounted();
    bootstrapCurrentPageFF(true);
    startInfoLineWatcher();
    startAttackOverlayWatcher();

    // Pre-fetch user's own faction ID for later use
    if (tornKey) {
        fetchUserFactionId(tornKey).then(id => {
            if (id) userFactionId = id;
        }).catch(e => {
            console.warn('[FF Scouter] Could not pre-fetch user faction ID:', e);
        });
    }

    // =========================================================================
    // SECTION: Faction Members List Observer (Legacy)
    // =========================================================================

    if (window.location.href.startsWith('https://www.torn.com/factions.php')) {
        const tornObserver = new MutationObserver(function() {
            const membersList = document.querySelector('.members-list');
            if (membersList) {
                tornObserver.disconnect();
                const playerIds = [];
                document.querySelectorAll('.table-body > .table-row').forEach(function(row) {
                    if (!row.querySelector('.fallen') && !row.querySelector('.fedded')) {
                        const anchor = row.querySelector('a[href^="/profiles"]');
                        if (anchor) {
                            const matched = anchor.href.match(/.*XID=(?<player_id>\d+)/);
                            if (matched?.groups?.player_id) {
                                playerIds.push(parseInt(matched.groups.player_id, 10));
                            }
                        }
                    }
                });
                updateFFCache(playerIds, function() { /* apply_fair_fight_info - no-op */ });
            }
        });
        tornObserver.observe(document, { attributes: false, childList: true, characterData: false, subtree: true });
        if (!key) setMessage('Limited API key needed - click to add');
    }

    // =========================================================================
    // SECTION: FF Gauge System
    // =========================================================================

    /**
 * Show cached FF gauge values on elements.
 * @param {Array} elements - Array of [playerId, element] pairs
 */
    function showCachedValues(elements) {
        for (const [playerId, element] of elements) {
            if (!element || !document.body.contains(element)) continue;
            element.classList.add('ff-scouter-indicator');
            if (!element.classList.contains('indicator-lines')) {
                element.classList.add('indicator-lines');
                element.style.setProperty('--arrow-width', '10px');
                element.classList.remove('small', 'big');
            }
            const response = getFairFightResponse(playerId);
            if (response) {
                // Remove existing indicators
                element.querySelectorAll('.ff-scouter-arrow, .ff-scouter-bs-estimate').forEach(el => el.remove());

                const ff = response.value;
                if (ff) {
                    const percent = ffToPercent(ff);
                    element.style.setProperty('--band-percent', percent);
                    const arrow = percent < 33 ? BLUE_ARROW : (percent < 66 ? GREEN_ARROW : RED_ARROW);

                    const arrowImg = document.createElement('img');
                    arrowImg.src = arrow;
                    arrowImg.className = 'ff-scouter-arrow';
                    arrowImg.alt = '';
                    element.appendChild(arrowImg);

                    const bsValue = response.bs_estimate_human || (response.bs_estimate ? formatBattleStats(response.bs_estimate) : null);
                    if (bsValue) {
                        const bgColor = getFFColour(ff);
                        const textColor = getContrastColor(bgColor);
                        const bsDiv = document.createElement('div');
                        bsDiv.className = 'ff-scouter-bs-estimate';
                        bsDiv.textContent = bsValue;
                        bsDiv.style.color = textColor;
                        bsDiv.style.backgroundColor = bgColor;
                        element.appendChild(bsDiv);
                    }
                }
            }
        }
    }

    /**
 * Apply FF gauge indicators to a list of elements.
 * Fetches missing data from API as needed.
 * @param {Element[]} elements - DOM elements to enhance
 */
    async function applyFFGauge(elements) {
        if (!elements || !elements.length) return;
        elements = elements.filter(e => e && !e.classList.contains('ff-scouter-indicator'));
        const pairs = elements.map(e => [getPlayerIdInElement(e), e]).filter(p => p[0]);
        if (pairs.length > 0) {
            showCachedValues(pairs);
            const playerIds = pairs.map(p => p[0]);
            updateFFCache(playerIds, () => { showCachedValues(pairs); });
        }
    }

    /**
 * Apply FF info to mini profile hover cards.
 * @param {Element} mini - Mini profile element
 */
    async function applyToMiniProfile(mini) {
        if (!mini || mini.classList.contains('ff-processed')) return;
        mini.classList.add('ff-processed');

        const playerId = getPlayerIdInElement(mini);
        if (!playerId) return;

        const response = getFairFightResponse(playerId);
        if (!response || response.no_data) return;

        mini.querySelectorAll('.ff-scouter-mini-ff').forEach(el => el.remove());

        const ffValueFormatted = formatFFForExtraRow(response.value);
        const bgColor = getFFColour(response.value);
        const textColor = getContrastColor(bgColor);

        const ffElement = document.createElement('div');
        ffElement.className = 'ff-scouter-mini-ff';
        ffElement.style.cssText = `font-size:10px;font-weight:bold;background-color:${bgColor};color:${textColor};padding:2px 4px;border-radius:3px;display:inline-block;margin-top:2px;text-align:center;`;
        ffElement.innerHTML = `FF: ${ffValueFormatted}`;

        const description = mini.querySelector('.description');
        if (description) {
            description.appendChild(ffElement);
        } else {
            mini.appendChild(ffElement);
        }
    }

    // Main FF gauge observer - watches for elements across various pages
    const ffGaugeObserver = new MutationObserver(async function() {
        try {
            const honorBars = Array.from(document.querySelectorAll('.honor-text-wrap'));
            if (honorBars.length > 0) {
                await applyFFGauge(honorBars);
            } else {
                const href = window.location.href;
                if (href.startsWith('https://www.torn.com/factions.php')) await applyFFGauge(Array.from(document.querySelectorAll('.member')));
                else if (href.startsWith('https://www.torn.com/companies.php')) await applyFFGauge(Array.from(document.querySelectorAll('.employee')));
                else if (href.startsWith('https://www.torn.com/joblist.php')) await applyFFGauge(Array.from(document.querySelectorAll('.employee')));
                else if (href.startsWith('https://www.torn.com/messages.php')) await applyFFGauge(Array.from(document.querySelectorAll('.name')));
                else if (href.startsWith('https://www.torn.com/index.php')) await applyFFGauge(Array.from(document.querySelectorAll('.name')));
                else if (href.startsWith('https://www.torn.com/hospitalview.php')) await applyFFGauge(Array.from(document.querySelectorAll('.name')));
                else if (href.startsWith('https://www.torn.com/page.php?sid=UserList')) await applyFFGauge(Array.from(document.querySelectorAll('.name')));
                else if (href.startsWith('https://www.torn.com/bounties.php')) {
                    await applyFFGauge(Array.from(document.querySelectorAll('.target')));
                    await applyFFGauge(Array.from(document.querySelectorAll('.listed')));
                } else if (href.startsWith('https://www.torn.com/forums.php')) {
                    await applyFFGauge(Array.from(document.querySelectorAll('.last-poster')));
                    await applyFFGauge(Array.from(document.querySelectorAll('.starter')));
                    await applyFFGauge(Array.from(document.querySelectorAll('.last-post')));
                    await applyFFGauge(Array.from(document.querySelectorAll('.poster')));
                } else if (href.includes('page.php?sid=hof')) {
                    await applyFFGauge(Array.from(document.querySelectorAll('[class^="userInfoBox__"]')));
                }
            }

            // Mini profiles
            const miniProfiles = Array.from(document.querySelectorAll('[class^="profile-mini-_userProfileWrapper_"]'));
            if (miniProfiles.length > 0) {
                for (const mini of miniProfiles) {
                    if (!mini.classList.contains('ff-processed')) {
                        const playerId = getPlayerIdInElement(mini);
                        applyToMiniProfile(mini);
                        updateFFCache([playerId], () => { applyToMiniProfile(mini); });
                    }
                }
            }
        } catch (e) {
            console.error('[FF Scouter] Error in gauge observer:', e);
        }
    });

    ffGaugeObserver.observe(document, { attributes: false, childList: true, characterData: false, subtree: true });

    // =========================================================================
    // SECTION: Travel & Destination Utilities
    // =========================================================================

    /**
 * Extract travel information from a member status object.
 * @param {Object} member - Faction member object
 * @returns {Object|null} Travel info with eta, remaining, etaDate or null
 */
    function getTravelInfo(member) {
        if (!member || !member.status || member.status.state !== 'Traveling') return null;
        const now = Math.floor(Date.now() / 1000);
        const eta = parseInt(member.status.until, 10);
        if (isNaN(eta)) return null;
        const remaining = eta - now;
        return {
            eta,
            remaining,
            etaDate: new Date(eta * 1000)
        };
    }

    /**
 * Extract country information from a status description string.
 * @param {string} desc - Status description
 * @returns {Object|null} Parsed location info
 */
    function extractCountryFromDescription(desc) {
        if (!desc) return null;

        // New pattern: "Traveling from X to Y"
        let match = desc.match(/Traveling from ([A-Za-z\s]+) to ([A-Za-z\s]+)/i);
        if (match) {
            return {
                from: standardizeCountryName(match[1].trim()),
                to: standardizeCountryName(match[2].trim())
            };
        }

        // Legacy: "Traveling to X"
        match = desc.match(/Traveling to ([A-Za-z\s]+)/i);
        if (match) return { to: standardizeCountryName(match[1].trim()), from: 'Torn' };

        // Legacy: "Returning to Torn from X"
        match = desc.match(/Returning to Torn from ([A-Za-z\s]+)/i);
        if (match) return { from: standardizeCountryName(match[1].trim()), to: 'Torn' };

        // Abroad: "In X"
        match = desc.match(/In ([A-Za-z\s]+)/i);
        if (match) return { location: standardizeCountryName(match[1].trim()) };

        return null;
    }

    // =========================================================================
    // SECTION: Torn API Interaction
    // =========================================================================

    /**
 * Fetch faction member data from Torn API.
 * @param {string|number} factionID - Faction ID
 * @returns {Promise<Object>} Faction data
 */
    async function fetchFactionData(factionID) {
        if (!tornKey) throw new Error('No Torn API key');
        const url = `https://api.torn.com/v2/faction/${factionID}/members?striptags=true&key=${encodeURIComponent(tornKey)}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT);

        try {
            const response = await fetch(url, { signal: controller.signal });
            clearTimeout(timeoutId);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            if (data.error) throw new Error(data.error);
            return data;
        } catch (e) {
            clearTimeout(timeoutId);
            throw e;
        }
    }

    /**
 * Fetch user's own faction ID from Torn API.
 * @param {string} apiKey - Torn API key
 * @returns {Promise<number|null>} Faction ID or null
 */
    /**
 * Fetch user's own faction ID from Torn API.
 * @param {string} apiKey - Torn API key
 * @returns {Promise<number|null>} Faction ID or null
 */
    async function fetchUserFactionId(apiKey) {
        // Try from page first (instant, no API call)
        const pageId = getUserFactionIdFromPage();
        if (pageId) {
            userFactionId = pageId;
            return pageId;
        }

        if (!apiKey) return null;
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT);
            const response = await fetch(
                `https://api.torn.com/v2/user/?selections=profile&key=${encodeURIComponent(apiKey)}`,
                { signal: controller.signal }
            );
            clearTimeout(timeoutId);
            const data = await response.json();
            if (data.error) {
                console.warn('[FF Scouter] User API error:', data.error);
                return null;
            }
            // v2 returns { profile: { faction_id: ... } }
            const factionId = data.profile?.faction_id;
            if (factionId) {
                userFactionId = factionId;
            }
            return factionId || null;
        } catch (e) {
            console.warn('[FF Scouter] Error fetching user faction ID:', e);
            return null;
        }
    }

    /**
 * Fetch members of a faction by ID.
 * @param {string|number} factionId - Faction ID
 * @param {string} apiKey - Torn API key
 * @returns {Promise<Array>} Members array
 */
    async function fetchFactionMembers(factionId, apiKey) {
        if (!apiKey) throw new Error('No API key');
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT);
        try {
            const response = await fetch(`https://api.torn.com/v2/faction/${factionId}/members?striptags=true&key=${encodeURIComponent(apiKey)}`, { signal: controller.signal });
            clearTimeout(timeoutId);
            const data = await response.json();
            if (data.error) throw new Error(data.error);
            if (!Array.isArray(data.members)) throw new Error('No members data');
            return data.members;
        } catch (e) {
            clearTimeout(timeoutId);
            throw e;
        }
    }

    /**
 * Get the user's current location via Torn API.
 * @param {string} apiKey - Torn API key
 * @returns {Promise<string>} Location string
 */
    async function getUserLocation(apiKey) {
        if (!apiKey) return 'Torn';
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT);
            const response = await fetch(`https://api.torn.com/v2/user/?selections=basic&key=${encodeURIComponent(apiKey)}`, { signal: controller.signal });
            clearTimeout(timeoutId);
            const data = await response.json();
            const status = data.status;
            if (!status) return 'Torn';

            if (status.state === 'Traveling') {
                const parsed = extractCountryFromDescription(status.description);
                if (parsed && parsed.from && parsed.to) {
                    if (parsed.from === 'Torn' || parsed.from === 'Torn City') {
                        return standardizeCountryName(parsed.to);
                    } else if (parsed.to === 'Torn' || parsed.to === 'Torn City') {
                        return standardizeCountryName(parsed.from);
                    }
                }
                if (status.description.includes('Traveling to ')) {
                    const country = extractCountryFromDescription(status.description)?.to;
                    return country || 'Traveling';
                } else if (status.description.includes('Returning to Torn from ')) {
                    const country = extractCountryFromDescription(status.description)?.from;
                    return country || 'Traveling';
                }
                return 'Traveling';
            } else if (status.state === 'Abroad') {
                const parsed = extractCountryFromDescription(status.description);
                if (parsed && parsed.location) return standardizeCountryName(parsed.location);
                const match = status.description.match(/In ([A-Za-z\s]+)/i);
                return match ? standardizeCountryName(match[1].trim()) : 'Abroad';
            }
            return 'Torn';
        } catch (e) {
            console.error('[FF Scouter] Error fetching user location:', e);
            return 'Torn';
        }
    }

    /**
 * Get the opponent faction ID from the user's current ranked war.
 * @param {string} apiKey - Torn API key
 * @returns {Promise<string|null>} Opponent faction ID or null if not in war
 */
    /**
 * Get the opponent faction ID from the user's current active ranked war.
 * @param {string} apiKey - Torn API key
 * @returns {Promise<number|null>} Opponent faction ID or null if not in an active war
 */
    async function getWarOpponentFactionId(apiKey) {
        if (!apiKey) return null;

        // Ensure we have your own faction ID
        const yourFactionId = userFactionId || await fetchUserFactionId(apiKey);
        if (!yourFactionId) return null;

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT);
            const response = await fetch(
                `https://api.torn.com/v2/faction/${yourFactionId}?selections=rankedwars&key=${encodeURIComponent(apiKey)}`,
                { signal: controller.signal }
            );
            clearTimeout(timeoutId);
            const data = await response.json();
            if (data.error) {
                console.warn('[FF Scouter] Ranked wars API error:', data.error);
                return null;
            }

            const wars = data.rankedwars || [];
            // Find an active war (winner === null) that includes your faction
            const activeWar = wars.find(w =>
                                        w.winner === null &&
                                        w.factions &&
                                        w.factions.some(f => f.id === yourFactionId)
                                       );
            if (!activeWar) return null;

            // Find the opponent object and return its id
            const opponent = activeWar.factions.find(f => f.id !== yourFactionId);
            return opponent ? opponent.id : null;
        } catch (e) {
            console.error('[FF Scouter] Error fetching war opponent:', e);
            return null;
        }
    }

    /**
 * Get faction ID from the current page context.
 * @returns {string|null}
 */
    function getFactionIdFromContext() {
        const enemyLink = document.querySelector('.opponentFactionName___vhESM a');
        if (enemyLink) {
            const match = enemyLink.href.match(/ID=(\d+)/);
            if (match) return match[1];
        }
        const profileMatch = window.location.href.match(/factions\.php\?step=profile&ID=(\d+)/);
        if (profileMatch) return profileMatch[1];
        return userFactionId || null;
    }

    /**
 * Get war faction IDs from DOM.
 * @returns {Object} { enemyFactionId, yourFactionId }
 */
    function getWarFactionIds() {
        let enemyFactionId = null;
        let yourFactionId = null;

        const enemyFactionLink =
              document.querySelector('.opponentFactionName___vhESM') ||
              document.querySelector('.enemy-faction a[href*="factions.php"][href*="ID="]') ||
              document.querySelector('[class*="opponentFactionName"]');

        const yourFactionLink =
              document.querySelector('.currentFactionName___eq7n8') ||
              document.querySelector('.your-faction a[href*="factions.php"][href*="ID="]') ||
              document.querySelector('[class*="currentFactionName"]');

        enemyFactionId = getFactionIdFromElement(enemyFactionLink);
        yourFactionId = getFactionIdFromElement(yourFactionLink);

        return { enemyFactionId, yourFactionId };
    }

    /**
 * Group faction members by their destination/location.
 * @param {Array} members - Array of member objects
 * @returns {Object} Grouped members
 */
    function groupMembersByDestination(members) {
        const groups = {
            Torn: [],
            Traveling: {},
            Abroad: {},
            Returning: {}
        };

        members.forEach(member => {
            if (!member || !member.status) return;
            const status = member.status;
            const state = status.state;
            const desc = status.description || '';

            if (state === 'Okay' || state === 'Hospital' || state === 'Jail') {
                groups.Torn.push({
                    name: member.name,
                    status: state,
                    onlineStatus: member.last_action?.status || 'Offline'
                });
            } else if (state === 'Traveling') {
                const parsed = extractCountryFromDescription(desc);
                if (parsed && parsed.from && parsed.to) {
                    if (parsed.to === 'Torn' || parsed.to === 'Torn City') {
                        const dest = parsed.from;
                        if (!groups.Returning[dest]) groups.Returning[dest] = [];
                        const travelInfo = getTravelInfo(member);
                        groups.Returning[dest].push({
                            name: member.name,
                            status: 'Returning',
                            onlineStatus: member.last_action?.status || 'Offline',
                            remainingSeconds: travelInfo ? travelInfo.remaining : null
                        });
                    } else if (parsed.from === 'Torn' || parsed.from === 'Torn City') {
                        const dest = parsed.to;
                        if (!groups.Traveling[dest]) groups.Traveling[dest] = [];
                        const travelInfo = getTravelInfo(member);
                        groups.Traveling[dest].push({
                            name: member.name,
                            status: 'Traveling',
                            onlineStatus: member.last_action?.status || 'Offline',
                            remainingSeconds: travelInfo ? travelInfo.remaining : null
                        });
                    } else {
                        const dest = parsed.to;
                        if (!groups.Traveling[dest]) groups.Traveling[dest] = [];
                        const travelInfo = getTravelInfo(member);
                        groups.Traveling[dest].push({
                            name: member.name,
                            status: 'Traveling',
                            onlineStatus: member.last_action?.status || 'Offline',
                            remainingSeconds: travelInfo ? travelInfo.remaining : null
                        });
                    }
                } else if (desc.includes('Returning to Torn from ')) {
                    const dest = desc.replace('Returning to Torn from ', '').trim();
                    if (!groups.Returning[dest]) groups.Returning[dest] = [];
                    const travelInfo = getTravelInfo(member);
                    groups.Returning[dest].push({
                        name: member.name,
                        status: 'Returning',
                        onlineStatus: member.last_action?.status || 'Offline',
                        remainingSeconds: travelInfo ? travelInfo.remaining : null
                    });
                } else if (desc.includes('Traveling to ')) {
                    const dest = desc.replace('Traveling to ', '').trim();
                    if (!groups.Traveling[dest]) groups.Traveling[dest] = [];
                    const travelInfo = getTravelInfo(member);
                    groups.Traveling[dest].push({
                        name: member.name,
                        status: 'Traveling',
                        onlineStatus: member.last_action?.status || 'Offline',
                        remainingSeconds: travelInfo ? travelInfo.remaining : null
                    });
                }
            } else if (state === 'Abroad') {
                const parsed = extractCountryFromDescription(desc);
                let dest = 'Unknown';
                if (parsed && parsed.location) dest = parsed.location;
                else if (desc.match(/In ([A-Za-z\s]+)/i)) dest = desc.match(/In ([A-Za-z\s]+)/i)[1].trim();
                dest = standardizeCountryName(dest);
                if (!groups.Abroad[dest]) groups.Abroad[dest] = [];
                groups.Abroad[dest].push({
                    name: member.name,
                    status: 'Abroad',
                    onlineStatus: member.last_action?.status || 'Offline'
                });
            }
        });

        return groups;
    }

    // =========================================================================
    // SECTION: Destinations Panel
    // =========================================================================

    let currentDestinationsMode = 'safe';

    /**
 * Create a collapsible group element for the destinations panel.
 * @param {string} title - Group title
 * @param {Array} members - Member items
 * @param {string} nameClass - CSS class for member names
 * @returns {Element} Group DOM element
 */
    function createGroupElement(title, members, nameClass) {
        const group = document.createElement('div');
        group.className = 'destination-group';
        group.innerHTML = `
        <div class="group-header">
            <span class="group-name">${title}</span>
            <span class="group-count">${members.length}</span>
            <span class="collapse-icon">\u25BC</span>
        </div>
        <div class="group-members"></div>
    `;
        const membersDiv = group.querySelector('.group-members');
        members.forEach(m => {
            const item = document.createElement('div');
            item.className = 'member-item';
            const onlineCircle =
                  m.onlineStatus === 'Online' ? '\uD83D\uDFE2' :
            m.onlineStatus === 'Idle' ? '\uD83D\uDFE1' : '\u26AB';
            let etaText = '';
            if ((m.status === 'Traveling' || m.status === 'Returning') && m.remainingSeconds > 0) {
                etaText = ` \u00B7 ETA ${formatTime(m.remainingSeconds * 1000)}`;
            }
            item.innerHTML = `<span class="member-name ${nameClass}">${onlineCircle} ${m.name}</span> <span class="member-status">${m.status}${etaText}</span>`;
            membersDiv.appendChild(item);
        });
        group.querySelector('.group-header').addEventListener('click', (e) => {
            e.stopPropagation();
            group.classList.toggle('collapsed');
            const icon = group.querySelector('.collapse-icon');
            icon.textContent = group.classList.contains('collapsed') ? '\u25B6' : '\u25BC';
        });
        return group;
    }

    /**
 * Render the destinations panel content.
 * @param {Element} container - Content container
 * @param {Object} groups - Grouped member data
 * @param {string} mode - 'safe' or 'enemy'
 * @param {string} userLocation - User's current location
 * @param {boolean} isOwnFaction - Whether viewing own faction
 */
    function renderDestinationsPanel(container, groups, mode, userLocation, isOwnFaction) {
        container.innerHTML = '';
        const allCountries = COUNTRY_LIST.map(c => c.name);

        if (mode === 'safe') {
            const occupied = new Set();
            Object.keys(groups.Traveling).forEach(c => occupied.add(c));
            Object.keys(groups.Abroad).forEach(c => occupied.add(c));
            const safe = allCountries.filter(c => !occupied.has(c));
            if (!safe.length) {
                container.innerHTML = '<div class="no-data">No safe destinations found</div>';
                return;
            }
            safe.forEach(country => {
                const item = document.createElement('div');
                item.className = 'member-item';
                const flagUrl = getFlagUrl(country);
                const flagImg = flagUrl ? `<img src="${flagUrl}" style="width:16px;height:11px;margin-right:4px;vertical-align:middle;" alt="">` : '';
                const tag = (userLocation === country) ? '<span class="location-tag">You are here</span>' : '';
                item.innerHTML = `<span class="member-name">${flagImg}${country} ${tag}</span> <span class="member-status">\u2705 Safe</span>`;
                container.appendChild(item);
            });
        } else {
            const nameClass = 'neutral';
            if (groups.Torn.length) {
                container.appendChild(createGroupElement('\uD83C\uDFE0 Torn', groups.Torn, nameClass));
            }
            ['Traveling', 'Abroad', 'Returning'].forEach(cat => {
                Object.keys(groups[cat]).sort().forEach(dest => {
                    const members = groups[cat][dest];
                    const icon = cat === 'Traveling' ? '\u2708\uFE0F' : (cat === 'Abroad' ? '\uD83C\uDF0D' : '\uD83D\uDD19');
                    container.appendChild(createGroupElement(`${icon} ${dest}`, members, nameClass));
                });
            });
            if (!groups.Torn.length && !Object.keys(groups.Traveling).length &&
                !Object.keys(groups.Abroad).length && !Object.keys(groups.Returning).length) {
                container.innerHTML = '<div class="no-data">No location data available</div>';
            }
        }
    }

    /**
 * Build a location map from member data for danger zone detection.
 * @param {Array} members - Array of member objects
 * @returns {Object} Location map
 */
    function buildMemberLocationMap(members) {
        const map = {};

        members.forEach(member => {
            if (!member || !member.status) return;
            const status = member.status;
            let country = null;
            let type = null;

            if (status.state === 'Abroad') {
                const parsed = extractCountryFromDescription(status.description);
                country = parsed?.location || null;
                if (country) type = 'present';
            } else if (status.state === 'Traveling') {
                const parsed = extractCountryFromDescription(status.description);
                if (parsed && parsed.from && parsed.to) {
                    if (parsed.from === 'Torn' || parsed.from === 'Torn City') {
                        country = parsed.to;
                        type = 'traveling';
                    } else if (parsed.to === 'Torn' || parsed.to === 'Torn City') {
                        country = null;
                    } else {
                        country = parsed.to;
                        type = 'traveling';
                    }
                } else {
                    if (status.description.includes('Traveling to ')) {
                        country = status.description.replace('Traveling to ', '').trim();
                        type = 'traveling';
                    }
                }
            }

            if (country && type) {
                country = standardizeCountryName(country);
                if (!map[country]) map[country] = { present: [], traveling: [] };

                const ffResponse = getFairFightResponse(member.id);
                const bsValue = ffResponse?.bs_estimate || 0;
                const bsHuman = ffResponse?.bs_estimate_human || (ffResponse?.bs_estimate ? formatBattleStats(ffResponse.bs_estimate) : 'N/A');

                let remainingSeconds = null;
                if (type === 'traveling') {
                    const travelInfo = getTravelInfo(member);
                    if (travelInfo) remainingSeconds = travelInfo.remaining;
                }

                map[country][type].push({
                    name: member.name,
                    id: member.id,
                    bs: bsValue,
                    bsHuman: bsHuman,
                    status: member.last_action?.status || 'Offline',
                    remainingSeconds
                });
            }
        });

        return map;
    }

    /**
 * Load and render the danger zones tab.
 * @param {Element} content - Content container
 * @param {string} apiKey - Torn API key
 */
    async function loadDangerZones(content, apiKey) {
        // Always get your own faction ID from the API (ignore page DOM)
        let yourFactionId = userFactionId;
        if (!yourFactionId) {
            yourFactionId = await fetchUserFactionId(apiKey);
        }
        // Get the current war opponent from the rankedwars endpoint
        const enemyFactionId = await getWarOpponentFactionId(apiKey);

        // Debug – check the IDs (open the browser console to see these)
        console.log('[Danger Tab] Your faction ID:', yourFactionId);
        console.log('[Danger Tab] Enemy faction ID:', enemyFactionId);

        if (!yourFactionId) {
            content.innerHTML = '<div class="error">Could not determine your faction. Check API key.</div>';
            return;
        }
        if (!enemyFactionId) {
            content.innerHTML = '<div class="error">No ranked war opponent detected.</div>';
            return;
        }

        // Fetch both faction members from the Torn API
        let ownMembers, enemyMembers;
        try {
            [ownMembers, enemyMembers] = await Promise.all([
                fetchFactionMembers(yourFactionId, apiKey),
                fetchFactionMembers(enemyFactionId, apiKey)
            ]);
        } catch (err) {
            content.innerHTML = `<div class="error">Failed to fetch members: ${err.message}</div>`;
            return;
        }

        if (!ownMembers || !enemyMembers) {
            content.innerHTML = '<div class="error">No member data received.</div>';
            return;
        }

        // Debug – how many members did we actually get?
        console.log('[Danger Tab] Own members count:', ownMembers.length);
        console.log('[Danger Tab] Enemy members count:', enemyMembers.length);

        // Fetch FF stats for all enemy members
        const allEnemyIds = enemyMembers.map(m => m.id).filter(Boolean);
        const uniqueEnemyIds = [...new Set(allEnemyIds)];
        if (uniqueEnemyIds.length > 0) {
            content.innerHTML = '<div class="loading">Fetching enemy stats...</div>';
            await new Promise((resolve) => {
                updateFFCache(uniqueEnemyIds, () => resolve());
            });
        }

        // Build location maps for both factions
        const ownMap = buildMemberLocationMap(ownMembers);
        const enemyMap = buildMemberLocationMap(enemyMembers);

        // Find overlapping countries
        const dangerZones = {};
        for (const [country, own] of Object.entries(ownMap)) {
            if (!enemyMap[country]) continue;
            const enemy = enemyMap[country];
            const hasOwn = own.present.length + own.traveling.length > 0;
            const hasEnemy = enemy.present.length + enemy.traveling.length > 0;
            if (hasOwn && hasEnemy) {
                dangerZones[country] = {
                    country,
                    friendlyPresent: own.present,
                    friendlyTraveling: own.traveling,
                    enemyPresent: enemy.present,
                    enemyTraveling: enemy.traveling
                };
            }
        }

        const sortedKeys = Object.keys(dangerZones).sort((a, b) => a.localeCompare(b));
        if (!sortedKeys.length) {
            content.innerHTML = '<div class="no-data">No danger zones detected.</div>';
            return;
        }

        // Render the danger zones (this part is unchanged from the original)
        content.innerHTML = '';
        sortedKeys.forEach(country => {
            const zone = dangerZones[country];
            const flagUrl = getFlagUrl(country);
            const flagHtml = flagUrl
            ? `<img src="${flagUrl}" style="width:18px;height:12px;vertical-align:middle;margin-right:4px;" alt="">`
            : (COUNTRY_FLAG_MAP?.[country] || '\uD83C\uDF0D');

        const group = document.createElement('div');
        group.className = 'destination-group';
        group.innerHTML = `
            <div class="group-header">
                <span class="group-name">AT RISK ${flagHtml} ${country}</span>
                <span class="collapse-icon">\u25BC</span>
            </div>
            <div class="group-members"></div>
        `;
        const membersDiv = group.querySelector('.group-members');

        // Friendly members
        const friendly = [...zone.friendlyPresent.map(m => ({...m, type:'present'})),
                          ...zone.friendlyTraveling.map(m => ({...m, type:'traveling'}))];
        friendly.sort((a, b) => (b.bs || 0) - (a.bs || 0));
        friendly.forEach(m => {
            const icon = m.type === 'present' ? '\uD83D\uDCCD' : '\u2192';
            const item = document.createElement('div');
            item.className = 'member-item';
            const onlineCircle = m.status === 'Online' ? '\uD83D\uDFE2' : (m.status === 'Idle' ? '\uD83D\uDFE1' : '\u26AB');
            let etaText = '';
            if (m.type === 'traveling' && m.remainingSeconds > 0) {
                etaText = ` - ETA: ${formatTime(m.remainingSeconds * 1000)}`;
            }
            item.innerHTML = `${icon} ${onlineCircle} ${m.name} (\u2248 ${m.bsHuman || 'N/A'})${etaText}`;
            membersDiv.appendChild(item);
        });

        // Enemy present
        if (zone.enemyPresent.length) {
            const present = [...zone.enemyPresent].sort((a, b) => (b.bs || 0) - (a.bs || 0));
            const header = document.createElement('div');
            header.className = 'member-item';
            header.style.fontWeight = 'bold';
            header.textContent = `\u2694\uFE0F Present (${present.length})`;
            membersDiv.appendChild(header);
            present.forEach(m => {
                const item = document.createElement('div');
                item.className = 'member-item';
                const onlineCircle = m.status === 'Online' ? '\uD83D\uDD34' : (m.status === 'Idle' ? '\uD83D\uDFE1' : '\u26AB');
                item.innerHTML = `${onlineCircle} ${m.name} (\u2248 ${m.bsHuman || 'N/A'})`;
                membersDiv.appendChild(item);
            });
        }

        // Enemy inbound
        if (zone.enemyTraveling.length) {
            const inbound = [...zone.enemyTraveling].sort((a, b) => (b.bs || 0) - (a.bs || 0));
            const header = document.createElement('div');
            header.className = 'member-item';
            header.style.fontWeight = 'bold';
            header.textContent = `\u2708\uFE0F Inbound (${inbound.length})`;
            membersDiv.appendChild(header);
            inbound.forEach(m => {
                const item = document.createElement('div');
                item.className = 'member-item';
                const onlineCircle = m.status === 'Online' ? '\uD83D\uDD34' : (m.status === 'Idle' ? '\uD83D\uDFE1' : '\u26AB');
                let etaText = '';
                if (m.remainingSeconds > 0) {
                    etaText = ` - ETA: ${formatTime(m.remainingSeconds * 1000)}`;
                }
                item.innerHTML = `${onlineCircle} ${m.name} (\u2248 ${m.bsHuman || 'N/A'})${etaText}`;
                membersDiv.appendChild(item);
            });
        }

        group.querySelector('.group-header').addEventListener('click', (e) => {
            e.stopPropagation();
            group.classList.toggle('collapsed');
            const icon = group.querySelector('.collapse-icon');
            icon.textContent = group.classList.contains('collapsed') ? '\u25B6' : '\u25BC';
        });

        content.appendChild(group);
    });
    }

    /**
* Build a formatted text string from the destinations panel content.
* @param {string} mode - Current panel mode ('safe' or 'danger')
* @returns {string} Formatted text for clipboard
*/
    function buildCopyText(mode) {
        const content = document.querySelector('.destinations-content');
        if (!content) return '';

        switch (mode) {
            case 'safe': {
                // Unoccupied tab – list of safe countries with flag emojis
                const items = content.querySelectorAll('.member-item .member-name');
                if (!items.length) return 'No safe destinations';

                const lines = ['**Safe Destinations**'];
                items.forEach(el => {
                    // The text contains the country name, possibly with a "You are here" tag
                    const rawText = el.textContent.trim();
                    // Extract the country name (first part before any tag)
                    const countryName = rawText.replace(/\s*You are here\s*$/i, '').trim();
                    // Look up flag emoji from the existing COUNTRY_FLAG_MAP
                    const flag = COUNTRY_FLAG_MAP[countryName] || '';
                    lines.push(`${flag} ${countryName} ✅ Safe`);
                });
                return lines.join('\n');
            }
            case 'danger': {
                // Danger tab – per-country risk summary
                const groups = content.querySelectorAll('.destination-group');
                const lines = [];
                groups.forEach(group => {
                    const header = group.querySelector('.group-name');
                    if (!header) return;
                    const countryName = header.textContent.replace(/^AT RISK\s*/, '').trim();
                    lines.push(`\n${countryName}:`);

                    const memberItems = group.querySelectorAll('.group-members .member-item');
                    const friendlyLines = [];
                    const enemyPresentLines = [];
                    const enemyInboundLines = [];
                    let section = 'friendly'; // friendly / enemyPresent / enemyInbound

                    memberItems.forEach(item => {
                        const text = item.textContent.trim();
                        if (text.startsWith('⚔️ Present')) {
                            section = 'enemyPresent';
                            return; // header line skipped
                        } else if (text.startsWith('✈️ Inbound')) {
                            section = 'enemyInbound';
                            return;
                        }
                        // Skip empty or header-like lines
                        if (!text || text.startsWith('AT RISK')) return;

                        if (section === 'friendly') {
                            friendlyLines.push(text);
                        } else if (section === 'enemyPresent') {
                            enemyPresentLines.push(text);
                        } else if (section === 'enemyInbound') {
                            enemyInboundLines.push(text);
                        }
                    });

                    if (friendlyLines.length) {
                        lines.push('  Friendly:');
                        friendlyLines.forEach(line => lines.push(`    ${line}`));
                    }
                    if (enemyPresentLines.length) {
                        lines.push('  ⚔️ Enemy Present:');
                        enemyPresentLines.forEach(line => lines.push(`    ${line}`));
                    }
                    if (enemyInboundLines.length) {
                        lines.push('  ✈️ Enemy Inbound:');
                        enemyInboundLines.forEach(line => lines.push(`    ${line}`));
                    }
                });
                return lines.length > 0 ? `Danger Zones:${lines.join('\n')}` : 'No danger zones';
            }
            default:
                return '';
        }
    }

    /**
 * Load destinations data into the panel.
 * @param {Element} content - Content container
 * @param {string} apiKey - Torn API key
 */
    async function loadDestinations(content, apiKey) {
        content.innerHTML = '<div class="loading">Loading...</div>';

        if (currentDestinationsMode === 'danger') {
            await loadDangerZones(content, apiKey);
            return;
        }

        if (currentDestinationsMode === 'safe') {
            // Unoccupied = countries with no enemy members
            try {
                const enemyId = await getWarOpponentFactionId(apiKey);
                if (!enemyId) {
                    content.innerHTML = '<div class="error">No ranked war opponent detected.</div>';
                    return;
                }
                const [userLocation, members] = await Promise.all([
                    getUserLocation(apiKey),
                    fetchFactionMembers(enemyId, apiKey)
                ]);

                const groups = groupMembersByDestination(members);
                renderDestinationsPanel(content, groups, 'safe', userLocation, false);
            } catch (err) {
                content.innerHTML = `<div class="error">${err.message}</div>`;
            }
            return;
        }

        // Locations tab
        let factionId = getFactionIdFromContext();
        if (!factionId) {
            content.innerHTML = '<div class="error">No faction detected.</div>';
            return;
        }

        try {
            const [userLocation, members] = await Promise.all([
                getUserLocation(apiKey),
                fetchFactionMembers(factionId, apiKey)
            ]);

            const groups = groupMembersByDestination(members);
            const isOwnFaction = (userFactionId && userFactionId == factionId);
            renderDestinationsPanel(content, groups, 'enemy', userLocation, isOwnFaction);
        } catch (err) {
            content.innerHTML = `<div class="error">${err.message}</div>`;
        }
    }

    /**
 * Show the destinations panel overlay.
 */
    async function showDestinationsPanel() {
        const existing = document.querySelector('.destinations-panel');
        if (existing) {
            existing.remove();
            return;
        }

        if (!tornKey) {
            const input = prompt(
                'FF Scouter: Torn API Key Required\n\n' +
                'Please enter your Torn API key (limited, from torn.com).\n' +
                'This is needed for travel data (ETA, destinations, etc.).',
                ''
            );
            if (input && input.trim()) {
                rD_setValue('torn_api_key', input.trim());
                tornKey = input.trim();
            } else {
                alert('A Torn API key is required for the Destinations panel.');
                return;
            }
        }

        const apiKey = tornKey;
        if (!apiKey) {
            alert('API key required.');
            return;
        }

        const panel = document.createElement('div');
        panel.className = 'destinations-panel';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', 'Destinations Panel');
        panel.innerHTML = `
        <div class="destinations-header">
            <h2>\uD83C\uDF0D Destinations</h2>
            <button class="destinations-close" aria-label="Close">\u2715</button>
        </div>
        <div class="destinations-toolbar">
            <div class="destinations-toggle">
                <button class="toggle-btn active" data-mode="safe">Unoccupied</button>
                <button class="toggle-btn" data-mode="enemy">Locations</button>
                <button class="toggle-btn" data-mode="danger">\u26A0\uFE0F Danger</button>
            </div>
            <button class="refresh-btn" id="copy-destinations">📋 Copy</button>
        </div>
        <div class="destinations-content">
            <div class="loading">Loading...</div>
        </div>
    `;

        document.body.appendChild(panel);

        panel.querySelector('.destinations-close').addEventListener('click', () => panel.remove());
        panel.addEventListener('click', (e) => e.stopPropagation());
        setTimeout(() => {
            document.addEventListener('click', function outsideClick(e) {
                if (!panel.contains(e.target)) {
                    panel.remove();
                    document.removeEventListener('click', outsideClick);
                }
            });
        }, 0);

        const content = panel.querySelector('.destinations-content');
        const toggleBtns = panel.querySelectorAll('.toggle-btn');
        const copyBtn = panel.querySelector('#copy-destinations');
        copyBtn.addEventListener('click', () => {
            const textToCopy = buildCopyText(currentDestinationsMode);
            if (textToCopy) {
                copyToClipboard(textToCopy)
                    .then(() => {
                    const originalText = copyBtn.innerHTML;
                    copyBtn.innerHTML = '✅ Copied!';
                    setTimeout(() => { copyBtn.innerHTML = originalText; }, 1500);
                })
                    .catch(err => {
                    console.error('Copy failed', err);
                    showToast('Copy failed – see console');
                });
            } else {
                showToast('Nothing to copy for this tab');
            }
        });

        const setMode = async (mode) => {
            toggleBtns.forEach(b => b.classList.remove('active'));
            panel.querySelector(`[data-mode="${mode}"]`).classList.add('active');
            currentDestinationsMode = mode;
            panel.querySelector('.destinations-header h2').innerHTML =
                mode === 'danger' ? '\uD83D\uDEA8 Danger Zones' :
            mode === 'enemy' ? '\uD83D\uDCCD Locations' :
            '\uD83C\uDF0D Destinations';
            try {
                await loadDestinations(content, apiKey);
            } catch (e) {
                console.error('[FF Scouter] Error loading destinations tab:', e);
                content.innerHTML = '<div class="error">Error loading. Check console.</div>';
            }
        };

        toggleBtns.forEach(btn => {
            btn.addEventListener('click', () => setMode(btn.dataset.mode));
        });

        await setMode('safe');
    }

    // =========================================================================
    // SECTION: Sort Panel
    // =========================================================================

    /**
 * Create the sort button and panel UI.
 */
    function createSortPanel() {
        if (document.getElementById('ff-scouter-sort-btn')) return;

        const sortBtn = document.createElement('button');
        sortBtn.id = 'ff-scouter-sort-btn';
        sortBtn.className = 'ff-scouter-sort-btn';
        sortBtn.textContent = '\u21C5';
        sortBtn.title = 'Click to show sort options';
        sortBtn.setAttribute('aria-label', 'Sort options');
        sortBtn.addEventListener('dblclick', forceSortNow);

        const sortPanel = document.createElement('div');
        sortPanel.id = 'ff-scouter-sort-panel';
        sortPanel.className = 'ff-scouter-sort-panel';
        sortPanel.setAttribute('role', 'menu');

        const options = [
            { id: 'bs-high-low', text: 'BS: High to Low' },
            { id: 'bs-low-high', text: 'BS: Low to High' },
            { id: 'hospital-priority', text: 'Hospital Priority' },
            { id: 'okay-priority', text: 'Okay Priority' },
            { id: 'traveling', text: 'Travel/Abroad' },
            { id: 'last-action', text: 'Last Action (recent first)' }
        ];

        options.forEach(option => {
            const optionBtn = document.createElement('button');
            optionBtn.className = 'ff-scouter-sort-option';
            optionBtn.dataset.sort = option.id;
            optionBtn.textContent = option.text;
            optionBtn.setAttribute('role', 'menuitem');
            optionBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                handleSortSelection(this.dataset.sort);
                sortPanel.classList.remove('visible');
                sortBtn.classList.add('visible');
            });
            sortPanel.appendChild(optionBtn);
        });

        // Reset Default button
        const resetBtn = document.createElement('button');
        resetBtn.className = 'ff-scouter-sort-option';
        resetBtn.textContent = 'Reset Default';
        resetBtn.setAttribute('role', 'menuitem');
        resetBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            handleResetSort();
            sortPanel.classList.remove('visible');
            sortBtn.classList.add('visible');
        });
        sortPanel.appendChild(resetBtn);

        const separator = document.createElement('hr');
        separator.style.cssText = 'width:100%;margin:5px 0;border:none;border-top:1px solid #555;';
        sortPanel.appendChild(separator);

        const toggleBtn = document.createElement('button');
        toggleBtn.id = 'ff-toggle-extra-btn';
        toggleBtn.className = 'ff-scouter-sort-option';
        toggleBtn.textContent = showExtraRows ? 'Hide Extra Rows' : 'Show Extra Rows';
        toggleBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            setExtraRowsVisibility(!showExtraRows);
        });
        sortPanel.appendChild(toggleBtn);

        const destBtn = document.createElement('button');
        destBtn.id = 'ff-destinations-btn';
        destBtn.className = 'ff-scouter-sort-option';
        destBtn.textContent = '\uD83C\uDF0D Destinations';
        destBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            showDestinationsPanel();
        });
        sortPanel.appendChild(destBtn);

        sortBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            sortPanel.classList.toggle('visible');
            sortBtn.classList.toggle('visible');
        });

        document.addEventListener('click', function(e) {
            if (!sortPanel.contains(e.target) && !sortBtn.contains(e.target)) {
                sortPanel.classList.remove('visible');
                sortBtn.classList.add('visible');
            }
        });

        document.body.appendChild(sortBtn);
        document.body.appendChild(sortPanel);
        sortBtn.classList.add('visible');

        highlightActiveSortOption();
    }

    /**
 * Handle sort option selection.
 * @param {string} sortType - Sort mode identifier
 */
    function handleSortSelection(sortType) {
        const isWarPage = document.querySelector('.your-faction .members-list') !== null &&
              document.querySelector('.enemy-faction .members-list') !== null;

        if (isWarPage) {
            warSortMode = sortType;
            GM_setValue('ff_scouter_sort_mode_war', warSortMode);
            applyWarSort(sortType);
        } else {
            currentSortMode = sortType;
            GM_setValue('ff_scouter_sort_mode', currentSortMode);
            fixExtraRowsAfterFilter();
            applyProfileSort(sortType);
        }
        highlightActiveSortOption();
    }

    /**
 * Reset sorting to original Torn order (no sorting).
 */
    function handleResetSort() {
        const isWarPage = document.querySelector('.your-faction .members-list') !== null &&
              document.querySelector('.enemy-faction .members-list') !== null;

        if (isWarPage) {
            warSortMode = 'none';
            GM_setValue('ff_scouter_sort_mode_war', 'none');
            resetWarSort();
        } else {
            currentSortMode = 'none';
            GM_setValue('ff_scouter_sort_mode', 'none');
            resetProfileSort();
        }
        highlightActiveSortOption();
    }

    /**
 * Highlight the active sort option in the panel.
 */
    function highlightActiveSortOption() {
        const sortPanel = document.getElementById('ff-scouter-sort-panel');
        if (!sortPanel) return;

        sortPanel.querySelectorAll('.ff-scouter-sort-option').forEach(btn => btn.classList.remove('active'));

        const isWarPage = document.querySelector('.your-faction .members-list') !== null &&
              document.querySelector('.enemy-faction .members-list') !== null;
        const activeMode = isWarPage ? warSortMode : currentSortMode;
        if (activeMode === 'none') return;

        const activeBtn = sortPanel.querySelector(`[data-sort="${activeMode}"]`);
        if (activeBtn) activeBtn.classList.add('active');
    }

    /**
 * Toggle extra rows visibility.
 * @param {boolean} show - Whether to show extra rows
 */
    function setExtraRowsVisibility(show) {
        showExtraRows = show;
        GM_setValue('ff_show_extra_rows', show);
        if (show) {
            document.body.classList.remove('ff-hide-extra');
        } else {
            document.body.classList.add('ff-hide-extra');
        }
        const btn = document.getElementById('ff-toggle-extra-btn');
        if (btn) btn.textContent = show ? 'Hide Extra Rows' : 'Show Extra Rows';
    }

    // =========================================================================
    // SECTION: Sort Logic - Profile & War
    // =========================================================================

    /**
 * Seed the profile original order map from current DOM.
 */
    function seedProfileOriginalOrderMap() {
        const tableBody = document.querySelector('.table-body');
        if (!tableBody) return;
        const rows = Array.from(tableBody.querySelectorAll('.table-row'));
        rows.forEach(row => {
            const playerId = getPlayerIdFromRow(row);
            if (!playerId) return;
            if (!profileOriginalOrderMap.has(playerId)) {
                profileOriginalOrderMap.set(playerId, nextProfileOriginalOrder++);
            }
        });
    }

    /**
 * Seed war original order map from a list element.
 * @param {Element} listElement - The members list element
 * @param {string} side - 'your' or 'enemy'
 */
    function seedWarOriginalOrderMap(listElement, side) {
        if (!listElement || !warOriginalOrderMaps[side]) return;
        Array.from(listElement.children).forEach(li => {
            const playerId = getPlayerIdFromRow(li);
            if (!playerId) return;
            if (!warOriginalOrderMaps[side].has(playerId)) {
                warOriginalOrderMaps[side].set(playerId, nextWarOriginalOrder[side]++);
            }
        });
    }

    /**
 * Get original index for a profile player.
 * @param {string} playerId
 * @returns {number}
 */
    function getProfileOriginalIndex(playerId) {
        if (!profileOriginalOrderMap.has(playerId)) {
            profileOriginalOrderMap.set(playerId, nextProfileOriginalOrder++);
        }
        return profileOriginalOrderMap.get(playerId);
    }

    /**
 * Get original index for a war player.
 * @param {string} side - 'your' or 'enemy'
 * @param {string} playerId
 * @returns {number}
 */
    function getWarOriginalIndex(side, playerId) {
        if (!warOriginalOrderMaps[side].has(playerId)) {
            warOriginalOrderMaps[side].set(playerId, nextWarOriginalOrder[side]++);
        }
        return warOriginalOrderMaps[side].get(playerId);
    }

    /**
 * Get status string from a profile main row element.
 * @param {Element} row
 * @returns {string}
 */
    function getStatusFromProfileMainRow(row) {
        const statusEl = row.querySelector('.status');
        if (!statusEl) return 'Unknown';
        const statusDiv = statusEl.querySelector('.faction-profile-status');
        if (!statusDiv) return 'Unknown';
        if (statusDiv.classList.contains('faction-status-okay')) return 'Okay';
        if (statusDiv.classList.contains('faction-status-hospital')) return 'Hospital';
        if (statusDiv.classList.contains('faction-status-traveling')) return 'Traveling';
        if (statusDiv.classList.contains('faction-status-abroad')) return 'Abroad';
        if (statusDiv.classList.contains('faction-status-jail')) return 'Jail';
        return 'Unknown';
    }

    /**
 * Get status string from a war row element.
 * @param {Element} row
 * @returns {string}
 */
    function getStatusFromWarRow(row) {
        const statusEl = row.querySelector('.status');
        if (!statusEl) return 'Unknown';
        if (statusEl.classList.contains('faction-status-okay')) return 'Okay';
        if (statusEl.classList.contains('faction-status-hospital')) return 'Hospital';
        if (statusEl.classList.contains('faction-status-traveling')) return 'Traveling';
        if (statusEl.classList.contains('faction-status-abroad')) return 'Abroad';
        if (statusEl.classList.contains('faction-status-jail')) return 'Jail';
        return 'Unknown';
    }

    /**
 * Compare two profile items for sorting.
 * @param {string} mode - Sort mode
 * @param {Object} a - Item A
 * @param {Object} b - Item B
 * @returns {number} Comparison result
 */
    function compareProfileItems(mode, a, b) {
        const statusPriorityHospital = { 'Hospital': 1, 'Okay': 2, 'Abroad': 3, 'Traveling': 4 };
        const statusPriorityOkay = { 'Okay': 1, 'Hospital': 2, 'Abroad': 3, 'Traveling': 4 };

        if (mode === 'bs-high-low') {
            if (a.bsValue !== b.bsValue) return b.bsValue - a.bsValue;
            return a.originalIndex - b.originalIndex;
        }

        if (mode === 'bs-low-high') {
            if (a.bsValue !== b.bsValue) return a.bsValue - b.bsValue;
            return a.originalIndex - b.originalIndex;
        }

        if (mode === 'hospital-priority') {
            const aPrio = statusPriorityHospital[a.status] || 99;
            const bPrio = statusPriorityHospital[b.status] || 99;
            if (aPrio !== bPrio) return aPrio - bPrio;
            if (a.status === 'Hospital' && b.status === 'Hospital') {
                if (a.hospitalTimer !== b.hospitalTimer) return a.hospitalTimer - b.hospitalTimer;
                return a.originalIndex - b.originalIndex;
            }
            if (a.status === 'Okay' && b.status === 'Okay') {
                if (a.bsValue !== b.bsValue) return b.bsValue - a.bsValue;
                return a.originalIndex - b.originalIndex;
            }
            if (a.bsValue !== b.bsValue) return b.bsValue - a.bsValue;
            return a.originalIndex - b.originalIndex;
        }

        if (mode === 'okay-priority') {
            const aPrio = statusPriorityOkay[a.status] || 99;
            const bPrio = statusPriorityOkay[b.status] || 99;
            if (aPrio !== bPrio) return aPrio - bPrio;
            if (a.status === 'Okay' && b.status === 'Okay') {
                if (a.bsValue !== b.bsValue) return b.bsValue - a.bsValue;
                return a.originalIndex - b.originalIndex;
            }
            if (a.status === 'Hospital' && b.status === 'Hospital') {
                if (a.hospitalTimer !== b.hospitalTimer) return a.hospitalTimer - b.hospitalTimer;
                return a.originalIndex - b.originalIndex;
            }
            if (a.bsValue !== b.bsValue) return b.bsValue - a.bsValue;
            return a.originalIndex - b.originalIndex;
        }

        if (mode === 'traveling') {
            const aHasDest = !!a.destination;
            const bHasDest = !!b.destination;
            if (aHasDest !== bHasDest) return aHasDest ? -1 : 1;
            if (aHasDest) {
                const cmp = a.destination.localeCompare(b.destination);
                if (cmp !== 0) return cmp;
                if (a.bsValue !== b.bsValue) return b.bsValue - a.bsValue;
                return a.originalIndex - b.originalIndex;
            }
            if (a.bsValue !== b.bsValue) return b.bsValue - a.bsValue;
            return a.originalIndex - b.originalIndex;
        }

        if (mode === 'last-action') {
            if (a.lastAction !== b.lastAction) return b.lastAction - a.lastAction;
            if (a.bsValue !== b.bsValue) return b.bsValue - a.bsValue;
            return a.originalIndex - b.originalIndex;
        }

        return a.originalIndex - b.originalIndex;
    }

    /**
 * Compare two war items (delegates to profile comparison).
 */
    function compareWarItems(mode, a, b) {
        return compareProfileItems(mode, a, b);
    }

    /**
 * Collect row data from the profile page for sorting.
 * @returns {Array} Array of item objects
 */
    function collectProfileRowData() {
        const tableBody = document.querySelector('.table-body');
        if (!tableBody) return [];

        seedProfileOriginalOrderMap();

        const mainRows = Array.from(tableBody.querySelectorAll('.table-row[data-ff-scouter-extra]'));
        const items = [];

        mainRows.forEach(mainRow => {
            const playerId = getPlayerIdFromRow(mainRow);
            if (!playerId) return;

            const extraRow = mainRow.nextElementSibling && mainRow.nextElementSibling.classList.contains('ff-scouter-extra-row')
            ? mainRow.nextElementSibling
            : null;

            const ffResponse = getFairFightResponse(playerId);
            const bsValue = ffResponse && ffResponse.bs_estimate ? ffResponse.bs_estimate : 0;
            const status = getStatusFromProfileMainRow(mainRow);
            let hospitalTimer = Infinity;
            if (status === 'Hospital' && memberCountdowns[playerId]) {
                const remaining = memberCountdowns[playerId] - Date.now();
                hospitalTimer = remaining > 0 ? remaining : 0;
            }

            items.push({
                playerId,
                mainRow,
                extraRow,
                bsValue,
                status,
                hospitalTimer,
                destination: mainRow.dataset.destination || '',
                lastAction: parseInt(mainRow.dataset.lastAction || '0', 10) || 0,
                originalIndex: getProfileOriginalIndex(playerId)
            });
        });

        return items;
    }

    /**
 * Apply sort to profile page rows.
 * @param {string} mode - Sort mode
 */
    function applyProfileSort(mode = currentSortMode) {
        if (!mode || mode === 'none') return;
        const tableBody = document.querySelector('.table-body');
        if (!tableBody) return;

        const items = collectProfileRowData();
        if (!items.length) return;

        items.sort((a, b) => compareProfileItems(mode, a, b));

        isApplyingProfileSort = true;
        try {
            items.forEach(item => {
                tableBody.appendChild(item.mainRow);
                if (item.extraRow) tableBody.appendChild(item.extraRow);
            });
        } finally {
            requestAnimationFrame(() => {
                isApplyingProfileSort = false;
            });
        }
    }

    /**
 * Reset profile rows to original order.
 */
    function resetProfileSort() {
        const tableBody = document.querySelector('.table-body');
        if (!tableBody) return;

        const items = collectProfileRowData();
        if (!items.length) return;

        // Sort by original index (the order when the page was first seen)
        items.sort((a, b) => a.originalIndex - b.originalIndex);

        isApplyingProfileSort = true;
        try {
            items.forEach(item => {
                tableBody.appendChild(item.mainRow);
                if (item.extraRow) tableBody.appendChild(item.extraRow);
            });
        } finally {
            requestAnimationFrame(() => {
                isApplyingProfileSort = false;
            });
        }
    }

    /**
 * Schedule a deferred profile sort.
 * @param {number} [delay=120] - Delay in ms
 */
    function scheduleProfileSort(delay = 120) {
        if (profileSortTimeout) clearTimeout(profileSortTimeout);
        profileSortTimeout = setTimeout(() => {
            profileSortTimeout = null;
            if (currentSortMode !== 'none') {
                fixExtraRowsAfterFilter();
                applyProfileSort(currentSortMode);
            }
        }, delay);
    }

    /**
 * Collect row data from a war list for sorting.
 * @param {Element} listElement - Members list element
 * @param {string} side - 'your' or 'enemy'
 * @returns {Array} Array of item objects
 */
    function collectWarRowData(listElement, side) {
        if (!listElement) return [];

        seedWarOriginalOrderMap(listElement, side);

        return Array.from(listElement.children).map(li => {
            const playerId = getPlayerIdFromRow(li);
            if (!playerId) return null;
            const ffResponse = getFairFightResponse(playerId);
            const bsValue = ffResponse && ffResponse.bs_estimate ? ffResponse.bs_estimate : 0;
            const status = getStatusFromWarRow(li);
            let hospitalTimer = Infinity;
            if (status === 'Hospital' && memberCountdowns[playerId]) {
                const remaining = memberCountdowns[playerId] - Date.now();
                hospitalTimer = remaining > 0 ? remaining : 0;
            }
            return {
                playerId,
                row: li,
                bsValue,
                status,
                hospitalTimer,
                destination: li.dataset.destination || '',
                lastAction: parseInt(li.dataset.lastAction || '0', 10) || 0,
                originalIndex: getWarOriginalIndex(side, playerId)
            };
        }).filter(Boolean);
    }

    /**
 * Apply sort to a war members list.
 * @param {Element} listElement
 * @param {string} side
 * @param {string} mode
 */
    function applyWarSortToList(listElement, side, mode = warSortMode) {
        if (!listElement || !mode || mode === 'none') return;

        const items = collectWarRowData(listElement, side);
        if (!items.length) return;

        items.sort((a, b) => compareWarItems(mode, a, b));

        isApplyingWarSort = true;
        try {
            items.forEach(item => listElement.appendChild(item.row));
        } finally {
            requestAnimationFrame(() => {
                isApplyingWarSort = false;
            });
        }
    }

    /**
 * Apply sort to both war faction lists.
 * @param {string} mode
 */
    function applyWarSort(mode = warSortMode) {
        if (!mode || mode === 'none') return;
        const yourList = document.querySelector('.your-faction .members-list');
        const enemyList = document.querySelector('.enemy-faction .members-list');
        if (yourList) applyWarSortToList(yourList, 'your', mode);
        if (enemyList) applyWarSortToList(enemyList, 'enemy', mode);
    }

    /**
 * Reset war rows to original order.
 */
    function resetWarSort() {
        const yourList = document.querySelector('.your-faction .members-list');
        const enemyList = document.querySelector('.enemy-faction .members-list');
        if (yourList) resetWarSortList(yourList, 'your');
        if (enemyList) resetWarSortList(enemyList, 'enemy');
    }

    function resetWarSortList(listElement, side) {
        if (!listElement) return;

        const items = collectWarRowData(listElement, side);
        if (!items.length) return;

        items.sort((a, b) => a.originalIndex - b.originalIndex);

        isApplyingWarSort = true;
        try {
            items.forEach(item => listElement.appendChild(item.row));
        } finally {
            requestAnimationFrame(() => {
                isApplyingWarSort = false;
            });
        }
    }

    /**
 * Schedule a deferred war sort.
 * @param {number} [delay=120]
 */
    function scheduleWarSort(delay = 120) {
        if (warSortTimeout) clearTimeout(warSortTimeout);
        warSortTimeout = setTimeout(() => {
            warSortTimeout = null;
            if (warSortMode !== 'none') {
                applyWarSort(warSortMode);
            }
        }, delay);
    }

    /**
 * Force an immediate sort now.
 */
    function forceSortNow() {
        const isWarPage = document.querySelector('.your-faction .members-list') !== null &&
              document.querySelector('.enemy-faction .members-list') !== null;
        if (isWarPage) {
            if (warSortMode !== 'none') applyWarSort(warSortMode);
        } else {
            if (currentSortMode !== 'none') {
                fixExtraRowsAfterFilter();
                applyProfileSort(currentSortMode);
            }
        }
    }

    // =========================================================================
    // SECTION: Sort Observers
    // =========================================================================

    function setupProfileSortObserver() {
        const tableBody = document.querySelector('.table-body');
        if (!tableBody) return;
        if (profileSortObserver) profileSortObserver.disconnect();

        profileSortObserver = new MutationObserver(() => {
            if (isApplyingProfileSort) return;
            if (currentSortMode === 'none') return;
            scheduleProfileSort(160);
        });

        profileSortObserver.observe(tableBody, { childList: true, subtree: false });
    }

    function setupWarSortObservers() {
        const yourList = document.querySelector('.your-faction .members-list');
        const enemyList = document.querySelector('.enemy-faction .members-list');

        if (warYourSortObserver) warYourSortObserver.disconnect();
        if (warEnemySortObserver) warEnemySortObserver.disconnect();

        if (yourList) {
            warYourSortObserver = new MutationObserver(() => {
                if (isApplyingWarSort) return;
                if (warSortMode === 'none') return;
                scheduleWarSort(160);
            });
            warYourSortObserver.observe(yourList, { childList: true, subtree: false });
        }

        if (enemyList) {
            warEnemySortObserver = new MutationObserver(() => {
                if (isApplyingWarSort) return;
                if (warSortMode === 'none') return;
                scheduleWarSort(160);
            });
            warEnemySortObserver.observe(enemyList, { childList: true, subtree: false });
        }
    }

    // =========================================================================
    // SECTION: Member Status Rendering
    // =========================================================================

    /**
 * Render shared member status into a row element.
 * @param {Element} row - The row element
 * @param {Object} member - Member data object
 * @param {Object} options - Rendering options
 */
    function renderSharedMemberStatus(row, member, options = {}) {
        if (!row || !member || !member.status) return;

        const statusEl = row.querySelector('.status');
        if (!statusEl) return;

        const showAttackButton = options.showAttackButton === true;

        statusEl.classList.remove(
            'faction-status-okay',
            'faction-status-hospital',
            'faction-status-traveling',
            'faction-status-abroad',
            'faction-status-jail'
        );

        let statusText = '';
        let statusClass = '';
        let untilTime = 0;
        let isAbroad = false;
        let destination = '';

        switch (member.status.state) {
            case 'Okay':
                statusText = 'Okay';
                statusClass = 'faction-status-okay';
                break;

            case 'Traveling': {
                const description = member.status.description || '';
                let location = '';
                let isReturning = false;

                const parsed = extractCountryFromDescription(description);
                if (parsed && parsed.from && parsed.to) {
                    if (parsed.from === 'Torn' || parsed.from === 'Torn City') {
                        isReturning = false;
                        location = parsed.to;
                    } else if (parsed.to === 'Torn' || parsed.to === 'Torn City') {
                        isReturning = true;
                        location = parsed.from;
                    } else {
                        isReturning = false;
                        location = parsed.to;
                    }
                } else if (parsed && parsed.location) {
                    location = parsed.location;
                    isReturning = false;
                } else {
                    if (description.includes('Traveling to ')) {
                        location = description.replace('Traveling to ', '').trim();
                        isReturning = false;
                    } else if (description.includes('Returning to Torn from ')) {
                        location = description.replace('Returning to Torn from ', '').trim();
                        isReturning = true;
                    }
                }

                if (!location) location = 'Unknown';
                destination = standardizeCountryName(location);
                const abbr = abbreviateCountry(location);

                statusText = isReturning
                    ? `${tornSymbol} ${createPlaneSvg(true)} ${abbr}`
                : `${tornSymbol} ${createPlaneSvg(false)} ${abbr}`;
                statusClass = 'faction-status-traveling';

                if (member.status.until) {
                    untilTime = parseInt(member.status.until, 10) * 1000;
                }
                break;
            }

            case 'Abroad': {
                const description = member.status.description || '';
                let location = '';

                if (description.startsWith('In ')) {
                    location = description.replace('In ', '').trim();
                    const abbr = abbreviateCountry(location);
                    statusText = `\uD83C\uDF0F ${abbr}`;
                    destination = standardizeCountryName(location);
                } else {
                    statusText = 'Abroad';
                }

                statusClass = 'faction-status-abroad';
                break;
            }

            case 'Hospital': {
                statusClass = 'faction-status-hospital';

                if (member.status.description) {
                    const descLower = member.status.description.toLowerCase();
                    const countryMap = {
                        'canadian': 'Canada', 'canada': 'Canada',
                        'cayman': 'Cayman Islands', 'cayman islands': 'Cayman Islands',
                        'mexican': 'Mexico', 'mexico': 'Mexico',
                        'argentine': 'Argentina', 'argentina': 'Argentina',
                        'uk': 'UK', 'british': 'UK', 'united kingdom': 'UK',
                        'hawaiian': 'Hawaii', 'hawaii': 'Hawaii',
                        'swiss': 'Switzerland', 'switzerland': 'Switzerland',
                        'south african': 'South Africa', 'south africa': 'South Africa',
                        'chinese': 'China', 'china': 'China',
                        'japanese': 'Japan', 'japan': 'Japan',
                        'emirati': 'UAE', 'uae': 'UAE', 'united arab emirates': 'UAE'
                    };

                    for (const [key, full] of Object.entries(countryMap)) {
                        if (descLower.includes(key)) {
                            isAbroad = true;
                            destination = standardizeCountryName(full);
                            break;
                        }
                    }
                }

                if (member.status.until) {
                    untilTime = parseInt(member.status.until, 10) * 1000;
                }

                statusText = '';
                break;
            }

            case 'Jail':
                statusClass = 'faction-status-jail';
                if (member.status.until) {
                    untilTime = parseInt(member.status.until, 10) * 1000;
                }
                break;

            default:
                statusText = member.status.state || '';
                statusClass = '';
        }

        if (untilTime > 0) {
            memberCountdowns[member.id] = untilTime;
        } else {
            delete memberCountdowns[member.id];
        }

        let countdownText = '';
        if (untilTime > 0) {
            const remaining = untilTime - Date.now();
            countdownText = remaining > 0 ? formatTime(remaining) : '00:00:00';
        }

        statusEl.classList.add(statusClass);

        let statusHTML = `<div class="faction-profile-status ${statusClass}" style="position:relative;display:flex;align-items:center;width:100%;">`;

        if (showAttackButton) {
            statusHTML += `<a href="https://www.torn.com/page.php?sid=attack&user2ID=${member.id}" target="_blank" class="status-attack-btn" aria-label="Attack">\u2694\uFE0F</a>`;
        }

        statusHTML += `<div class="status-text-container">`;

        if (statusText) {
            statusHTML += `<span class="status-text">${statusText}</span>`;
        }

        if (countdownText) {
            statusHTML += `<span class="faction-status-countdown">${countdownText}</span>`;
        }

        statusHTML += `</div>`;

        if (member.status.state === 'Hospital' && isAbroad) {
            statusHTML += `<span class="hospital-abroad-icon">\uD83C\uDF0F</span>`;
        }

        statusHTML += `</div>`;

        statusEl.innerHTML = statusHTML;

        row.dataset.destination = destination || '';
        row.dataset.lastAction = member.last_action?.timestamp ? String(member.last_action.timestamp * 1000) : '0';
    }

    /**
 * Update faction profile member status in a row.
 * @param {Element} li - Row element
 * @param {Object} member - Member data
 * @param {boolean} isFactionProfilePage - Whether on faction profile page
 */
    function updateFactionProfileMemberStatus(li, member, isFactionProfilePage) {
        if (!member || !member.status) return;

        renderSharedMemberStatus(li, member, {
            showAttackButton: true
        });

        if (isFactionProfilePage) {
            createOrUpdateExtraInfoRow(li, member);
        }
    }

    // =========================================================================
    // SECTION: Extra Info Rows
    // =========================================================================

    /**
 * Update travel ETA display in an extra row.
 * @param {Element} extraRow
 * @param {Object} member
 */
    function updateTravelEtaInExtraRow(extraRow, member) {
        const etaSpan = extraRow.querySelector('.ff-scouter-travel-eta');
        if (!etaSpan) return;
        const travelInfo = getTravelInfo(member);
        if (travelInfo && travelInfo.remaining > 0) {
            const ms = travelInfo.remaining * 1000;
            etaSpan.textContent = `ETA: ${formatTime(ms)}`;
        } else {
            etaSpan.textContent = '';
        }
    }

    /**
 * Create or update extra info row for a member.
 * @param {Element} li - Main row element
 * @param {Object} member - Member data
 */
    function createOrUpdateExtraInfoRow(li, member) {
        let extraRow = li.nextElementSibling;
        if (extraRow && extraRow.classList.contains('ff-scouter-extra-row')) {
            updateExtraInfoRowContent(extraRow, member);
        } else {
            createExtraInfoRow(li, member);
        }
    }

    /**
 * Create a new extra info row.
 * @param {Element} li - Main row
 * @param {Object} member - Member data
 */
    function createExtraInfoRow(li, member) {
        const extraRow = document.createElement('li');
        extraRow.className = 'ff-scouter-extra-row';

        const profileLink = li.querySelector('a[href*="profiles.php?XID="]');
        if (profileLink) {
            const match = profileLink.href.match(/XID=(\d+)/);
            if (match) extraRow.dataset.userId = match[1];
        }

        li.dataset.ffScouterExtra = 'true';

        const extraContent = document.createElement('div');
        extraContent.className = 'ff-scouter-extra-content';

        let playerId = getPlayerIdFromRow(li);
        let ffValue = 'N/A';
        let ffColor = '#000';
        if (playerId) {
            const ffResponse = getFairFightResponse(playerId);
            if (ffResponse && !ffResponse.no_data) {
                ffValue = formatFFForExtraRow(ffResponse.value);
                ffColor = getFFColour(ffResponse.value);
            }
        }

        let lastActionText = 'Last action: N/A';
        if (member.last_action && member.last_action.relative) {
            lastActionText = `Last action: ${member.last_action.relative}`;
        }

        extraContent.innerHTML = `
        <div class="ff-scouter-last-action">${lastActionText}</div>
        <span class="ff-scouter-travel-eta" style="flex:1;text-align:center;font-size:11px;color:#aaa;"></span>
        <div class="ff-scouter-ff-right">
            FF: <span class="ff-scouter-ff-value" style="color:${ffColor}">${ffValue}</span>
        </div>
    `;

        extraRow.appendChild(extraContent);
        li.parentNode.insertBefore(extraRow, li.nextSibling);
        updateTravelEtaInExtraRow(extraRow, member);
    }

    /**
 * Update content of existing extra info row.
 * @param {Element} extraRow
 * @param {Object} member
 */
    function updateExtraInfoRowContent(extraRow, member) {
        const lastActionDiv = extraRow.querySelector('.ff-scouter-last-action');
        if (lastActionDiv) {
            lastActionDiv.textContent = member.last_action?.relative
                ? `Last action: ${member.last_action.relative}`
            : 'Last action: N/A';
        }
        updateTravelEtaInExtraRow(extraRow, member);
    }

    /**
 * Update FF stats in all extra info rows.
 */
    function updateExtraInfoRowStats() {
        const isProfileOrMainFaction = window.location.href.match(/factions\.php\?step=profile&ID=\d+/) ||
              (window.location.href.includes('factions.php?step=your') && !window.location.hash.includes('/war/rank'));
        if (!isProfileOrMainFaction) return;

        document.querySelectorAll('.ff-scouter-extra-row').forEach(extraRow => {
            const li = extraRow.previousElementSibling;
            if (!li || !li.classList.contains('table-row')) return;

            const playerId = getPlayerIdFromRow(li);
            if (!playerId) return;

            const ffResponse = getFairFightResponse(playerId);
            if (ffResponse && !ffResponse.no_data) {
                const ffSpan = extraRow.querySelector('.ff-scouter-ff-value');
                if (ffSpan) {
                    ffSpan.innerHTML = formatFFForExtraRow(ffResponse.value);
                    ffSpan.style.color = getFFColour(ffResponse.value);
                }
            }
        });
    }

    /**
 * Fix extra rows position after DOM filtering.
 */
    function fixExtraRowsAfterFilter() {
        const isProfileOrMainFaction = window.location.href.match(/factions\.php\?step=profile&ID=\d+/) ||
              (window.location.href.includes('factions.php?step=your') && !window.location.hash.includes('/war/rank'));
        if (!isProfileOrMainFaction) return;

        const tableBody = document.querySelector('.table-body');
        if (!tableBody) return;

        const mainRows = Array.from(tableBody.querySelectorAll('.table-row[data-ff-scouter-extra]'));
        const extraRows = Array.from(tableBody.querySelectorAll('.ff-scouter-extra-row'));

        const extraRowMap = new Map();
        extraRows.forEach(extraRow => {
            if (extraRow.dataset.userId) extraRowMap.set(extraRow.dataset.userId, extraRow);
        });

        mainRows.forEach(mainRow => {
            const userId = getPlayerIdFromRow(mainRow);
            if (!userId) return;
            const extraRow = extraRowMap.get(userId);
            if (!extraRow) return;
            if (extraRow.previousElementSibling !== mainRow) {
                extraRow.remove();
                mainRow.parentNode.insertBefore(extraRow, mainRow.nextSibling);
            }
        });
    }

    // =========================================================================
    // SECTION: Faction Profile Status Update
    // =========================================================================

    /**
 * Update all faction profile statuses for a given faction ID.
 * @param {string|number} factionID
 */
    function updateFactionProfileStatuses(factionID) {
        if (!key) return;

        fetchFactionData(factionID)
            .then(data => {
            if (!Array.isArray(data.members)) {
                console.warn(`[FF Scouter] No members array for faction ${factionID}`);
                return;
            }

            const memberMap = {};
            data.members.forEach(member => {
                memberMap[member.id] = member;
            });

            document.querySelectorAll('.table-body > .table-row').forEach(row => {
                const userID = getPlayerIdFromRow(row);
                if (!userID) return;
                updateFactionProfileMemberStatus(row, memberMap[userID], true);
            });

            updateExtraInfoRowStats();
            fixExtraRowsAfterFilter();
            scheduleProfileSort(120);
        })
            .catch(err => {
            console.error('[FF Scouter] Error fetching faction data for profile:', err);
        });
    }

    /**
 * Update countdown timers on faction profile page.
 */
    function updateFactionProfileTimers() {
        const isProfileOrMainFaction = window.location.href.match(/factions\.php\?step=profile&ID=\d+/) ||
              (window.location.href.includes('factions.php?step=your') && !window.location.hash.includes('/war/rank'));
        if (!isProfileOrMainFaction) return;

        document.querySelectorAll('.table-body > .table-row').forEach(row => {
            const userID = getPlayerIdFromRow(row);
            if (!userID) return;
            const statusEl = row.querySelector('.status');
            if (!statusEl) return;
            if (memberCountdowns[userID]) {
                const remaining = memberCountdowns[userID] - Date.now();
                const countdownEl = statusEl.querySelector('.faction-status-countdown');
                if (countdownEl) countdownEl.textContent = remaining > 0 ? formatTime(remaining) : '00:00:00';
            }
        });
    }

    // =========================================================================
    // SECTION: Faction Profile Page Init
    // =========================================================================

    function initFactionProfileStatus() {
        const profileMatch = window.location.href.match(/factions\.php\?step=profile&ID=(\d+)/);
        if (!profileMatch) return false;

        const factionID = profileMatch[1];
        const memberTable = document.querySelector('.table-body');
        if (!memberTable) return false;

        const pageKey = `profile:${factionID}`;

        if (currentProfilePageKey === pageKey && document.body.contains(memberTable)) {
            return true;
        }

        cleanupProfilePage();
        currentProfilePageKey = pageKey;

        createSortPanel();
        seedProfileOriginalOrderMap();
        setupProfileSortObserver();

        const playerIds = [];
        document.querySelectorAll('.table-body > .table-row').forEach(row => {
            const playerId = getPlayerIdFromRow(row);
            if (playerId) playerIds.push(playerId);
        });

        if (playerIds.length > 0) {
            updateFFCache(playerIds, () => {
                updateFactionProfileStatuses(factionID);
                updateExtraInfoRowStats();
            });
        } else {
            updateFactionProfileStatuses(factionID);
        }

        setExtraRowsVisibility(showExtraRows);

        profileStatusInterval = setInterval(() => updateFactionProfileStatuses(factionID), API_INTERVAL);
        profileTimerInterval = setInterval(updateFactionProfileTimers, 1000);

        return true;
    }

    // =========================================================================
    // SECTION: Main Faction Page Init
    // =========================================================================

    function initMainFactionPage() {
        if (!(window.location.href.includes('factions.php?step=your') && !window.location.hash.includes('/war/rank'))) {
            return false;
        }

        const memberTable = document.querySelector('.table-body');
        if (!memberTable) return false;

        const pageKey = 'main-faction';

        if (currentMainFactionPageKey === pageKey && document.body.contains(memberTable)) {
            return true;
        }

        cleanupMainFactionPage();
        currentMainFactionPageKey = pageKey;

        fetchUserFactionId(tornKey).then(fetchedId => {
            if (!fetchedId) {
                console.warn('[FF Scouter] Could not fetch own faction ID');
                return;
            }

            userFactionId = fetchedId;
            createSortPanel();
            seedProfileOriginalOrderMap();
            setupProfileSortObserver();

            const playerIds = [];
            document.querySelectorAll('.table-body > .table-row').forEach(row => {
                const playerId = getPlayerIdFromRow(row);
                if (playerId) playerIds.push(playerId);
            });

            if (playerIds.length > 0) {
                updateFFCache(playerIds, () => {
                    updateFactionProfileStatuses(userFactionId);
                    updateExtraInfoRowStats();
                });
            } else {
                updateFactionProfileStatuses(userFactionId);
            }

            setExtraRowsVisibility(showExtraRows);

            mainFactionStatusInterval = setInterval(() => updateFactionProfileStatuses(userFactionId), API_INTERVAL);
            mainFactionTimerInterval = setInterval(updateFactionProfileTimers, 1000);
        }).catch(e => {
            console.warn('[FF Scouter] Error in initMainFactionPage:', e);
        });

        return true;
    }

    // =========================================================================
    // SECTION: War Page Member Status
    // =========================================================================

    /**
 * Update member status in a war page row.
 * @param {Element} li - List item element
 * @param {Object} member - Member data
 */
    function updateMemberStatus(li, member) {
        if (!member || !member.status) return;

        renderSharedMemberStatus(li, member, {
            showAttackButton: false
        });

        let lastActionRow = li.querySelector('.last-action-row');
        const lastActionText = member.last_action?.relative || '';

        if (lastActionRow) {
            lastActionRow.textContent = `Last Action: ${lastActionText}`;
        } else {
            lastActionRow = document.createElement('div');
            lastActionRow.className = 'last-action-row';
            lastActionRow.textContent = `Last Action: ${lastActionText}`;

            const lastDiv = Array.from(li.children).reverse().find(el => el.tagName === 'DIV');
            if (lastDiv?.nextSibling) {
                li.insertBefore(lastActionRow, lastDiv.nextSibling);
            } else {
                li.appendChild(lastActionRow);
            }
        }
    }

    /**
 * Update faction statuses for a war page.
 * @param {string|number} factionID
 * @param {Element} container - Members list container
 */
    function updateFactionStatuses(factionID, container) {
        apiCallInProgressCount++;
        fetchFactionData(factionID)
            .then(data => {
            if (!Array.isArray(data.members)) {
                console.warn(`[FF Scouter] No members array for faction ${factionID}`);
                return;
            }

            const memberMap = {};
            data.members.forEach(member => {
                memberMap[member.id] = member;
            });

            container.querySelectorAll('li').forEach(li => {
                const userID = getPlayerIdFromRow(li);
                if (!userID) return;
                updateMemberStatus(li, memberMap[userID]);
            });

            scheduleWarSort(120);
        })
            .catch(err => {
            console.error('[FF Scouter] Error fetching faction data:', err);
        })
            .finally(() => {
            apiCallInProgressCount--;
        });
    }

    /**
 * Update all member countdown timers.
 */
    function updateAllMemberTimers() {
        const rows = document.querySelectorAll(
            '.enemy-faction .members-list li, .your-faction .members-list li, .table-body > .table-row'
        );

        rows.forEach(row => {
            const userID = getPlayerIdFromRow(row);
            if (!userID) return;

            const statusEl = row.querySelector('.status');
            if (!statusEl) return;

            if (memberCountdowns[userID]) {
                let remaining = memberCountdowns[userID] - Date.now();
                if (remaining < 0) remaining = 0;

                const countdownEl = statusEl.querySelector('.faction-status-countdown');
                if (countdownEl) {
                    countdownEl.textContent = formatTime(remaining);
                }
            }
        });
    }

    // =========================================================================
    // SECTION: War Page Init
    // =========================================================================

    function isWarDomReady() {
        return !!(
            document.querySelector('.enemy-faction .members-list') &&
            document.querySelector('.your-faction .members-list')
        );
    }

    function updateAPICalls() {
        const enemyList = document.querySelector('.enemy-faction .members-list');
        const yourList = document.querySelector('.your-faction .members-list');

        if (!enemyList || !yourList) return;

        const ids = getWarFactionIds();

        if (!ids.enemyFactionId || !ids.yourFactionId) {
            console.warn('[FF Scouter] Could not detect war faction IDs', ids);
            return;
        }

        updateFactionStatuses(ids.enemyFactionId, enemyList);
        updateFactionStatuses(ids.yourFactionId, yourList);
    }

    function initWarScript() {
        const enemyList = document.querySelector('.enemy-faction .members-list');
        const yourList = document.querySelector('.your-faction .members-list');

        if (!enemyList || !yourList) return false;

        const ids = getWarFactionIds();
        const enemyId = ids.enemyFactionId || 'enemy';
        const yourId = ids.yourFactionId || 'your';

        const pageKey = `war:${yourId}:${enemyId}`;

        if (
            currentWarPageKey === pageKey &&
            document.body.contains(enemyList) &&
            document.body.contains(yourList)
        ) {
            updateAPICalls();
            return true;
        }

        cleanupWarPage();
        currentWarPageKey = pageKey;

        createSortPanel();

        seedWarOriginalOrderMap(yourList, 'your');
        seedWarOriginalOrderMap(enemyList, 'enemy');

        setupWarSortObservers();

        const savedWarSort = GM_getValue('ff_scouter_sort_mode_war', 'none');
        if (savedWarSort !== 'none') {
            warSortMode = savedWarSort;
            setTimeout(() => {
                applyWarSort(savedWarSort);
                highlightActiveSortOption();
            }, 300);
        }

        updateAPICalls();

        if (warStatusInterval) clearInterval(warStatusInterval);
        warStatusInterval = setInterval(updateAPICalls, API_INTERVAL);

        console.log('[FF Scouter] War page initialized successfully', pageKey);

        return true;
    }

    // =========================================================================
    // SECTION: Page Reconciliation & Lifecycle
    // =========================================================================

    /**
 * Reconcile current page state, initializing or cleaning up as needed.
 */
    function reconcilePageState() {
        const isProfile = /factions\.php\?step=profile&ID=\d+/.test(window.location.href);
        const isMainFaction = window.location.href.includes('factions.php?step=your') && !window.location.hash.includes('/war/rank');
        const isWar = isWarDomReady();

        if (!isProfile && currentProfilePageKey) {
            cleanupProfilePage();
            currentProfilePageKey = '';
        }

        if (!isMainFaction && currentMainFactionPageKey) {
            cleanupMainFactionPage();
            currentMainFactionPageKey = '';
        }

        if (!isWar && currentWarPageKey) {
            cleanupWarPage();
            currentWarPageKey = '';
        }

        if (isProfile) initFactionProfileStatus();
        if (isMainFaction) initMainFactionPage();
        if (isWar) initWarScript();

        if (location.href !== lastKnownPageUrl) {
            lastKnownPageUrl = location.href;
            ensureInfoLineMounted();
            bootstrapCurrentPageFF(true);
        } else if (getProfileTargetIdFromUrl()) {
            if (!info_line || !document.body.contains(info_line)) {
                ensureInfoLineMounted();
                bootstrapCurrentPageFF();
            }
        }
    }

    setInterval(() => {
        if (isAttackPage()) return;
        reconcilePageState();
    }, 1000);

    setInterval(updateAllMemberTimers, 1000);

    // =========================================================================
    // SECTION: War DOM Observer (reactive init)
    // =========================================================================

    const ffWarDomObserver = new MutationObserver(() => {
        if (isAttackPage()) return;
        if (isWarDomReady()) {
            initWarScript();
        }
    });

    ffWarDomObserver.observe(document.body, {
        childList: true,
        subtree: true
    });

    // =========================================================================
    // SECTION: Days Column Removal
    // =========================================================================

    function removeDaysColumn() {
        const isProfileOrMainFaction = window.location.href.includes('factions.php?step=profile') ||
              (window.location.href.includes('factions.php?step=your') && !window.location.hash.includes('/war/rank'));
        if (!isProfileOrMainFaction) return;
        document.querySelectorAll('.table-header .table-cell.days').forEach(el => el.remove());
        document.querySelectorAll('.table-row .table-cell.days').forEach(el => el.remove());
    }

    if (window.location.href.includes('factions.php?step=profile') ||
        (window.location.href.includes('factions.php?step=your') && !window.location.hash.includes('/war/rank'))) {
        setTimeout(removeDaysColumn, 500);
        const daysObserver = new MutationObserver(() => {
            setTimeout(removeDaysColumn, 100);
        });
        daysObserver.observe(document.body, { childList: true, subtree: true });
    }

    // =========================================================================
    // SECTION: Attack Page UI Enhancements
    // =========================================================================

    function enlargeStartFightButton() {
        const buttons = Array.from(document.querySelectorAll('button.torn-btn.silver'));
        const btn = buttons.find(b => b.textContent.trim() === 'Start fight');
        if (!btn) return;

        btn.style.cssText = 'font-size:34px;padding:18px 24px;min-width:280px;min-height:110px;position:relative;z-index:100000;';
    }

    function moveAttackModalLowerOnMobile() {
        const isMobile = window.matchMedia('(max-width: 768px)').matches;
        const modal = document.querySelector('.modal___lMj6N.defender___niX1M');
        if (!modal) return;

        if (!isMobile) {
            modal.style.alignItems = '';
            modal.style.justifyContent = '';
            modal.style.paddingTop = '';
            modal.style.paddingBottom = '';
            return;
        }

        modal.style.alignItems = 'flex-end';
        modal.style.justifyContent = 'center';
        modal.style.paddingTop = '0';
        modal.style.paddingBottom = '0px';
    }

    function styleStartFightArea() {
        enlargeStartFightButton();
        moveAttackModalLowerOnMobile();
    }

    styleStartFightArea();

    const startFightObserver = new MutationObserver(() => {
        if (!isAttackPage()) return;
        styleStartFightArea();
    });
    startFightObserver.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', styleStartFightArea);

    // =========================================================================
    // SECTION: Debug Hooks (Non-invasive)
    // =========================================================================

    /**
 * Safe debug hooks exposed on window.FFSCOUTER for development inspection.
 * No sensitive data is exposed. All properties are read-only views of state.
 */
    if (typeof unsafeWindow !== 'undefined') {
        unsafeWindow.FFSCOUTER = {
            version: FF_VERSION,
            getState: () => ({
                currentSortMode,
                warSortMode,
                showExtraRows,
                hasApiKey: !!key,
                hasTornKey: !!tornKey,
                userFactionId,
                currentProfilePageKey,
                currentMainFactionPageKey,
                currentWarPageKey,
                apiCallInProgressCount,
                isAttackPage: isAttackPage(),
                isWarDomReady: isWarDomReady()
            }),
            getCacheForPlayer: (playerId) => getFairFightResponse(playerId),
            getCacheMisses: (playerIds) => getCacheMisses(playerIds),
            forceRefresh: () => {
                bootstrapCurrentPageFF(true);
                reconcilePageState();
            },
            getCountdowns: () => ({ ...memberCountdowns }),
            __internal: {
                info_line,
                rD_getValue,
                rD_setValue,
                key,
                tornKey
            }
        };
    } else {
        window.FFSCOUTER = {
            version: FF_VERSION,
            getState: () => ({
                currentSortMode,
                warSortMode,
                showExtraRows,
                hasApiKey: !!key,
                hasTornKey: !!tornKey,
                userFactionId,
                currentProfilePageKey,
                currentMainFactionPageKey,
                currentWarPageKey,
                apiCallInProgressCount,
                isAttackPage: isAttackPage(),
                isWarDomReady: isWarDomReady()
            }),
            getCacheForPlayer: (playerId) => getFairFightResponse(playerId),
            getCacheMisses: (playerIds) => getCacheMisses(playerIds),
            forceRefresh: () => {
                bootstrapCurrentPageFF(true);
                reconcilePageState();
            },
            getCountdowns: () => ({ ...memberCountdowns })
        };
    }

    console.log('[FF Scouter] Initialization complete. Debug hooks available at window.FFSCOUTER');

})();
