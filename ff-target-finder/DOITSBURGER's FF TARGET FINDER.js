// ==UserScript==
// @name         1 Doits FF Target Finder
// @namespace    http://tampermonkey.net/
// @version      3.8
// @description  Quick target finder (no overlay)
// @author       FFScouter
// @match        https://www.torn.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @connect      ffscouter.com
// @connect      api.torn.com
// @updateURL    https://raw.githubusercontent.com/doitsburger/doits-scripts/329e49ba16b2a2a1ddba7e8ac9b2f2a26f601956/ff-target-finder/DOITSBURGER's%20FF%20TARGET%20FINDER
// @downloadURL  https://raw.githubusercontent.com/doitsburger/doits-scripts/329e49ba16b2a2a1ddba7e8ac9b2f2a26f601956/ff-target-finder/DOITSBURGER's%20FF%20TARGET%20FINDER
// ==/UserScript==

(function() {
    'use strict';

    // ==================== FF SCOUTER CORE ====================
    // PDA API Key placeholder
    const PDA_API_KEY = "###PDA-APIKEY###";

    // Faction medical page URL
    const FACTION_MEDICAL_URL = "https://www.torn.com/factions.php?step=your&type=1#/tab=armoury&start=0&sub=medical";

    // Detect mobile/touch device
    const isMobile = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);

    // Default configuration (overlay removed completely)
    const defaultConfig = {
        apiKey: '',
        target: {
            minFF: 1.50,
            maxFF: 3.00
        },
        factionlessOnly: false,
        inactiveOnly: true,
        openInNewTab: true,
        verifyStatus: false,
        hasUsedTap: false,
        hasUsedHold: false,
        buttonPosition: isMobile
        ? { right: 2, top: 218, isPercent: false }
        : { right: 0, top: 27, isPercent: true },
        buttonVisible: true
        // fightOverlayEnabled removed
    };

    // Load or initialize configuration (migrate old format)
    function getConfig() {
        const saved = GM_getValue('ffscouter_config');
        if (saved) {
            try {
                const config = JSON.parse(saved);
                if (config.easy || config.good) {
                    const newConfig = {
                        apiKey: config.apiKey || '',
                        target: {
                            minFF: config.easy?.minFF ?? 1.50,
                            maxFF: config.good?.maxFF ?? 3.00
                        },
                        factionlessOnly: config.factionlessOnly ?? false,
                        inactiveOnly: config.inactiveOnly ?? true,
                        openInNewTab: config.openInNewTab ?? true,
                        verifyStatus: config.verifyStatus ?? false,
                        hasUsedTap: config.hasUsedTap ?? false,
                        hasUsedHold: config.hasUsedHold ?? false,
                        buttonPosition: config.buttonPosition || defaultConfig.buttonPosition,
                        buttonVisible: config.buttonVisible ?? true
                    };
                    saveConfig(newConfig);
                    return newConfig;
                }
                if (!config.target) {
                    config.target = { minFF: 1.50, maxFF: 3.00 };
                }
                // Remove any leftover fightOverlayEnabled
                delete config.fightOverlayEnabled;
                return config;
            } catch (e) {
                return defaultConfig;
            }
        }
        return defaultConfig;
    }

    function saveConfig(config) {
        GM_setValue('ffscouter_config', JSON.stringify(config));
    }

    function getApiKey() {
        const config = getConfig();
        if (config.apiKey && /^[a-zA-Z0-9]{16}$/.test(config.apiKey)) {
            return { key: config.apiKey, source: 'manual' };
        }
        return { key: PDA_API_KEY, source: 'pda' };
    }

    // ===== API-BASED HOSPITAL CHECK (with DOM fallback) =====
    async function checkUserInHospital() {
        const { key } = getApiKey();

        if (key) {
            try {
                const response = await new Promise((resolve, reject) => {
                    GM_xmlhttpRequest({
                        method: 'GET',
                        url: `https://api.torn.com/v2/user/?selections=basic&key=${key}`,
                        timeout: 5000,
                        onload: resolve,
                        onerror: reject,
                        ontimeout: reject
                    });
                });

                const data = JSON.parse(response.responseText);
                if (!data.error) {
                    const state = data.status?.state;
                    console.log('FF Scouter: User status via API:', state);
                    return state === 'Hospital';
                } else {
                    console.warn('FF Scouter: API error, falling back to DOM check:', data.error);
                }
            } catch (e) {
                console.warn('FF Scouter: API request failed, falling back to DOM check:', e);
            }
        }

        const hospitalElements = document.querySelectorAll('a[href="/index.php"][aria-label^="Hospital:"]');
        for (const el of hospitalElements) {
            if (el.offsetParent !== null) {
                console.log('FF Scouter: Visible hospital element found (fallback) – user is hospitalized');
                return true;
            }
        }
        console.log('FF Scouter: No visible hospital element – user is not hospitalized');
        return false;
    }

    // Torn-style CSS – updated with new glass button UI
    GM_addStyle(`
    /* ===== SETTINGS POPUP (unchanged) ===== */
    .ffs-overlay {
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.85);
        z-index: 999999;
        display: flex;
        justify-content: center;
        align-items: center;
        font-family: Arial, Helvetica, sans-serif;
        backdrop-filter: blur(3px);
    }

    .ffs-popup {
        background: linear-gradient(180deg, #2d2d2d 0%, #1a1a1a 100%);
        border-radius: 8px;
        width: 380px;
        max-width: 95vw;
        max-height: 90vh;
        overflow-y: auto;
        box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255,255,255,0.1);
        color: #ddd;
    }

    .ffs-popup::-webkit-scrollbar {
        width: 8px;
    }

    .ffs-popup::-webkit-scrollbar-track {
        background: #1a1a1a;
    }

    .ffs-popup::-webkit-scrollbar-thumb {
        background: #444;
        border-radius: 4px;
    }

    .ffs-header {
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

    .ffs-header-title {
        display: flex;
        align-items: center;
        gap: 10px;
    }

    .ffs-header-title svg {
        width: 22px;
        height: 22px;
        fill: #6ac46a;
    }

    .ffs-header h2 {
        margin: 0!important;
        color: #fff;
        font-size: 15px;
        font-weight: 600;
        letter-spacing: 0.5px;
    }

    .ffs-close {
        background: rgba(255,255,255,0.1);
        border: none;
        color: #888;
        font-size: 18px;
        cursor: pointer;
        padding: 0;
        width: 28px;
        height: 28px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.2s;
    }

    .ffs-close:hover {
        background: rgba(255,100,100,0.2);
        color: #f66;
    }

    .ffs-content {
        padding: 16px;
    }

    /* API Status Banner */
    .ffs-api-banner {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px 14px;
        border-radius: 6px;
        margin-bottom: 16px;
        cursor: pointer;
        transition: all 0.2s;
    }

    .ffs-api-banner svg {
        width: 20px;
        height: 20px;
        flex-shrink: 0;
    }

    .ffs-api-banner-text {
        flex: 1;
    }

    .ffs-api-banner-title {
        font-size: 12px;
        font-weight: 600;
        margin-bottom: 2px;
    }

    .ffs-api-banner-sub {
        font-size: 10px;
        opacity: 0.7;
    }

    .ffs-api-banner.manual {
        background: linear-gradient(135deg, rgba(106, 196, 106, 0.15) 0%, rgba(80, 150, 80, 0.1) 100%);
        border: 1px solid rgba(106, 196, 106, 0.3);
    }

    .ffs-api-banner.manual svg {
        fill: #6c6;
    }

    .ffs-api-banner.manual:hover {
        background: linear-gradient(135deg, rgba(106, 196, 106, 0.25) 0%, rgba(80, 150, 80, 0.15) 100%);
    }

    .ffs-api-banner.auto {
        background: linear-gradient(135deg, rgba(106, 150, 196, 0.15) 0%, rgba(80, 120, 150, 0.1) 100%);
        border: 1px solid rgba(106, 150, 196, 0.3);
    }

    .ffs-api-banner.auto svg {
        fill: #6af;
    }

    .ffs-api-banner.auto:hover {
        background: linear-gradient(135deg, rgba(106, 150, 196, 0.25) 0%, rgba(80, 120, 150, 0.15) 100%);
    }

    .ffs-api-badge {
        background: rgba(255,255,255,0.1);
        padding: 3px 8px;
        border-radius: 10px;
        font-size: 9px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.5px;
    }

    .ffs-api-banner.auto .ffs-api-badge {
        background: rgba(106, 170, 255, 0.2);
        color: #6af;
    }

    .ffs-api-banner.manual .ffs-api-badge {
        background: rgba(106, 196, 106, 0.2);
        color: #6c6;
    }

    /* Target Card (single) */
    .ffs-target-card {
        background: rgba(0,0,0,0.2);
        border: 1px solid #333;
        border-radius: 6px;
        margin-bottom: 12px;
        overflow: hidden;
    }

    .ffs-card-header {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 14px;
        background: rgba(255,255,255,0.03);
        border-bottom: 1px solid #333;
    }

    .ffs-card-icon {
        width: 32px;
        height: 32px;
        border-radius: 6px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 16px;
        background: linear-gradient(135deg, #4a7c4a 0%, #3a5c3a 100%);
    }

    .ffs-card-title {
        flex: 1;
    }

    .ffs-card-title h3 {
        margin: 0!important;
        font-size: 13px;
        font-weight: 600;
        color: #eee;
    }

    .ffs-card-title span {
        font-size: 10px;
        color: #777;
    }

    .ffs-card-body {
        padding: 12px 14px;
        display: flex;
        flex-direction: column;
        gap: 10px;
    }

    .ffs-input-row {
        display: flex;
        align-items: center;
        gap: 10px;
    }

    .ffs-input-label {
        font-size: 11px;
        color: #999;
        width: 55px;
        flex-shrink: 0;
    }

    .ffs-input-group {
        display: flex;
        align-items: center;
        gap: 6px;
        flex: 1;
    }

    .ffs-input {
        flex: 1;
        padding: 8px 10px;
        border: 1px solid #444;
        border-radius: 4px;
        background: #252525;
        color: #fff;
        font-size: 13px;
        text-align: center;
        transition: all 0.2s;
    }

    .ffs-input:focus {
        outline: none;
        border-color: #6ac46a;
        background: #2a2a2a;
        box-shadow: 0 0 0 2px rgba(106, 196, 106, 0.1);
    }

    .ffs-input-sep {
        color: #555;
        font-size: 11px;
    }

    /* Target Count Badge */
    .ffs-card-count {
        padding: 6px 14px;
        background: rgba(0,0,0,0.2);
        border-top: 1px solid #333;
        font-size: 11px;
        color: #888;
        display: flex;
        align-items: center;
        gap: 6px;
    }

    .ffs-card-count.loading {
        color: #666;
    }

    .ffs-card-count.error {
        color: #c66;
    }

    .ffs-card-count.warning {
        color: #c96;
    }

    .ffs-card-count.good {
        color: #6a6;
    }

    .ffs-count-num {
        font-weight: 600;
        color: #aaa;
    }

    .ffs-card-count.warning .ffs-count-num {
        color: #fc6;
    }

    .ffs-card-count.good .ffs-count-num {
        color: #6c6;
    }

    .ffs-card-count.error .ffs-count-num {
        color: #c66;
    }

    .ffs-count-spinner {
        width: 12px;
        height: 12px;
        border: 2px solid #444;
        border-top-color: #888;
        border-radius: 50%;
        animation: ffs-spin 0.8s linear infinite;
    }

    @keyframes ffs-spin {
        to { transform: rotate(360deg); }
    }

    /* Options Section */
    .ffs-options {
        background: rgba(0,0,0,0.2);
        border: 1px solid #333;
        border-radius: 6px;
        overflow: hidden;
        margin-bottom: 16px;
    }

    .ffs-options-header {
        padding: 10px 14px;
        background: rgba(255,255,255,0.03);
        border-bottom: 1px solid #333;
        font-size: 11px;
        font-weight: 600;
        color: #888;
        text-transform: uppercase;
        letter-spacing: 0.5px;
    }

    .ffs-option {
        display: flex;
        align-items: center;
        padding: 12px 14px;
        border-bottom: 1px solid #2a2a2a;
        cursor: pointer;
        transition: background 0.15s;
    }

    .ffs-option:last-child {
        border-bottom: none;
    }

    .ffs-option:hover {
        background: rgba(255,255,255,0.02);
    }

    .ffs-option-text {
        flex: 1;
        margin-left: 12px;
    }

    .ffs-option-title {
        font-size: 12px;
        color: #ddd;
    }

    .ffs-option-desc {
        font-size: 10px;
        color: #666;
        margin-top: 2px;
    }

    .ffs-option-warn {
        color: #c96;
    }

    /* Custom Toggle Switch */
    .ffs-toggle {
        position: relative;
        width: 40px;
        height: 22px;
        flex-shrink: 0;
    }

    .ffs-toggle input {
        opacity: 0;
        width: 0;
        height: 0;
    }

    .ffs-toggle-slider {
        position: absolute;
        cursor: pointer;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: #3a3a3a;
        border-radius: 22px;
        transition: 0.2s;
        border: 1px solid #444;
    }

    .ffs-toggle-slider:before {
        position: absolute;
        content: "";
        height: 16px;
        width: 16px;
        left: 2px;
        bottom: 2px;
        background: #888;
        border-radius: 50%;
        transition: 0.2s;
    }

    .ffs-toggle input:checked + .ffs-toggle-slider {
        background: #4a7c4a;
        border-color: #5a5;
    }

    .ffs-toggle input:checked + .ffs-toggle-slider:before {
        transform: translateX(18px);
        background: #fff;
    }

    /* Footer */
    .ffs-footer {
        display: flex;
        gap: 10px;
        padding: 16px;
        background: rgba(0,0,0,0.2);
        border-top: 1px solid #333;
    }

    .ffs-btn {
        flex: 1;
        padding: 12px 20px;
        border: none;
        border-radius: 6px;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.2s;
    }

    .ffs-btn-primary {
        background: linear-gradient(180deg, #5a9 0%, #4a8 100%);
        color: #fff;
        box-shadow: 0 2px 8px rgba(90, 170, 150, 0.3);
    }

    .ffs-btn-primary:hover {
        background: linear-gradient(180deg, #6ba 0%, #5a9 100%);
        transform: translateY(-1px);
        box-shadow: 0 4px 12px rgba(90, 170, 150, 0.4);
    }

    .ffs-btn-secondary {
        background: #333;
        color: #aaa;
        border: 1px solid #444;
    }

    .ffs-btn-secondary:hover {
        background: #3a3a3a;
        color: #ddd;
    }

    /* Keyboard hints */
    .ffs-kbd-hints {
        display: ${isMobile ? 'none' : 'flex'};
        justify-content: center;
        gap: 16px;
        padding: 12px;
        background: rgba(0,0,0,0.3);
        border-top: 1px solid #333;
    }

    .ffs-kbd-hint {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 10px;
        color: #666;
    }

    .ffs-kbd {
        background: #333;
        padding: 3px 6px;
        border-radius: 3px;
        font-family: monospace;
        font-size: 10px;
        color: #999;
        border: 1px solid #444;
    }

    /* ===== TOAST ===== */
    .ffs-toast {
        position: fixed;
        bottom: ${isMobile ? '80px' : '20px'};
        right: 20px;
        left: ${isMobile ? '20px' : 'auto'};
        padding: 14px 18px;
        border-radius: 8px;
        color: #fff;
        font-size: 13px;
        font-weight: 500;
        z-index: 9999999;
        animation: ffs-slide-in 0.3s ease;
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
        max-width: ${isMobile ? 'none' : '320px'};
    }

    .ffs-toast-success {
        background: linear-gradient(135deg, #4a7c4a 0%, #3a5c3a 100%);
    }

    .ffs-toast-error {
        background: linear-gradient(135deg, #7c4a4a 0%, #5c3a3a 100%);
    }

    .ffs-toast-info {
        background: linear-gradient(135deg, #4a5c7c 0%, #3a4a5c 100%);
    }

    .ffs-toast-warning {
        background: linear-gradient(135deg, #7c6a4a 0%, #5c4a3a 100%);
    }

    @keyframes ffs-slide-in {
        from { transform: translateY(20px); opacity: 0; }
        to { transform: translateY(0); opacity: 1; }
    }

    /* ===== NEW GLASS BUTTON UI ===== */
    .ffs-fab-container {
        position: fixed;
        z-index: 10000;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 6px;
    }

    .ffs-fab-container.hidden {
        display: none !important;
    }

    .ffs-fab {
        width: 28px;
        height: 40px;
        border-radius: 25px;
        background: rgba(15,15,18,0.85);
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        border: 1px solid rgba(255,255,255,0.2);
        box-shadow: 0 4px 12px rgba(0,0,0,0.5);
        color: white;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: transform 0.2s, background 0.2s;
        outline: none;
        font-size: 18px;
        font-weight: bold;
        position: relative;
        user-select: none;
        -webkit-tap-highlight-color: transparent;
    }

    .ffs-fab:hover {
        transform: translateY(-2px);
        background: rgba(25,25,28,0.9);
    }

    .ffs-fab:active {
        transform: scale(0.95);
    }

    .ffs-fab svg.ffs-fab-progress {
        position: absolute;
        top: -4px;
        left: -4px;
        width: calc(100% + 8px);
        height: calc(100% + 8px);
        transform: rotate(-90deg);
        opacity: 0;
        transition: opacity 0.1s;
    }

    .ffs-fab svg.ffs-fab-progress circle {
        fill: none;
        stroke: #fff;
        stroke-width: 3;
        stroke-dasharray: 160;
        stroke-dashoffset: 160;
        stroke-linecap: round;
    }

    .ffs-fab.pressing svg.ffs-fab-progress {
        opacity: 1;
    }

    .ffs-fab.pressing svg.ffs-fab-progress circle {
        animation: ffs-progress-fill 0.5s ease-out forwards;
    }

    @keyframes ffs-progress-fill {
        to { stroke-dashoffset: 0; }
    }

    .ffs-fab-hint {
        position: absolute;
        right: calc(100% + 12px);
        top: 50%;
        transform: translateY(-50%);
        background: #222;
        color: #ddd;
        padding: 10px 14px;
        border-radius: 8px;
        font-size: 12px;
        white-space: nowrap;
        box-shadow: 0 4px 15px rgba(0,0,0,0.5);
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.3s;
        border: 1px solid #444;
    }

    .ffs-fab-hint::after {
        content: '';
        position: absolute;
        right: -6px;
        top: 50%;
        transform: translateY(-50%);
        border: 6px solid transparent;
        border-left-color: #444;
    }

    .ffs-fab-hint.show {
        opacity: 1;
    }

    .ffs-fab-hint.animate {
        animation: ffs-hint-bounce 0.5s ease;
    }

    @keyframes ffs-hint-bounce {
        0%, 100% { transform: translateY(-50%) translateX(0); }
        50% { transform: translateY(-50%) translateX(-5px); }
    }

    .ffs-hint-row {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 4px 0;
    }

    .ffs-hint-action {
        background: #333;
        padding: 2px 8px;
        border-radius: 4px;
        font-size: 10px;
        color: #999;
        min-width: 40px;
        text-align: center;
    }

    .ffs-hint-result {
        color: #ddd;
    }

    .ffs-hint-result.good {
        color: #fc6;
    }

    .ffs-hint-result.menu {
        color: #aaa;
    }

    /* ===== REPOSITION MODE ===== */
    .ffs-fab-container.repositioning {
        cursor: grab;
        z-index: 9999999;
    }

    .ffs-fab-container.repositioning.dragging {
        cursor: grabbing;
    }

    .ffs-fab-container.repositioning .ffs-fab {
        animation: ffs-pulse 1.5s ease-in-out infinite;
        border-color: #6af;
        background: rgba(15,15,18,0.95);
    }

    @keyframes ffs-pulse {
        0%, 100% { box-shadow: 0 0 0 0 rgba(102, 170, 255, 0.5), 0 4px 15px rgba(0, 0, 0, 0.4); }
        50% { box-shadow: 0 0 0 10px rgba(102, 170, 255, 0), 0 4px 15px rgba(0, 0, 0, 0.4); }
    }

    .ffs-reposition-bar {
        position: fixed;
        bottom: 20px;
        left: 50%;
        transform: translateX(-50%);
        background: #1c1c1c;
        border: 1px solid #444;
        border-radius: 12px;
        padding: 12px 20px;
        display: flex;
        align-items: center;
        gap: 16px;
        z-index: 99999999;
        box-shadow: 0 8px 30px rgba(0, 0, 0, 0.6);
        font-family: Arial, Helvetica, sans-serif;
    }

    .ffs-reposition-text {
        color: #ddd;
        font-size: 13px;
    }

    .ffs-reposition-text span {
        color: #6af;
        font-weight: 600;
    }

    .ffs-reposition-btns {
        display: flex;
        gap: 8px;
    }

    .ffs-reposition-btn {
        padding: 8px 16px;
        border: none;
        border-radius: 6px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.2s;
    }

    .ffs-reposition-btn.confirm {
        background: linear-gradient(180deg, #5a9 0%, #4a8 100%);
        color: #fff;
    }

    .ffs-reposition-btn.confirm:hover {
        background: linear-gradient(180deg, #6ba 0%, #5a9 100%);
    }

    .ffs-reposition-btn.cancel {
        background: #333;
        color: #aaa;
        border: 1px solid #444;
    }

    .ffs-reposition-btn.cancel:hover {
        background: #3a3a3a;
        color: #ddd;
    }

    .ffs-reposition-btn.reset {
        background: transparent;
        color: #888;
        padding: 8px 12px;
    }

    .ffs-reposition-btn.reset:hover {
        color: #c66;
    }

    /* ===== TORN SETTINGS MENU TOGGLE ===== */
    .ffs-torn-toggle .icon-wrapper svg {
        fill: #6ac46a;
    }
`);

    // Toast notification
    function showToast(message, type = 'info', duration = 3000) {
        const existing = document.querySelector('.ffs-toast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.className = `ffs-toast ffs-toast-${type}`;
        toast.textContent = message;
        document.body.appendChild(toast);

        setTimeout(() => {
            toast.style.animation = 'ffs-slide-in 0.3s ease reverse';
            setTimeout(() => toast.remove(), 300);
        }, duration);
    }

    // API Key prompt
    function promptApiKey() {
        const config = getConfig();
        const currentKey = config.apiKey || '';

        const newKey = prompt(
            "Enter your FF Scouter API Key (16 characters):\n\nIf you don't have one: \n    Get an api key from: \n        https://www.torn.com/preferences.php#tab=api \n    then register it in: ffscouter.com\n\nTorn PDA users: Leave empty to use automatic key",
            currentKey
        );

        if (newKey === null) return;

        const trimmedKey = newKey.trim();

        if (trimmedKey === '') {
            config.apiKey = '';
            saveConfig(config);
            showToast('Using automatic API key', 'success');
            return;
        }

        if (!/^[a-zA-Z0-9]{16}$/.test(trimmedKey)) {
            showToast('Invalid key format (must be 16 characters)', 'error');
            return;
        }

        config.apiKey = trimmedKey;
        saveConfig(config);
        showToast('API key saved!', 'success');
    }

    function getRandomElement(arr) {
        return arr[Math.floor(Math.random() * arr.length)];
    }

    function shuffleArray(arr) {
        const shuffled = [...arr];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return shuffled;
    }

    // Check target status via Torn API
    function checkTargetStatus(playerId, apiKey) {
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: `https://api.torn.com/v2/user/${playerId}/basic?striptags=true&key=${apiKey}`,
                timeout: 5000,
                onload: function(response) {
                    try {
                        const data = JSON.parse(response.responseText);
                        if (data.error) {
                            resolve({ success: false, error: data.error.error || 'API error' });
                            return;
                        }
                        const state = data.profile?.status?.state;
                        const isOkay = state === 'Okay';
                        resolve({
                            success: true,
                            isOkay,
                            state,
                            status: data.profile?.status
                        });
                    } catch (e) {
                        resolve({ success: false, error: 'Parse error' });
                    }
                },
                onerror: function() {
                    resolve({ success: false, error: 'Request failed' });
                },
                ontimeout: function() {
                    resolve({ success: false, error: 'Timeout' });
                }
            });
        });
    }

    // Fetch target count for preview
    function fetchTargetCount(settings, inactiveOnly, factionlessOnly) {
        return new Promise((resolve) => {
            const { key } = getApiKey();

            const params = new URLSearchParams({
                key: key,
                minff: settings.minFF,
                maxff: settings.maxFF,
                inactiveonly: inactiveOnly ? 1 : 0,
                factionless: factionlessOnly ? 1 : 0,
                limit: 50
            });

            const url = `https://ffscouter.com/api/v1/get-targets?${params.toString()}`;

            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                timeout: 10000,
                onload: function(response) {
                    try {
                        const data = JSON.parse(response.responseText);
                        if (data.error) {
                            resolve({ success: false, error: data.error });
                            return;
                        }
                        const count = data.targets?.length || 0;
                        resolve({ success: true, count });
                    } catch (e) {
                        resolve({ success: false, error: 'Parse error' });
                    }
                },
                onerror: function() {
                    resolve({ success: false, error: 'Request failed' });
                },
                ontimeout: function() {
                    resolve({ success: false, error: 'Timeout' });
                }
            });
        });
    }

    // Find a valid target (with optional status verification)
    async function findValidTarget(targets, apiKey, verifyStatus) {
        if (!verifyStatus) {
            return { target: getRandomElement(targets), checked: 0 };
        }

        const shuffled = shuffleArray(targets);
        let checked = 0;

        for (const target of shuffled) {
            checked++;
            const status = await checkTargetStatus(target.player_id, apiKey);

            if (!status.success) {
                console.warn('FFS: Status check failed:', status.error);
                return { target, checked, verifyFailed: true };
            }

            if (status.isOkay) {
                return { target, checked };
            }

            console.log(`FFS: Target ${target.name} is ${status.state}, trying next...`);
        }

        return { target: null, checked };
    }

    // Main fetch function
    async function fetchTarget() {
        const inHospital = await checkUserInHospital();
        if (inHospital) {
            showToast('You are in hospital – redirecting to faction medical', 'warning', 3000);
            setTimeout(() => {
                window.location.href = FACTION_MEDICAL_URL;
            }, 800);
            return;
        }

        const { key, source } = getApiKey();
        const config = getConfig();
        const settings = config.target;

        const params = new URLSearchParams({
            key: key,
            minff: settings.minFF,
            maxff: settings.maxFF,
            inactiveonly: config.inactiveOnly ? 1 : 0,
            factionless: config.factionlessOnly ? 1 : 0,
            limit: 50
        });

        const url = `https://ffscouter.com/api/v1/get-targets?${params.toString()}`;

        showToast('Finding target...', 'info');

        GM_xmlhttpRequest({
            method: 'GET',
            url: url,
            onload: async function(response) {
                try {
                    const data = JSON.parse(response.responseText);

                    if (data.error) {
                        if (source === 'pda' && (data.error.includes('key') || data.error.includes('API') || data.error.includes('auth'))) {
                            showToast('API key required - not using Torn PDA?', 'error');
                            setTimeout(() => promptApiKey(), 1000);
                        } else {
                            showToast(`Error: ${data.error}`, 'error');
                        }
                        return;
                    }

                    if (!data.targets || data.targets.length === 0) {
                        showToast('No targets found with current filters', 'error');
                        return;
                    }

                    const targetCount = data.targets.length;

                    if (targetCount < 10) {
                        showToast(`Warning: Only ${targetCount} target${targetCount === 1 ? '' : 's'} available. Consider adjusting filters.`, 'warning');
                        await new Promise(r => setTimeout(r, 1500));
                    }

                    const verifyStatus = config.verifyStatus;
                    if (verifyStatus) {
                        showToast('Verifying target status...', 'info');
                    }

                    const result = await findValidTarget(data.targets, key, verifyStatus);

                    if (!result.target) {
                        showToast(`No available targets found (checked ${result.checked})`, 'error');
                        return;
                    }

                    if (result.verifyFailed) {
                        showToast('Status check failed, using unverified target', 'warning');
                        await new Promise(r => setTimeout(r, 1000));
                    }

                    const target = result.target;
                    const attackUrl = `https://www.torn.com/page.php?sid=attack&user2ID=${target.player_id}`;

                    let message = `${target.name} [${target.player_id}] • Lvl ${target.level} • FF ${target.fair_fight.toFixed(2)}`;
                    if (verifyStatus && result.checked > 1) {
                        message += ` (${result.checked} checked)`;
                    }
                    showToast(message, 'success');

                    if (config.openInNewTab) {
                        window.open(attackUrl, '_blank');
                    } else {
                        window.location.href = attackUrl;
                    }
                } catch (e) {
                    showToast('Failed to parse response', 'error');
                    console.error('FFS Error:', e);
                }
            },
            onerror: function(error) {
                showToast('Request failed - check connection', 'error');
                console.error('FFS Error:', error);
            }
        });
    }

    // Reposition mode
    let isRepositioning = false;
    let originalPosition = null;

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
        </div>
    `;
    document.body.appendChild(bar);

    let isDragging = false;
    let startX, startY;
    let startLeft, startTop;

    const getContainerPosition = () => {
        const rect = container.getBoundingClientRect();
        return {
            left: rect.left,
            top: rect.top
        };
    };

    const onDragStart = (e) => {
        e.preventDefault();
        isDragging = true;
        container.classList.add('dragging');

        const pos = getContainerPosition();
        startLeft = pos.left;
        startTop = pos.top;

        if (e.type === 'touchstart') {
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
        } else {
            startX = e.clientX;
            startY = e.clientY;
        }
    };

    const onDragMove = (e) => {
        if (!isDragging) return;
        e.preventDefault();

        let clientX, clientY;
        if (e.type === 'touchmove') {
            clientX = e.touches[0].clientX;
            clientY = e.touches[0].clientY;
        } else {
            clientX = e.clientX;
            clientY = e.clientY;
        }

        const deltaX = clientX - startX;
        const deltaY = clientY - startY;

        let newLeft = startLeft + deltaX;
        let newTop = startTop + deltaY;

        const fabWidth = 28;
        const fabHeight = 40;
        const padding = 2;
        newLeft = Math.max(padding, Math.min(window.innerWidth - fabWidth - padding, newLeft));
        newTop = Math.max(padding, Math.min(window.innerHeight - fabHeight - padding, newTop));

        container.style.left = newLeft + 'px';
        container.style.top = newTop + 'px';
        container.style.right = 'auto';
        container.style.transform = 'none';
    };

    const onDragEnd = () => {
        if (!isDragging) return;
        isDragging = false;
        container.classList.remove('dragging');
    };

    container.addEventListener('mousedown', onDragStart);
    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragEnd);

    container.addEventListener('touchstart', onDragStart, { passive: false });
    document.addEventListener('touchmove', onDragMove, { passive: false });
    document.addEventListener('touchend', onDragEnd);

    const cleanup = () => {
        container.removeEventListener('mousedown', onDragStart);
        document.removeEventListener('mousemove', onDragMove);
        document.removeEventListener('mouseup', onDragEnd);
        container.removeEventListener('touchstart', onDragStart);
        document.removeEventListener('touchmove', onDragMove);
        document.removeEventListener('touchend', onDragEnd);
        document.removeEventListener('keydown', escHandler);
        bar.remove();
        container.classList.remove('repositioning', 'dragging');
        isRepositioning = false;
    };

    const savePosition = () => {
        const rect = container.getBoundingClientRect();
        const config = getConfig();

        const usePercent = config.buttonPosition.isPercent;

        if (usePercent) {
            config.buttonPosition = {
                right: (window.innerWidth - rect.right) / window.innerWidth * 100,
                top: (rect.top / window.innerHeight) * 100,
                isPercent: true
            };
        } else {
            config.buttonPosition = {
                right: window.innerWidth - rect.right,
                top: rect.top,
                isPercent: false
            };
        }

        saveConfig(config);
        applyButtonPosition();
        cleanup();
        showToast('Button position saved!', 'success');
    };

    const cancelReposition = () => {
        applyButtonPosition(originalPosition);
        cleanup();
    };

    const resetPosition = () => {
        const config = getConfig();
        config.buttonPosition = isMobile
            ? { right: 2, top: 218, isPercent: false }
        : { right: 0, top: 27, isPercent: true };
        saveConfig(config);
        applyButtonPosition();
        cleanup();
        showToast('Button position reset!', 'info');
    };

    bar.querySelector('.confirm').addEventListener('click', savePosition);
    bar.querySelector('.cancel').addEventListener('click', cancelReposition);
    bar.querySelector('.reset').addEventListener('click', resetPosition);

    const escHandler = (e) => {
        if (e.key === 'Escape') {
            cancelReposition();
        }
    };
    document.addEventListener('keydown', escHandler);
}

    function applyButtonPosition(customPosition = null) {
        const container = document.querySelector('.ffs-fab-container');
        if (!container) return;

        const config = getConfig();
        const pos = customPosition || config.buttonPosition;

        container.style.left = 'auto';
        container.style.bottom = 'auto';
        container.style.transform = 'none';

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
        if (!container) return;

        const config = getConfig();
        if (config.buttonVisible) {
            container.classList.remove('hidden');
        } else {
            container.classList.add('hidden');
        }
    }

    function injectSettingsToggle() {
        const settingsMenu = document.querySelector('ul.settings-menu');
        if (!settingsMenu || document.getElementById('ffs-button-state')) return;

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
        </label>
    `;

    const settingsLink = settingsMenu.querySelector('li.link a[href="/preferences.php"]');
    if (settingsLink && settingsLink.parentElement) {
        settingsMenu.insertBefore(li, settingsLink.parentElement);
    } else {
        const logoutLink = settingsMenu.querySelector('li.link a[href^="/logout.php"]');
        if (logoutLink && logoutLink.parentElement) {
            settingsMenu.insertBefore(li, logoutLink.parentElement);
        } else {
            settingsMenu.appendChild(li);
        }
    }

    document.getElementById('ffs-button-state').addEventListener('change', (e) => {
        const cfg = getConfig();
        cfg.buttonVisible = e.target.checked;
        saveConfig(cfg);
        updateButtonVisibility();

        if (!e.target.checked) {
            showToast('FF Scouter button hidden. Re-enable from profile menu.', 'info', 4000);
        } else {
            showToast('FF Scouter button visible', 'success');
        }
    });
}

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
                <div class="ffs-api-banner ${isManual ? 'manual' : 'auto'}" id="ffs-api-btn">
                    <svg viewBox="0 0 24 24"><path d="M12.65 10C11.83 7.67 9.61 6 7 6c-3.31 0-6 2.69-6 6s2.69 6 6 6c2.61 0 4.83-1.67 5.65-4H17v4h4v-4h2v-4H12.65zM7 14c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z"/></svg>
                    <div class="ffs-api-banner-text">
                        <div class="ffs-api-banner-title">${isManual ? 'Manual API Key' : 'Automatic (Torn PDA)'}</div>
                        <div class="ffs-api-banner-sub">${isManual ? 'Click to change or use automatic' : 'Click to set manual key instead'}</div>
                    </div>
                    <span class="ffs-api-badge">${isManual ? 'Manual' : 'Auto'}</span>
                </div>

                <div class="ffs-target-card">
                    <div class="ffs-card-header">
                        <div class="ffs-card-icon">🎯</div>
                        <div class="ffs-card-title">
                            <h3>Target Settings</h3>
                            <span>${isMobile ? 'Tap button to find' : 'Press F1 to find'}</span>
                        </div>
                    </div>
                    <div class="ffs-card-body">
                        <div class="ffs-input-row">
                            <span class="ffs-input-label">Fair Fight</span>
                            <div class="ffs-input-group">
                                <input type="number" class="ffs-input" id="ffs-minff" value="${config.target.minFF}" step="0.1" min="1" max="3">
                                <span class="ffs-input-sep">→</span>
                                <input type="number" class="ffs-input" id="ffs-maxff" value="${config.target.maxFF}" step="0.1" min="1" max="3">
                            </div>
                        </div>
                    </div>
                    <div class="ffs-card-count loading" id="ffs-count">
                        <div class="ffs-count-spinner"></div>
                        <span>Checking available targets...</span>
                    </div>
                </div>

                <div class="ffs-options">
                    <div class="ffs-options-header">Filters</div>
                    <label class="ffs-option">
                        <div class="ffs-toggle">
                            <input type="checkbox" id="ffs-inactive" ${config.inactiveOnly ? 'checked' : ''}>
                            <span class="ffs-toggle-slider"></span>
                        </div>
                        <div class="ffs-option-text">
                            <div class="ffs-option-title">Inactive Only</div>
                            <div class="ffs-option-desc">Target players inactive 14+ days</div>
                        </div>
                    </label>
                    <label class="ffs-option">
                        <div class="ffs-toggle">
                            <input type="checkbox" id="ffs-factionless" ${config.factionlessOnly ? 'checked' : ''}>
                            <span class="ffs-toggle-slider"></span>
                        </div>
                        <div class="ffs-option-text">
                            <div class="ffs-option-title">Factionless Only</div>
                            <div class="ffs-option-desc">Target players without a faction</div>
                        </div>
                    </label>
                    <label class="ffs-option">
                        <div class="ffs-toggle">
                            <input type="checkbox" id="ffs-verify" ${config.verifyStatus ? 'checked' : ''}>
                            <span class="ffs-toggle-slider"></span>
                        </div>
                        <div class="ffs-option-text">
                            <div class="ffs-option-title">Verify Status</div>
                            <div class="ffs-option-desc">Check target is okay <span class="ffs-option-warn">(slower)</span></div>
                        </div>
                    </label>
                </div>

                <div class="ffs-options">
                    <div class="ffs-options-header">Behavior</div>
                    <label class="ffs-option">
                        <div class="ffs-toggle">
                            <input type="checkbox" id="ffs-newtab" ${config.openInNewTab ? 'checked' : ''}>
                            <span class="ffs-toggle-slider"></span>
                        </div>
                        <div class="ffs-option-text">
                            <div class="ffs-option-title">Open in New Tab</div>
                            <div class="ffs-option-desc">Open attack page in a new browser tab</div>
                        </div>
                    </label>
                    <div class="ffs-option" id="ffs-move-btn" style="cursor: pointer;">
                        <div style="width: 40px; height: 22px; display: flex; align-items: center; justify-content: center;">
                            <span style="font-size: 18px;">📍</span>
                        </div>
                        <div class="ffs-option-text">
                            <div class="ffs-option-title">Move Button</div>
                            <div class="ffs-option-desc">Drag the floating button to a new position</div>
                        </div>
                    </div>
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
        </div>
    `;

    document.body.appendChild(overlay);

    let countDebounce = null;

    function updateCountDisplay(result) {
        const el = document.getElementById('ffs-count');
        if (!el) return;

        if (!result.success) {
            el.className = 'ffs-card-count error';
            el.innerHTML = `<span class="ffs-count-num">!</span> <span>${result.error}</span>`;
            return;
        }

        const count = result.count;
        let statusClass = 'good';
        let statusText = 'targets available';

        if (count === 0) {
            statusClass = 'error';
            statusText = 'No targets found';
        } else if (count < 10) {
            statusClass = 'warning';
            statusText = count === 1 ? 'target available (very low!)' : 'targets available (low!)';
        } else if (count == 50) {
            statusText = 'targets available (max)';
        }

        el.className = `ffs-card-count ${statusClass}`;
        el.innerHTML = `<span class="ffs-count-num">${count}</span> <span>${statusText}</span>`;
    }

    function setCountLoading() {
        const el = document.getElementById('ffs-count');
        if (!el) return;
        el.className = 'ffs-card-count loading';
        el.innerHTML = '<div class="ffs-count-spinner"></div> <span>Checking...</span>';
    }

    function getFormSettings() {
        return {
            minFF: parseFloat(document.getElementById('ffs-minff').value) || 1,
            maxFF: parseFloat(document.getElementById('ffs-maxff').value) || 3
        };
    }

    function getFormFilters() {
        return {
            inactiveOnly: document.getElementById('ffs-inactive').checked,
            factionlessOnly: document.getElementById('ffs-factionless').checked
        };
    }

    async function refreshCount() {
        setCountLoading();
        const settings = getFormSettings();
        const filters = getFormFilters();
        const result = await fetchTargetCount(settings, filters.inactiveOnly, filters.factionlessOnly);
        updateCountDisplay(result);
    }

    function debouncedRefresh() {
        clearTimeout(countDebounce);
        countDebounce = setTimeout(refreshCount, 300);
    }

    document.getElementById('ffs-minff').addEventListener('blur', debouncedRefresh);
    document.getElementById('ffs-maxff').addEventListener('blur', debouncedRefresh);
    document.getElementById('ffs-minff').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
    document.getElementById('ffs-maxff').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
    document.getElementById('ffs-inactive').addEventListener('change', debouncedRefresh);
    document.getElementById('ffs-factionless').addEventListener('change', debouncedRefresh);

    refreshCount();

    const closePopup = () => {
        clearTimeout(countDebounce);
        overlay.remove();
    };

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closePopup();
    });

    document.getElementById('ffs-close').addEventListener('click', closePopup);
    document.getElementById('ffs-cancel').addEventListener('click', closePopup);
    document.getElementById('ffs-api-btn').addEventListener('click', () => {
        closePopup();
        promptApiKey();
    });

    document.getElementById('ffs-move-btn').addEventListener('click', () => {
        closePopup();
        setTimeout(() => enterRepositionMode(), 100);
    });

    document.getElementById('ffs-save').addEventListener('click', () => {
        const currentConfig = getConfig();

        const newConfig = {
            apiKey: currentConfig.apiKey,
            target: {
                minFF: parseFloat(document.getElementById('ffs-minff').value) || 1.50,
                maxFF: parseFloat(document.getElementById('ffs-maxff').value) || 3.00
            },
            inactiveOnly: document.getElementById('ffs-inactive').checked,
            factionlessOnly: document.getElementById('ffs-factionless').checked,
            verifyStatus: document.getElementById('ffs-verify').checked,
            openInNewTab: document.getElementById('ffs-newtab').checked,
            hasUsedTap: currentConfig.hasUsedTap,
            hasUsedHold: currentConfig.hasUsedHold,
            buttonPosition: currentConfig.buttonPosition,
            buttonVisible: currentConfig.buttonVisible
        };

        if (newConfig.target.minFF > newConfig.target.maxFF) {
            showToast('Min FF cannot exceed Max', 'error');
            return;
        }

        saveConfig(newConfig);
        showToast('Settings saved!', 'success');
        closePopup();
    });

    const escHandler = (e) => {
        if (e.key === 'Escape') {
            closePopup();
            document.removeEventListener('keydown', escHandler);
        }
    };
    document.addEventListener('keydown', escHandler);
}

    function createFloatingButton() {
        const container = document.createElement('div');
        container.className = 'ffs-fab-container';

        const config = getConfig();
        const showInitialHint = !config.hasUsedTap || !config.hasUsedHold;

        container.innerHTML = `
        <div class="ffs-fab" title="Tap: Find Target • Hold: Settings">
            <svg class="ffs-fab-progress" viewBox="0 0 52 52">
                <circle cx="26" cy="26" r="24"/>
            </svg>
            <span style="font-size: 18px; line-height: 1;">🎯</span>
            <div class="ffs-fab-hint ${showInitialHint ? 'show animate' : ''}" id="ffs-hint">
                <div class="ffs-hint-row">
                    <span class="ffs-hint-action">Tap</span>
                    <span class="ffs-hint-result good">🎯 Find Target</span>
                </div>
                <div class="ffs-hint-row">
                    <span class="ffs-hint-action">Hold</span>
                    <span class="ffs-hint-result menu">⚙️ Settings</span>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(container);

    applyButtonPosition();
    updateButtonVisibility();

    const fab = container.querySelector('.ffs-fab');
    const hint = container.querySelector('#ffs-hint');
    let hintTimeout = null;

    function shouldShowHints() {
        const cfg = getConfig();
        return !cfg.hasUsedTap || !cfg.hasUsedHold;
    }

    const hideHint = () => {
        hint.classList.remove('show', 'animate');
    };

    const showHint = (animate = false) => {
        if (shouldShowHints()) {
            hint.classList.add('show');
            if (animate) hint.classList.add('animate');
        }
    };

    if (showInitialHint) {
        hintTimeout = setTimeout(() => {
            hideHint();
        }, isMobile ? 8000 : 6000);
    }

    if (!isMobile) {
        fab.addEventListener('mouseenter', () => {
            if (shouldShowHints()) {
                clearTimeout(hintTimeout);
                showHint(false);
            }
        });
        fab.addEventListener('mouseleave', () => {
            if (!fab.classList.contains('pressing')) {
                hideHint();
            }
        });
    }

    let pressTimer = null;
    let isLongPress = false;
    const LONG_PRESS_DURATION = 500;

    const startPress = (e) => {
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
            if (!cfg.hasUsedHold) {
                cfg.hasUsedHold = true;
                saveConfig(cfg);
            }
        }, LONG_PRESS_DURATION);
    };

    const endPress = (e) => {
        if (isRepositioning) return;
        e.preventDefault();
        fab.classList.remove('pressing');

        if (pressTimer) {
            clearTimeout(pressTimer);
            pressTimer = null;
        }

        if (!isLongPress) {
            const cfg = getConfig();
            if (!cfg.hasUsedTap) {
                cfg.hasUsedTap = true;
                saveConfig(cfg);
            }
            fetchTarget();
        }
    };

    const cancelPress = () => {
        if (isRepositioning) return;
        fab.classList.remove('pressing');
        if (pressTimer) {
            clearTimeout(pressTimer);
            pressTimer = null;
        }
    };

    fab.addEventListener('mousedown', startPress);
    fab.addEventListener('mouseup', endPress);
    fab.addEventListener('mouseleave', cancelPress);

    fab.addEventListener('touchstart', startPress, { passive: false });
    fab.addEventListener('touchend', endPress, { passive: false });
    fab.addEventListener('touchcancel', cancelPress);

    fab.addEventListener('contextmenu', (e) => e.preventDefault());
}

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) {
            return;
        }

        if (isRepositioning) return;

        switch (e.key) {
            case 'F1':
                e.preventDefault();
                fetchTarget();
                break;
            case 'F2':
                e.preventDefault();
                showConfigPopup();
                break;
            case 'F3':
                e.preventDefault();
                promptApiKey();
                break;
        }
    });

    // ==================== INITIALIZATION ====================
    const observer = new MutationObserver(() => {
        injectSettingsToggle();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    createFloatingButton();
    injectSettingsToggle();

    console.log('FF Scouter v3.8 (overlay removed) loaded');

})();
