// ==UserScript==
// @name         Background Image
// @namespace    https://github.com/doitsburger/doits-scripts
// @version      1.0.0
// @description  Simple background for Torn.com with minimal emoji button
// @author       Torn Player
// @match        https://www.torn.com/*
// @updateURL    https://raw.githubusercontent.com/doitsburger/doits-scripts/main/background-image/background
// @downloadURL  https://raw.githubusercontent.com/doitsburger/doits-scripts/main/background-image/background
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // Settings
    const DEFAULT_OPACITY = 0.3;
    const DEFAULT_BLUR = 0;
    const DEFAULT_BRIGHTNESS = 1;

    // Torn.com dark theme colors (no orange)
    const TORN_COLORS = {
        darkBg: '#0f0f0f',      // Torn dark background
        darkCard: '#1a1a1a',    // Torn card background
        border: '#333333',      // Torn border color (dark gray)
        text: '#d1d1d1',        // Torn text color (light gray)
        inputBg: '#0a0a0a',     // Torn input background
        buttonBg: '#2a2a2a',    // Button background
        buttonText: '#e0e0e0',  // Button text
        buttonHover: '#3a3a3a', // Button hover
        overlay: 'rgba(15, 15, 15, 0.92)' // Overlay background
    };

    // Get saved background URL
    function getSavedBackground() {
        try {
            return GM_getValue('torn_background_url', '');
        } catch (e) {
            return localStorage.getItem('torn_background_url') || '';
        }
    }

    // Save background URL
    function saveBackground(url) {
        try {
            GM_setValue('torn_background_url', url);
        } catch (e) {
            localStorage.setItem('torn_background_url', url);
        }
    }

    // Apply background to page
    function applyBackground(url) {
        removeBackground();

        if (!url) return;

        const bg = document.createElement('div');
        bg.id = 'torn-custom-bg';
        bg.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100vw;
            height: 100vh;
            background-image: url('${url}');
            background-size: cover;
            background-position: center;
            background-repeat: no-repeat;
            background-attachment: fixed;
            opacity: ${DEFAULT_OPACITY};
            filter: blur(${DEFAULT_BLUR}px) brightness(${DEFAULT_BRIGHTNESS});
            z-index: -9999;
            pointer-events: none;
        `;

        document.body.appendChild(bg);
    }

    // Remove background
    function removeBackground() {
        const existing = document.getElementById('torn-custom-bg');
        if (existing) existing.remove();
    }

    // Show mobile-friendly setup prompt
    function showSetupPrompt() {
        const existingPrompt = document.getElementById('torn-bg-prompt');
        if (existingPrompt) existingPrompt.remove();

        // Create overlay
        const overlay = document.createElement('div');
        overlay.id = 'torn-bg-prompt';
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: ${TORN_COLORS.overlay};
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 10000;
            padding: 20px;
            box-sizing: border-box;
        `;

        // Create container - mobile responsive
        const container = document.createElement('div');
        container.style.cssText = `
            background: ${TORN_COLORS.darkCard};
            padding: 25px;
            border-radius: 8px;
            border: 1px solid ${TORN_COLORS.border};
            width: 100%;
            max-width: 350px;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
        `;

        // Add input and button
        container.innerHTML = `
            <input type="text" id="bg-url-input"
                   placeholder="Insert image URL"
                   style="
                       width: 100%;
                       padding: 15px;
                       margin-bottom: 20px;
                       border: 1px solid ${TORN_COLORS.border};
                       border-radius: 6px;
                       background: ${TORN_COLORS.inputBg};
                       color: ${TORN_COLORS.text};
                       font-size: 16px;
                       box-sizing: border-box;
                       outline: none;
                   ">
            <button id="bg-save-btn" style="
                       width: 100%;
                       padding: 15px;
                       background: ${TORN_COLORS.buttonBg};
                       color: ${TORN_COLORS.buttonText};
                       border: 1px solid ${TORN_COLORS.border};
                       border-radius: 6px;
                       font-weight: 500;
                       cursor: pointer;
                       font-size: 16px;
                       outline: none;
                       box-sizing: border-box;
                   ">
                Save Background
            </button>
        `;

        overlay.appendChild(container);
        document.body.appendChild(overlay);

        // Focus input
        setTimeout(() => {
            const input = document.getElementById('bg-url-input');
            input.focus();

            // Add focus style
            input.addEventListener('focus', function() {
                this.style.borderColor = '#555';
                this.style.boxShadow = '0 0 0 2px rgba(85, 85, 85, 0.2)';
            });

            input.addEventListener('blur', function() {
                this.style.borderColor = TORN_COLORS.border;
                this.style.boxShadow = 'none';
            });
        }, 100);

        // Save button click
        const saveBtn = document.getElementById('bg-save-btn');
        saveBtn.addEventListener('click', () => {
            const url = document.getElementById('bg-url-input').value.trim();
            if (url) {
                saveBackground(url);
                applyBackground(url);
                overlay.remove();
                showChangeButton();
            }
        });

        // Add hover effect to button
        saveBtn.addEventListener('mouseenter', () => {
            saveBtn.style.background = TORN_COLORS.buttonHover;
            saveBtn.style.borderColor = '#444';
        });

        saveBtn.addEventListener('mouseleave', () => {
            saveBtn.style.background = TORN_COLORS.buttonBg;
            saveBtn.style.borderColor = TORN_COLORS.border;
        });

        // Add active effect to button
        saveBtn.addEventListener('mousedown', () => {
            saveBtn.style.transform = 'scale(0.98)';
        });

        saveBtn.addEventListener('mouseup', () => {
            saveBtn.style.transform = 'scale(1)';
        });

        // Enter key to save
        document.getElementById('bg-url-input').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                saveBtn.click();
            }
        });

        // Click outside to exit
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                overlay.remove();
            }
        });

        // Escape key to exit
        document.addEventListener('keydown', function escHandler(e) {
            if (e.key === 'Escape') {
                overlay.remove();
                document.removeEventListener('keydown', escHandler);
            }
        });
    }

    // Show change button - MINIMAL EMOJI ONLY
    function showChangeButton() {
        const existingBtn = document.getElementById('torn-bg-change-btn');
        if (existingBtn) existingBtn.remove();

        const btn = document.createElement('button');
        btn.id = 'torn-bg-change-btn';
        btn.innerHTML = '🖼️';
        btn.title = 'Change Background';
        btn.style.cssText = `
            position: fixed;
            bottom: 40px;
            right: 2px;
            width: 28px;
            height: 28px;
            background: none;
            color: ${TORN_COLORS.text};
            border: none;
            font-size: 20px;
            cursor: pointer;
            z-index: 9999;
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: 0.6;
            outline: none;
            padding: 0;
            margin: 0;
            border-radius: 0;
            box-shadow: none;
        `;

        // Mobile touch-friendly
        btn.addEventListener('touchstart', () => {
            btn.style.opacity = '1';
            btn.style.transform = 'scale(1.1)';
        });

        btn.addEventListener('touchend', () => {
            btn.style.opacity = '0.6';
            btn.style.transform = 'scale(1)';
        });

        // Desktop hover
        btn.addEventListener('mouseenter', () => {
            btn.style.opacity = '1';
            btn.style.transform = 'scale(1.1)';
        });

        btn.addEventListener('mouseleave', () => {
            btn.style.opacity = '0.6';
            btn.style.transform = 'scale(1)';
        });

        // Click to show prompt
        btn.addEventListener('click', showSetupPrompt);

        document.body.appendChild(btn);
    }

    // Initialize
    function init() {
        const savedUrl = getSavedBackground();

        if (savedUrl) {
            applyBackground(savedUrl);
            // Show change button after a delay
            setTimeout(showChangeButton, 1000);
        } else {
            // Show setup prompt after page loads
            setTimeout(showSetupPrompt, 1500);
        }

        // Handle Torn's AJAX navigation
        let lastUrl = location.href;
        const observer = new MutationObserver(() => {
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                setTimeout(() => {
                    const url = getSavedBackground();
                    if (url) {
                        applyBackground(url);
                        // Ensure button is shown after navigation
                        if (!document.getElementById('torn-bg-change-btn')) {
                            showChangeButton();
                        }
                    }
                }, 100);
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });
    }

    // Add mobile viewport handling
    function addMobileStyles() {
        const style = document.createElement('style');
        style.id = 'torn-bg-mobile-styles';
        style.textContent = `
            /* Mobile optimizations */
            @media (max-width: 768px) {
                #torn-bg-change-btn {
                    font-size: 22px;
                    width: 30px;
                    height: 30px;
                }

                #torn-bg-prompt {
                    padding: 15px;
                }

                #torn-bg-prompt > div {
                    padding: 20px;
                    max-width: 95%;
                }

                #bg-url-input {
                    padding: 14px;
                    font-size: 15px;
                }

                #bg-save-btn {
                    padding: 14px;
                    font-size: 15px;
                }
            }

            @media (max-width: 480px) {
                #torn-bg-change-btn {
                    font-size: 20px;
                }

                #torn-bg-prompt > div {
                    padding: 18px;
                }
            }

            /* Smooth transitions */
            #torn-bg-change-btn {
                transition: all 0.2s ease;
            }

            #bg-url-input, #bg-save-btn {
                transition: all 0.2s ease;
            }
        `;
        document.head.appendChild(style);
    }

    // Start when page loads
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            addMobileStyles();
            init();
        });
    } else {
        addMobileStyles();
        init();
    }

})();
