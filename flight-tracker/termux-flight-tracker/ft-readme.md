✈️ Torn Travel Tracker

Android Setup Guide

Runs a 24/7 background server on your phone that polls Torn APIs every 20 seconds and sends native notifications when enemies fly to your destination or land soon.

---

What This Does

- Runs a persistent background server on your Android phone using Termux.
- Polls Torn APIs every 20 seconds — works even when your browser is closed.
- Sends native Android notifications for enemies travelling to your destination or landing soon.
- Provides a lightweight browser userscript that reads from the local server.

---

Prerequisites

App| Where to Get It
Termux| F-Droid (NOT Google Play)
Termux:API| F-Droid
Kiwi Browser or Firefox| Google Play or F-Droid
Tampermonkey| Browser Extension Store

«⚠️ Important: Install Termux and Termux:API from F-Droid. The Google Play versions are deprecated and do not work correctly.»

---

Table of Contents

1. Install Termux & Termux:API
2. Disable Android Battery Kill
3. Install Node.js
4. Create the Server Directory
5. Create "server.js"
6. Set Your API Key
7. Start the Server
8. Verify the Server
9. Install the Browser Userscript
10. Using the Tracker
11. Making It Persistent (Background Mode)
12. Auto-Start on Boot
13. Updating the Server
14. Troubleshooting
15. Quick Command Reference

---

1. Install Termux & Termux:API

1. Download and install both apps from F-Droid.
2. Open Termux.
3. Run the initial setup:

pkg update && pkg upgrade -y

Type y and press Enter when prompted.

---

2. Disable Android Battery Kill

Android will often kill background applications to save battery. You must prevent this for Termux.

Steps

1. Open Android Settings → Apps → Termux
2. Tap Battery → Unrestricted (or Don't Optimize)
3. Repeat for Termux:API

Additional Steps (Samsung, Xiaomi, OnePlus, etc.)

- Open Termux in Recent Apps
- Tap the app icon
- Select Lock
- Disable Put unused apps to sleep

---

3. Install Node.js

In Termux, run:

pkg install nodejs termux-api -y

Verify installation:

node --version

Expected output:

v18+

or

v20+

---

4. Create the Server Directory

mkdir -p ~/torn-tracker && cd ~/torn-tracker

---

5. Create server.js

Create the server file:

nano server.js

Delete anything already in the file and paste the complete server code.

Save and Exit Nano

- Ctrl + O
- Enter
- Ctrl + X

---

6. Set Your API Key

Create the configuration file:

nano config.json

Paste:

{
  "apiKey": "YOUR_API_KEY",
  "watchedFactions": {}
}

Save and exit Nano.

---

7. Start the Server

cd ~/torn-tracker
termux-wake-lock
nohup node server.js > tracker.log 2>&1 &

---

8. Verify the Server

Run:

curl http://127.0.0.1:3000/api/health

Expected output:

{
  "status": "ok",
  "uptime": 12345,
  "apiKeySet": true,
  "watchedCount": 0,
  "lastScanTime": 1234567890
}

---

9. Install the Browser Userscript

1. Open Kiwi Browser or Firefox.
2. Install Tampermonkey.
3. Create a new userscript that communicates with:

GET    http://127.0.0.1:3000/api/state
POST   /api/apikey
POST   /api/watch
DELETE /api/watch/:fid

---

10. Using the Tracker

1. Visit any faction profile page.
2. Use the userscript to watch factions.
3. The server scans every 20 seconds.
4. Receive Android notifications when:
   - Enemies fly to your destination.
   - Enemies are landing soon.

Status Indicators

Status| Meaning
🟢 Green| Server online, API key configured
🟠 Orange| Server online, API key missing
🔴 Red| Server offline

---

11. Making It Persistent (Background Mode)

Start in background:

cd ~/torn-tracker
termux-wake-lock
nohup node server.js > tracker.log 2>&1 &

Check if running:

ps aux | grep node

View logs:

tail -f ~/torn-tracker/tracker.log

Stop the server:

killall node

Force stop if required:

kill -9 $(ps aux | grep "server.js" | grep -v grep | awk '{print $2}')

---

12. Auto-Start on Boot

Install Termux:Boot

Install Termux:Boot from F-Droid.

Create Boot Script

mkdir -p ~/.termux/boot
nano ~/.termux/boot/start-tracker.sh

Paste:

#!/data/data/com.termux/files/usr/bin/bash

termux-wake-lock
cd ~/torn-tracker
nohup node server.js > tracker.log 2>&1 &

Make executable:

chmod +x ~/.termux/boot/start-tracker.sh

Finally, open Termux:Boot once.

---

13. Updating the Server

killall node

cd ~/torn-tracker

cp state.json state.json.backup
cp config.json config.json.backup

nano server.js

Paste the updated version and save.

Restart:

termux-wake-lock
nohup node server.js > tracker.log 2>&1 &

---

14. Troubleshooting

Problem| Fix
Local Server Offline| Start the server again in Termux
No notifications| Test with "termux-notification"
Failed to watch faction| API key missing or server offline
Server won't stop| Use the "kill -9" command
High battery usage| Increase "SCAN_INTERVAL_MS"
Termux keeps getting killed| Disable battery optimisation
Players stuck landing| Latest "server.js" fixes this automatically

---

15. Quick Command Reference

Task| Command
Start server (foreground)| "cd ~/torn-tracker && node server.js"
Start server (background)| "nohup node server.js > tracker.log 2>&1 &"
Check if running| "ps aux | grep node"
View logs| "tail -f ~/torn-tracker/tracker.log"
Stop server| "killall node"
Health check| "curl http://127.0.0.1:3000/api/health"
Reset data| "rm ~/torn-tracker/state.json"
Edit config| "nano ~/torn-tracker/config.json"

---

🎉 Enjoy Never Missing an Enemy Flight Again!

Your Torn Travel Tracker is now running 24/7, scanning for hostile travel activity and delivering native Android alerts directly to your device.

✈️🔔
