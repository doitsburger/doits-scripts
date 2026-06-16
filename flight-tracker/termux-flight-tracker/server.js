const http = require('http');
const https = require('https');
const fs = require('fs');
const { exec } = require('child_process');

// ==================== CONFIG ====================
const CONFIG_FILE = './config.json';
const STATE_FILE = './state.json';
const PORT = 3000;
const SCAN_INTERVAL_MS = 20000;
const FACTION_DELAY_MS = 2000;
const LANDED_DISPLAY_MS = 30000;
const STUCK_FLIGHT_BUFFER_MIN = 15;

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

const PLANE_TYPE_MAP = {
  "light_aircraft": "Personal",
  "airliner": "Commercial",
  "private_jet": "Private"
};

// ==================== STATE ====================
let config = { apiKey: '', watchedFactions: {} };
let state = {
  myUserID: null,
  myDestination: null,
  lastScanTime: 0,
  scanTimer: null,
  factions: {}
};

// ==================== HELPERS ====================
function loadFiles() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch(e) { console.error('[CONFIG] Load error:', e.message); }
  
  try {
    if (fs.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      state.myUserID = saved.myUserID || null;
      state.myDestination = saved.myDestination || null;
      state.factions = saved.factions || {};
      state.lastScanTime = saved.lastScanTime || 0;
    }
  } catch(e) { console.error('[STATE] Load error:', e.message); }
}

function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify({
    myUserID: state.myUserID,
    myDestination: state.myDestination,
    factions: state.factions,
    lastScanTime: state.lastScanTime
  }, null, 2));
}

function getFastestDuration(destination, flightType) {
  const base = DEFAULT_DURATIONS[destination]?.[flightType];
  return base ? base * 0.97 : 10;
}

function getSlowestDuration(destination, flightType) {
  const base = DEFAULT_DURATIONS[destination]?.[flightType];
  return base ? base * 1.03 : 10;
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

function tornRequest(urlPath) {
  return new Promise((resolve, reject) => {
    if (!config.apiKey) return reject(new Error('No API key configured'));
    const sep = urlPath.includes('?') ? '&' : '?';
    const url = `https://api.torn.com${urlPath}${sep}key=${config.apiKey}`;
    https.get(url, { headers: { 'Accept': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { reject(new Error('Invalid JSON')); }
      });
    }).on('error', reject);
  });
}

