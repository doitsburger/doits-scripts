Torn Travel Tracker

Android Setup Guide

Runs a 24/7 background server on your phone that polls Torn APIs every 20 seconds and sends native notifications when enemies fly to your destination or land soon.

What This Does

Runs a persistent background server on your Android phone using Termux

Polls Torn APIs every 20 seconds – works even when your browser is closed

Sends native Android notifications for enemies travelling to your destination or landing soon

Provides a lightweight browser userscript that reads from the local server

Prerequisites

App

Where to Get It

Termux

F-Droid (NOT Google Play)

Termux:API

F-Droid

Kiwi Browser or Firefox

Google Play or F-Droid

Tampermonkey

Browser extension store

⚠️ Important: Install Termux and Termux:API from F-Droid. The Google Play versions are broken and deprecated.

Table of Contents

Install Termux & Termux:API

Disable Android Battery Kill

Install Node.js

Create the Server Directory

Create server.js

Set Your API Key

Start the Server

Verify the Server

Install the Browser Userscript

Using the Tracker

Making It Persistent (Background Mode)

Auto-Start on Boot

Updating the Server

Troubleshooting

Quick Command Reference

1. Install Termux & Termux:API

Download and install both apps from the F-Droid links above.

Open Termux.

Run the initial setup:

pkg update && pkg upgrade -y

Type y and press Enter when prompted.

2. Disable Android Battery Kill

Android will kill Termux to save battery. You must stop this.

Open Android Settings → Apps → Termux

Tap Battery → Unrestricted (or Don't optimize)

Repeat for Termux:API

Additional steps for Samsung/Xiaomi/OnePlus/etc:

Open Termux in recent apps → tap the app icon → Lock

Disable Put unused apps to sleep

3. Install Node.js

In Termux, run:

pkg install nodejs termux-api -y

Verify:

node --version

Should show v18+ or v20+.

4. Create the Server Directory

mkdir -p ~/torn-tracker && cd ~/torn-tracker

5. Create server.js

Run:

nano server.js

Delete anything in the file (Ctrl+K repeatedly), then paste the full server code.

Save and exit nano:

Ctrl+O

Enter

Ctrl+X

6. Set Your API Key

You can do this now or later via the browser.

nano config.json

Paste:

{
  "apiKey": "YOUR_API_KEY",
  "watchedFactions": {}
}

Save and exit.

7. Start the Server

cd ~/torn-tracker
termux-wake-lock
nohup node server.js > tracker.log 2>&1 &

8. Verify the Server

curl http://127.0.0.1:3000/api/health

Expected output:

{"status":"ok","uptime":...,"apiKeySet":true,"watchedCount":0,"lastScanTime":...}

9. Install the Browser Userscript

Open Kiwi Browser or Firefox.

Install Tampermonkey.

Create a new userscript that connects to:

http://127.0.0.1:3000/api/state

POST /api/apikey

POST /api/watch

DELETE /api/watch/:fid

10. Using the Tracker

Visit any faction profile page.

Use your userscript to watch factions.

Server scans every 20 seconds.

You receive Android notifications for:

Enemies flying to your destination

Enemies landing soon

Status dot colors:

🟢 Green – Server online, API key set

🟠 Orange – Server online, no API key

🔴 Red – Server offline

11. Making It Persistent (Background Mode)

cd ~/torn-tracker
termux-wake-lock
nohup node server.js > tracker.log 2>&1 &

Check if running:

ps aux | grep node

View logs:

tail -f ~/torn-tracker/tracker.log

Stop server:

killall node

If needed:

kill -9 $(ps aux | grep "server.js" | grep -v grep | awk '{print $2}')

12. Auto-Start on Boot

Install Termux:Boot from F-Droid.

Create boot script:

mkdir -p ~/.termux/boot
nano ~/.termux/boot/start-tracker.sh

Paste:

#!/data/data/com.termux/files/usr/bin/bash
termux-wake-lock
cd ~/torn-tracker
nohup node server.js > tracker.log 2>&1 &

Make executable:

chmod +x ~/.termux/boot/start-tracker.sh

Open Termux:Boot once.

13. Updating the Server

killall node
cd ~/torn-tracker
cp state.json state.json.backup
cp config.json config.json.backup
nano server.js
# paste new version
termux-wake-lock
nohup node server.js > tracker.log 2>&1 &

14. Troubleshooting

Problem

Fix

"Local Server Offline"

Start server again in Termux

No notifications

Test with termux-notification

"Failed to watch faction"

API key missing or server offline

Server won't stop

Use the kill -9 command

High battery usage

Increase SCAN_INTERVAL_MS

Termux killed

Disable battery optimization

Stuck landing

Latest server.js fixes automatically

15. Quick Command Reference

Task

Command

Start server (foreground)

cd ~/torn-tracker && node server.js

Start server (background)

nohup node server.js > tracker.log 2>&1 &

Check if running

`ps aux

grep node`

View logs

tail -f ~/torn-tracker/tracker.log

Stop server

killall node

Health check

curl http://127.0.0.1:3000/api/health

Reset data

rm ~/torn-tracker/state.json

Edit config

nano ~/torn-tracker/config.json

Enjoy never missing an enemy flight again! ✈️🔔
