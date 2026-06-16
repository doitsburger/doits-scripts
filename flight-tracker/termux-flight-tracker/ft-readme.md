# ✈️ Torn Travel Tracker – Android Setup Guide

Runs a 24/7 background server on your phone that polls Torn APIs every 20 seconds and sends native notifications when enemies fly to your destination or land soon.

---

## What This Does

- Runs a persistent background server on your Android phone using Termux.
- Polls Torn APIs every 20 seconds — works even when your browser is closed.
- Sends native Android notifications for enemies travelling to your destination or landing soon.
- Provides a lightweight browser userscript that reads from the local server.

---

## Prerequisites

| App | Where to Get It |
|-----|----------------|
| Termux | [F-Droid](https://f-droid.org/en/packages/com.termux/) (NOT Google Play) |
| Termux:API | [F-Droid](https://f-droid.org/en/packages/com.termux.api/) |
| Kiwi Browser or Firefox | Google Play or F-Droid |
| Tampermonkey | Browser Extension Store |

> ⚠️ **Important:** Install Termux and Termux:API from F-Droid. The Google Play versions are deprecated and do not work correctly.

---

## Table of Contents

- [Install Termux & Termux:API](#install-termux--termuxapi)
- [Disable Android Battery Kill](#disable-android-battery-kill)
- [Install Node.js](#install-nodejs)
- [Create the Server Directory](#create-the-server-directory)
- [Create "server.js"](#create-serverjs)
- [Set Your API Key](#set-your-api-key)
- [Start the Server](#start-the-server)
- [Verify the Server](#verify-the-server)
- [Install the Browser Userscript](#install-the-browser-userscript)
- [Using the Tracker](#using-the-tracker)
- [Making It Persistent (Background Mode)](#making-it-persistent-background-mode)
- [Auto‑Start on Boot](#auto-start-on-boot)
- [Updating the Server](#updating-the-server)
- [Troubleshooting](#troubleshooting)
- [Quick Command Reference](#quick-command-reference)

---

## Install Termux & Termux:API

1. Download and install both apps from F-Droid.
2. Open Termux.
3. Run the initial setup:

   ```bash
   pkg update && pkg upgrade -y
   ```

   Type `y` and press Enter when prompted.

---

## Disable Android Battery Kill

Android will often kill background applications to save battery. You must prevent this for Termux.

**Steps**

- Open **Android Settings → Apps → Termux**
- Tap **Battery → Unrestricted** (or **Don't Optimize**)
- Repeat for **Termux:API**

**Additional Steps (Samsung, Xiaomi, OnePlus, etc.)**

- Open Termux in **Recent Apps**
- Tap the app icon
- Select **Lock**
- Disable **Put unused apps to sleep**

---

## Install Node.js

In Termux, run:

```bash
pkg install nodejs termux-api -y
```

Verify installation:

```bash
node --version
```

Expected output: `v18+` or `v20+`.

---

## Create the Server Directory

```bash
mkdir -p ~/torn-tracker && cd ~/torn-tracker
```

---

## Create "server.js"

Create the server file:

```bash
nano server.js
```

Delete anything already in the file and paste the complete server code from:  
[https://github.com/doitsburger/doits-scripts/blob/main/flight-tracker/termux-flight-tracker/server.js](https://github.com/doitsburger/doits-scripts/blob/main/flight-tracker/termux-flight-tracker/server.js)

- `Ctrl + O` → Enter
- `Ctrl + X`

---

## Set Your API Key

Create the configuration file:

```bash
nano config.json
```

Paste:

```json
{ "apiKey": "YOUR_API_KEY", "watchedFactions": {} }
```

Save and exit Nano.

---

## Start the Server

```bash
cd ~/torn-tracker
termux-wake-lock
nohup node server.js > tracker.log 2>&1 &
```

---

## Verify the Server

Run:

```bash
curl http://127.0.0.1:3000/api/health
```

Expected output:

```json
{ "status": "ok", "uptime": 12345, "apiKeySet": true, "watchedCount": 0, "lastScanTime": 1234567890 }
```

---

## Install the Browser Userscript

1. Open **Kiwi Browser** or **Firefox**.
2. Install [Tampermonkey](https://www.tampermonkey.net/).
3. Install the userscript from:  
   `https://raw.githubusercontent.com/doitsburger/doits-scripts/main/flight-tracker/termux-flight-tracker/termux-flight-tracker.js`

---

## Using the Tracker

- Visit any faction profile page.
- Use the userscript to watch factions.
- The server scans every 20 seconds.
- Receive Android notifications when:
  - Enemies fly to your destination.
  - Enemies are landing soon.

**Status Indicators**

| Status | Meaning |
|--------|---------|
| 🟢 Green | Server online, API key configured |
| 🟠 Orange | Server online, API key missing |
| 🔴 Red | Server offline |

---

## Making It Persistent (Background Mode)

Start in background:

```bash
cd ~/torn-tracker
termux-wake-lock
nohup node server.js > tracker.log 2>&1 &
```

Check if running:

```bash
ps aux | grep node
```

View logs:

```bash
tail -f ~/torn-tracker/tracker.log
```

Stop the server:

```bash
killall node
```

Force stop if required:

```bash
kill -9 $(ps aux | grep "server.js" | grep -v grep | awk '{print $2}')
```

---

## Auto‑Start on Boot

1. **Install Termux:Boot** from F-Droid.

2. **Create Boot Script**

   ```bash
   mkdir -p ~/.termux/boot
   nano ~/.termux/boot/start-tracker.sh
   ```

   Paste:

   ```bash
   #!/data/data/com.termux/files/usr/bin/bash
   termux-wake-lock
   cd ~/torn-tracker
   nohup node server.js > tracker.log 2>&1 &
   ```

   Make executable:

   ```bash
   chmod +x ~/.termux/boot/start-tracker.sh
   ```

3. Finally, open **Termux:Boot** once.

---

## Updating the Server

```bash
killall node
cd ~/torn-tracker
cp state.json state.json.backup
cp config.json config.json.backup
nano server.js
```

Paste the updated version and save.  
Restart:

```bash
termux-wake-lock
nohup node server.js > tracker.log 2>&1 &
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Local Server Offline | Start the server again in Termux |
| No notifications | Test with `termux-notification` |
| Failed to watch faction | API key missing or server offline |
| Server won't stop | Use the `kill -9` command |
| High battery usage | Increase `SCAN_INTERVAL_MS` |
| Termux keeps getting killed | Disable battery optimisation |
| Players stuck landing | Latest `server.js` fixes this automatically |

---

## Quick Command Reference

| Task | Command |
|------|---------|
| Start server (foreground) | `cd ~/torn-tracker && node server.js` |
| Start server (background) | `nohup node server.js > tracker.log 2>&1 &` |
| Check if running | `ps aux | grep node` |
| View logs | `tail -f ~/torn-tracker/tracker.log` |
| Stop server | `killall node` |
| Health check | `curl http://127.0.0.1:3000/api/health` |
| Reset data | `rm ~/torn-tracker/state.json` |
| Edit config | `nano ~/torn-tracker/config.json` |

---

🎉 **Enjoy Never Missing an Enemy Flight Again!**  
Your Torn Travel Tracker is now running 24/7, scanning for hostile travel activity and delivering native Android alerts directly to your device.

✈️🔔