function notify(title, message) {
  exec('which termux-notification', (err) => {
    if (err) {
      console.log(`[NOTIFY] ${title}: ${message}`);
      return;
    }
    const safeTitle = title.replace(/\"/g, '\\"');
    const safeMsg = message.replace(/\"/g, '\\"');
    exec(`termux-notification --title "${safeTitle}" --content "${safeMsg}" --priority high`, (err) => {
      if (err) console.error('[NOTIFY] Failed:', err.message);
    });
  });
}

// ==================== STUCK FLIGHT DETECTOR ====================
function forceLandIfStuck(member) {
  if (member.status !== 'traveling' || !member.travelStarted || !member.lookupDest || !member.flightType) return false;
  const slowest = getSlowestDuration(member.lookupDest, member.flightType);
  const elapsedMin = (Date.now() - member.travelStarted) / 60000;
  if (elapsedMin > (slowest + STUCK_FLIGHT_BUFFER_MIN)) {
    const landedAt = member.travelStarted + (slowest * 60000);
    Object.assign(member, {
      status: 'landed',
      landedAt: landedAt,
      alertPlayed: false
    });
    console.log(`[STUCK] Forced ${member.playerName} to landed. Flight was ${Math.floor(elapsedMin)}min, max allowed ${slowest + STUCK_FLIGHT_BUFFER_MIN}min.`);
    return true;
  }
  return false;
}

// ==================== PROCESSING ====================
async function fetchMyTravelInfo() {
  try {
    const data = await tornRequest('/v2/user/?selections=travel');
    state.myUserID = data.player_id;
    const travel = data.travel || {};
    state.myDestination = (travel.destination && travel.method !== 'Return') ? travel.destination : null;
  } catch(e) {
    console.warn('[USER] Could not fetch travel info:', e.message);
  }
}

function processApiData(fid, data) {
  const faction = config.watchedFactions[fid];
  if (!faction) return 0;
  
  if (!state.factions[fid]) {
    state.factions[fid] = { name: faction.name, members: {} };
  }
  const sFaction = state.factions[fid];
  const members = sFaction.members;
  const apiMembers = data.members || [];
  let travellingCount = 0;
  let stuckFixed = false;

  for (const apiMem of apiMembers) {
    const xid = apiMem.id.toString();
    if (!members[xid]) {
      members[xid] = {
        status: 'idle', playerName: apiMem.name || `User ${xid}`,
        destination: null, flightType: null, travelStarted: null,
        lookupDest: null, origin: null, landedAt: null,
        sameDestination: false, alertPlayed: false
      };
    }
    const member = members[xid];
    member.playerName = apiMem.name;

    if (forceLandIfStuck(member)) {
      stuckFixed = true;
      travellingCount++;
      continue;
    }

    const apiStatus = apiMem.status;
    const isTravelling = apiStatus && apiStatus.state === 'Traveling';

    if (isTravelling) {
      const desc = apiStatus.description || '';
      const match = desc.match(/Traveling from (.+?) to (.+)/);
      if (!match) continue;

      const origin = match[1].trim();
      const dest = match[2].trim();
      const planeType = apiStatus.plane_image_type;
      const flightType = PLANE_TYPE_MAP[planeType] || 'Commercial';
      const lookupDest = dest === 'Torn' ? origin : dest;

      if (member.status === 'landed') {
        member.landedAt = null;
        member.alertPlayed = false;
      }

      const isSameDest = !!(state.myDestination && dest !== 'Torn' && dest === state.myDestination && xid !== (state.myUserID?.toString()));

      if (member.status !== 'traveling') {
        let departureTime;
        if (state.lastScanTime === 0) {
          if (apiMem.last_action && apiMem.last_action.timestamp) {
            departureTime = apiMem.last_action.timestamp * 1000;
            if (departureTime > Date.now()) departureTime = Date.now();
          } else {
            departureTime = Date.now();
          }
        } else {
          departureTime = Math.floor((state.lastScanTime + Date.now()) / 2);
        }
        
        Object.assign(member, {
          status: 'traveling', destination: dest, flightType: flightType,
          travelStarted: departureTime, lookupDest: lookupDest, origin: origin,
          landedAt: null, sameDestination: isSameDest
        });
        
        if (isSameDest) {
          notify(`🚨 ENEMY TRAVEL ALERT`, `${member.playerName} flying to ${dest} (${flightType})`);
          member.alertPlayed = true;
        }
        travellingCount++;
      } else if (member.destination !== dest || member.flightType !== flightType) {
        member.alertPlayed = false;
        let departureTime;
        if (state.lastScanTime > 0) {
          departureTime = Math.floor((state.lastScanTime + Date.now()) / 2);
        } else if (apiMem.last_action && apiMem.last_action.timestamp) {
          departureTime = apiMem.last_action.timestamp * 1000;
          if (departureTime > Date.now()) departureTime = Date.now();
        } else {
          departureTime = Date.now();
        }
        
        Object.assign(member, {
          destination: dest, flightType: flightType, travelStarted: departureTime,
          lookupDest: lookupDest, origin: origin, landedAt: null,
          sameDestination: isSameDest
        });
        
        if (isSameDest) {
          notify(`🚨 ENEMY TRAVEL ALERT`, `${member.playerName} flying to ${dest} (${flightType})`);
          member.alertPlayed = true;
        }
        travellingCount++;
      } else {
        member.sameDestination = isSameDest;
        travellingCount++;
      }
    } else {
      if (member.status === 'traveling') {
        Object.assign(member, { status: 'landed', landedAt: Date.now(), alertPlayed: false });
        travellingCount++;
      } else if (member.status === 'landed') {
        if (Date.now() - member.landedAt > LANDED_DISPLAY_MS) {
          Object.assign(member, {
            status: 'idle', destination: null, flightType: null,
            travelStarted: null, lookupDest: null, origin: null,
            landedAt: null, sameDestination: false, alertPlayed: false
          });
        }
      }
    }
  }

  for (const xid in members) {
    const m = members[xid];
    if (m.status === 'landed' && Date.now() - m.landedAt > LANDED_DISPLAY_MS) {
      Object.assign(m, {
        status: 'idle', destination: null, flightType: null,
        travelStarted: null, lookupDest: null, origin: null,
        landedAt: null, sameDestination: false, alertPlayed: false
      });
    }
  }

  if (stuckFixed) saveState();
  return travellingCount;
}

async function scanAllFactions() {
  await fetchMyTravelInfo();
  const fids = Object.keys(config.watchedFactions);
  
  if (fids.length === 0) {
    state.scanTimer = setTimeout(scanAllFactions, SCAN_INTERVAL_MS);
    return;
  }
  
  console.log(`[${new Date().toLocaleTimeString()}] Scanning ${fids.length} faction(s)...`);
  let totalTravellers = 0;
  
  for (let i = 0; i < fids.length; i++) {
    const fid = fids[i];
    try {
      const data = await tornRequest(`/v2/faction/${fid}/members?striptags=true`);
      totalTravellers += processApiData(fid, data);
    } catch(e) {
      console.warn(`[SCAN] Faction ${fid} failed:`, e.message);
    }
    if (i < fids.length - 1) await new Promise(r => setTimeout(r, FACTION_DELAY_MS));
  }
  
  state.lastScanTime = Date.now();
  saveState();
  console.log(`[SCAN] Complete. ${totalTravellers} travellers across ${fids.length} factions.`);
  
  state.scanTimer = setTimeout(scanAllFactions, SCAN_INTERVAL_MS);
}

setInterval(() => {
  const now = Date.now();
  let stateChanged = false;
  
  for (const fid in state.factions) {
    const members = state.factions[fid].members;
    for (const xid in members) {
      const m = members[xid];
      if (m.status !== 'traveling') continue;
      
      if (forceLandIfStuck(m)) {
        stateChanged = true;
        continue;
      }
      
      const fastest = getFastestDuration(m.lookupDest, m.flightType);
      const fastestETA = m.travelStarted + fastest * 60000;
      const fastestRemaining = Math.max(0, fastestETA - now);
      
      if (fastestRemaining <= 300000 && !m.alertPlayed) {
        notify(`⏰ ${m.playerName} landing soon`, `ETA: ${formatTime(fastestRemaining)} (${m.destination})`);
        m.alertPlayed = true;
        stateChanged = true;
      }
    }
  }
  
  if (stateChanged) saveState();
}, 1000);

function sendJSON(res, data, statusCode = 200) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const method = req.method;
  
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }
  
  if (method === 'GET' && url.pathname === '/api/state') {
    sendJSON(res, {
      apiKeySet: !!config.apiKey,
      myUserID: state.myUserID,
      myDestination: state.myDestination,
      lastScanTime: state.lastScanTime,
      watchedFactions: config.watchedFactions,
      factions: state.factions
    });
    return;
  }
  
  if (method === 'POST' && url.pathname === '/api/apikey') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { key } = JSON.parse(body);
        if (key && key.trim()) {
          config.apiKey = key.trim();
          saveConfig();
          if (!state.scanTimer) {
            state.lastScanTime = 0;
            state.scanTimer = setTimeout(scanAllFactions, 1000);
          }
          sendJSON(res, { success: true });
        } else {
          sendJSON(res, { error: 'Invalid key' }, 400);
        }
      } catch(e) {
        sendJSON(res, { error: 'Invalid JSON' }, 400);
      }
    });
    return;
  }
  
  if (method === 'POST' && url.pathname === '/api/watch') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { fid, name } = JSON.parse(body);
        if (!fid) { sendJSON(res, { error: 'Missing fid' }, 400); return; }
        if (!config.watchedFactions[fid]) {
          config.watchedFactions[fid] = { name: name || `Faction ${fid}`, members: {} };
          state.factions[fid] = { name: config.watchedFactions[fid].name, members: {} };
          saveConfig();
          saveState();
          if (!state.scanTimer) {
            state.lastScanTime = 0;
            state.scanTimer = setTimeout(scanAllFactions, 1000);
          }
        }
        sendJSON(res, { success: true, fid });
      } catch(e) {
        sendJSON(res, { error: 'Invalid JSON' }, 400);
      }
    });
    return;
  }
  
  if (method === 'DELETE' && url.pathname.startsWith('/api/watch/')) {
    const fid = url.pathname.split('/').pop();
    if (config.watchedFactions[fid]) {
      delete config.watchedFactions[fid];
      delete state.factions[fid];
      saveConfig();
      saveState();
    }
    sendJSON(res, { success: true });
    return;
  }
  
  if (method === 'GET' && url.pathname === '/api/health') {
    sendJSON(res, {
      status: 'ok', uptime: process.uptime(),
      apiKeySet: !!config.apiKey,
      watchedCount: Object.keys(config.watchedFactions).length,
      lastScanTime: state.lastScanTime
    });
    return;
  }
  
  sendJSON(res, { error: 'Not found' }, 404);
});

loadFiles();

if (config.apiKey && Object.keys(config.watchedFactions).length > 0) {
  state.scanTimer = setTimeout(scanAllFactions, 1000);
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Torn Travel Tracker Server`);
  console.log(`Listening on http://127.0.0.1:${PORT}`);
  console.log(`API Key: ${config.apiKey ? 'Set' : 'NOT SET'}`);
  console.log(`Factions: ${Object.keys(config.watchedFactions).length}`);
  console.log(`State file: ${STATE_FILE}`);
  console.log(`Config file: ${CONFIG_FILE}`);
});
