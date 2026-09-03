import { DurableObject } from "cloudflare:workers";
async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);

  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

function createInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(12);

  crypto.getRandomValues(bytes);

  let code = '';

  for (let i = 0; i < bytes.length; i++) {
    code += chars[bytes[i] % chars.length];
  }

  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}`;
}

function createClientSecret() {
  const bytes = new Uint8Array(32);

  crypto.getRandomValues(bytes);

  return [...bytes]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function authenticateClient(request, env, options={}) {
  const suppliedId=String(
    request.headers.get('X-Client-ID') || ''
  ).trim();

  const suppliedSecret=String(
    request.headers.get('X-Client-Secret') || ''
  ).trim();

  if(!suppliedId || !suppliedSecret){
    return null;
  }

  const secretHash=await sha256Hex(suppliedSecret);

  let device=null;
  let accountClientId=suppliedId;

  if(suppliedId.startsWith('dev_')){
    device=await env.DB
      .prepare(`
        SELECT
          device_id,
          client_id,
          secret_hash,
          active,
          last_seen_at
        FROM client_devices
        WHERE device_id=?
        LIMIT 1
      `)
      .bind(suppliedId)
      .first();

    if(!device){
      return null;
    }
  }

  if(device){
    if(Number(device.active)!==1){
      return null;
    }

    if(device.secret_hash!==secretHash){
      return null;
    }

    accountClientId=String(
      device.client_id || ''
    ).trim();

    if(!accountClientId){
      return null;
    }
  }

  const client=await env.DB
    .prepare(`
      SELECT
        client_id,
        label,
        active,
        secret_hash,
        last_seen_at,
        role,
        torn_user_id,
        torn_name,
        own_faction_id,
        max_watched_factions,
        max_tracked_individuals,
        max_combined_trackers,
        max_torn_requests_per_minute,
        api_key_validated_at,
        access_type,
        access_status,
        registered_faction_id,
        faction_mismatch_since,
        access_suspended_at,
        access_last_checked_at,
        CASE
          WHEN api_key_ciphertext IS NOT NULL
           AND api_key_iv IS NOT NULL
          THEN 1
          ELSE 0
        END AS api_key_configured
      FROM clients
      WHERE client_id=?
      LIMIT 1
    `)
    .bind(accountClientId)
    .first();

  if(!client){
    return null;
  }

  if(Number(client.active)!==1){
    return null;
  }

  if(!device && client.secret_hash!==secretHash){
    return null;
  }

  const accessStatus=String(
    client.access_status || 'active'
  );

  if(
    accessStatus==='pending' &&
    options?.allowPending!==true
  ){
    return null;
  }

  const now=Date.now();
  const LAST_SEEN_INTERVAL_MS=15*60*1000;

  const accountLastSeen=
    client.last_seen_at==null
      ? null
      : Number(client.last_seen_at);

  if(
    !accountLastSeen ||
    now-accountLastSeen>=LAST_SEEN_INTERVAL_MS
  ){
    await env.DB
      .prepare(`
        UPDATE clients
        SET last_seen_at=?
        WHERE client_id=?
      `)
      .bind(now,client.client_id)
      .run();
  }

  if(device){
    const deviceLastSeen=
      device.last_seen_at==null
        ? null
        : Number(device.last_seen_at);

    if(
      !deviceLastSeen ||
      now-deviceLastSeen>=LAST_SEEN_INTERVAL_MS
    ){
      await env.DB
        .prepare(`
          UPDATE client_devices
          SET last_seen_at=?
          WHERE device_id=?
            AND active=1
        `)
        .bind(now,device.device_id)
        .run();
    }
  }

  return {
    clientId:client.client_id,
    label:client.label,
    role:client.role || 'user',
    tornUserId:client.torn_user_id || null,
    tornName:client.torn_name || null,
    ownFactionId:client.own_faction_id || null,
    maxWatchedFactions:Number(
      client.max_watched_factions || 10
    ),
    maxTrackedIndividuals:Number(
      client.max_tracked_individuals || 20
    ),
    maxCombinedTrackers:Number(
      client.max_combined_trackers || 25
    ),
    maxTornRequestsPerMinute:Number(
      client.max_torn_requests_per_minute || 60
    ),
    apiKeyConfigured:
      Number(client.api_key_configured || 0)===1,
    apiKeyValidatedAt:
      client.api_key_validated_at || null,
    accessType:
      client.access_type || 'legacy',
    accessStatus:
      client.access_status || 'active',
    registeredFactionId:
      client.registered_faction_id==null
        ? null
        : String(client.registered_faction_id),
    factionMismatchSince:
      client.faction_mismatch_since==null
        ? null
        : Number(client.faction_mismatch_since),
    accessSuspendedAt:
      client.access_suspended_at==null
        ? null
        : Number(client.access_suspended_at),
    accessLastCheckedAt:
      client.access_last_checked_at==null
        ? null
        : Number(client.access_last_checked_at)
  };
}


function base64ToBytes(value) {
  const binary=atob(String(value || '').trim());
  const bytes=new Uint8Array(binary.length);
  for(let i=0;i<binary.length;i++) bytes[i]=binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(value) {
  const bytes=value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary='';
  for(let i=0;i<bytes.length;i++) binary+=String.fromCharCode(bytes[i]);
  return btoa(binary);
}

async function getApiEncryptionKey(env) {
  const raw=base64ToBytes(env.API_ENCRYPTION_KEY);
  if(raw.byteLength!==32) throw new Error('API_ENCRYPTION_KEY must decode to 32 bytes');

  return crypto.subtle.importKey(
    'raw',
    raw,
    {name:'AES-GCM'},
    false,
    ['encrypt','decrypt']
  );
}

async function encryptApiKey(apiKey, clientId, env) {
  const key=await getApiEncryptionKey(env);
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const plaintext=new TextEncoder().encode(String(apiKey));
  const additionalData=new TextEncoder().encode(String(clientId));

  const encrypted=await crypto.subtle.encrypt(
    {
      name:'AES-GCM',
      iv,
      additionalData,
      tagLength:128
    },
    key,
    plaintext
  );

  return {
    ciphertext:bytesToBase64(encrypted),
    iv:bytesToBase64(iv)
  };
}

async function decryptApiKey(ciphertext, ivBase64, clientId, env) {
  const key=await getApiEncryptionKey(env);
  const encrypted=base64ToBytes(ciphertext);
  const iv=base64ToBytes(ivBase64);
  const additionalData=new TextEncoder().encode(String(clientId));

  const decrypted=await crypto.subtle.decrypt(
    {
      name:'AES-GCM',
      iv,
      additionalData,
      tagLength:128
    },
    key,
    encrypted
  );

  return new TextDecoder().decode(decrypted);
}



async function encryptFactionAccessCode(
  accessCode,
  factionId,
  env
){
  return encryptApiKey(
    accessCode,
    'faction-access:'+String(factionId),
    env
  );
}

async function decryptFactionAccessCode(
  ciphertext,
  iv,
  factionId,
  env
){
  return decryptApiKey(
    ciphertext,
    iv,
    'faction-access:'+String(factionId),
    env
  );
}

async function fetchValidationJson(url) {
  let response;

  try {
    response=await fetch(url,{
      headers:{
        'Accept':'application/json',
        'User-Agent':'DoitsFlightTracker/1.0'
      }
    });
  } catch(e) {
    return {ok:false,status:0,data:null};
  }

  let data=null;

  try {
    data=await response.json();
  } catch(e) {}

  return {
    ok:response.ok,
    status:response.status,
    data
  };
}

async function validateTrackerApiKey(apiKey) {
  const key=String(apiKey || '').trim();

  if(!/^[A-Za-z0-9]{16}$/.test(key)){
    return {
      ok:false,
      status:400,
      error:'API key must be 16 alphanumeric characters'
    };
  }

  const keyInfoUrl=new URL('https://api.torn.com/v2/key/info');
  keyInfoUrl.searchParams.set('key',key);

  const keyInfoResult=await fetchValidationJson(keyInfoUrl);

  if(
    !keyInfoResult.ok ||
    !keyInfoResult.data ||
    keyInfoResult.data.error
  ){
    return {
      ok:false,
      status:400,
      error:'Torn rejected this API key'
    };
  }

  const tornUserId=Number(
    keyInfoResult.data?.info?.user?.id
  );

  if(
    !Number.isInteger(tornUserId) ||
    tornUserId<=0
  ){
    return {
      ok:false,
      status:400,
      error:'Unable to identify Torn account from API key'
    };
  }

  const factionValue=
    keyInfoResult.data?.info?.user?.faction_id;

  const ownFactionId=
    factionValue==null
      ? null
      : String(factionValue);

  const basicUrl=new URL('https://api.torn.com/v2/user');
  basicUrl.searchParams.set('selections','basic');
  basicUrl.searchParams.set('key',key);
  basicUrl.searchParams.set('striptags','true');

  const basicResult=await fetchValidationJson(basicUrl);

  if(
    !basicResult.ok ||
    !basicResult.data ||
    basicResult.data.error
  ){
    return {
      ok:false,
      status:400,
      error:'API key cannot access Torn basic profile information'
    };
  }

  const profile=basicResult.data?.profile;

  if(
    !profile ||
    String(profile.id)!==String(tornUserId) ||
    !profile.name
  ){
    return {
      ok:false,
      status:400,
      error:'Torn account validation failed'
    };
  }

  const ffscouterUrl=
    new URL('https://ffscouter.com/api/v1/check-key');

  ffscouterUrl.searchParams.set('key',key);

  const ffscouterResult=
    await fetchValidationJson(ffscouterUrl);

  if(
    !ffscouterResult.ok ||
    !ffscouterResult.data ||
    ffscouterResult.data.is_registered!==true
  ){
    return {
      ok:false,
      status:400,
      error:'This Torn API key is not registered with FFScouter'
    };
  }

  return {
    ok:true,
    tornUserId:String(tornUserId),
    tornName:String(profile.name).slice(0,100),
    ownFactionId,
    ffscouterRegistered:true
  };
}


async function getClientTrackerApiKey(clientId,env) {
  const row=await env.DB
    .prepare(`
      SELECT
        api_key_ciphertext,
        api_key_iv
      FROM clients
      WHERE client_id=?
        AND active=1
    `)
    .bind(clientId)
    .first();

  if(
    !row ||
    !row.api_key_ciphertext ||
    !row.api_key_iv
  ){
    throw new Error('Client API key is not configured');
  }

  return decryptApiKey(
    row.api_key_ciphertext,
    row.api_key_iv,
    clientId,
    env
  );
}


async function consumeTornRequestBudget(client,env) {
  const clientId=String(
    client?.clientId ||
    client?.client_id ||
    ''
  );

  const limit=Number(
    client?.maxTornRequestsPerMinute ??
    client?.max_torn_requests_per_minute ??
    60
  );

  if(!clientId || !Number.isFinite(limit) || limit<=0){
    return {
      allowed:false,
      used:0,
      limit:Math.max(0,Number(limit)||0)
    };
  }

  const now=Date.now();
  const minuteBucket=Math.floor(now/60000);

  const row=await env.DB
    .prepare(`
      INSERT INTO client_api_usage
      (
        client_id,
        minute_bucket,
        torn_requests,
        ffscouter_requests,
        updated_at
      )
      VALUES (?, ?, 1, 0, ?)
      ON CONFLICT(client_id,minute_bucket)
      DO UPDATE SET
        torn_requests=
          client_api_usage.torn_requests + 1,
        updated_at=excluded.updated_at
      WHERE
        client_api_usage.torn_requests < ?
      RETURNING torn_requests
    `)
    .bind(
      clientId,
      minuteBucket,
      now,
      limit
    )
    .first();

  if(!row){
    return {
      allowed:false,
      used:limit,
      limit,
      minuteBucket
    };
  }

  return {
    allowed:true,
    used:Number(row.torn_requests || 0),
    limit,
    minuteBucket
  };
}


const TRACKER_POLL_INTERVAL_MS=30000;
const TRACKER_LANDED_DISPLAY_MS=30000;
const TRACKER_STUCK_FLIGHT_BUFFER_MIN=15;
const TRACKER_DETECTION_DELAY_MS=20000;

const TRACKER_TRAVEL_DURATIONS={
  'Mexico':{'Commercial':26,'Personal':18,'Private':13},
  'Cayman Islands':{'Commercial':35,'Personal':25,'Private':18},
  'Canada':{'Commercial':41,'Personal':29,'Private':20},
  'Hawaii':{'Commercial':134,'Personal':94,'Private':67},
  'United Kingdom':{'Commercial':159,'Personal':111,'Private':80},
  'Argentina':{'Commercial':167,'Personal':117,'Private':83},
  'Switzerland':{'Commercial':175,'Personal':123,'Private':88},
  'Japan':{'Commercial':225,'Personal':158,'Private':113},
  'China':{'Commercial':242,'Personal':169,'Private':121},
  'UAE':{'Commercial':271,'Personal':190,'Private':135},
  'South Africa':{'Commercial':297,'Personal':208,'Private':149}
};

const TRACKER_PLANE_TYPE_MAP={
  'light_aircraft':'Personal',
  'airliner':'Commercial',
  'private_jet':'Private'
};

function getTrackerFastestDuration(destination,flightType){
  return (TRACKER_TRAVEL_DURATIONS[destination]?.[flightType] || 10)*0.97;
}

function getTrackerSlowestDuration(destination,flightType){
  return (TRACKER_TRAVEL_DURATIONS[destination]?.[flightType] || 10)*1.03;
}

function getTrackerLandingWindow(travelStarted,destination,flightType){
  if(!travelStarted || !destination || !flightType) return null;

  const fastest=getTrackerFastestDuration(destination,flightType);
  const slowest=getTrackerSlowestDuration(destination,flightType);

  return {
    earliest:
      Number(travelStarted)+
      fastest*60000-
      TRACKER_DETECTION_DELAY_MS,
    latest:
      Number(travelStarted)+
      slowest*60000-
      TRACKER_DETECTION_DELAY_MS
  };
}


async function clientTornRequest(client,path,env){
  const budget=await consumeTornRequestBudget(client,env);

  if(!budget.allowed){
    const error=new Error('Per-user Torn API budget exhausted');
    error.code='TORN_BUDGET_EXHAUSTED';
    error.budget=budget;
    throw error;
  }

  let apiKey=await getClientTrackerApiKey(client.clientId,env);
  const url=new URL('https://api.torn.com'+path);
  url.searchParams.set('key',apiKey);

  let response;

  try{
    response=await fetch(url,{
      headers:{
        'Accept':'application/json',
        'User-Agent':'DoitsFlightTracker/1.0'
      }
    });
  }finally{
    apiKey=null;
  }

  let data=null;

  try{
    data=await response.json();
  }catch(e){}

  if(!response.ok){
    const error=new Error(
      'Torn API HTTP '+response.status
    );
    error.code='TORN_HTTP_ERROR';
    error.status=response.status;
    throw error;
  }

  if(data?.error){
    const error=new Error(
      String(
        data.error.error ||
        data.error.message ||
        'Torn API error'
      )
    );
    error.code='TORN_API_ERROR';
    error.tornCode=data.error.code ?? null;
    throw error;
  }

  return {
    data,
    budget
  };
}




async function globalTornRequestWithKey(
  apiKey,
  path
){
  let key=String(
    apiKey || ''
  ).trim();

  if(!/^[A-Za-z0-9]{16}$/.test(key)){
    const error=
      new Error(
        'Collector Torn API key is invalid'
      );

    error.code=
      'GLOBAL_COLLECTOR_KEY_INVALID';

    throw error;
  }

  const url=
    new URL(
      'https://api.torn.com'+path
    );

  url.searchParams.set(
    'key',
    key
  );

  let response;

  try{
    response=await fetch(
      url,
      {
        headers:{
          'Accept':'application/json',
          'User-Agent':
            'DoitsFlightTracker/1.0'
        }
      }
    );
  }finally{
    key=null;

    try{
      url.searchParams.delete('key');
    }catch(e){}
  }

  let data=null;

  try{
    data=await response.json();
  }catch(e){}

  if(!response.ok){
    const error=
      new Error(
        'Torn API HTTP '+
        response.status
      );

    error.code=
      'TORN_HTTP_ERROR';

    error.status=
      response.status;

    throw error;
  }

  if(data?.error){
    const error=
      new Error(
        String(
          data.error.error ||
          data.error.message ||
          'Torn API error'
        )
      );

    error.code=
      'TORN_API_ERROR';

    error.tornCode=
      data.error.code ?? null;

    throw error;
  }

  return {
    data
  };
}



function getGlobalLandingWindow(
  travelStarted,
  destination,
  flightType,
  detectionUncertaintyMs=60000
){
  if(
    !travelStarted ||
    !destination ||
    !flightType
  ){
    return null;
  }

  const fastest=
    getTrackerFastestDuration(
      destination,
      flightType
    );

  const slowest=
    getTrackerSlowestDuration(
      destination,
      flightType
    );

  return {
    earliest:
      Number(travelStarted)+
      fastest*60000-
      Math.max(
        0,
        Number(
          detectionUncertaintyMs ||
          0
        )
      ),
    latest:
      Number(travelStarted)+
      slowest*60000
  };
}


function globalFactionMemberCore(member){
  return {
    playerName:
      member?.playerName || null,
    status:
      member?.status || 'idle',
    destination:
      member?.destination || null,
    origin:
      member?.origin || null,
    flightType:
      member?.flightType || null,
    travelStarted:
      member?.travelStarted==null
        ? null
        : Number(
            member.travelStarted
          ),
    landedAt:
      member?.landedAt==null
        ? null
        : Number(
            member.landedAt
          )
  };
}


function globalCoreStateEqual(a,b){
  return JSON.stringify(
    globalFactionMemberCore(a)
  )===JSON.stringify(
    globalFactionMemberCore(b)
  );
}


async function runGlobalStatementBatches(
  statements,
  env,
  batchSize=50
){
  for(
    let i=0;
    i<statements.length;
    i+=batchSize
  ){
    await env.DB.batch(
      statements.slice(
        i,
        i+batchSize
      )
    );
  }
}


async function pollGlobalFactionTarget(
  target,
  collectorApiKey,
  env,
  poolConfig={}
){
  const factionId=String(
    target?.faction_id ||
    target?.target_id ||
    ''
  ).trim();

  if(!/^\d+$/.test(factionId)){
    throw new Error(
      'Invalid global faction ID'
    );
  }

  const pollIntervalMs=
    Math.max(
      60000,
      Number(
        poolConfig.pollIntervalMs ||
        poolConfig.poll_interval_ms ||
        60000
      )
    );

  const detectionUncertaintyMs=
    Math.max(
      pollIntervalMs,
      Number(
        poolConfig.detectionUncertaintyMs ||
        poolConfig.detection_uncertainty_ms ||
        pollIntervalMs
      )
    );

  const landedDisplayMs=60000;

  const response=
    await globalTornRequestWithKey(
      collectorApiKey,
      '/v2/faction/'+
        encodeURIComponent(factionId)+
        '/members?striptags=true'
    );

  const data=
    response?.data || {};

  const apiMembers=
    Array.isArray(data.members)
      ? data.members
      : [];

  const factionRow=
    await env.DB
      .prepare(`
        SELECT
          faction_name,
          state_hash,
          state_json,
          member_count,
          travelling_count,
          data_version
        FROM global_factions
        WHERE faction_id=?
        LIMIT 1
      `)
      .bind(factionId)
      .first();

  let previousSnapshot={};

  if(factionRow?.state_json){
    try{
      const parsed=
        JSON.parse(
          factionRow.state_json
        );

      if(
        parsed &&
        typeof parsed==='object' &&
        !Array.isArray(parsed)
      ){
        previousSnapshot=parsed;
      }
    }catch(e){
      previousSnapshot={};
    }
  }

  const now=Date.now();
  const currentSnapshot={};
  const changedMembers=[];
  let travellingCount=0;

  for(const apiMem of apiMembers){
    if(apiMem?.id==null){
      continue;
    }

    const playerId=
      String(apiMem.id);

    const previous=
      previousSnapshot[playerId] ||
      null;

    const apiStatus=
      apiMem.status || {};

    const rawStatus=
      String(
        apiStatus.description ||
        ''
      ).trim();

    let status='idle';
    let destination=null;
    let origin=null;
    let flightType=null;
    let travelStarted=null;
    let landedAt=null;

    const previousStatus=
      previous?.status ||
      'idle';

    if(
      previousStatus==='traveling' &&
      previous?.travelStarted
    ){
      const previousDestination=
        previous.destination ||
        null;

      const previousOrigin=
        previous.origin ||
        null;

      const lookupDest=
        previousDestination==='Torn'
          ? previousOrigin
          : previousDestination;

      if(
        lookupDest &&
        previous.flightType
      ){
        const slowest=
          getTrackerSlowestDuration(
            lookupDest,
            previous.flightType
          );

        const elapsedMinutes=
          (
            now-
            Number(
              previous.travelStarted
            )
          )/60000;

        if(
          elapsedMinutes>
          slowest+
          TRACKER_STUCK_FLIGHT_BUFFER_MIN
        ){
          status='landed';
          destination=
            previousDestination;
          origin=
            previousOrigin;
          flightType=
            previous.flightType;
          travelStarted=
            Number(
              previous.travelStarted
            );
          landedAt=
            Number(
              previous.travelStarted
            )+
            slowest*60000;
        }
      }
    }

    const forcedLanded=
      status==='landed';

    if(!forcedLanded){
      if(apiStatus.state==='Traveling'){
        const match=
          rawStatus.match(
            /Traveling\s+from\s+(.+?)\s+to\s+(.+)$/i
          );

        if(match){
          origin=
            match[1].trim();

          destination=
            match[2].trim();

          flightType=
            TRACKER_PLANE_TYPE_MAP[
              apiStatus.plane_image_type
            ] ||
            'Commercial';

          const sameFlight=
            previousStatus==='traveling' &&
            previous?.destination===
              destination &&
            previous?.origin===
              origin &&
            previous?.flightType===
              flightType &&
            previous?.travelStarted;

          if(sameFlight){
            travelStarted=
              Number(
                previous.travelStarted
              );
          }else{
            travelStarted=now;
          }

          status='traveling';
          landedAt=null;
          travellingCount++;
        }else{
          status=
            previousStatus;

          destination=
            previous?.destination ||
            null;

          origin=
            previous?.origin ||
            null;

          flightType=
            previous?.flightType ||
            null;

          travelStarted=
            previous?.travelStarted==null
              ? null
              : Number(
                  previous.travelStarted
                );

          landedAt=
            previous?.landedAt==null
              ? null
              : Number(
                  previous.landedAt
                );
        }
      }else if(
        apiStatus.state==='Abroad' &&
        previousStatus!=='traveling' &&
        !(
          previousStatus==='landed' &&
          previous?.landedAt &&
          now-
          Number(previous.landedAt)<=
          landedDisplayMs
        )
      ){
        status='abroad';

        const abroadMatch=
          rawStatus.match(
            /^\s*(?:Currently\s+)?in\s+(.+?)\s*$/i
          );

        if(abroadMatch){
          origin=
            abroadMatch[1].trim();
        }
      }else if(
        previousStatus==='traveling'
      ){
        status='landed';

        destination=
          previous?.destination ||
          null;

        origin=
          previous?.origin ||
          null;

        flightType=
          previous?.flightType ||
          null;

        travelStarted=
          previous?.travelStarted==null
            ? null
            : Number(
                previous.travelStarted
              );

        landedAt=now;
      }else if(
        previousStatus==='landed' &&
        previous?.landedAt &&
        now-
        Number(previous.landedAt)<=
        landedDisplayMs
      ){
        status='landed';

        destination=
          previous?.destination ||
          null;

        origin=
          previous?.origin ||
          null;

        flightType=
          previous?.flightType ||
          null;

        travelStarted=
          previous?.travelStarted==null
            ? null
            : Number(
                previous.travelStarted
              );

        landedAt=
          Number(
            previous.landedAt
          );
      }
    }

    const member={
      playerId,
      playerName:
        String(
          apiMem.name ||
          previous?.playerName ||
          'User '+playerId
        ).slice(0,100),
      status,
      rawStatus:
        rawStatus || null,
      destination,
      origin,
      flightType,
      travelStarted,
      landedAt,
      lastAction:
        apiMem.last_action?.timestamp==null
          ? previous?.lastAction ??
            null
          : Number(
              apiMem.last_action.timestamp
            )
    };

    currentSnapshot[playerId]=
      member;

    if(
      !previous ||
      !globalCoreStateEqual(
        previous,
        member
      )
    ){
      changedMembers.push(
        member
      );
    }
  }

  const removedPlayerIds=
    Object.keys(
      previousSnapshot
    ).filter(
      playerId=>
        !Object.prototype.hasOwnProperty.call(
          currentSnapshot,
          playerId
        )
    );

  const factionName=
    String(
      data?.name ||
      data?.faction?.name ||
      target?.faction_name ||
      factionRow?.faction_name ||
      ''
    ).trim() || null;

  const canonicalMembers=
    Object.keys(
      currentSnapshot
    )
      .sort(
        (a,b)=>
          a.localeCompare(
            b,
            undefined,
            {numeric:true}
          )
      )
      .map(
        playerId=>[
          playerId,
          globalFactionMemberCore(
            currentSnapshot[
              playerId
            ]
          )
        ]
      );

  const stateHash=
    await sha256Hex(
      JSON.stringify({
        factionName,
        members:
          canonicalMembers
      })
    );

  const previousHash=
    factionRow?.state_hash ||
    null;

  if(
    previousHash===stateHash &&
    removedPlayerIds.length===0
  ){
    return {
      factionId,
      factionName,
      changed:false,
      memberCount:
        apiMembers.length,
      travellingCount,
      changedMembers:0,
      removedMembers:0,
      writes:0,
      pollIntervalMs,
      detectionUncertaintyMs,
      landedDisplayMs
    };
  }

  const memberStatements=[];

  for(const member of changedMembers){
    const memberHash=
      await sha256Hex(
        JSON.stringify(
          globalFactionMemberCore(
            member
          )
        )
      );

    memberStatements.push(
      env.DB
        .prepare(`
          INSERT INTO global_faction_members
          (
            faction_id,
            player_id,
            player_name,
            status,
            raw_status,
            destination,
            origin,
            flight_type,
            travel_started,
            landed_at,
            last_action,
            state_hash,
            updated_at
          )
          VALUES (
            ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?
          )
          ON CONFLICT(
            faction_id,
            player_id
          )
          DO UPDATE SET
            player_name=
              excluded.player_name,
            status=
              excluded.status,
            raw_status=
              excluded.raw_status,
            destination=
              excluded.destination,
            origin=
              excluded.origin,
            flight_type=
              excluded.flight_type,
            travel_started=
              excluded.travel_started,
            landed_at=
              excluded.landed_at,
            last_action=
              excluded.last_action,
            state_hash=
              excluded.state_hash,
            updated_at=
              excluded.updated_at
        `)
        .bind(
          factionId,
          member.playerId,
          member.playerName,
          member.status,
          member.rawStatus,
          member.destination,
          member.origin,
          member.flightType,
          member.travelStarted,
          member.landedAt,
          member.lastAction,
          memberHash,
          now
        )
    );
  }

  for(const playerId of removedPlayerIds){
    memberStatements.push(
      env.DB
        .prepare(`
          DELETE FROM
            global_faction_members
          WHERE faction_id=?
            AND player_id=?
        `)
        .bind(
          factionId,
          playerId
        )
    );
  }

  if(memberStatements.length){
    await runGlobalStatementBatches(
      memberStatements,
      env
    );
  }

  const stateJson=
    JSON.stringify(
      currentSnapshot
    );

  const previousVersion=
    Number(
      factionRow?.data_version ||
      0
    );

  const nextVersion=
    previousVersion+1;

  await env.DB
    .prepare(`
      INSERT INTO global_factions
      (
        faction_id,
        faction_name,
        data_version,
        created_at,
        updated_at,
        state_hash,
        state_json,
        member_count,
        travelling_count
      )
      VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
      ON CONFLICT(faction_id)
      DO UPDATE SET
        faction_name=
          COALESCE(
            excluded.faction_name,
            global_factions.faction_name
          ),
        data_version=
          excluded.data_version,
        updated_at=
          excluded.updated_at,
        state_hash=
          excluded.state_hash,
        state_json=
          excluded.state_json,
        member_count=
          excluded.member_count,
        travelling_count=
          excluded.travelling_count
    `)
    .bind(
      factionId,
      factionName,
      nextVersion,
      now,
      now,
      stateHash,
      stateJson,
      apiMembers.length,
      travellingCount
    )
    .run();

  return {
    factionId,
    factionName,
    changed:true,
    dataVersion:
      nextVersion,
    memberCount:
      apiMembers.length,
    travellingCount,
    changedMembers:
      changedMembers.length,
    removedMembers:
      removedPlayerIds.length,
    writes:
      changedMembers.length+
      removedPlayerIds.length+
      1,
    pollIntervalMs,
    detectionUncertaintyMs,
    landedDisplayMs
  };
}



function globalPlayerCore(player){
  return {
    playerName:player?.playerName || null,
    factionId:player?.factionId==null ? null : String(player.factionId),
    status:player?.status || 'idle',
    destination:player?.destination || null,
    origin:player?.origin || null,
    flightType:player?.flightType || null,
    travelStarted:player?.travelStarted==null ? null : Number(player.travelStarted),
    landedAt:player?.landedAt==null ? null : Number(player.landedAt)
  };
}

function globalPlayerRowToState(row){
  if(!row) return null;
  return {
    playerId:String(row.player_id),
    playerName:row.player_name || null,
    factionId:row.faction_id==null ? null : String(row.faction_id),
    status:row.status || 'idle',
    rawStatus:row.raw_status || null,
    destination:row.destination || null,
    origin:row.origin || null,
    flightType:row.flight_type || null,
    travelStarted:row.travel_started==null ? null : Number(row.travel_started),
    landedAt:row.landed_at==null ? null : Number(row.landed_at),
    lastAction:row.last_action==null ? null : Number(row.last_action)
  };
}

async function pollGlobalPlayerTarget(target,collectorApiKey,env,poolConfig={}){
  const playerId=String(target?.player_id || target?.target_id || '').trim();
  if(!/^\d+$/.test(playerId)) throw new Error('Invalid global player ID');

  const pollIntervalMs=Math.max(60000,Number(poolConfig.pollIntervalMs || poolConfig.poll_interval_ms || 60000));
  const detectionUncertaintyMs=Math.max(pollIntervalMs,Number(poolConfig.detectionUncertaintyMs || poolConfig.detection_uncertainty_ms || pollIntervalMs));
  const landedDisplayMs=60000;

  const response=await globalTornRequestWithKey(
    collectorApiKey,
    '/v2/user/'+encodeURIComponent(playerId)+'/basic?striptags=true'
  );

  const data=response?.data || {};
  const profile=data?.profile || data?.basic || data?.user || null;
  if(!profile) throw new Error('No Torn profile returned for '+playerId);

  const previousRow=await env.DB.prepare(`
    SELECT player_id,player_name,faction_id,status,raw_status,destination,origin,flight_type,
           travel_started,landed_at,last_action,state_hash,data_version
    FROM global_players
    WHERE player_id=?
    LIMIT 1
  `).bind(playerId).first();

  const previous=globalPlayerRowToState(previousRow);
  const previousStatus=previous?.status || 'idle';
  const apiStatus=profile.status || {};
  const rawStatus=String(apiStatus.description || '').trim();
  const now=Date.now();

  let status='idle';
  let destination=null;
  let origin=null;
  let flightType=null;
  let travelStarted=null;
  let landedAt=null;

  if(previousStatus==='traveling' && previous?.travelStarted){
    const previousDestination=previous.destination || null;
    const previousOrigin=previous.origin || null;
    const lookupDest=previousDestination==='Torn' ? previousOrigin : previousDestination;

    if(lookupDest && previous.flightType){
      const slowest=getTrackerSlowestDuration(lookupDest,previous.flightType);
      const elapsedMinutes=(now-Number(previous.travelStarted))/60000;

      if(elapsedMinutes>slowest+TRACKER_STUCK_FLIGHT_BUFFER_MIN){
        status='landed';
        destination=previousDestination;
        origin=previousOrigin;
        flightType=previous.flightType;
        travelStarted=Number(previous.travelStarted);
        landedAt=Number(previous.travelStarted)+slowest*60000;
      }
    }
  }

  const forcedLanded=status==='landed';

  if(!forcedLanded){
    if(apiStatus.state==='Traveling'){
      const match=rawStatus.match(/Traveling\s+from\s+(.+?)\s+to\s+(.+)$/i);

      if(match){
        origin=match[1].trim();
        destination=match[2].trim();
        flightType=TRACKER_PLANE_TYPE_MAP[apiStatus.plane_image_type] || 'Commercial';

        const sameFlight=
          previousStatus==='traveling' &&
          previous?.origin===origin &&
          previous?.destination===destination &&
          previous?.flightType===flightType &&
          previous?.travelStarted;

        travelStarted=sameFlight ? Number(previous.travelStarted) : now;
        status='traveling';
        landedAt=null;
      }else{
        status=previousStatus;
        destination=previous?.destination || null;
        origin=previous?.origin || null;
        flightType=previous?.flightType || null;
        travelStarted=previous?.travelStarted==null ? null : Number(previous.travelStarted);
        landedAt=previous?.landedAt==null ? null : Number(previous.landedAt);
      }
    }else if(
        apiStatus.state==='Abroad' &&
        previousStatus!=='traveling' &&
        !(
          previousStatus==='landed' &&
          previous?.landedAt &&
          now-
          Number(previous.landedAt)<=
          landedDisplayMs
        )
      ){
      status='abroad';
      const abroadMatch=rawStatus.match(/^\s*(?:Currently\s+)?in\s+(.+?)\s*$/i);
      origin=abroadMatch?.[1]?.trim() || previous?.origin || null;
      destination=null;
      flightType=null;
      travelStarted=null;
      landedAt=null;
    }else if(previousStatus==='traveling'){
      status='landed';
      destination=previous?.destination || null;
      origin=previous?.origin || null;
      flightType=previous?.flightType || null;
      travelStarted=previous?.travelStarted==null ? null : Number(previous.travelStarted);
      landedAt=now;
    }else if(
      previousStatus==='landed' &&
      previous?.landedAt &&
      now-Number(previous.landedAt)<=landedDisplayMs
    ){
      status='landed';
      destination=previous?.destination || null;
      origin=previous?.origin || null;
      flightType=previous?.flightType || null;
      travelStarted=previous?.travelStarted==null ? null : Number(previous.travelStarted);
      landedAt=Number(previous.landedAt);
    }
  }

  const rawFactionId=
    profile?.faction_id !== undefined
      ? profile.faction_id
      : profile?.faction?.id !== undefined
        ? profile.faction.id
        : previous?.factionId;

  const factionId=normalizeTrackerFactionId(rawFactionId);

  const playerName=String(
    profile?.name ||
    previous?.playerName ||
    'User '+playerId
  ).slice(0,100);

  const lastAction=
    profile?.last_action?.timestamp==null
      ? previous?.lastAction ?? null
      : Number(profile.last_action.timestamp);

  const state={
    playerId,
    playerName,
    factionId,
    status,
    rawStatus:rawStatus || null,
    destination,
    origin,
    flightType,
    travelStarted,
    landedAt,
    lastAction
  };

  const stateHash=await sha256Hex(JSON.stringify(globalPlayerCore(state)));

  const lookupDest=destination==='Torn' ? origin : destination;
  const arrivalWindow=
    status==='traveling' && lookupDest && flightType
      ? getGlobalLandingWindow(travelStarted,lookupDest,flightType,detectionUncertaintyMs)
      : null;

  if(previousRow?.state_hash===stateHash){
    return {
      playerId,
      playerName,
      changed:false,
      status,
      origin,
      destination,
      flightType,
      travelStarted,
      landedAt,
      arrivalWindow,
      writes:0,
      pollIntervalMs,
      detectionUncertaintyMs,
      landedDisplayMs
    };
  }

  const nextVersion=Number(previousRow?.data_version || 0)+1;

  await env.DB.prepare(`
    INSERT INTO global_players(
      player_id,player_name,faction_id,status,raw_status,destination,origin,flight_type,
      travel_started,landed_at,last_action,state_hash,data_version,created_at,updated_at
    )
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(player_id)
    DO UPDATE SET
      player_name=excluded.player_name,
      faction_id=excluded.faction_id,
      status=excluded.status,
      raw_status=excluded.raw_status,
      destination=excluded.destination,
      origin=excluded.origin,
      flight_type=excluded.flight_type,
      travel_started=excluded.travel_started,
      landed_at=excluded.landed_at,
      last_action=excluded.last_action,
      state_hash=excluded.state_hash,
      data_version=excluded.data_version,
      updated_at=excluded.updated_at
  `).bind(
    playerId,
    playerName,
    factionId,
    status,
    rawStatus || null,
    destination,
    origin,
    flightType,
    travelStarted,
    landedAt,
    lastAction,
    stateHash,
    nextVersion,
    now,
    now
  ).run();

  return {
    playerId,
    playerName,
    changed:true,
    dataVersion:nextVersion,
    status,
    origin,
    destination,
    flightType,
    travelStarted,
    landedAt,
    arrivalWindow,
    writes:1,
    pollIntervalMs,
    detectionUncertaintyMs,
    landedDisplayMs
  };
}



function normalizeGlobalTargetType(value){
  const type=String(value || '').trim().toLowerCase();

  if(type!=='faction' && type!=='player'){
    throw new Error('Invalid global target type');
  }

  return type;
}


async function getGlobalPoolConfig(env){
  const row=await env.DB
    .prepare(`
      SELECT
        enabled,
        legacy_client_collection_enabled,
        poll_interval_ms,
        detection_uncertainty_ms,
        collector_max_targets,
        collector_failover_after_ms,
        bs_ttl_ms
      FROM global_pool_config
      WHERE id=1
      LIMIT 1
    `)
    .first();

  return {
    enabled:Number(row?.enabled || 0)===1,
    legacyClientCollectionEnabled:
      Number(
        row?.legacy_client_collection_enabled ?? 1
      )===1,
    pollIntervalMs:
      Math.max(
        60000,
        Number(row?.poll_interval_ms || 60000)
      ),
    detectionUncertaintyMs:
      Math.max(
        60000,
        Number(
          row?.detection_uncertainty_ms ||
          row?.poll_interval_ms ||
          60000
        )
      ),
    collectorMaxTargets:
      Math.max(
        1,
        Number(row?.collector_max_targets || 20)
      ),
    collectorFailoverAfterMs:
      Math.max(
        60000,
        Number(
          row?.collector_failover_after_ms ||
          120000
        )
      ),
    bsTtlMs:
      Math.max(
        3600000,
        Number(row?.bs_ttl_ms || 86400000)
      )
  };
}


async function ensureGlobalTargetRegistry(
  targetType,
  targetId,
  targetName,
  env
){
  const type=
    normalizeGlobalTargetType(targetType);

  const id=String(targetId || '').trim();

  if(!/^\d+$/.test(id)){
    throw new Error('Invalid global target ID');
  }

  const cleanName=
    targetName==null
      ? null
      : String(targetName)
          .trim()
          .slice(0,100) ||
        null;

  const now=Date.now();

  if(type==='faction'){
    await env.DB
      .prepare(`
        INSERT INTO global_factions
        (
          faction_id,
          faction_name,
          data_version,
          created_at,
          updated_at
        )
        VALUES (?, ?, 0, ?, ?)
        ON CONFLICT(faction_id)
        DO UPDATE SET
          faction_name=
            COALESCE(
              excluded.faction_name,
              global_factions.faction_name
            )
      `)
      .bind(
        id,
        cleanName,
        now,
        now
      )
      .run();

    return;
  }

  await env.DB
    .prepare(`
      INSERT INTO global_players
      (
        player_id,
        player_name,
        status,
        data_version,
        created_at,
        updated_at
      )
      VALUES (?, ?, 'idle', 0, ?, ?)
      ON CONFLICT(player_id)
      DO UPDATE SET
        player_name=
          COALESCE(
            excluded.player_name,
            global_players.player_name
          )
    `)
    .bind(
      id,
      cleanName,
      now,
      now
    )
    .run();
}


async function getGlobalTargetDemand(
  targetType,
  targetId,
  env
){
  const type=
    normalizeGlobalTargetType(targetType);

  const id=String(targetId);

  const sql=
    type==='faction'
      ? `
          SELECT
            w.client_id,
            w.created_at,
            c.role,
            c.access_status,
            CASE
              WHEN
                c.api_key_ciphertext IS NOT NULL
                AND c.api_key_iv IS NOT NULL
              THEN 1
              ELSE 0
            END AS api_key_configured
          FROM watched_factions w
          INNER JOIN clients c
            ON c.client_id=w.client_id
          WHERE w.faction_id=?
            AND w.active=1
            AND c.active=1
            AND COALESCE(
              c.access_status,
              'active'
            )<>'suspended'
          ORDER BY
            w.created_at ASC,
            w.client_id ASC
        `
      : `
          SELECT
            s.client_id,
            s.created_at,
            c.role,
            c.access_status,
            CASE
              WHEN
                c.api_key_ciphertext IS NOT NULL
                AND c.api_key_iv IS NOT NULL
              THEN 1
              ELSE 0
            END AS api_key_configured
          FROM subscriptions s
          INNER JOIN clients c
            ON c.client_id=s.client_id
          WHERE s.player_id=?
            AND s.active=1
            AND c.active=1
            AND COALESCE(
              c.access_status,
              'active'
            )<>'suspended'
          ORDER BY
            s.created_at ASC,
            s.client_id ASC
        `;

  const result=await env.DB
    .prepare(sql)
    .bind(id)
    .all();

  return result?.results || [];
}


async function getGlobalCollectorLoad(
  clientId,
  targetType,
  targetId,
  env
){
  const row=await env.DB
    .prepare(`
      SELECT COUNT(*) AS count
      FROM global_target_leases
      WHERE active=1
        AND collector_client_id=?
        AND NOT (
          target_type=?
          AND target_id=?
        )
    `)
    .bind(
      String(clientId),
      String(targetType),
      String(targetId)
    )
    .first();

  return Number(row?.count || 0);
}


async function reconcileGlobalTargetLease(
  targetType,
  targetId,
  env,
  options={}
){
  const type=
    normalizeGlobalTargetType(targetType);

  const id=String(targetId || '').trim();

  if(!/^\d+$/.test(id)){
    throw new Error('Invalid global target ID');
  }

  const config=
    await getGlobalPoolConfig(env);

  const current=
    await env.DB
      .prepare(`
        SELECT
          target_type,
          target_id,
          collector_client_id,
          preferred_collector_client_id,
          collector_assigned_at,
          collector_last_success_at,
          collector_last_failure_at,
          collector_failure_count,
          active,
          created_at,
          updated_at
        FROM global_target_leases
        WHERE target_type=?
          AND target_id=?
        LIMIT 1
      `)
      .bind(type,id)
      .first();

  const demand=
    await getGlobalTargetDemand(
      type,
      id,
      env
    );

  const demandCount=
    demand.length;

  const eligible=
    demand.filter(
      row=>
        Number(
          row.api_key_configured || 0
        )===1
    );

  const excludedCollector=
    options?.excludeCollectorClientId==null
      ? null
      : String(
          options.excludeCollectorClientId
        );

  const candidates=
    eligible.filter(
      row=>
        !excludedCollector ||
        String(row.client_id)!==
          excludedCollector
    );

  let primaryFactionId=null;
  let supportAdminClientId=null;

  if(type==='faction'){
    const accessConfig=
      await env.DB
        .prepare(`
          SELECT
            primary_faction_id,
            support_admin_client_id
          FROM tracker_access_config
          WHERE id=1
          LIMIT 1
        `)
        .first();

    primaryFactionId=
      accessConfig?.primary_faction_id==null
        ? null
        : String(
            accessConfig.primary_faction_id
          );

    supportAdminClientId=
      accessConfig?.support_admin_client_id==null
        ? null
        : String(
            accessConfig.support_admin_client_id
          );
  }

  const isPrimary=
    type==='faction' &&
    primaryFactionId===id;

  const currentCollector=
    current?.collector_client_id==null
      ? null
      : String(
          current.collector_client_id
        );

  let preferredCollector=
    current?.preferred_collector_client_id==null
      ? null
      : String(
          current.preferred_collector_client_id
        );

  if(isPrimary && supportAdminClientId){
    preferredCollector=
      supportAdminClientId;
  }

  const candidateById=
    new Map(
      candidates.map(
        row=>[
          String(row.client_id),
          row
        ]
      )
    );

  const loadCache=
    new Map();

  async function hasCapacity(clientId){
    const idValue=String(clientId);

    if(!candidateById.has(idValue)){
      return false;
    }

    if(!loadCache.has(idValue)){
      loadCache.set(
        idValue,
        await getGlobalCollectorLoad(
          idValue,
          type,
          id,
          env
        )
      );
    }

    return (
      Number(loadCache.get(idValue)) <
      config.collectorMaxTargets
    );
  }

  let desiredCollector=null;

  if(demandCount>0){
    if(
      currentCollector &&
      (
        !excludedCollector ||
        currentCollector!==
          excludedCollector
      ) &&
      await hasCapacity(
        currentCollector
      )
    ){
      desiredCollector=
        currentCollector;
    }else if(
      preferredCollector &&
      await hasCapacity(
        preferredCollector
      )
    ){
      desiredCollector=
        preferredCollector;
    }else{
      for(const candidate of candidates){
        const candidateId=
          String(candidate.client_id);

        if(
          await hasCapacity(
            candidateId
          )
        ){
          desiredCollector=
            candidateId;

          break;
        }
      }
    }
  }

  if(
    demandCount>0 &&
    !desiredCollector &&
    options?.retainCurrentIfNoAlternative===true &&
    currentCollector &&
    eligible.some(
      row=>
        String(row.client_id)===
        currentCollector
    )
  ){
    const currentLoad=
      await getGlobalCollectorLoad(
        currentCollector,
        type,
        id,
        env
      );

    if(
      currentLoad<
      config.collectorMaxTargets
    ){
      desiredCollector=
        currentCollector;
    }
  }

  if(
    !preferredCollector &&
    desiredCollector
  ){
    preferredCollector=
      desiredCollector;
  }

  const desiredActive=
    demandCount>0
      ? 1
      : 0;

  if(desiredActive===0){
    desiredCollector=null;
  }

  const currentActive=
    Number(current?.active || 0);

  const assignmentChanged=
    currentCollector!==
      desiredCollector;

  const preferredChanged=
    (
      current?.preferred_collector_client_id==
      null
        ? null
        : String(
            current.preferred_collector_client_id
          )
    )!==preferredCollector;

  const activeChanged=
    !current ||
    currentActive!==desiredActive;

  const assignedAtNeedsCleanup=
    !!current &&
    desiredCollector===null &&
    current.collector_assigned_at!=null;

  if(
    current &&
    !assignmentChanged &&
    !preferredChanged &&
    !activeChanged &&
    !assignedAtNeedsCleanup
  ){
    return {
      targetType:type,
      targetId:id,
      changed:false,
      active:
        desiredActive===1,
      demandCount,
      eligibleCollectors:
        candidates.length,
      collectorClientId:
        desiredCollector,
      preferredCollectorClientId:
        preferredCollector,
      collectorMaxTargets:
        config.collectorMaxTargets,
      writes:0
    };
  }

  const now=Date.now();

  const assignedAt=
    desiredCollector===null
      ? null
      : assignmentChanged
        ? now
        : current?.collector_assigned_at ??
          now;

  await env.DB
    .prepare(`
      INSERT INTO global_target_leases
      (
        target_type,
        target_id,
        collector_client_id,
        preferred_collector_client_id,
        collector_assigned_at,
        collector_last_success_at,
        collector_last_failure_at,
        collector_failure_count,
        active,
        created_at,
        updated_at
      )
      VALUES (
        ?, ?, ?, ?, ?,
        NULL, NULL, 0,
        ?, ?, ?
      )
      ON CONFLICT(
        target_type,
        target_id
      )
      DO UPDATE SET
        collector_client_id=
          excluded.collector_client_id,
        preferred_collector_client_id=
          excluded.preferred_collector_client_id,
        collector_assigned_at=
          excluded.collector_assigned_at,
        collector_last_success_at=
          CASE
            WHEN
              global_target_leases.collector_client_id
              IS NOT
              excluded.collector_client_id
            THEN NULL
            ELSE
              global_target_leases.collector_last_success_at
          END,
        collector_last_failure_at=
          CASE
            WHEN
              global_target_leases.collector_client_id
              IS NOT
              excluded.collector_client_id
            THEN NULL
            ELSE
              global_target_leases.collector_last_failure_at
          END,
        collector_failure_count=
          CASE
            WHEN
              global_target_leases.collector_client_id
              IS NOT
              excluded.collector_client_id
            THEN 0
            ELSE
              global_target_leases.collector_failure_count
          END,
        active=
          excluded.active,
        updated_at=
          excluded.updated_at
    `)
    .bind(
      type,
      id,
      desiredCollector,
      preferredCollector,
      assignedAt,
      desiredActive,
      current?.created_at ||
        now,
      now
    )
    .run();

  return {
    targetType:type,
    targetId:id,
    changed:true,
    assignmentChanged,
    active:
      desiredActive===1,
    demandCount,
    eligibleCollectors:
      candidates.length,
    previousCollectorClientId:
      currentCollector,
    collectorClientId:
      desiredCollector,
    preferredCollectorClientId:
      preferredCollector,
    collectorMaxTargets:
      config.collectorMaxTargets,
    writes:1
  };
}


async function recordGlobalCollectorSuccess(
  targetType,
  targetId,
  collectorClientId,
  env
){
  const type=
    normalizeGlobalTargetType(targetType);

  const id=String(targetId || '').trim();
  const collectorId=
    String(collectorClientId || '').trim();

  if(
    !/^\d+$/.test(id) ||
    !collectorId
  ){
    throw new Error(
      'Invalid global collector success target'
    );
  }

  const lease=
    await env.DB
      .prepare(`
        SELECT
          collector_client_id,
          collector_last_success_at,
          collector_last_failure_at,
          collector_failure_count
        FROM global_target_leases
        WHERE target_type=?
          AND target_id=?
          AND active=1
        LIMIT 1
      `)
      .bind(type,id)
      .first();

  if(
    !lease ||
    String(
      lease.collector_client_id || ''
    )!==collectorId
  ){
    return {
      matched:false,
      recovered:false,
      writes:0
    };
  }

  const recovering=
    lease.collector_last_failure_at!=null ||
    Number(
      lease.collector_failure_count || 0
    )>0;

  const firstSuccess=
    lease.collector_last_success_at==null;

  if(
    !recovering &&
    !firstSuccess
  ){
    return {
      matched:true,
      recovered:false,
      firstSuccess:false,
      writes:0
    };
  }

  const now=Date.now();

  await env.DB
    .prepare(`
      UPDATE global_target_leases
      SET
        collector_last_success_at=?,
        collector_last_failure_at=NULL,
        collector_failure_count=0,
        updated_at=?
      WHERE target_type=?
        AND target_id=?
        AND collector_client_id=?
        AND active=1
    `)
    .bind(
      now,
      now,
      type,
      id,
      collectorId
    )
    .run();

  return {
    matched:true,
    recovered:recovering,
    firstSuccess,
    successAt:now,
    writes:1
  };
}


async function recordGlobalCollectorFailure(
  targetType,
  targetId,
  collectorClientId,
  error,
  env
){
  const type=
    normalizeGlobalTargetType(targetType);

  const id=String(targetId || '').trim();
  const collectorId=
    String(collectorClientId || '').trim();

  if(
    !/^\d+$/.test(id) ||
    !collectorId
  ){
    throw new Error(
      'Invalid global collector failure target'
    );
  }

  const config=
    await getGlobalPoolConfig(env);

  const lease=
    await env.DB
      .prepare(`
        SELECT
          collector_client_id,
          collector_last_failure_at,
          collector_failure_count,
          active
        FROM global_target_leases
        WHERE target_type=?
          AND target_id=?
        LIMIT 1
      `)
      .bind(type,id)
      .first();

  if(
    !lease ||
    Number(lease.active)!==1 ||
    String(
      lease.collector_client_id || ''
    )!==collectorId
  ){
    return {
      matched:false,
      writes:0,
      failoverAttempted:false
    };
  }

  const now=Date.now();

  let firstFailureAt=
    lease.collector_last_failure_at==null
      ? null
      : Number(
          lease.collector_last_failure_at
        );

  let writes=0;
  let failureEpisodeStarted=false;

  if(!firstFailureAt){
    firstFailureAt=now;
    failureEpisodeStarted=true;

    await env.DB
      .prepare(`
        UPDATE global_target_leases
        SET
          collector_last_failure_at=?,
          collector_failure_count=
            CASE
              WHEN collector_failure_count<1
              THEN 1
              ELSE collector_failure_count
            END,
          updated_at=?
        WHERE target_type=?
          AND target_id=?
          AND collector_client_id=?
          AND active=1
      `)
      .bind(
        firstFailureAt,
        now,
        type,
        id,
        collectorId
      )
      .run();

    writes++;
  }

  const failureDurationMs=
    Math.max(
      0,
      now-firstFailureAt
    );

  let failover=null;

  if(
    failureDurationMs>=
    config.collectorFailoverAfterMs
  ){
    failover=
      await reconcileGlobalTargetLease(
        type,
        id,
        env,
        {
          excludeCollectorClientId:
            collectorId,
          retainCurrentIfNoAlternative:
            true
        }
      );

    writes+=Number(
      failover?.writes || 0
    );
  }

  const nextCollectorId=
    failover?.collectorClientId==null
      ? collectorId
      : String(
          failover.collectorClientId
        );

  return {
    matched:true,
    failureEpisodeStarted,
    failureCode:
      error?.code ||
      'GLOBAL_COLLECTOR_FAILURE',
    firstFailureAt,
    failureDurationMs,
    failoverAfterMs:
      config.collectorFailoverAfterMs,
    failoverAttempted:
      failover!=null,
    transferred:
      !!(
        failover &&
        nextCollectorId!==collectorId
      ),
    retainedBecauseNoAlternative:
      !!(
        failover &&
        nextCollectorId===collectorId
      ),
    collectorClientId:
      nextCollectorId,
    failover,
    writes
  };
}


async function reconcileGlobalTargetsForClient(
  clientId,
  env
){
  const id=String(clientId || '').trim();

  if(!id){
    return {
      changed:0,
      checked:0
    };
  }

  const factions=
    await env.DB
      .prepare(`
        SELECT
          faction_id
        FROM watched_factions
        WHERE client_id=?
          AND active=1
      `)
      .bind(id)
      .all();

  const players=
    await env.DB
      .prepare(`
        SELECT
          player_id
        FROM subscriptions
        WHERE client_id=?
          AND active=1
      `)
      .bind(id)
      .all();

  let checked=0;
  let changed=0;

  for(const row of factions?.results || []){
    const result=
      await reconcileGlobalTargetLease(
        'faction',
        row.faction_id,
        env
      );

    checked++;

    if(result.changed){
      changed++;
    }
  }

  for(const row of players?.results || []){
    const result=
      await reconcileGlobalTargetLease(
        'player',
        row.player_id,
        env
      );

    checked++;

    if(result.changed){
      changed++;
    }
  }

  return {
    checked,
    changed
  };
}


async function safeEnsureAndReconcileGlobalTarget(
  targetType,
  targetId,
  targetName,
  env
){
  try{
    await ensureGlobalTargetRegistry(
      targetType,
      targetId,
      targetName,
      env
    );

    return await reconcileGlobalTargetLease(
      targetType,
      targetId,
      env
    );
  }catch(error){
    console.error(
      'Global target ensure/reconcile failed',
      String(targetType),
      String(targetId),
      String(error?.message || error)
    );

    return null;
  }
}


async function safeReconcileGlobalTarget(
  targetType,
  targetId,
  env
){
  try{
    return await reconcileGlobalTargetLease(
      targetType,
      targetId,
      env
    );
  }catch(error){
    console.error(
      'Global target reconcile failed',
      String(targetType),
      String(targetId),
      String(error?.message || error)
    );

    return null;
  }
}


async function safeReconcileGlobalTargetsForClient(
  clientId,
  env
){
  try{
    return await reconcileGlobalTargetsForClient(
      clientId,
      env
    );
  }catch(error){
    console.error(
      'Global client reconcile failed',
      String(clientId),
      String(error?.message || error)
    );

    return null;
  }
}


const ACCESS_CHECK_WRITE_INTERVAL_MS=300000;

function normalizeTrackerFactionId(value){
  if(
    value==null ||
    String(value).trim()==='' ||
    String(value).trim()==='0'
  ){
    return null;
  }

  return String(value).trim();
}

function extractTrackerCurrentFaction(data,profile){
  const source=
    data && typeof data==='object'
      ? data
      : {};

  if(
    Object.prototype.hasOwnProperty.call(
      source,
      'faction'
    )
  ){
    const faction=source.faction;

    if(faction==null){
      return {
        known:true,
        factionId:null
      };
    }

    if(
      typeof faction==='string' ||
      typeof faction==='number'
    ){
      return {
        known:true,
        factionId:
          normalizeTrackerFactionId(faction)
      };
    }

    if(
      faction &&
      typeof faction==='object'
    ){
      const candidate=
        faction.id ??
        faction.faction_id ??
        faction.ID ??
        null;

      return {
        known:true,
        factionId:
          normalizeTrackerFactionId(candidate)
      };
    }

    return {
      known:true,
      factionId:null
    };
  }

  const p=
    profile && typeof profile==='object'
      ? profile
      : {};

  if(
    Object.prototype.hasOwnProperty.call(
      p,
      'faction_id'
    )
  ){
    return {
      known:true,
      factionId:
        normalizeTrackerFactionId(
          p.faction_id
        )
    };
  }

  return {
    known:false,
    factionId:null
  };
}

async function touchClientAccessCheck(
  client,
  env,
  now
){
  const last=
    Number(client.accessLastCheckedAt || 0);

  if(
    last &&
    now-last<ACCESS_CHECK_WRITE_INTERVAL_MS
  ){
    return;
  }

  await env.DB
    .prepare(`
      UPDATE clients
      SET access_last_checked_at=?
      WHERE client_id=?
    `)
    .bind(
      now,
      client.clientId
    )
    .run();

  client.accessLastCheckedAt=now;
}

async function updateClientFactionAccess(
  client,
  factionInfo,
  env
){
  const currentStatus=
    client.accessStatus || 'active';

  if(
    client.role==='admin' ||
    client.accessType!=='faction' ||
    !client.registeredFactionId
  ){
    return {
      status:currentStatus,
      changed:false,
      checked:false,
      reason:'not-faction-controlled'
    };
  }

  if(!factionInfo?.known){
    return {
      status:currentStatus,
      changed:false,
      checked:false,
      reason:'faction-unavailable'
    };
  }

  const now=Date.now();

  const expectedFactionId=
    String(client.registeredFactionId);

  const currentFactionId=
    factionInfo.factionId==null
      ? null
      : String(factionInfo.factionId);

  if(currentFactionId===expectedFactionId){
    const restoring=
      currentStatus!=='active' ||
      client.factionMismatchSince!=null ||
      client.accessSuspendedAt!=null;

    if(restoring){
      await env.DB
        .prepare(`
          UPDATE clients
          SET
            access_status='active',
            faction_mismatch_since=NULL,
            access_suspended_at=NULL,
            access_last_checked_at=?,
            access_updated_at=?
          WHERE client_id=?
        `)
        .bind(
          now,
          now,
          client.clientId
        )
        .run();

      client.accessStatus='active';
      client.factionMismatchSince=null;
      client.accessSuspendedAt=null;
      client.accessLastCheckedAt=now;

      await safeReconcileGlobalTargetsForClient(
        client.clientId,
        env
      );

      return {
        status:'active',
        changed:true,
        checked:true,
        restored:true,
        currentFactionId
      };
    }

    await touchClientAccessCheck(
      client,
      env,
      now
    );

    return {
      status:'active',
      changed:false,
      checked:true,
      restored:false,
      currentFactionId
    };
  }

  if(
    currentStatus==='active' ||
    client.factionMismatchSince==null
  ){
    await env.DB
      .prepare(`
        UPDATE clients
        SET
          access_status='grace',
          faction_mismatch_since=?,
          access_suspended_at=NULL,
          access_last_checked_at=?,
          access_updated_at=?
        WHERE client_id=?
      `)
      .bind(
        now,
        now,
        now,
        client.clientId
      )
      .run();

    client.accessStatus='grace';
    client.factionMismatchSince=now;
    client.accessSuspendedAt=null;
    client.accessLastCheckedAt=now;

    return {
      status:'grace',
      changed:true,
      checked:true,
      graceStartedAt:now,
      currentFactionId
    };
  }

  if(currentStatus==='suspended'){
    await touchClientAccessCheck(
      client,
      env,
      now
    );

    return {
      status:'suspended',
      changed:false,
      checked:true,
      suspendedAt:
        client.accessSuspendedAt || null,
      currentFactionId
    };
  }

  const config=
    await env.DB
      .prepare(`
        SELECT grace_period_ms
        FROM tracker_access_config
        WHERE id=1
        LIMIT 1
      `)
      .first();

  const gracePeriodMs=
    Math.max(
      0,
      Number(
        config?.grace_period_ms ||
        86400000
      )
    );

  const mismatchSince=
    Number(client.factionMismatchSince);

  if(
    currentStatus==='grace' &&
    now-mismatchSince>=gracePeriodMs
  ){
    await env.DB
      .prepare(`
        UPDATE clients
        SET
          access_status='suspended',
          access_suspended_at=?,
          access_last_checked_at=?,
          access_updated_at=?
        WHERE client_id=?
      `)
      .bind(
        now,
        now,
        now,
        client.clientId
      )
      .run();

    client.accessStatus='suspended';
    client.accessSuspendedAt=now;
    client.accessLastCheckedAt=now;

    await safeReconcileGlobalTargetsForClient(
      client.clientId,
      env
    );

    return {
      status:'suspended',
      changed:true,
      checked:true,
      suspendedAt:now,
      currentFactionId
    };
  }

  await touchClientAccessCheck(
    client,
    env,
    now
  );

  return {
    status:'grace',
    changed:false,
    checked:true,
    graceStartedAt:
      client.factionMismatchSince || null,
    currentFactionId
  };
}


async function getClientAccessSnapshot(
  client,
  env
){
  const now=Date.now();

  const config=
    await env.DB
      .prepare(`
        SELECT
          c.primary_faction_id,
          c.support_admin_client_id,
          c.grace_period_ms,
          a.torn_user_id AS support_admin_torn_user_id,
          a.torn_name AS support_admin_torn_name
        FROM tracker_access_config c
        LEFT JOIN clients a
          ON a.client_id=c.support_admin_client_id
        WHERE c.id=1
        LIMIT 1
      `)
      .first();

  const latestRequest=
    await env.DB
      .prepare(`
        SELECT
          request_id,
          request_type,
          status,
          requested_access_status,
          requested_faction_id,
          requested_at,
          resolved_at,
          activated_at
        FROM access_requests
        WHERE client_id=?
        ORDER BY requested_at DESC
        LIMIT 1
      `)
      .bind(client.clientId)
      .first();

  const approval=
    await env.DB
      .prepare(`
        SELECT
          code_hash,
          expires_at,
          access_request_id
        FROM personal_access_codes
        WHERE target_client_id=?
          AND active=1
          AND (
            expires_at IS NULL OR
            expires_at>?
          )
        ORDER BY created_at DESC
        LIMIT 1
      `)
      .bind(
        client.clientId,
        now
      )
      .first();

  const gracePeriodMs=
    Math.max(
      0,
      Number(
        config?.grace_period_ms ||
        86400000
      )
    );

  const mismatchSince=
    client.factionMismatchSince==null
      ? null
      : Number(client.factionMismatchSince);

  const graceEndsAt=
    mismatchSince==null
      ? null
      : mismatchSince+gracePeriodMs;

  const graceRemainingMs=
    graceEndsAt==null
      ? null
      : Math.max(
          0,
          graceEndsAt-now
        );

  const supportAdminTornUserId=
    config?.support_admin_torn_user_id==null
      ? null
      : String(
          config.support_admin_torn_user_id
        );

  const supportAdmin=
    supportAdminTornUserId
      ? {
          tornUserId:
            supportAdminTornUserId,
          name:
            config?.support_admin_torn_name ||
            'Tracker Admin',
          profileUrl:
            'https://www.torn.com/profiles.php?XID='+
            encodeURIComponent(
              supportAdminTornUserId
            )
        }
      : null;

  const personalAccessReady=
    !!approval;

  const pendingRequest=
    latestRequest?.status==='pending';

  return {
    accessType:
      client.accessType || 'legacy',
    accessStatus:
      client.accessStatus || 'active',
    registeredFactionId:
      client.registeredFactionId || null,
    factionMismatchSince:
      mismatchSince,
    suspendedAt:
      client.accessSuspendedAt || null,
    gracePeriodMs,
    graceEndsAt,
    graceRemainingMs,
    supportAdmin,
    personalAccessReady,
    canRequestPersonal:
      client.accessType==='faction' &&
      (
        client.accessStatus==='grace' ||
        client.accessStatus==='suspended'
      ) &&
      !pendingRequest &&
      !personalAccessReady,
    canActivatePersonal:
      personalAccessReady,
    latestRequest:
      latestRequest
        ? {
            requestId:
              latestRequest.request_id,
            type:
              latestRequest.request_type,
            status:
              latestRequest.status,
            requestedAccessStatus:
              latestRequest.requested_access_status ||
              null,
            requestedFactionId:
              latestRequest.requested_faction_id ||
              null,
            requestedAt:
              Number(
                latestRequest.requested_at
              ),
            resolvedAt:
              latestRequest.resolved_at==null
                ? null
                : Number(
                    latestRequest.resolved_at
                  ),
            activatedAt:
              latestRequest.activated_at==null
                ? null
                : Number(
                    latestRequest.activated_at
                  )
          }
        : null
  };
}


async function activateClientPersonalAccess(
  client,
  codeRow,
  env
){
  if(
    !codeRow ||
    Number(codeRow.active)!==1
  ){
    throw new Error(
      'Personal Access Code is not active'
    );
  }

  const wasPendingRegistration=
    client.accessType==='pending' &&
    client.accessStatus==='pending';

  const now=Date.now();

  if(
    codeRow.expires_at!=null &&
    Number(codeRow.expires_at)<=now
  ){
    throw new Error(
      'Personal Access Code has expired'
    );
  }

  if(
    codeRow.target_client_id &&
    String(codeRow.target_client_id)!==
      String(client.clientId)
  ){
    throw new Error(
      'Personal Access Code is assigned to another tracker account'
    );
  }

  if(
    codeRow.target_torn_user_id &&
    String(codeRow.target_torn_user_id)!==
      String(client.tornUserId || '')
  ){
    throw new Error(
      'Personal Access Code is assigned to another Torn account'
    );
  }

  const statements=[
    env.DB
      .prepare(`
        UPDATE clients
        SET
          access_type='personal',
          access_status='active',
          registered_faction_id=NULL,
          faction_mismatch_since=NULL,
          access_suspended_at=NULL,
          access_granted_at=?,
          access_granted_by_client_id=?,
          access_updated_at=?
        WHERE client_id=?
      `)
      .bind(
        now,
        codeRow.created_by_client_id ||
          null,
        now,
        client.clientId
      ),

    env.DB
      .prepare(`
        UPDATE personal_access_codes
        SET
          active=0,
          used_at=?,
          used_by_client_id=?
        WHERE code_hash=?
          AND active=1
      `)
      .bind(
        now,
        client.clientId,
        codeRow.code_hash
      )
  ];

  if(codeRow.access_request_id){
    statements.push(
      env.DB
        .prepare(`
          UPDATE access_requests
          SET
            status='completed',
            resolved_at=COALESCE(
              resolved_at,
              ?
            ),
            activated_at=?
          WHERE request_id=?
            AND client_id=?
        `)
        .bind(
          now,
          now,
          codeRow.access_request_id,
          client.clientId
        )
    );
  }

  if(
    wasPendingRegistration &&
    client.ownFactionId
  ){
    statements.push(
      env.DB
        .prepare(`
          INSERT INTO watched_factions
          (
            client_id,
            faction_id,
            faction_name,
            active,
            created_at,
            next_poll_at,
            is_own_faction
          )
          VALUES (?, ?, NULL, 1, ?, 0, 1)
          ON CONFLICT(
            client_id,
            faction_id
          )
          DO UPDATE SET
            active=1,
            next_poll_at=0,
            is_own_faction=1
        `)
        .bind(
          client.clientId,
          String(client.ownFactionId),
          now
        )
    );
  }

  await env.DB.batch(statements);

  client.accessType='personal';
  client.accessStatus='active';
  client.registeredFactionId=null;
  client.factionMismatchSince=null;
  client.accessSuspendedAt=null;

  let pendingOwnFactionAdded=false;
  let schedulerStarted=false;
  let schedulerAlreadyRunning=false;
  let schedulerError=null;

  if(wasPendingRegistration){
    if(client.ownFactionId){
      pendingOwnFactionAdded=true;

      await safeEnsureAndReconcileGlobalTarget(
        'faction',
        String(client.ownFactionId),
        null,
        env
      );
    }

    try{
      const schedulerId=
        env.TRACKER_SCHEDULER.idFromName(
          client.clientId
        );

      const scheduler=
        env.TRACKER_SCHEDULER.get(
          schedulerId
        );

      const schedulerResult=
        await scheduler.start();

      schedulerStarted=true;
      schedulerAlreadyRunning=
        schedulerResult?.alreadyRunning===true;
    }catch(error){
      schedulerError=
        trackerSafeError(error);

      console.error(
        'Pending registration scheduler start failed',
        schedulerError
      );
    }
  }

  await safeReconcileGlobalTargetsForClient(
    client.clientId,
    env
  );

  return {
    activated:true,
    accessType:'personal',
    accessStatus:'active',
    activatedAt:now,
    pendingRegistrationActivated:
      wasPendingRegistration,
    ownFactionAdded:
      pendingOwnFactionAdded,
    schedulerStarted,
    schedulerAlreadyRunning,
    schedulerError
  };
}



async function issueClientPersonalAccess(
  adminClient,
  targetClientId,
  requestedRequestId,
  env
){
  const target=
    await env.DB
      .prepare(`
        SELECT
          client_id,
          torn_user_id,
          torn_name,
          access_type,
          access_status,
          registered_faction_id
        FROM clients
        WHERE client_id=?
          AND active=1
        LIMIT 1
      `)
      .bind(targetClientId)
      .first();

  if(!target){
    const error=
      new Error('Tracker user not found');

    error.httpStatus=404;
    throw error;
  }

  const isFactionPersonalUpgrade=
    target.access_type==='faction' &&
    (
      target.access_status==='grace' ||
      target.access_status==='suspended'
    );

  const isPendingRegistration=
    target.access_type==='pending' &&
    target.access_status==='pending' &&
    !!requestedRequestId;

  if(
    !isFactionPersonalUpgrade &&
    !isPendingRegistration
  ){
    const error=
      new Error(
        'Personal Access is not available for this tracker account state'
      );

    error.httpStatus=409;
    throw error;
  }

  let requestRow=null;

  if(requestedRequestId){
    requestRow=
      await env.DB
        .prepare(`
          SELECT
            request_id,
            client_id,
            status
          FROM access_requests
          WHERE request_id=?
            AND client_id=?
          LIMIT 1
        `)
        .bind(
          requestedRequestId,
          target.client_id
        )
        .first();

    if(!requestRow){
      const error=
        new Error(
          'Access request not found'
        );

      error.httpStatus=404;
      throw error;
    }

    if(requestRow.status!=='pending'){
      const error=
        new Error(
          'Access request is no longer pending'
        );

      error.httpStatus=409;
      throw error;
    }
  }else{
    requestRow=
      await env.DB
        .prepare(`
          SELECT
            request_id,
            client_id,
            status
          FROM access_requests
          WHERE client_id=?
            AND status='pending'
          ORDER BY requested_at ASC
          LIMIT 1
        `)
        .bind(target.client_id)
        .first();
  }

  const requestId=
    requestRow?.request_id ||
    crypto.randomUUID();

  const accessCode=
    createInviteCode();

  const codeHash=
    await sha256Hex(accessCode);

  const encrypted=
    await encryptApiKey(
      accessCode,
      'personal-access:'+
        String(target.client_id),
      env
    );

  const now=Date.now();

  const statements=[];

  statements.push(
    env.DB
      .prepare(`
        UPDATE personal_access_codes
        SET active=0
        WHERE target_client_id=?
          AND active=1
      `)
      .bind(target.client_id)
  );

  if(requestRow){
    statements.push(
      env.DB
        .prepare(`
          UPDATE access_requests
          SET
            status='approved',
            resolved_at=?,
            resolved_by_client_id=?
          WHERE request_id=?
            AND client_id=?
            AND status='pending'
        `)
        .bind(
          now,
          adminClient.clientId,
          requestId,
          target.client_id
        )
    );
  }else{
    statements.push(
      env.DB
        .prepare(`
          INSERT INTO access_requests
          (
            request_id,
            client_id,
            torn_user_id,
            request_type,
            status,
            requested_access_status,
            requested_faction_id,
            requested_at,
            resolved_at,
            resolved_by_client_id
          )
          VALUES
          (
            ?, ?, ?,
            'admin_personal',
            'approved',
            ?, ?, ?, ?, ?
          )
        `)
        .bind(
          requestId,
          target.client_id,
          target.torn_user_id || null,
          target.access_status,
          target.registered_faction_id ||
            null,
          now,
          now,
          adminClient.clientId
        )
    );
  }

  statements.push(
    env.DB
      .prepare(`
        INSERT INTO personal_access_codes
        (
          code_hash,
          target_client_id,
          target_torn_user_id,
          active,
          created_by_client_id,
          created_at,
          expires_at,
          used_at,
          used_by_client_id,
          code_ciphertext,
          code_iv,
          access_request_id
        )
        VALUES
        (
          ?, ?, ?, 1, ?, ?,
          NULL, NULL, NULL,
          ?, ?, ?
        )
      `)
      .bind(
        codeHash,
        target.client_id,
        target.torn_user_id || null,
        adminClient.clientId,
        now,
        encrypted.ciphertext,
        encrypted.iv,
        requestId
      )
  );

  await env.DB.batch(statements);

  return {
    issued:true,
    requestId,
    accessCode,
    targetClientId:
      String(target.client_id),
    tornUserId:
      target.torn_user_id==null
        ? null
        : String(target.torn_user_id),
    tornName:
      target.torn_name || null,
    accessStatus:
      target.access_status,
    registeredFactionId:
      target.registered_faction_id ||
      null,
    issuedAt:now
  };
}


async function syncClientOwnFaction(
  client,
  factionInfo,
  env
){
  if(!factionInfo?.known){
    return {
      checked:false,
      changed:false,
      reason:'faction-unavailable'
    };
  }

  const previousFactionId=
    normalizeTrackerFactionId(
      client?.ownFactionId
    );

  const currentFactionId=
    normalizeTrackerFactionId(
      factionInfo?.factionId
    );

  const watchResult=
    await env.DB
      .prepare(`
        SELECT
          faction_id,
          active,
          is_own_faction
        FROM watched_factions
        WHERE client_id=?
          AND (
            is_own_faction=1
            OR faction_id=?
          )
      `)
      .bind(
        client.clientId,
        currentFactionId
      )
      .all();

  const watchRows=
    watchResult?.results || [];

  const previousOwnWatchFactionIds=[
    ...new Set(
      watchRows
        .filter(
          row=>
            Number(row.is_own_faction || 0)===1
        )
        .map(
          row=>
            normalizeTrackerFactionId(
              row.faction_id
            )
        )
        .filter(Boolean)
    )
  ];

  const currentWatchRow=
    currentFactionId
      ? watchRows.find(
          row=>
            String(row.faction_id)===
            currentFactionId
        ) || null
      : null;

  const clientMatches=
    previousFactionId===currentFactionId;

  const watchMatches=
    currentFactionId
      ? !!currentWatchRow &&
        Number(currentWatchRow.active || 0)===1 &&
        Number(
          currentWatchRow.is_own_faction || 0
        )===1 &&
        previousOwnWatchFactionIds.every(
          factionId=>
            factionId===currentFactionId
        )
      : previousOwnWatchFactionIds.length===0;

  if(clientMatches && watchMatches){
    return {
      checked:true,
      changed:false,
      previousFactionId,
      currentFactionId,
      watchRepaired:false,
      previousOwnWatchFactionIds
    };
  }

  const now=Date.now();
  const statements=[];

  if(!clientMatches){
    statements.push(
      env.DB
        .prepare(`
          UPDATE clients
          SET own_faction_id=?
          WHERE client_id=?
        `)
        .bind(
          currentFactionId,
          client.clientId
        )
    );
  }

  if(previousOwnWatchFactionIds.length>0){
    statements.push(
      env.DB
        .prepare(`
          UPDATE watched_factions
          SET
            active=0,
            is_own_faction=0,
            next_poll_at=0
          WHERE client_id=?
            AND is_own_faction=1
        `)
        .bind(client.clientId)
    );
  }

  if(currentFactionId){
    statements.push(
      env.DB
        .prepare(`
          INSERT INTO watched_factions
          (
            client_id,
            faction_id,
            faction_name,
            active,
            created_at,
            next_poll_at,
            is_own_faction
          )
          VALUES (?, ?, NULL, 1, ?, 0, 1)
          ON CONFLICT(client_id,faction_id)
          DO UPDATE SET
            active=1,
            next_poll_at=0,
            is_own_faction=1
        `)
        .bind(
          client.clientId,
          currentFactionId,
          now
        )
    );
  }

  if(statements.length){
    await env.DB.batch(statements);
  }

  client.ownFactionId=currentFactionId;

  const oldTargetIds=[
    ...new Set([
      ...previousOwnWatchFactionIds,
      previousFactionId
    ].filter(Boolean))
  ];

  for(const oldFactionId of oldTargetIds){
    if(oldFactionId===currentFactionId){
      continue;
    }

    await safeReconcileGlobalTarget(
      'faction',
      oldFactionId,
      env
    );
  }

  if(currentFactionId){
    await safeEnsureAndReconcileGlobalTarget(
      'faction',
      currentFactionId,
      null,
      env
    );
  }

  return {
    checked:true,
    changed:true,
    previousFactionId,
    currentFactionId,
    identityChanged:
      !clientMatches,
    watchRepaired:
      !watchMatches,
    previousOwnWatchFactionIds,
    updatedAt:now
  };
}

async function refreshClientRuntimeState(client,env) {
  const result=
    await clientTornRequest(
      client,
      '/v2/user/?selections=profile,travel,faction',
      env
    );

  const profile=
    result?.data?.profile ||
    result?.data ||
    {};

  const travel=
    result?.data?.travel ||
    {};

  const factionInfo=
    extractTrackerCurrentFaction(
      result?.data,
      profile
    );

  const isTravelling=
    profile?.status?.state==='Traveling';

  const destination=
    isTravelling &&
    travel.destination &&
    travel.method!=='Return'
      ? String(travel.destination)
      : null;

  const travelStarted=
    isTravelling &&
    travel.departed_at
      ? Number(travel.departed_at)*1000
      : null;

  const travelArrival=
    isTravelling &&
    travel.arrival_at
      ? Number(travel.arrival_at)*1000
      : null;

  const now=Date.now();

  await env.DB
    .prepare(`
      INSERT INTO client_runtime_state
      (
        client_id,
        my_destination,
        my_travel_started,
        my_travel_arrival,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(client_id)
      DO UPDATE SET
        my_destination=excluded.my_destination,
        my_travel_started=excluded.my_travel_started,
        my_travel_arrival=excluded.my_travel_arrival,
        updated_at=excluded.updated_at
    `)
    .bind(
      client.clientId,
      destination,
      travelStarted,
      travelArrival,
      now
    )
    .run();

  const ownFaction=
    await syncClientOwnFaction(
      client,
      factionInfo,
      env
    );

  const access=
    await updateClientFactionAccess(
      client,
      factionInfo,
      env
    );

  return {
    isTravelling,
    destination,
    travelStarted,
    travelArrival,
    updatedAt:now,
    budget:result.budget,
    currentFactionKnown:
      factionInfo.known===true,
    currentFactionId:
      factionInfo.factionId || null,
    ownFaction,
    access
  };
}


async function resolveCurrentFactionName(client,factionId,env){
  const id=normalizeTrackerFactionId(factionId);
  if(!id) return null;

  const cached=await env.DB.prepare(`
    SELECT faction_name
    FROM (
      SELECT faction_name,1 AS priority FROM registered_factions WHERE faction_id=?
      UNION ALL
      SELECT faction_name,2 AS priority FROM global_factions WHERE faction_id=?
      UNION ALL
      SELECT faction_name,3 AS priority FROM watched_factions WHERE client_id=? AND faction_id=?
      UNION ALL
      SELECT faction_name,4 AS priority FROM client_faction_states WHERE client_id=? AND faction_id=?
    )
    WHERE faction_name IS NOT NULL
      AND TRIM(faction_name)<>''
    ORDER BY priority
    LIMIT 1
  `).bind(id,id,client.clientId,id,client.clientId,id).first();

  const cachedName=String(cached?.faction_name || '').trim();
  if(cachedName) return cachedName;

  try{
    const response=await clientTornRequest(
      client,
      '/v2/faction/'+encodeURIComponent(id)+'/basic?striptags=true',
      env
    );

    return String(
      response?.data?.basic?.name ||
      response?.data?.name ||
      response?.data?.faction?.name ||
      ''
    ).trim() || null;
  }catch(e){
    return null;
  }
}

async function pollClientFaction(client,factionRow,env,runtime=null) {
  const factionId=String(factionRow?.faction_id || '').trim();

  if(!/^\d+$/.test(factionId)){
    throw new Error('Invalid faction ID');
  }

  const response=
    await clientTornRequest(
      client,
      '/v2/faction/'+encodeURIComponent(factionId)+'/members?striptags=true',
      env
    );

  const data=response?.data || {};
  const apiMembers=
    Array.isArray(data.members)
      ? data.members
      : [];

  const previousResult=await env.DB
    .prepare(`
      SELECT *
      FROM client_faction_member_states
      WHERE client_id=?
        AND faction_id=?
    `)
    .bind(
      client.clientId,
      factionId
    )
    .all();

  const previousMap=new Map();

  for(const row of previousResult?.results || []){
    previousMap.set(
      String(row.player_id),
      row
    );
  }

  const now=Date.now();
  const writes=[];
  let travellingCount=0;

  for(const apiMem of apiMembers){
    if(apiMem?.id==null) continue;

    const playerId=String(apiMem.id);
    const previous=previousMap.get(playerId) || null;
    const apiStatus=apiMem.status || {};
    const rawStatus=String(
      apiStatus.description || ''
    ).trim();

    let status='idle';
    let destination=null;
    let origin=null;
    let flightType=null;
    let travelStarted=null;
    let landedAt=null;

    const previousStatus=
      previous?.status || 'idle';

    if(
      previousStatus==='traveling' &&
      previous?.travel_started
    ){
      const previousDestination=
        previous.destination || null;

      const previousOrigin=
        previous.origin || null;

      const lookupDest=
        previousDestination==='Torn'
          ? previousOrigin
          : previousDestination;

      if(
        lookupDest &&
        previous.flight_type
      ){
        const slowest=
          getTrackerSlowestDuration(
            lookupDest,
            previous.flight_type
          );

        const elapsedMinutes=
          (
            now-
            Number(previous.travel_started)
          )/60000;

        if(
          elapsedMinutes >
          slowest+
          TRACKER_STUCK_FLIGHT_BUFFER_MIN
        ){
          status='landed';
          destination=previousDestination;
          origin=previousOrigin;
          flightType=previous.flight_type;
          travelStarted=
            Number(previous.travel_started);

          landedAt=
            Number(previous.travel_started)+
            slowest*60000;
        }
      }
    }

    const forcedLanded=status==='landed';

    if(!forcedLanded){
      if(apiStatus.state==='Traveling'){
        const match=
          rawStatus.match(
            /Traveling\s+from\s+(.+?)\s+to\s+(.+)$/i
          );

        if(match){
          origin=match[1].trim();
          destination=match[2].trim();

          flightType=
            TRACKER_PLANE_TYPE_MAP[
              apiStatus.plane_image_type
            ] || 'Commercial';

          const sameFlight=
            previousStatus==='traveling' &&
            previous?.destination===destination &&
            previous?.origin===origin &&
            previous?.flight_type===flightType &&
            previous?.travel_started;

          if(sameFlight){
            travelStarted=
              Number(previous.travel_started);
          }else if(
            String(client.tornUserId || '')===
              playerId &&
            runtime?.my_travel_started
          ){
            travelStarted=
              Number(runtime.my_travel_started);
          }else{
            travelStarted=now;
          }

          status='traveling';
          landedAt=null;
          travellingCount++;
        }else{
          status=previousStatus;
          destination=previous?.destination || null;
          origin=previous?.origin || null;
          flightType=previous?.flight_type || null;
          travelStarted=
            previous?.travel_started==null
              ? null
              : Number(previous.travel_started);
          landedAt=
            previous?.landed_at==null
              ? null
              : Number(previous.landed_at);
        }
      }else if(apiStatus.state==='Abroad'){
        status='abroad';

        const abroadMatch=
          rawStatus.match(
            /^\s*(?:Currently\s+)?in\s+(.+?)\s*$/i
          );

        if(abroadMatch){
          origin=abroadMatch[1].trim();
        }
      }else if(previousStatus==='traveling'){
        status='landed';
        destination=previous?.destination || null;
        origin=previous?.origin || null;
        flightType=previous?.flight_type || null;
        travelStarted=
          previous?.travel_started==null
            ? null
            : Number(previous.travel_started);
        landedAt=now;
      }else if(
        previousStatus==='landed' &&
        previous?.landed_at &&
        now-Number(previous.landed_at)<=
          TRACKER_LANDED_DISPLAY_MS
      ){
        status='landed';
        destination=previous?.destination || null;
        origin=previous?.origin || null;
        flightType=previous?.flight_type || null;
        travelStarted=
          previous?.travel_started==null
            ? null
            : Number(previous.travel_started);
        landedAt=Number(previous.landed_at);
      }
    }

    const lastAction=
      apiMem.last_action?.timestamp==null
        ? null
        : Number(apiMem.last_action.timestamp);

    writes.push(
      env.DB
        .prepare(`
          INSERT INTO client_faction_member_states
          (
            client_id,
            faction_id,
            player_id,
            player_name,
            status,
            raw_status,
            destination,
            origin,
            flight_type,
            travel_started,
            landed_at,
            tbs,
            tbs_human,
            last_action,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(client_id,faction_id,player_id)
          DO UPDATE SET
            player_name=excluded.player_name,
            status=excluded.status,
            raw_status=excluded.raw_status,
            destination=excluded.destination,
            origin=excluded.origin,
            flight_type=excluded.flight_type,
            travel_started=excluded.travel_started,
            landed_at=excluded.landed_at,
            last_action=excluded.last_action,
            updated_at=excluded.updated_at
        `)
        .bind(
          client.clientId,
          factionId,
          playerId,
          String(
            apiMem.name ||
            previous?.player_name ||
            'User '+playerId
          ).slice(0,100),
          status,
          rawStatus || null,
          destination,
          origin,
          flightType,
          travelStarted,
          landedAt,
          previous?.tbs ?? null,
          previous?.tbs_human ?? null,
          lastAction,
          now
        )
    );
  }

  if(writes.length){
    await env.DB.batch(writes);
  }

  let factionName=
    String(
      data?.name ||
      data?.faction?.name ||
      factionRow?.faction_name ||
      ''
    ).trim() || null;

  if(!factionName){
    try{
      const basicResponse=
        await clientTornRequest(
          client,
          '/v2/faction/'+encodeURIComponent(factionId)+'/basic?striptags=true',
          env
        );

      factionName=
        String(
          basicResponse?.data?.basic?.name ||
          basicResponse?.data?.name ||
          basicResponse?.data?.faction?.name ||
          ''
        ).trim() || null;
    }catch(e){
      factionName=null;
    }
  }

  await env.DB.batch([
    env.DB
      .prepare(`
        INSERT INTO client_faction_states
        (
          client_id,
          faction_id,
          faction_name,
          updated_at
        )
        VALUES (?, ?, ?, ?)
        ON CONFLICT(client_id,faction_id)
        DO UPDATE SET
          faction_name=
            COALESCE(
              excluded.faction_name,
              client_faction_states.faction_name
            ),
          updated_at=excluded.updated_at
      `)
      .bind(
        client.clientId,
        factionId,
        factionName,
        now
      ),

    env.DB
      .prepare(`
        UPDATE watched_factions
        SET
          faction_name=
            COALESCE(?,faction_name),
          next_poll_at=?
        WHERE client_id=?
          AND faction_id=?
      `)
      .bind(
        factionName,
        now+TRACKER_POLL_INTERVAL_MS,
        client.clientId,
        factionId
      )
  ]);

  return {
    factionId,
    factionName,
    memberCount:apiMembers.length,
    travellingCount,
    nextPollAt:
      now+TRACKER_POLL_INTERVAL_MS,
    budget:response.budget
  };
}


const TRACKER_BS_CACHE_TTL_MS=3600000;
const TRACKER_BS_MISSING_RETRY_MS=300000;
const TRACKER_BS_BATCH_SIZE=205;
const TRACKER_D1_CACHE_CHUNK_SIZE=90;
const TRACKER_FFSCOUTER_LIMIT_PER_MINUTE=18;

async function consumeGlobalFfscouterBudget(env) {
  const now=Date.now();
  const minuteBucket=Math.floor(now/60000);

  const row=await env.DB
    .prepare(`
      INSERT INTO global_api_usage
      (
        service,
        minute_bucket,
        requests,
        updated_at
      )
      VALUES ('FFScouter', ?, 1, ?)
      ON CONFLICT(service,minute_bucket)
      DO UPDATE SET
        requests=global_api_usage.requests+1,
        updated_at=excluded.updated_at
      WHERE
        global_api_usage.requests <
        ?
      RETURNING requests
    `)
    .bind(
      minuteBucket,
      now,
      TRACKER_FFSCOUTER_LIMIT_PER_MINUTE
    )
    .first();

  if(!row){
    return {
      allowed:false,
      used:TRACKER_FFSCOUTER_LIMIT_PER_MINUTE,
      limit:TRACKER_FFSCOUTER_LIMIT_PER_MINUTE,
      minuteBucket
    };
  }

  return {
    allowed:true,
    used:Number(row.requests || 0),
    limit:TRACKER_FFSCOUTER_LIMIT_PER_MINUTE,
    minuteBucket
  };
}

async function recordClientFfscouterRequest(clientId,env) {
  const now=Date.now();
  const minuteBucket=Math.floor(now/60000);

  await env.DB
    .prepare(`
      INSERT INTO client_api_usage
      (
        client_id,
        minute_bucket,
        torn_requests,
        ffscouter_requests,
        updated_at
      )
      VALUES (?, ?, 0, 1, ?)
      ON CONFLICT(client_id,minute_bucket)
      DO UPDATE SET
        ffscouter_requests=
          client_api_usage.ffscouter_requests+1,
        updated_at=excluded.updated_at
    `)
    .bind(
      clientId,
      minuteBucket,
      now
    )
    .run();
}


async function clientFfscouterGetStats(client,targetIds,env) {
  const ids=[
    ...new Set(
      (Array.isArray(targetIds) ? targetIds : [])
        .filter(id=>id!==null && id!==undefined)
        .map(id=>String(id).trim())
        .filter(id=>/^\d+$/.test(id))
    )
  ];

  if(ids.length===0) return {
    results:[],
    targets:0,
    budget:null
  };

  if(ids.length>TRACKER_BS_BATCH_SIZE){
    throw new Error(
      'FFScouter batch exceeds '+
      TRACKER_BS_BATCH_SIZE+
      ' targets'
    );
  }

  const budget=
    await consumeGlobalFfscouterBudget(env);

  if(!budget.allowed){
    const error=
      new Error('Global FFScouter budget exhausted');

    error.code=
      'FFSCOUTER_BUDGET_EXHAUSTED';

    error.budget=budget;

    throw error;
  }

  let apiKey=
    await getClientTrackerApiKey(
      client.clientId,
      env
    );

  const url=
    new URL(
      'https://ffscouter.com/api/v1/get-stats'
    );

  url.searchParams.set('key',apiKey);
  url.searchParams.set(
    'targets',
    ids.join(',')
  );

  await recordClientFfscouterRequest(
    client.clientId,
    env
  );

  let response;

  try{
    response=await fetch(url,{
      headers:{
        'Accept':'application/json',
        'User-Agent':'DoitsFlightTracker/1.0'
      }
    });
  }finally{
    apiKey=null;
  }

  let data=null;

  try{
    data=await response.json();
  }catch(e){}

  if(!response.ok){
    const error=
      new Error(
        'FFScouter HTTP '+
        response.status
      );

    error.code=
      'FFSCOUTER_HTTP_ERROR';

    error.status=
      response.status;

    throw error;
  }

  if(
    data?.error ||
    (
      data?.code &&
      !Array.isArray(data)
    )
  ){
    const error=
      new Error(
        String(
          data?.error ||
          data?.message ||
          'FFScouter API error'
        )
      );

    error.code=
      'FFSCOUTER_API_ERROR';

    throw error;
  }

  return {
    results:
      Array.isArray(data)
        ? data
        : [],
    targets:ids.length,
    budget
  };
}


async function refreshClientBsCache(client,playerIds,env) {
  const uniqueIds=[
    ...new Set(
      (Array.isArray(playerIds) ? playerIds : [])
        .filter(id=>id!==null && id!==undefined)
        .map(id=>String(id).trim())
        .filter(id=>/^\d+$/.test(id))
    )
  ];

  if(uniqueIds.length===0){
    return {
      total:0,
      stale:0,
      fetched:0,
      requests:0
    };
  }

  const now=Date.now();
  const cutoff=now-TRACKER_BS_CACHE_TTL_MS;
  const cachedMap=new Map();

  for(
    let i=0;
    i<uniqueIds.length;
    i+=TRACKER_D1_CACHE_CHUNK_SIZE
  ){
    const chunk=uniqueIds.slice(
      i,
      i+TRACKER_D1_CACHE_CHUNK_SIZE
    );
    const placeholders=chunk.map(()=>'?').join(',');

    const result=await env.DB
      .prepare(`
        SELECT
          player_id,
          tbs,
          tbs_human,
          fair_fight,
          updated_at
        FROM client_bs_cache
        WHERE client_id=?
          AND player_id IN (${placeholders})
      `)
      .bind(
        client.clientId,
        ...chunk
      )
      .all();

    for(const row of result?.results || []){
      cachedMap.set(
        String(row.player_id),
        row
      );
    }
  }

  const staleIds=uniqueIds.filter(id=>{
    const row=cachedMap.get(id);

    if(!row || !row.updated_at){
      return true;
    }

    if(row.tbs==null){
      return (
        Number(row.updated_at)<
        now-TRACKER_BS_MISSING_RETRY_MS
      );
    }

    return Number(row.updated_at)<cutoff;
  });

  if(staleIds.length===0){
    return {
      total:uniqueIds.length,
      stale:0,
      fetched:0,
      requests:0
    };
  }

  let fetched=0;
  let requests=0;

  for(
    let i=0;
    i<staleIds.length;
    i+=TRACKER_BS_BATCH_SIZE
  ){
    const batch=
      staleIds.slice(
        i,
        i+TRACKER_BS_BATCH_SIZE
      );

    const response=
      await clientFfscouterGetStats(
        client,
        batch,
        env
      );

    requests++;

    const returnedMap=new Map();

    for(const stat of response.results || []){
      const playerId=
        stat?.player_id==null
          ? null
          : String(stat.player_id);

      if(!playerId) continue;

      returnedMap.set(
        playerId,
        stat
      );
    }

    const statements=[];

    for(const playerId of batch){
      const stat=
        returnedMap.get(playerId);

      const previousCache=
        cachedMap.get(playerId) || null;

      const returnedTbs=
        stat?.bs_estimate==null
          ? null
          : Number(stat.bs_estimate);

      const returnedTbsHuman=
        stat?.bs_estimate_human==null
          ? null
          : String(
              stat.bs_estimate_human
            ).slice(0,80);

      const returnedFairFight=
        stat?.fair_fight==null
          ? null
          : Number(stat.fair_fight);

      const tbs=
        Number.isFinite(returnedTbs)
          ? returnedTbs
          : previousCache?.tbs ?? null;

      const tbsHuman=
        returnedTbsHuman ||
        previousCache?.tbs_human ||
        null;

      const fairFight=
        Number.isFinite(returnedFairFight)
          ? returnedFairFight
          : previousCache?.fair_fight ?? null;

      statements.push(
        env.DB
          .prepare(`
            INSERT INTO client_bs_cache
            (
              client_id,
              player_id,
              tbs,
              tbs_human,
              fair_fight,
              updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(client_id,player_id)
            DO UPDATE SET
              tbs=excluded.tbs,
              tbs_human=excluded.tbs_human,
              fair_fight=excluded.fair_fight,
              updated_at=excluded.updated_at
          `)
          .bind(
            client.clientId,
            playerId,
            Number.isFinite(tbs)
              ? tbs
              : null,
            tbsHuman,
            Number.isFinite(fairFight)
              ? fairFight
              : null,
            now
          )
      );

      fetched++;
    }

    if(statements.length){
      await env.DB.batch(statements);
    }
  }

  return {
    total:uniqueIds.length,
    stale:staleIds.length,
    fetched,
    requests
  };
}


async function syncClientBsCacheToStates(clientId,env) {
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE client_faction_member_states
      SET
        tbs=COALESCE(
          (
            SELECT b.tbs
            FROM client_bs_cache b
            WHERE b.client_id=client_faction_member_states.client_id
              AND b.player_id=client_faction_member_states.player_id
          ),
          tbs
        ),
        tbs_human=COALESCE(
          (
            SELECT b.tbs_human
            FROM client_bs_cache b
            WHERE b.client_id=client_faction_member_states.client_id
              AND b.player_id=client_faction_member_states.player_id
          ),
          tbs_human
        )
      WHERE client_id=?
        AND EXISTS (
          SELECT 1
          FROM client_bs_cache b
          WHERE b.client_id=client_faction_member_states.client_id
            AND b.player_id=client_faction_member_states.player_id
        )
    `).bind(clientId),

    env.DB.prepare(`
      UPDATE client_player_states
      SET
        tbs=COALESCE(
          (
            SELECT b.tbs
            FROM client_bs_cache b
            WHERE b.client_id=client_player_states.client_id
              AND b.player_id=client_player_states.player_id
          ),
          tbs
        ),
        tbs_human=COALESCE(
          (
            SELECT b.tbs_human
            FROM client_bs_cache b
            WHERE b.client_id=client_player_states.client_id
              AND b.player_id=client_player_states.player_id
          ),
          tbs_human
        )
      WHERE client_id=?
        AND EXISTS (
          SELECT 1
          FROM client_bs_cache b
          WHERE b.client_id=client_player_states.client_id
            AND b.player_id=client_player_states.player_id
        )
    `).bind(clientId)
  ]);
}


async function pollClientIndividual(client,subscriptionRow,env,runtime=null) {
  const playerId=String(
    subscriptionRow?.player_id || ''
  ).trim();

  if(!/^\d+$/.test(playerId)){
    throw new Error('Invalid Torn player ID');
  }

  const response=
    await clientTornRequest(
      client,
      '/v2/user/'+encodeURIComponent(playerId)+'/basic?striptags=true',
      env
    );

  const data=response?.data || {};

  const profile=
    data?.profile ||
    data?.basic ||
    data?.user ||
    null;

  if(!profile){
    throw new Error(
      'No Torn profile returned for '+playerId
    );
  }

  const previous=await env.DB
    .prepare(`
      SELECT *
      FROM client_player_states
      WHERE client_id=?
        AND player_id=?
    `)
    .bind(
      client.clientId,
      playerId
    )
    .first();

  const cachedBs=await env.DB
    .prepare(`
      SELECT
        tbs,
        tbs_human
      FROM client_bs_cache
      WHERE client_id=?
        AND player_id=?
    `)
    .bind(
      client.clientId,
      playerId
    )
    .first();

  const now=Date.now();

  const apiStatus=
    profile.status || {};

  const rawStatus=
    String(
      apiStatus.description || ''
    ).trim();

  const previousStatus=
    previous?.status || 'idle';

  let status='idle';
  let destination=null;
  let origin=null;
  let flightType=null;
  let travelStarted=null;
  let landedAt=null;

  if(
    previousStatus==='traveling' &&
    previous?.travel_started
  ){
    const previousDestination=
      previous.destination || null;

    const previousOrigin=
      previous.origin || null;

    const lookupDest=
      previousDestination==='Torn'
        ? previousOrigin
        : previousDestination;

    if(
      lookupDest &&
      previous.flight_type
    ){
      const slowest=
        getTrackerSlowestDuration(
          lookupDest,
          previous.flight_type
        );

      const elapsedMinutes=
        (
          now-
          Number(previous.travel_started)
        )/60000;

      if(
        elapsedMinutes >
        slowest+
        TRACKER_STUCK_FLIGHT_BUFFER_MIN
      ){
        status='landed';
        destination=previousDestination;
        origin=previousOrigin;
        flightType=previous.flight_type;
        travelStarted=
          Number(previous.travel_started);

        landedAt=
          Number(previous.travel_started)+
          slowest*60000;
      }
    }
  }

  const forcedLanded=
    status==='landed';

  if(!forcedLanded){
    if(apiStatus.state==='Traveling'){
      const match=
        rawStatus.match(
          /Traveling\s+from\s+(.+?)\s+to\s+(.+)$/i
        );

      if(match){
        origin=match[1].trim();
        destination=match[2].trim();

        flightType=
          TRACKER_PLANE_TYPE_MAP[
            apiStatus.plane_image_type
          ] || 'Commercial';

        const sameFlight=
          previousStatus==='traveling' &&
          previous?.origin===origin &&
          previous?.destination===destination &&
          previous?.flight_type===flightType &&
          previous?.travel_started;

        if(sameFlight){
          travelStarted=
            Number(previous.travel_started);
        }else if(
          String(client.tornUserId || '')===
            playerId &&
          runtime?.my_travel_started
        ){
          travelStarted=
            Number(runtime.my_travel_started);
        }else{
          travelStarted=now;
        }

        status='traveling';
        landedAt=null;
      }else{
        status=previousStatus;

        destination=
          previous?.destination || null;

        origin=
          previous?.origin || null;

        flightType=
          previous?.flight_type || null;

        travelStarted=
          previous?.travel_started==null
            ? null
            : Number(previous.travel_started);

        landedAt=
          previous?.landed_at==null
            ? null
            : Number(previous.landed_at);
      }
    }else if(apiStatus.state==='Abroad'){
      status='abroad';

      const abroadMatch=
        rawStatus.match(
          /^\s*(?:Currently\s+)?in\s+(.+?)\s*$/i
        );

      const country=
        abroadMatch?.[1]?.trim() ||
        previous?.origin ||
        null;

      origin=country;
      destination=null;
      flightType=null;
      travelStarted=null;
      landedAt=null;
    }else if(previousStatus==='traveling'){
      status='landed';

      destination=
        previous?.destination || null;

      origin=
        previous?.origin || null;

      flightType=
        previous?.flight_type || null;

      travelStarted=
        previous?.travel_started==null
          ? null
          : Number(previous.travel_started);

      landedAt=now;
    }else if(
      previousStatus==='landed' &&
      previous?.landed_at &&
      now-Number(previous.landed_at)<=
        TRACKER_LANDED_DISPLAY_MS
    ){
      status='landed';

      destination=
        previous?.destination || null;

      origin=
        previous?.origin || null;

      flightType=
        previous?.flight_type || null;

      travelStarted=
        previous?.travel_started==null
          ? null
          : Number(previous.travel_started);

      landedAt=
        Number(previous.landed_at);
    }
  }

  const factionId=
    profile?.faction_id ??
    profile?.faction?.id ??
    previous?.faction_id ??
    null;

  const lastAction=
    profile?.last_action?.timestamp==null
      ? null
      : Number(
          profile.last_action.timestamp
        );

  const tbs=
    cachedBs?.tbs==null
      ? previous?.tbs ?? null
      : Number(cachedBs.tbs);

  const tbsHuman=
    cachedBs?.tbs_human ||
    previous?.tbs_human ||
    null;

  const playerName=
    String(
      profile?.name ||
      previous?.player_name ||
      'User '+playerId
    ).slice(0,100);

  await env.DB.batch([
    env.DB
      .prepare(`
        INSERT INTO client_player_states
        (
          client_id,
          player_id,
          player_name,
          faction_id,
          status,
          raw_status,
          destination,
          origin,
          flight_type,
          travel_started,
          landed_at,
          tbs,
          tbs_human,
          last_action,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(client_id,player_id)
        DO UPDATE SET
          player_name=excluded.player_name,
          faction_id=excluded.faction_id,
          status=excluded.status,
          raw_status=excluded.raw_status,
          destination=excluded.destination,
          origin=excluded.origin,
          flight_type=excluded.flight_type,
          travel_started=excluded.travel_started,
          landed_at=excluded.landed_at,
          tbs=excluded.tbs,
          tbs_human=excluded.tbs_human,
          last_action=excluded.last_action,
          updated_at=excluded.updated_at
      `)
      .bind(
        client.clientId,
        playerId,
        playerName,
        factionId==null
          ? null
          : String(factionId),
        status,
        rawStatus || null,
        destination,
        origin,
        flightType,
        travelStarted,
        landedAt,
        tbs,
        tbsHuman,
        lastAction,
        now
      ),

    env.DB
      .prepare(`
        UPDATE subscriptions
        SET next_poll_at=?
        WHERE client_id=?
          AND player_id=?
          AND active=1
      `)
      .bind(
        now+TRACKER_POLL_INTERVAL_MS,
        client.clientId,
        playerId
      )
  ]);

  return {
    playerId,
    playerName,
    status,
    origin,
    destination,
    flightType,
    travelStarted,
    landedAt,
    tbs,
    tbsHuman,
    nextPollAt:
      now+TRACKER_POLL_INTERVAL_MS,
    budget:response.budget
  };
}


async function getClientCombinedTrackerCount(clientId,env) {
  const factionRow=await env.DB
    .prepare(`
      SELECT COUNT(*) AS count
      FROM watched_factions
      WHERE client_id=?
        AND active=1
        AND is_own_faction=0
    `)
    .bind(clientId)
    .first();

  const individualRow=await env.DB
    .prepare(`
      SELECT COUNT(*) AS count
      FROM subscriptions
      WHERE client_id=?
        AND active=1
    `)
    .bind(clientId)
    .first();

  const watchedFactions=
    Number(factionRow?.count || 0);

  const trackedIndividuals=
    Number(individualRow?.count || 0);

  return {
    watchedFactions,
    trackedIndividuals,
    total:
      watchedFactions+
      trackedIndividuals
  };
}


function trackerSafeError(error){
  return String(
    error?.stack ||
    error?.message ||
    error ||
    'Unknown error'
  ).replace(
    /([?&]key=)[^&\\s]+/gi,
    '$1[REDACTED]'
  );
}

async function collectGlobalTargetOnce(targetType,targetId,env,options={}){
  const type=normalizeGlobalTargetType(targetType);
  const id=String(targetId || '').trim();

  if(!/^\d+$/.test(id)){
    throw new Error('Invalid global target ID');
  }

  const config=
    options?.config ||
    await getGlobalPoolConfig(env);

  const reconciliation=
    await reconcileGlobalTargetLease(
      type,
      id,
      env
    );

  const lease=
    await env.DB
      .prepare(`
        SELECT
          target_type,
          target_id,
          collector_client_id,
          preferred_collector_client_id,
          active
        FROM global_target_leases
        WHERE target_type=?
          AND target_id=?
        LIMIT 1
      `)
      .bind(type,id)
      .first();

  if(
    !lease ||
    Number(lease.active)!==1
  ){
    return {
      success:true,
      skipped:true,
      reason:'inactive',
      targetType:type,
      targetId:id,
      reconciliation,
      writes:0
    };
  }

  if(!lease.collector_client_id){
    return {
      success:true,
      skipped:true,
      reason:'unassigned',
      targetType:type,
      targetId:id,
      reconciliation,
      writes:0
    };
  }

  const collectorClientId=
    String(lease.collector_client_id);

  const collector=
    await env.DB
      .prepare(`
        SELECT
          client_id,
          torn_user_id,
          torn_name,
          label,
          active,
          access_status,
          CASE
            WHEN
              api_key_ciphertext IS NOT NULL
              AND api_key_iv IS NOT NULL
            THEN 1
            ELSE 0
          END AS api_key_configured
        FROM clients
        WHERE client_id=?
        LIMIT 1
      `)
      .bind(collectorClientId)
      .first();

  if(
    !collector ||
    Number(collector.active)!==1 ||
    Number(collector.api_key_configured)!==1 ||
    String(
      collector.access_status ||
      'active'
    )==='suspended'
  ){
    return {
      success:false,
      skipped:true,
      reason:'collector-ineligible',
      targetType:type,
      targetId:id,
      collectorClientId,
      reconciliation,
      writes:0
    };
  }

  let apiKey=null;

  try{
    apiKey=
      await getClientTrackerApiKey(
        collectorClientId,
        env
      );

    let result;

    if(type==='faction'){
      const target=
        await env.DB
          .prepare(`
            SELECT
              faction_id,
              faction_name
            FROM global_factions
            WHERE faction_id=?
            LIMIT 1
          `)
          .bind(id)
          .first();

      result=
        await pollGlobalFactionTarget(
          {
            faction_id:id,
            faction_name:
              target?.faction_name ||
              null
          },
          apiKey,
          env,
          config
        );
    }else{
      result=
        await pollGlobalPlayerTarget(
          {
            player_id:id
          },
          apiKey,
          env,
          config
        );
    }

    const collectorHealth=
      await recordGlobalCollectorSuccess(
        type,
        id,
        collectorClientId,
        env
      );

    return {
      success:true,
      skipped:false,
      targetType:type,
      targetId:id,
      collectorClientId,
      collectorName:
        collector.torn_name ||
        collector.label ||
        null,
      reconciliation,
      collectorHealth,
      result,
      writes:
        Number(result?.writes || 0)+
        Number(collectorHealth?.writes || 0)
    };
  }catch(error){
    let collectorHealth=null;

    try{
      collectorHealth=
        await recordGlobalCollectorFailure(
          type,
          id,
          collectorClientId,
          error,
          env
        );
    }catch(healthError){
      console.error(
        'Global collector failure recording failed',
        healthError
      );
    }

    return {
      success:false,
      skipped:false,
      targetType:type,
      targetId:id,
      collectorClientId,
      collectorName:
        collector?.torn_name ||
        collector?.label ||
        null,
      reconciliation,
      collectorHealth,
      error:trackerSafeError(error),
      code:error?.code || null,
      writes:
        Number(
          collectorHealth?.writes || 0
        )
    };
  }finally{
    apiKey=null;
  }
}

async function refreshGlobalBsCache(env,config){
  const now=Date.now();

  const bsTtlMs=Math.max(
    60000,
    Number(
      config?.bsTtlMs ||
      86400000
    )
  );

  const dueResult=
    await env.DB
      .prepare(`
        WITH demanded_players AS (
          SELECT DISTINCT
            m.player_id AS player_id
          FROM global_faction_members m
          INNER JOIN global_target_leases l
            ON l.target_type='faction'
           AND l.target_id=m.faction_id
           AND l.active=1

          UNION

          SELECT
            target_id AS player_id
          FROM global_target_leases
          WHERE target_type='player'
            AND active=1
        )
        SELECT
          d.player_id,
          b.tbs,
          b.tbs_human,
          b.fair_fight,
          b.updated_at,
          b.next_refresh_at
        FROM demanded_players d
        LEFT JOIN global_bs_cache b
          ON b.player_id=d.player_id
        WHERE
          b.player_id IS NULL
          OR b.next_refresh_at<=?
        ORDER BY
          CAST(d.player_id AS INTEGER) ASC
      `)
      .bind(now)
      .all();

  const dueRows=
    dueResult?.results || [];

  if(dueRows.length===0){
    return {
      due:0,
      processed:0,
      valid:0,
      missing:0,
      requests:0,
      writes:0,
      budgetExhausted:false,
      collectors:0,
      errors:[]
    };
  }

  const collectorResult=
    await env.DB
      .prepare(`
        SELECT DISTINCT
          c.client_id,
          c.torn_name,
          c.label,
          c.role,
          c.created_at
        FROM global_target_leases l
        INNER JOIN clients c
          ON c.client_id=
             l.collector_client_id
        WHERE l.active=1
          AND l.collector_client_id
              IS NOT NULL
          AND c.active=1
          AND COALESCE(
                c.access_status,
                'active'
              )<>'suspended'
          AND c.api_key_ciphertext
              IS NOT NULL
          AND c.api_key_iv
              IS NOT NULL
        ORDER BY
          CASE
            WHEN c.role='admin'
            THEN 0
            ELSE 1
          END,
          c.created_at ASC,
          c.client_id ASC
      `)
      .all();

  const collectors=
    collectorResult?.results || [];

  if(collectors.length===0){
    return {
      due:dueRows.length,
      processed:0,
      valid:0,
      missing:0,
      requests:0,
      writes:0,
      budgetExhausted:false,
      collectors:0,
      skipped:true,
      reason:'no-eligible-bs-collector',
      errors:[]
    };
  }

  let processed=0;
  let valid=0;
  let missing=0;
  let requests=0;
  let writes=0;
  let budgetExhausted=false;
  const errors=[];

  outer:
  for(
    let offset=0,batchIndex=0;
    offset<dueRows.length;
    offset+=TRACKER_BS_BATCH_SIZE,batchIndex++
  ){
    const batchRows=
      dueRows.slice(
        offset,
        offset+TRACKER_BS_BATCH_SIZE
      );

    const batchIds=
      batchRows
        .map(row=>String(row.player_id))
        .filter(id=>/^\d+$/.test(id));

    if(batchIds.length===0){
      continue;
    }

    let response=null;
    let successfulCollector=null;

    for(
      let attempt=0;
      attempt<collectors.length;
      attempt++
    ){
      const collector=
        collectors[
          (batchIndex+attempt) %
          collectors.length
        ];

      try{
        response=
          await clientFfscouterGetStats(
            {
              clientId:
                String(collector.client_id)
            },
            batchIds,
            env
          );

        requests++;
        successfulCollector=collector;
        break;
      }catch(error){
        if(
          error?.code===
          'FFSCOUTER_BUDGET_EXHAUSTED'
        ){
          budgetExhausted=true;
          break outer;
        }

        requests++;

        errors.push({
          batchStart:offset,
          collectorClientId:
            String(
              collector.client_id
            ),
          collectorName:
            collector.torn_name ||
            collector.label ||
            null,
          error:
            trackerSafeError(error),
          code:
            error?.code || null
        });
      }
    }

    if(!response || !successfulCollector){
      continue;
    }

    const returnedMap=new Map();

    for(const stat of response.results || []){
      const playerId=
        stat?.player_id==null
          ? null
          : String(stat.player_id);

      if(!playerId){
        continue;
      }

      returnedMap.set(
        playerId,
        stat
      );
    }

    const statements=[];

    for(const row of batchRows){
      const playerId=
        String(row.player_id);

      const stat=
        returnedMap.get(playerId);

      const returnedTbs=
        stat?.bs_estimate==null
          ? null
          : Number(
              stat.bs_estimate
            );

      const returnedTbsHuman=
        stat?.bs_estimate_human==null
          ? null
          : String(
              stat.bs_estimate_human
            ).slice(0,80);

      const returnedFairFight=
        stat?.fair_fight==null
          ? null
          : Number(
              stat.fair_fight
            );

      const freshTbs=
        Number.isFinite(
          returnedTbs
        );

      const previousTbs=
        row?.tbs==null
          ? null
          : Number(row.tbs);

      const previousFairFight=
        row?.fair_fight==null
          ? null
          : Number(
              row.fair_fight
            );

      const tbs=
        freshTbs
          ? returnedTbs
          : Number.isFinite(
              previousTbs
            )
            ? previousTbs
            : null;

      const tbsHuman=
        returnedTbsHuman ||
        row?.tbs_human ||
        null;

      const fairFight=
        Number.isFinite(
          returnedFairFight
        )
          ? returnedFairFight
          : Number.isFinite(
              previousFairFight
            )
            ? previousFairFight
            : null;

      const updatedAt=
        freshTbs
          ? now
          : row?.updated_at==null
            ? now
            : Number(
                row.updated_at
              );

      const nextRefreshAt=
        freshTbs
          ? now+bsTtlMs
          : now+
            TRACKER_BS_MISSING_RETRY_MS;

      if(freshTbs){
        valid++;
      }else{
        missing++;
      }

      statements.push(
        env.DB
          .prepare(`
            INSERT INTO global_bs_cache
            (
              player_id,
              tbs,
              tbs_human,
              fair_fight,
              updated_at,
              next_refresh_at
            )
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(player_id)
            DO UPDATE SET
              tbs=excluded.tbs,
              tbs_human=
                excluded.tbs_human,
              fair_fight=
                excluded.fair_fight,
              updated_at=
                excluded.updated_at,
              next_refresh_at=
                excluded.next_refresh_at
          `)
          .bind(
            playerId,
            Number.isFinite(tbs)
              ? tbs
              : null,
            tbsHuman,
            Number.isFinite(fairFight)
              ? fairFight
              : null,
            updatedAt,
            nextRefreshAt
          )
      );

      processed++;
    }

    if(statements.length){
      await runGlobalStatementBatches(
        statements,
        env
      );

      writes+=statements.length;
    }
  }

  return {
    due:dueRows.length,
    processed,
    valid,
    missing,
    requests,
    writes,
    budgetExhausted,
    collectors:collectors.length,
    errors
  };
}

async function runGlobalPoolSchedulerCycle(env){
  const startedAt=Date.now();
  const config=await getGlobalPoolConfig(env);

  const summary={
    mode:'global-pool',
    startedAt,
    enabled:config.enabled===true,
    pollIntervalMs:
      Math.max(
        60000,
        Number(config.pollIntervalMs || 60000)
      ),
    targets:0,
    collected:0,
    unchanged:0,
    skipped:0,
    failures:0,
    writes:0,
    errors:[]
  };

  if(config.enabled!==true){
    summary.skipped=true;
    summary.reason='global-pool-disabled';
    summary.finishedAt=Date.now();
    summary.durationMs=
      summary.finishedAt-startedAt;

    return summary;
  }

  const targetResult=
    await env.DB
      .prepare(`
        WITH targets AS (
          SELECT
            'faction' AS target_type,
            faction_id AS target_id
          FROM watched_factions
          WHERE active=1

          UNION

          SELECT
            'player' AS target_type,
            player_id AS target_id
          FROM subscriptions
          WHERE active=1

          UNION

          SELECT
            target_type,
            target_id
          FROM global_target_leases
          WHERE active=1
        )
        SELECT
          target_type,
          target_id
        FROM targets
        ORDER BY
          target_type ASC,
          target_id ASC
      `)
      .all();

  const targets=
    targetResult?.results || [];

  summary.targets=targets.length;

  for(const target of targets){
    try{
      const result=
        await collectGlobalTargetOnce(
          target.target_type,
          target.target_id,
          env,
          {config}
        );

      summary.writes+=
        Number(result?.writes || 0);

      if(result?.skipped){
        summary.skipped++;
        continue;
      }

      if(result?.success===true){
        summary.collected++;

        if(
          Number(
            result?.result?.writes || 0
          )===0
        ){
          summary.unchanged++;
        }
      }else{
        summary.failures++;

        summary.errors.push({
          targetType:
            String(target.target_type),
          targetId:
            String(target.target_id),
          error:
            result?.error ||
            result?.reason ||
            'Global collection failed',
          code:
            result?.code || null
        });
      }
    }catch(error){
      summary.failures++;

      summary.errors.push({
        targetType:
          String(target.target_type),
        targetId:
          String(target.target_id),
        error:trackerSafeError(error)
      });
    }
  }

  try{
    summary.bsResult=
      await refreshGlobalBsCache(
        env,
        config
      );

    summary.bsRefreshed=true;

    summary.writes+=
      Number(
        summary.bsResult?.writes ||
        0
      );
  }catch(error){
    summary.bsRefreshed=false;
    summary.bsError=
      trackerSafeError(error);

    summary.errors.push({
      type:'global-bs',
      error:
        summary.bsError
    });
  }

  summary.finishedAt=Date.now();
  summary.durationMs=
    summary.finishedAt-startedAt;

  return summary;
}

async function runTrackerSchedulerCycle(env,clientId){
  if(clientId==='global-pool'){
    return runGlobalPoolSchedulerCycle(env);
  }

  const startedAt=Date.now();

  if(!clientId){
    throw new Error('Scheduler client ID is missing');
  }

  const row=await env.DB
    .prepare(`
      SELECT
        client_id,
        role,
        active,
        torn_user_id,
        torn_name,
        own_faction_id,
        max_watched_factions,
        max_tracked_individuals,
        max_combined_trackers,
        max_torn_requests_per_minute,
        api_key_validated_at,
        access_type,
        access_status,
        registered_faction_id,
        faction_mismatch_since,
        access_suspended_at,
        access_last_checked_at
      FROM clients
      WHERE client_id=?
        AND active=1
        AND api_key_ciphertext IS NOT NULL
        AND api_key_iv IS NOT NULL
      LIMIT 1
    `)
    .bind(clientId)
    .first();

  if(!row){
    return {
      clientId,
      startedAt,
      finishedAt:Date.now(),
      skipped:true,
      reason:'inactive-or-unconfigured'
    };
  }

  const client={
    clientId:String(row.client_id),
    role:row.role || 'user',
    tornUserId:
      row.torn_user_id==null
        ? null
        : String(row.torn_user_id),
    tornName:row.torn_name || null,
    ownFactionId:
      row.own_faction_id==null
        ? null
        : String(row.own_faction_id),
    maxWatchedFactions:
      Number(row.max_watched_factions || 10),
    maxTrackedIndividuals:
      Number(row.max_tracked_individuals || 20),
    maxCombinedTrackers:
      Number(row.max_combined_trackers || 25),
    maxTornRequestsPerMinute:
      Number(row.max_torn_requests_per_minute || 60),
    apiKeyConfigured:true,
    apiKeyValidatedAt:
      row.api_key_validated_at==null
        ? null
        : Number(row.api_key_validated_at),
    accessType:
      row.access_type || 'legacy',
    accessStatus:
      row.access_status || 'active',
    registeredFactionId:
      row.registered_faction_id==null
        ? null
        : String(row.registered_faction_id),
    factionMismatchSince:
      row.faction_mismatch_since==null
        ? null
        : Number(row.faction_mismatch_since),
    accessSuspendedAt:
      row.access_suspended_at==null
        ? null
        : Number(row.access_suspended_at),
    accessLastCheckedAt:
      row.access_last_checked_at==null
        ? null
        : Number(row.access_last_checked_at)
  };

  const summary={
    clientId:client.clientId,
    startedAt,
    dueFactions:0,
    dueIndividuals:0,
    factionPolls:0,
    individualPolls:0,
    runtimeRefreshed:false,
    bsRefreshed:false,
    legacyCollectionEnabled:true,
    legacyCollectionSkipped:false,
    errors:[]
  };

  let legacyCollectionEnabled=true;

  try{
    const poolConfig=
      await getGlobalPoolConfig(env);

    legacyCollectionEnabled=
      poolConfig
        .legacyClientCollectionEnabled!==false;
  }catch(error){
    summary.errors.push({
      type:'config',
      error:trackerSafeError(error)
    });

    legacyCollectionEnabled=true;
  }

  summary.legacyCollectionEnabled=
    legacyCollectionEnabled;

  let runtime=null;

  try{
    runtime=await refreshClientRuntimeState(
      client,
      env
    );

    summary.runtimeRefreshed=true;

    if(runtime?.access?.status){
      client.accessStatus=
        runtime.access.status;
    }

    summary.accessStatus=
      client.accessStatus;

    summary.accessChanged=
      runtime?.access?.changed===true;

    summary.ownFactionChanged=
      runtime?.ownFaction?.changed===true;

    summary.previousOwnFactionId=
      runtime?.ownFaction?.previousFactionId ||
      null;

    summary.currentOwnFactionId=
      runtime?.ownFaction?.currentFactionId ||
      null;
  }catch(error){
    summary.errors.push({
      type:'runtime',
      error:trackerSafeError(error)
    });
  }

  if(
    client.accessType==='faction' &&
    client.accessStatus==='suspended'
  ){
    summary.skipped=true;
    summary.reason='access-suspended';
    summary.finishedAt=Date.now();
    summary.durationMs=
      summary.finishedAt-startedAt;

    return summary;
  }

  if(!legacyCollectionEnabled){
    summary.legacyCollectionSkipped=true;
    summary.legacyCollectionReason=
      'disabled-by-global-pool-config';
    summary.finishedAt=Date.now();
    summary.durationMs=
      summary.finishedAt-startedAt;

    return summary;
  }

  const factionResult=await env.DB
    .prepare(`
      SELECT
        faction_id,
        faction_name,
        is_own_faction,
        next_poll_at,
        created_at
      FROM watched_factions
      WHERE client_id=?
        AND active=1
      ORDER BY
        is_own_faction DESC,
        created_at ASC
    `)
    .bind(client.clientId)
    .all();

  const individualResult=await env.DB
    .prepare(`
      SELECT
        player_id,
        next_poll_at,
        created_at
      FROM subscriptions
      WHERE client_id=?
        AND active=1
      ORDER BY created_at ASC
    `)
    .bind(client.clientId)
    .all();

  const factions=
    factionResult?.results || [];

  const individuals=
    individualResult?.results || [];

  summary.dueFactions=factions.length;
  summary.dueIndividuals=individuals.length;

  for(const faction of factions){
    try{
      await pollClientFaction(
        client,
        faction,
        env,
        runtime
      );

      summary.factionPolls++;
    }catch(error){
      summary.errors.push({
        type:'faction',
        id:String(faction.faction_id),
        error:trackerSafeError(error)
      });

      await env.DB
        .prepare(`
          UPDATE watched_factions
          SET next_poll_at=?
          WHERE client_id=?
            AND faction_id=?
        `)
        .bind(
          Date.now()+TRACKER_POLL_INTERVAL_MS,
          client.clientId,
          String(faction.faction_id)
        )
        .run();
    }
  }

  for(const subscription of individuals){
    try{
      await pollClientIndividual(
        client,
        subscription,
        env,
        runtime
      );

      summary.individualPolls++;
    }catch(error){
      summary.errors.push({
        type:'individual',
        id:String(subscription.player_id),
        error:trackerSafeError(error)
      });

      await env.DB
        .prepare(`
          UPDATE subscriptions
          SET next_poll_at=?
          WHERE client_id=?
            AND player_id=?
        `)
        .bind(
          Date.now()+TRACKER_POLL_INTERVAL_MS,
          client.clientId,
          String(subscription.player_id)
        )
        .run();
    }
  }

  if(
    summary.factionPolls>0 ||
    summary.individualPolls>0
  ){
    try{
      const idsResult=await env.DB
        .prepare(`
          SELECT DISTINCT m.player_id
          FROM client_faction_member_states m
          INNER JOIN watched_factions w
            ON w.client_id=m.client_id
           AND w.faction_id=m.faction_id
          WHERE m.client_id=?
            AND w.active=1

          UNION

          SELECT s.player_id
          FROM subscriptions s
          WHERE s.client_id=?
            AND s.active=1
        `)
        .bind(
          client.clientId,
          client.clientId
        )
        .all();

      const playerIds=
        (idsResult?.results || [])
          .map(row=>String(row.player_id))
          .filter(Boolean);

      summary.bsResult=
        await refreshClientBsCache(
          client,
          playerIds,
          env
        );

      await syncClientBsCacheToStates(
        client.clientId,
        env
      );

      summary.bsRefreshed=true;
    }catch(error){
      summary.errors.push({
        type:'bs',
        error:trackerSafeError(error)
      });
    }
  }

  summary.finishedAt=Date.now();
  summary.durationMs=
    summary.finishedAt-startedAt;

  return summary;
}

export class TrackerScheduler extends DurableObject {
  constructor(ctx,env){
    super(ctx,env);
    this.env=env;
  }

  async start(){
    const existing=await this.ctx.storage.getAlarm();

    if(existing!==null){
      return {
        started:true,
        alreadyRunning:true,
        alarmAt:existing
      };
    }

    const alarmAt=Date.now()+1000;
    await this.ctx.storage.setAlarm(alarmAt);

    return {
      started:true,
      alreadyRunning:false,
      alarmAt
    };
  }

  async stop(){
    await this.ctx.storage.deleteAlarm();

    return {
      stopped:true
    };
  }

  async status(){
    const alarmAt=await this.ctx.storage.getAlarm();
    const lastRunAt=await this.ctx.storage.get('lastRunAt');
    const nextAlarmAt=await this.ctx.storage.get('nextAlarmAt');
    const lastResult=await this.ctx.storage.get('lastResult');
    const lastError=await this.ctx.storage.get('lastError');

    return {
      running:alarmAt!==null,
      alarmAt,
      lastRunAt:lastRunAt||null,
      nextAlarmAt:nextAlarmAt||alarmAt||null,
      lastResult:lastResult||null,
      lastError:lastError||null
    };
  }

  async alarm(){
    const startedAt=Date.now();

    try{
      const result=await runTrackerSchedulerCycle(
        this.env,
        this.ctx.id.name
      );

      await this.ctx.storage.put('lastResult',result);
      await this.ctx.storage.delete('lastError');
    }catch(error){
      await this.ctx.storage.put(
        'lastError',
        String(error?.stack||error?.message||error)
      );
    }finally{
      await this.ctx.storage.put('lastRunAt',startedAt);

      let schedulerIntervalMs=
        TRACKER_POLL_INTERVAL_MS;

      if(this.ctx.id.name==='global-pool'){
        try{
          const globalConfig=
            await getGlobalPoolConfig(this.env);

          schedulerIntervalMs=
            Math.max(
              60000,
              Number(
                globalConfig.pollIntervalMs ||
                60000
              )
            );
        }catch(error){
          schedulerIntervalMs=60000;
        }
      }

      const nextAlarmAt=Math.max(
        startedAt+schedulerIntervalMs,
        Date.now()+1000
      );

      await this.ctx.storage.setAlarm(nextAlarmAt);
      await this.ctx.storage.put('nextAlarmAt',nextAlarmAt);
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({
        status: 'ok',
        service: 'Doits Flight Tracker Relay'
      });
    }

    if (url.pathname === '/admin/ping') {
      const suppliedSecret =
        request.headers.get('X-Server-Secret');

      if (
        !suppliedSecret ||
        suppliedSecret !== env.SERVER_SECRET
      ) {
        return Response.json(
          { error: 'Unauthorized' },
          { status: 401 }
        );
      }

      const result = await env.DB
        .prepare('SELECT COUNT(*) AS count FROM clients')
        .first();

      return Response.json({
        status: 'ok',
        authenticated: true,
        database: 'connected',
        clients: result?.count ?? 0
      });
    }

    if (
      url.pathname === '/admin/global-pool/test-failure' &&
      request.method === 'POST'
    ) {
      const client=
        await authenticateClient(
          request,
          env
        );

      if(!client){
        return Response.json(
          {error:'Unauthorized'},
          {status:401}
        );
      }

      if(client.role!=='admin'){
        return Response.json(
          {error:'Admin access required'},
          {status:403}
        );
      }

      let body;

      try{
        body=await request.json();
      }catch(e){
        return Response.json(
          {error:'Invalid JSON'},
          {status:400}
        );
      }

      let targetType;

      try{
        targetType=
          normalizeGlobalTargetType(
            body?.targetType
          );
      }catch(e){
        return Response.json(
          {error:'targetType must be faction or player'},
          {status:400}
        );
      }

      const targetId=
        String(
          body?.targetId || ''
        ).trim();

      if(!/^\d+$/.test(targetId)){
        return Response.json(
          {error:'Valid targetId required'},
          {status:400}
        );
      }

      const before=
        await env.DB
          .prepare(`
            SELECT
              collector_client_id,
              preferred_collector_client_id,
              collector_last_success_at,
              collector_last_failure_at,
              collector_failure_count,
              active
            FROM global_target_leases
            WHERE target_type=?
              AND target_id=?
            LIMIT 1
          `)
          .bind(
            targetType,
            targetId
          )
          .first();

      if(
        !before ||
        Number(before.active)!==1 ||
        !before.collector_client_id
      ){
        return Response.json(
          {error:'No active collector lease found for target'},
          {status:404}
        );
      }

      const failedCollectorClientId=
        String(
          before.collector_client_id
        );

      const failedCollector=
        await env.DB
          .prepare(`
            SELECT
              torn_user_id,
              torn_name
            FROM clients
            WHERE client_id=?
            LIMIT 1
          `)
          .bind(
            failedCollectorClientId
          )
          .first();

      const failure=
        await recordGlobalCollectorFailure(
          targetType,
          targetId,
          failedCollectorClientId,
          {code:'ADMIN_DIAGNOSTIC_FAILURE'},
          env
        );

      const after=
        await env.DB
          .prepare(`
            SELECT
              collector_client_id,
              preferred_collector_client_id,
              collector_last_success_at,
              collector_last_failure_at,
              collector_failure_count,
              active
            FROM global_target_leases
            WHERE target_type=?
              AND target_id=?
            LIMIT 1
          `)
          .bind(
            targetType,
            targetId
          )
          .first();

      let afterCollector=null;

      if(after?.collector_client_id){
        afterCollector=
          await env.DB
            .prepare(`
              SELECT
                torn_user_id,
                torn_name
              FROM clients
              WHERE client_id=?
              LIMIT 1
            `)
            .bind(
              String(
                after.collector_client_id
              )
            )
            .first();
      }

      return Response.json({
        success:true,
        diagnostic:true,
        tornApiCalled:false,
        targetType,
        targetId,
        failedCollector:{
          clientId:
            failedCollectorClientId,
          tornUserId:
            failedCollector?.torn_user_id==null
              ? null
              : String(
                  failedCollector.torn_user_id
                ),
          tornName:
            failedCollector?.torn_name ||
            null
        },
        failure,
        leaseBefore:{
          collectorClientId:
            before.collector_client_id ||
            null,
          preferredCollectorClientId:
            before.preferred_collector_client_id ||
            null,
          lastSuccessAt:
            before.collector_last_success_at==null
              ? null
              : Number(
                  before.collector_last_success_at
                ),
          lastFailureAt:
            before.collector_last_failure_at==null
              ? null
              : Number(
                  before.collector_last_failure_at
                ),
          failureCount:
            Number(
              before.collector_failure_count ||
              0
            )
        },
        leaseAfter:{
          collectorClientId:
            after?.collector_client_id ||
            null,
          collectorName:
            afterCollector?.torn_name ||
            null,
          preferredCollectorClientId:
            after?.preferred_collector_client_id ||
            null,
          lastSuccessAt:
            after?.collector_last_success_at==null
              ? null
              : Number(
                  after.collector_last_success_at
                ),
          lastFailureAt:
            after?.collector_last_failure_at==null
              ? null
              : Number(
                  after.collector_last_failure_at
                ),
          failureCount:
            Number(
              after?.collector_failure_count ||
              0
            )
        }
      });
    }


    if (
      url.pathname === '/admin/global-pool/scheduler/status' &&
      request.method === 'GET'
    ) {
      const client=await authenticateClient(request,env);

      if(!client){
        return Response.json(
          {error:'Unauthorized'},
          {status:401}
        );
      }

      if(client.role!=='admin'){
        return Response.json(
          {error:'Admin access required'},
          {status:403}
        );
      }

      const config=await getGlobalPoolConfig(env);
      const id=env.TRACKER_SCHEDULER.idFromName('global-pool');
      const scheduler=env.TRACKER_SCHEDULER.get(id);
      const status=await scheduler.status();

      return Response.json({
        success:true,
        schedulerName:'global-pool',
        globalPoolEnabled:config.enabled===true,
        legacyClientCollectionEnabled:
          config.legacyClientCollectionEnabled!==false,
        pollIntervalMs:Math.max(
          60000,
          Number(config.pollIntervalMs || 60000)
        ),
        ...status
      });
    }

    if (
      url.pathname === '/admin/global-pool/scheduler/start' &&
      request.method === 'POST'
    ) {
      const client=await authenticateClient(request,env);

      if(!client){
        return Response.json(
          {error:'Unauthorized'},
          {status:401}
        );
      }

      if(client.role!=='admin'){
        return Response.json(
          {error:'Admin access required'},
          {status:403}
        );
      }

      const config=await getGlobalPoolConfig(env);
      const id=env.TRACKER_SCHEDULER.idFromName('global-pool');
      const scheduler=env.TRACKER_SCHEDULER.get(id);
      const result=await scheduler.start();

      return Response.json({
        success:true,
        schedulerName:'global-pool',
        globalPoolEnabled:config.enabled===true,
        pollIntervalMs:Math.max(
          60000,
          Number(config.pollIntervalMs || 60000)
        ),
        ...result
      });
    }

    if (
      url.pathname === '/admin/global-pool/scheduler/stop' &&
      request.method === 'POST'
    ) {
      const client=await authenticateClient(request,env);

      if(!client){
        return Response.json(
          {error:'Unauthorized'},
          {status:401}
        );
      }

      if(client.role!=='admin'){
        return Response.json(
          {error:'Admin access required'},
          {status:403}
        );
      }

      const id=env.TRACKER_SCHEDULER.idFromName('global-pool');
      const scheduler=env.TRACKER_SCHEDULER.get(id);
      const result=await scheduler.stop();

      return Response.json({
        success:true,
        schedulerName:'global-pool',
        ...result
      });
    }

    if (
      url.pathname === '/admin/global-pool/test-collect' &&
      request.method === 'POST'
    ) {
      const client=
        await authenticateClient(request,env);

      if(!client){
        return Response.json(
          {error:'Unauthorized'},
          {status:401}
        );
      }

      if(client.role!=='admin'){
        return Response.json(
          {error:'Admin access required'},
          {status:403}
        );
      }

      let body;

      try{
        body=await request.json();
      }catch(e){
        return Response.json(
          {error:'Invalid JSON'},
          {status:400}
        );
      }

      let targetType;

      try{
        targetType=
          normalizeGlobalTargetType(
            body?.targetType
          );
      }catch(e){
        return Response.json(
          {error:'targetType must be faction or player'},
          {status:400}
        );
      }

      const targetId=
        String(
          body?.targetId || ''
        ).trim();

      if(!/^\d+$/.test(targetId)){
        return Response.json(
          {error:'Valid numeric targetId required'},
          {status:400}
        );
      }

      const config=
        await getGlobalPoolConfig(env);

      const reconciliation=
        await reconcileGlobalTargetLease(
          targetType,
          targetId,
          env
        );

      const lease=
        await env.DB
          .prepare(`
            SELECT
              target_type,
              target_id,
              collector_client_id,
              preferred_collector_client_id,
              active
            FROM global_target_leases
            WHERE target_type=?
              AND target_id=?
            LIMIT 1
          `)
          .bind(
            targetType,
            targetId
          )
          .first();

      if(
        !lease ||
        Number(lease.active)!==1
      ){
        return Response.json(
          {
            error:'Global target is not active',
            targetType,
            targetId
          },
          {status:409}
        );
      }

      if(!lease.collector_client_id){
        return Response.json(
          {
            error:'Global target has no eligible collector',
            targetType,
            targetId
          },
          {status:409}
        );
      }

      const collectorClientId=
        String(
          lease.collector_client_id
        );

      const collector=
        await env.DB
          .prepare(`
            SELECT
              client_id,
              torn_user_id,
              torn_name,
              label,
              active,
              access_status,
              CASE
                WHEN
                  api_key_ciphertext IS NOT NULL
                  AND api_key_iv IS NOT NULL
                THEN 1
                ELSE 0
              END AS api_key_configured
            FROM clients
            WHERE client_id=?
            LIMIT 1
          `)
          .bind(
            collectorClientId
          )
          .first();

      if(
        !collector ||
        Number(collector.active)!==1 ||
        Number(collector.api_key_configured)!==1 ||
        String(
          collector.access_status ||
          'active'
        )==='suspended'
      ){
        return Response.json(
          {
            error:'Assigned collector is not currently eligible',
            targetType,
            targetId,
            collectorClientId
          },
          {status:409}
        );
      }

      let apiKey=null;

      try{
        apiKey=
          await getClientTrackerApiKey(
            collectorClientId,
            env
          );

        let result;

        if(targetType==='faction'){
          const target=
            await env.DB
              .prepare(`
                SELECT
                  faction_id,
                  faction_name
                FROM global_factions
                WHERE faction_id=?
                LIMIT 1
              `)
              .bind(targetId)
              .first();

          result=
            await pollGlobalFactionTarget(
              {
                faction_id:targetId,
                faction_name:
                  target?.faction_name ||
                  null
              },
              apiKey,
              env,
              config
            );
        }else{
          result=
            await pollGlobalPlayerTarget(
              {
                player_id:targetId
              },
              apiKey,
              env,
              config
            );
        }

        const collectorHealth=
          await recordGlobalCollectorSuccess(
            targetType,
            targetId,
            collectorClientId,
            env
          );

        return Response.json({
          success:true,
          manualTest:true,
          collectorHealth,
          globalPoolEnabled:
            config.enabled===true,
          schedulerStarted:false,
          targetType,
          targetId,
          collectorClientId,
          collectorName:
            collector.torn_name ||
            collector.label ||
            null,
          reconciliation,
          result
        });
      }catch(error){
        let collectorHealth=null;

        try{
          collectorHealth=
            await recordGlobalCollectorFailure(
              targetType,
              targetId,
              collectorClientId,
              error,
              env
            );
        }catch(healthError){
          console.error(
            'Global collector failure recording failed',
            healthError
          );
        }

        return Response.json(
          {
            success:false,
            manualTest:true,
            collectorHealth,
            globalPoolEnabled:
              config.enabled===true,
            schedulerStarted:false,
            targetType,
            targetId,
            collectorClientId,
            collectorName:
              collector?.torn_name ||
              collector?.label ||
              null,
            error:
              trackerSafeError(error),
            code:
              error?.code || null
          },
          {status:500}
        );
      }finally{
        apiKey=null;
      }
    }


    if (
      url.pathname === '/admin/global-pool/reconcile' &&
      request.method === 'POST'
    ) {
      const client=
        await authenticateClient(request,env);

      if(!client){
        return Response.json(
          {error:'Unauthorized'},
          {status:401}
        );
      }

      if(client.role!=='admin'){
        return Response.json(
          {error:'Admin access required'},
          {status:403}
        );
      }

      const config=
        await getGlobalPoolConfig(env);

      const factionTargets=
        await env.DB
          .prepare(`
            WITH target_ids AS (
              SELECT faction_id AS target_id
              FROM watched_factions
              WHERE active=1

              UNION

              SELECT target_id
              FROM global_target_leases
              WHERE target_type='faction'
            )
            SELECT
              t.target_id,
              MAX(
                COALESCE(
                  g.faction_name,
                  s.faction_name,
                  w.faction_name
                )
              ) AS target_name
            FROM target_ids t
            LEFT JOIN global_factions g
              ON g.faction_id=t.target_id
            LEFT JOIN watched_factions w
              ON w.faction_id=t.target_id
             AND w.active=1
            LEFT JOIN client_faction_states s
              ON s.client_id=w.client_id
             AND s.faction_id=w.faction_id
            GROUP BY t.target_id
            ORDER BY t.target_id
          `)
          .all();

      const playerTargets=
        await env.DB
          .prepare(`
            WITH target_ids AS (
              SELECT player_id AS target_id
              FROM subscriptions
              WHERE active=1

              UNION

              SELECT target_id
              FROM global_target_leases
              WHERE target_type='player'
            )
            SELECT
              t.target_id,
              MAX(
                COALESCE(
                  g.player_name,
                  p.player_name
                )
              ) AS target_name
            FROM target_ids t
            LEFT JOIN global_players g
              ON g.player_id=t.target_id
            LEFT JOIN subscriptions s
              ON s.player_id=t.target_id
             AND s.active=1
            LEFT JOIN client_player_states p
              ON p.client_id=s.client_id
             AND p.player_id=s.player_id
            GROUP BY t.target_id
            ORDER BY t.target_id
          `)
          .all();

      const targets=[
        ...(factionTargets?.results || [])
          .map(row=>({
            targetType:'faction',
            targetId:String(row.target_id),
            targetName:row.target_name || null
          })),
        ...(playerTargets?.results || [])
          .map(row=>({
            targetType:'player',
            targetId:String(row.target_id),
            targetName:row.target_name || null
          }))
      ];

      const reconciled=[];

      for(const target of targets){
        const result=
          await reconcileGlobalTargetLease(
            target.targetType,
            target.targetId,
            env
          );

        reconciled.push({
          ...target,
          ...result
        });
      }

      const leaseRows=
        await env.DB
          .prepare(`
            SELECT
              l.target_type,
              l.target_id,
              l.collector_client_id,
              l.preferred_collector_client_id,
              l.active,
              l.collector_assigned_at,
              l.collector_failure_count,
              c.torn_name AS collector_torn_name,
              c.label AS collector_label,
              pc.torn_name AS preferred_torn_name,
              pc.label AS preferred_label
            FROM global_target_leases l
            LEFT JOIN clients c
              ON c.client_id=l.collector_client_id
            LEFT JOIN clients pc
              ON pc.client_id=l.preferred_collector_client_id
            ORDER BY
              l.target_type,
              l.target_id
          `)
          .all();

      const leases=
        (leaseRows?.results || [])
          .map(row=>({
            targetType:String(row.target_type),
            targetId:String(row.target_id),
            active:Number(row.active)===1,
            collectorClientId:
              row.collector_client_id || null,
            collectorName:
              row.collector_torn_name ||
              row.collector_label ||
              null,
            preferredCollectorClientId:
              row.preferred_collector_client_id || null,
            preferredCollectorName:
              row.preferred_torn_name ||
              row.preferred_label ||
              null,
            collectorAssignedAt:
              row.collector_assigned_at==null
                ? null
                : Number(row.collector_assigned_at),
            collectorFailureCount:
              Number(row.collector_failure_count || 0)
          }));

      return Response.json({
        success:true,
        globalPoolEnabled:
          config.enabled===true,
        legacyClientCollectionEnabled:
          config.legacyClientCollectionEnabled!==false,
        routeStartsPolling:false,
        pollIntervalMs:
          config.pollIntervalMs,
        detectionUncertaintyMs:
          config.detectionUncertaintyMs,
        collectorMaxTargets:
          config.collectorMaxTargets,
        collectorFailoverAfterMs:
          config.collectorFailoverAfterMs,
        bsTtlMs:
          config.bsTtlMs,
        targetCount:
          targets.length,
        changedLeases:
          reconciled.filter(
            item=>item.changed===true
          ).length,
        unassignedTargets:
          reconciled.filter(
            item=>
              item.active===true &&
              !item.collectorClientId
          ).length,
        reconciled,
        leases
      });
    }


    if (
      url.pathname === '/admin/access/factions' &&
      request.method === 'GET'
    ) {
      const client=
        await authenticateClient(request,env);

      if(!client){
        return Response.json(
          {error:'Unauthorized'},
          {status:401}
        );
      }

      if(client.role!=='admin'){
        return Response.json(
          {error:'Admin access required'},
          {status:403}
        );
      }

      const config=
        await env.DB
          .prepare(`
            SELECT
              primary_faction_id,
              primary_auto_access,
              grace_period_ms
            FROM tracker_access_config
            WHERE id=1
            LIMIT 1
          `)
          .first();

      const result=
        await env.DB
          .prepare(`
            SELECT
              f.faction_id,
              f.faction_name,
              f.active,
              f.is_primary,
              f.access_code_ciphertext,
              f.access_code_iv,
              f.code_created_at,
              f.created_at,
              f.updated_at,
              COUNT(c.client_id) AS registered_users,
              SUM(
                CASE
                  WHEN c.access_status='active'
                  THEN 1 ELSE 0
                END
              ) AS active_users,
              SUM(
                CASE
                  WHEN c.access_status='grace'
                  THEN 1 ELSE 0
                END
              ) AS grace_users,
              SUM(
                CASE
                  WHEN c.access_status='suspended'
                  THEN 1 ELSE 0
                END
              ) AS suspended_users
            FROM registered_factions f
            LEFT JOIN clients c
              ON c.registered_faction_id=f.faction_id
             AND c.access_type='faction'
             AND c.active=1
            GROUP BY
              f.faction_id,
              f.faction_name,
              f.active,
              f.is_primary,
              f.access_code_ciphertext,
              f.access_code_iv,
              f.code_created_at,
              f.created_at,
              f.updated_at
            ORDER BY
              f.is_primary DESC,
              f.faction_name COLLATE NOCASE ASC,
              f.faction_id ASC
          `)
          .all();

      const factions=[];

      for(const row of result?.results || []){
        let accessCode=null;

        if(
          Number(row.is_primary)!==1 &&
          row.access_code_ciphertext &&
          row.access_code_iv
        ){
          try{
            accessCode=
              await decryptFactionAccessCode(
                row.access_code_ciphertext,
                row.access_code_iv,
                row.faction_id,
                env
              );
          }catch(e){
            accessCode=null;
          }
        }

        factions.push({
          factionId:String(row.faction_id),
          factionName:
            row.faction_name || null,
          active:Number(row.active)===1,
          isPrimary:
            Number(row.is_primary)===1,
          accessCode,
          codeCreatedAt:
            row.code_created_at==null
              ? null
              : Number(row.code_created_at),
          registeredUsers:
            Number(row.registered_users || 0),
          activeUsers:
            Number(row.active_users || 0),
          graceUsers:
            Number(row.grace_users || 0),
          suspendedUsers:
            Number(row.suspended_users || 0)
        });
      }

      return Response.json({
        success:true,
        primaryFactionId:
          config?.primary_faction_id==null
            ? null
            : String(config.primary_faction_id),
        primaryAutoAccess:
          Number(
            config?.primary_auto_access ?? 1
          )===1,
        gracePeriodMs:
          Number(
            config?.grace_period_ms ||
            86400000
          ),
        factions
      });
    }


    if (
      url.pathname === '/admin/access/factions' &&
      request.method === 'POST'
    ) {
      const client=
        await authenticateClient(request,env);

      if(!client){
        return Response.json(
          {error:'Unauthorized'},
          {status:401}
        );
      }

      if(client.role!=='admin'){
        return Response.json(
          {error:'Admin access required'},
          {status:403}
        );
      }

      let body;

      try{
        body=await request.json();
      }catch(e){
        return Response.json(
          {error:'Invalid JSON'},
          {status:400}
        );
      }

      const factionId=String(
        body?.factionId || ''
      ).trim();

      if(!/^\d+$/.test(factionId)){
        return Response.json(
          {error:'Valid faction ID required'},
          {status:400}
        );
      }

      const config=
        await env.DB
          .prepare(`
            SELECT primary_faction_id
            FROM tracker_access_config
            WHERE id=1
            LIMIT 1
          `)
          .first();

      const isPrimary=
        String(
          config?.primary_faction_id || ''
        )===factionId;

      let factionName=String(
        body?.factionName || ''
      )
        .trim()
        .slice(0,120);

      if(!factionName){
        try{
          const lookup=
            await clientTornRequest(
              client,
              '/v2/faction/'+
                encodeURIComponent(factionId)+
                '/basic?striptags=true',
              env
            );

          factionName=String(
            lookup?.data?.basic?.name ||
            lookup?.data?.faction?.name ||
            lookup?.data?.name ||
            ''
          )
            .trim()
            .slice(0,120);
        }catch(e){}
      }

      if(!factionName){
        factionName='Faction '+factionId;
      }

      const existing=
        await env.DB
          .prepare(`
            SELECT
              access_code_hash,
              access_code_ciphertext,
              access_code_iv,
              code_created_at
            FROM registered_factions
            WHERE faction_id=?
            LIMIT 1
          `)
          .bind(factionId)
          .first();

      let accessCode=null;
      let codeHash=null;
      let ciphertext=null;
      let iv=null;
      let codeCreatedAt=null;

      if(!isPrimary){
        if(
          existing?.access_code_hash &&
          existing?.access_code_ciphertext &&
          existing?.access_code_iv
        ){
          try{
            accessCode=
              await decryptFactionAccessCode(
                existing.access_code_ciphertext,
                existing.access_code_iv,
                factionId,
                env
              );

            codeHash=
              existing.access_code_hash;

            ciphertext=
              existing.access_code_ciphertext;

            iv=
              existing.access_code_iv;

            codeCreatedAt=
              existing.code_created_at==null
                ? null
                : Number(
                    existing.code_created_at
                  );
          }catch(e){
            accessCode=null;
          }
        }

        if(!accessCode){
          accessCode=createInviteCode();
          codeHash=
            await sha256Hex(accessCode);

          const encrypted=
            await encryptFactionAccessCode(
              accessCode,
              factionId,
              env
            );

          ciphertext=
            encrypted.ciphertext;

          iv=
            encrypted.iv;

          codeCreatedAt=Date.now();
        }
      }

      const now=Date.now();

      await env.DB
        .prepare(`
          INSERT INTO registered_factions
          (
            faction_id,
            faction_name,
            active,
            is_primary,
            access_code_hash,
            access_code_ciphertext,
            access_code_iv,
            code_created_at,
            created_by_client_id,
            created_at,
            updated_at
          )
          VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(faction_id)
          DO UPDATE SET
            faction_name=excluded.faction_name,
            active=1,
            is_primary=excluded.is_primary,
            access_code_hash=
              excluded.access_code_hash,
            access_code_ciphertext=
              excluded.access_code_ciphertext,
            access_code_iv=
              excluded.access_code_iv,
            code_created_at=
              excluded.code_created_at,
            updated_at=excluded.updated_at
        `)
        .bind(
          factionId,
          factionName,
          isPrimary ? 1 : 0,
          codeHash,
          ciphertext,
          iv,
          codeCreatedAt,
          client.clientId,
          now,
          now
        )
        .run();

      return Response.json({
        success:true,
        factionId,
        factionName,
        active:true,
        isPrimary,
        accessCode:
          isPrimary
            ? null
            : accessCode,
        codeRequired:
          !isPrimary
      });
    }


    const regenerateFactionCodeMatch=
      url.pathname.match(
        /^\/admin\/access\/factions\/(\d+)\/regenerate$/
      );

    if (
      regenerateFactionCodeMatch &&
      request.method === 'POST'
    ) {
      const client=
        await authenticateClient(request,env);

      if(!client){
        return Response.json(
          {error:'Unauthorized'},
          {status:401}
        );
      }

      if(client.role!=='admin'){
        return Response.json(
          {error:'Admin access required'},
          {status:403}
        );
      }

      const factionId=
        regenerateFactionCodeMatch[1];

      const faction=
        await env.DB
          .prepare(`
            SELECT
              faction_id,
              faction_name,
              is_primary
            FROM registered_factions
            WHERE faction_id=?
            LIMIT 1
          `)
          .bind(factionId)
          .first();

      if(!faction){
        return Response.json(
          {error:'Registered faction not found'},
          {status:404}
        );
      }

      if(Number(faction.is_primary)===1){
        return Response.json(
          {
            error:
              'Primary faction does not require an access code'
          },
          {status:400}
        );
      }

      const accessCode=createInviteCode();
      const codeHash=
        await sha256Hex(accessCode);

      const encrypted=
        await encryptFactionAccessCode(
          accessCode,
          factionId,
          env
        );

      const now=Date.now();

      await env.DB
        .prepare(`
          UPDATE registered_factions
          SET
            access_code_hash=?,
            access_code_ciphertext=?,
            access_code_iv=?,
            code_created_at=?,
            updated_at=?
          WHERE faction_id=?
        `)
        .bind(
          codeHash,
          encrypted.ciphertext,
          encrypted.iv,
          now,
          now,
          factionId
        )
        .run();

      return Response.json({
        success:true,
        factionId,
        factionName:
          faction.faction_name || null,
        accessCode,
        regenerated:true
      });
    }


    const factionStatusMatch=
      url.pathname.match(
        /^\/admin\/access\/factions\/(\d+)\/status$/
      );

    if (
      factionStatusMatch &&
      request.method === 'POST'
    ) {
      const client=
        await authenticateClient(request,env);

      if(!client){
        return Response.json(
          {error:'Unauthorized'},
          {status:401}
        );
      }

      if(client.role!=='admin'){
        return Response.json(
          {error:'Admin access required'},
          {status:403}
        );
      }

      let body;

      try{
        body=await request.json();
      }catch(e){
        return Response.json(
          {error:'Invalid JSON'},
          {status:400}
        );
      }

      if(typeof body?.active!=='boolean'){
        return Response.json(
          {error:'active must be true or false'},
          {status:400}
        );
      }

      const factionId=
        factionStatusMatch[1];

      const faction=
        await env.DB
          .prepare(`
            SELECT
              faction_id,
              faction_name,
              is_primary
            FROM registered_factions
            WHERE faction_id=?
            LIMIT 1
          `)
          .bind(factionId)
          .first();

      if(!faction){
        return Response.json(
          {error:'Registered faction not found'},
          {status:404}
        );
      }

      if(
        Number(faction.is_primary)===1 &&
        body.active===false
      ){
        return Response.json(
          {
            error:
              'Primary faction automatic access cannot be disabled here'
          },
          {status:400}
        );
      }

      const now=Date.now();

      await env.DB
        .prepare(`
          UPDATE registered_factions
          SET
            active=?,
            updated_at=?
          WHERE faction_id=?
        `)
        .bind(
          body.active ? 1 : 0,
          now,
          factionId
        )
        .run();

      return Response.json({
        success:true,
        factionId,
        factionName:
          faction.faction_name || null,
        active:body.active
      });
    }


    if (
      url.pathname === '/admin/access/users' &&
      request.method === 'GET'
    ) {
      const client=
        await authenticateClient(
          request,
          env
        );

      if(!client){
        return Response.json(
          {error:'Unauthorized'},
          {status:401}
        );
      }

      if(client.role!=='admin'){
        return Response.json(
          {error:'Admin access required'},
          {status:403}
        );
      }

      const now=Date.now();

      const config=
        await env.DB
          .prepare(`
            SELECT grace_period_ms
            FROM tracker_access_config
            WHERE id=1
            LIMIT 1
          `)
          .first();

      const gracePeriodMs=
        Math.max(
          0,
          Number(
            config?.grace_period_ms ||
            86400000
          )
        );

      const result=
        await env.DB
          .prepare(`
            SELECT
              c.client_id,
              c.label,
              c.active,
              c.role,
              c.torn_user_id,
              c.torn_name,
              c.own_faction_id,
              c.access_type,
              c.access_status,
              c.registered_faction_id,
              c.faction_mismatch_since,
              c.access_suspended_at,
              c.access_granted_at,
              c.created_at,
              c.last_seen_at,

              rf.faction_name
                AS registered_faction_name,

              COUNT(
                DISTINCT CASE
                  WHEN wf.active=1
                   AND COALESCE(wf.is_own_faction,0)=0
                  THEN wf.faction_id
                END
              ) AS watched_factions,

              COUNT(
                DISTINCT CASE
                  WHEN s.active=1
                  THEN s.player_id
                END
              ) AS tracked_individuals,

              MAX(
                CASE
                  WHEN ar.status='pending'
                  THEN 1 ELSE 0
                END
              ) AS has_pending_request,

              MAX(
                CASE
                  WHEN ar.status='approved'
                  THEN 1 ELSE 0
                END
              ) AS has_approved_request,

              MAX(
                CASE
                  WHEN pac.active=1
                   AND (
                     pac.expires_at IS NULL OR
                     pac.expires_at>?
                   )
                  THEN 1 ELSE 0
                END
              ) AS personal_access_ready

            FROM clients c

            LEFT JOIN registered_factions rf
              ON rf.faction_id=
                c.registered_faction_id

            LEFT JOIN watched_factions wf
              ON wf.client_id=c.client_id

            LEFT JOIN subscriptions s
              ON s.client_id=c.client_id

            LEFT JOIN access_requests ar
              ON ar.client_id=c.client_id

            LEFT JOIN personal_access_codes pac
              ON pac.target_client_id=
                c.client_id

            GROUP BY
              c.client_id,
              c.label,
              c.active,
              c.role,
              c.torn_user_id,
              c.torn_name,
              c.own_faction_id,
              c.access_type,
              c.access_status,
              c.registered_faction_id,
              c.faction_mismatch_since,
              c.access_suspended_at,
              c.access_granted_at,
              c.created_at,
              c.last_seen_at,
              rf.faction_name

            ORDER BY
              CASE
                WHEN c.access_status='suspended'
                THEN 0
                WHEN c.access_status='grace'
                THEN 1
                WHEN c.role='admin'
                THEN 2
                ELSE 3
              END,
              COALESCE(
                c.torn_name,
                c.label,
                c.client_id
              ) COLLATE NOCASE ASC
          `)
          .bind(now)
          .all();

      const users=
        (result?.results || [])
          .map(row=>{
            const mismatchSince=
              row.faction_mismatch_since==null
                ? null
                : Number(
                    row.faction_mismatch_since
                  );

            const graceEndsAt=
              mismatchSince==null
                ? null
                : mismatchSince+
                  gracePeriodMs;

            const graceRemainingMs=
              graceEndsAt==null
                ? null
                : Math.max(
                    0,
                    graceEndsAt-now
                  );

            const tornUserId=
              row.torn_user_id==null
                ? null
                : String(
                    row.torn_user_id
                  );

            const accessType=
              row.access_type ||
              'legacy';

            const accessStatus=
              row.access_status ||
              'active';

            return {
              clientId:
                row.client_id,
              label:
                row.label || null,
              accountActive:
                Number(row.active)===1,
              role:
                row.role || 'user',
              tornUserId,
              tornName:
                row.torn_name || null,
              profileUrl:
                tornUserId
                  ? 'https://www.torn.com/profiles.php?XID='+
                    encodeURIComponent(
                      tornUserId
                    )
                  : null,
              ownFactionId:
                row.own_faction_id ||
                null,
              accessType,
              accessStatus,
              registeredFactionId:
                row.registered_faction_id ||
                null,
              registeredFactionName:
                row.registered_faction_name ||
                null,
              factionMismatchSince:
                mismatchSince,
              suspendedAt:
                row.access_suspended_at==null
                  ? null
                  : Number(
                      row.access_suspended_at
                    ),
              graceEndsAt,
              graceRemainingMs,
              accessGrantedAt:
                row.access_granted_at==null
                  ? null
                  : Number(
                      row.access_granted_at
                    ),
              createdAt:
                Number(row.created_at),
              lastSeenAt:
                row.last_seen_at==null
                  ? null
                  : Number(
                      row.last_seen_at
                    ),
              watchedFactions:
                Number(
                  row.watched_factions || 0
                ),
              trackedIndividuals:
                Number(
                  row.tracked_individuals || 0
                ),
              pendingRequest:
                Number(
                  row.has_pending_request || 0
                )===1,
              approvedRequest:
                Number(
                  row.has_approved_request || 0
                )===1,
              personalAccessReady:
                Number(
                  row.personal_access_ready || 0
                )===1,
              canSendPersonal:
                accessType==='faction' &&
                (
                  accessStatus==='grace' ||
                  accessStatus==='suspended'
                )
            };
          });

      return Response.json({
        success:true,
        count:users.length,
        users
      });
    }


    const adminUserStatusMatch=
      url.pathname.match(
        /^\/admin\/access\/users\/([0-9a-fA-F-]{36})\/status$/
      );

    if (
      adminUserStatusMatch &&
      request.method === 'POST'
    ) {
      const client=
        await authenticateClient(
          request,
          env
        );

      if(!client){
        return Response.json(
          {error:'Unauthorized'},
          {status:401}
        );
      }

      if(client.role!=='admin'){
        return Response.json(
          {error:'Admin access required'},
          {status:403}
        );
      }

      let body;

      try{
        body=await request.json();
      }catch(e){
        return Response.json(
          {error:'Invalid JSON'},
          {status:400}
        );
      }

      if(typeof body?.active!=='boolean'){
        return Response.json(
          {error:'active must be true or false'},
          {status:400}
        );
      }

      const targetClientId=
        adminUserStatusMatch[1];

      if(targetClientId===client.clientId){
        return Response.json(
          {
            error:
              'You cannot disable your own admin account'
          },
          {status:400}
        );
      }

      const target=
        await env.DB
          .prepare(`
            SELECT
              client_id,
              torn_user_id,
              torn_name,
              role,
              active
            FROM clients
            WHERE client_id=?
            LIMIT 1
          `)
          .bind(targetClientId)
          .first();

      if(!target){
        return Response.json(
          {error:'Tracker user not found'},
          {status:404}
        );
      }

      if(target.role==='admin'){
        return Response.json(
          {
            error:
              'Admin accounts cannot be disabled from this control'
          },
          {status:403}
        );
      }

      const now=Date.now();

      await env.DB
        .prepare(`
          UPDATE clients
          SET
            active=?,
            access_updated_at=?
          WHERE client_id=?
        `)
        .bind(
          body.active ? 1 : 0,
          now,
          targetClientId
        )
        .run();

      if(body.active){
        const row=
          await env.DB
            .prepare(`
              SELECT
                api_key_ciphertext,
                api_key_iv
              FROM clients
              WHERE client_id=?
              LIMIT 1
            `)
            .bind(targetClientId)
            .first();

        if(
          row?.api_key_ciphertext &&
          row?.api_key_iv
        ){
          const schedulerId=
            env.TRACKER_SCHEDULER.idFromName(
              targetClientId
            );

          const scheduler=
            env.TRACKER_SCHEDULER.get(
              schedulerId
            );

          await scheduler.start();
        }
      }else{
        const schedulerId=
          env.TRACKER_SCHEDULER.idFromName(
            targetClientId
          );

        const scheduler=
          env.TRACKER_SCHEDULER.get(
            schedulerId
          );

        try{
          await scheduler.stop();
        }catch(e){}
      }

      await safeReconcileGlobalTargetsForClient(
        targetClientId,
        env
      );

      return Response.json({
        success:true,
        clientId:targetClientId,
        tornUserId:
          target.torn_user_id==null
            ? null
            : String(target.torn_user_id),
        tornName:
          target.torn_name || null,
        active:body.active
      });
    }

    if (
      url.pathname === '/admin/faction-applications' &&
      request.method === 'GET'
    ) {
      const client=await authenticateClient(request,env);

      if(!client){
        return Response.json(
          {error:'Unauthorized'},
          {status:401}
        );
      }

      if(client.role!=='admin'){
        return Response.json(
          {error:'Admin access required'},
          {status:403}
        );
      }

      const result=
        await env.DB
          .prepare(`
            SELECT
              a.application_id,
              a.faction_id,
              a.faction_name,
              a.applicant_client_id,
              a.applicant_torn_user_id,
              a.applicant_torn_name,
              a.status,
              a.created_at,
              a.updated_at,
              a.resolved_at,
              a.resolved_by_client_id,
              rf.active AS faction_registered_active,
              (
                SELECT COUNT(*)
                FROM faction_application_messages m
                WHERE m.application_id=a.application_id
              ) AS message_count
            FROM faction_applications a
            LEFT JOIN registered_factions rf
              ON rf.faction_id=a.faction_id
            ORDER BY
              CASE a.status
                WHEN 'needs_info' THEN 0
                WHEN 'pending' THEN 1
                WHEN 'approved' THEN 2
                ELSE 3
              END,
              a.updated_at DESC
            LIMIT 200
          `)
          .all();

      const applications=
        (result?.results || []).map(row=>({
          applicationId:row.application_id,
          factionId:String(row.faction_id),
          factionName:row.faction_name || null,
          applicantClientId:row.applicant_client_id,
          applicantTornUserId:
            row.applicant_torn_user_id==null
              ? null
              : String(row.applicant_torn_user_id),
          applicantTornName:
            row.applicant_torn_name || null,
          applicantProfileUrl:
            row.applicant_torn_user_id
              ? 'https://www.torn.com/profiles.php?XID='+
                encodeURIComponent(
                  String(row.applicant_torn_user_id)
                )
              : null,
          status:row.status,
          createdAt:Number(row.created_at),
          updatedAt:Number(row.updated_at),
          resolvedAt:
            row.resolved_at==null
              ? null
              : Number(row.resolved_at),
          resolvedByClientId:
            row.resolved_by_client_id || null,
          registered:
            Number(row.faction_registered_active || 0)===1,
          messageCount:
            Number(row.message_count || 0)
        }));

      return Response.json({
        success:true,
        pendingCount:
          applications.filter(
            item=>item.status==='pending'
          ).length,
        needsInfoCount:
          applications.filter(
            item=>item.status==='needs_info'
          ).length,
        applications
      });
    }

    const factionApplicationDetailMatch=
      url.pathname.match(
        /^\/admin\/faction-applications\/([0-9a-fA-F-]{36})$/
      );

    if (
      factionApplicationDetailMatch &&
      request.method === 'GET'
    ) {
      const client=await authenticateClient(request,env);

      if(!client){
        return Response.json(
          {error:'Unauthorized'},
          {status:401}
        );
      }

      if(client.role!=='admin'){
        return Response.json(
          {error:'Admin access required'},
          {status:403}
        );
      }

      const applicationId=
        factionApplicationDetailMatch[1];

      const application=
        await env.DB
          .prepare(`
            SELECT
              a.application_id,
              a.faction_id,
              a.faction_name,
              a.applicant_client_id,
              a.applicant_torn_user_id,
              a.applicant_torn_name,
              a.status,
              a.created_at,
              a.updated_at,
              a.resolved_at,
              a.resolved_by_client_id,
              c.access_type,
              c.access_status,
              c.active AS client_active,
              c.own_faction_id,
              rf.active AS faction_registered_active
            FROM faction_applications a
            INNER JOIN clients c
              ON c.client_id=a.applicant_client_id
            LEFT JOIN registered_factions rf
              ON rf.faction_id=a.faction_id
            WHERE a.application_id=?
            LIMIT 1
          `)
          .bind(applicationId)
          .first();

      if(!application){
        return Response.json(
          {error:'Faction application not found'},
          {status:404}
        );
      }

      const messageResult=
        await env.DB
          .prepare(`
            SELECT
              m.message_id,
              m.sender_client_id,
              m.sender_type,
              m.message,
              m.created_at,
              c.torn_user_id,
              c.torn_name
            FROM faction_application_messages m
            LEFT JOIN clients c
              ON c.client_id=m.sender_client_id
            WHERE m.application_id=?
            ORDER BY m.created_at ASC
          `)
          .bind(applicationId)
          .all();

      return Response.json({
        success:true,
        application:{
          applicationId:
            application.application_id,
          factionId:
            String(application.faction_id),
          factionName:
            application.faction_name || null,
          status:
            application.status,
          applicant:{
            clientId:
              application.applicant_client_id,
            tornUserId:
              application.applicant_torn_user_id==null
                ? null
                : String(application.applicant_torn_user_id),
            tornName:
              application.applicant_torn_name || null,
            profileUrl:
              application.applicant_torn_user_id
                ? 'https://www.torn.com/profiles.php?XID='+
                  encodeURIComponent(
                    String(application.applicant_torn_user_id)
                  )
                : null,
            accessType:
              application.access_type || null,
            accessStatus:
              application.access_status || null,
            active:
              Number(application.client_active)===1,
            currentFactionId:
              application.own_faction_id==null
                ? null
                : String(application.own_faction_id)
          },
          factionRegistered:
            Number(
              application.faction_registered_active || 0
            )===1,
          createdAt:
            Number(application.created_at),
          updatedAt:
            Number(application.updated_at),
          resolvedAt:
            application.resolved_at==null
              ? null
              : Number(application.resolved_at),
          resolvedByClientId:
            application.resolved_by_client_id ||
            null
        },
        messages:
          (messageResult?.results || []).map(row=>({
            messageId:row.message_id,
            senderClientId:row.sender_client_id,
            senderType:row.sender_type,
            senderTornUserId:
              row.torn_user_id==null
                ? null
                : String(row.torn_user_id),
            senderTornName:
              row.torn_name || null,
            message:row.message,
            createdAt:Number(row.created_at)
          }))
      });
    }

    const factionApplicationMessageMatch=
      url.pathname.match(
        /^\/admin\/faction-applications\/([0-9a-fA-F-]{36})\/message$/
      );

    if (
      factionApplicationMessageMatch &&
      request.method === 'POST'
    ) {
      const client=await authenticateClient(request,env);

      if(!client){
        return Response.json(
          {error:'Unauthorized'},
          {status:401}
        );
      }

      if(client.role!=='admin'){
        return Response.json(
          {error:'Admin access required'},
          {status:403}
        );
      }

      let body;

      try{
        body=await request.json();
      }catch(e){
        return Response.json(
          {error:'Invalid JSON'},
          {status:400}
        );
      }

      const message=
        String(body?.message || '').trim();

      if(!message){
        return Response.json(
          {error:'Message is required'},
          {status:400}
        );
      }

      if(message.length>4000){
        return Response.json(
          {error:'Message is too long'},
          {status:400}
        );
      }

      const applicationId=
        factionApplicationMessageMatch[1];

      const application=
        await env.DB
          .prepare(`
            SELECT status
            FROM faction_applications
            WHERE application_id=?
            LIMIT 1
          `)
          .bind(applicationId)
          .first();

      if(!application){
        return Response.json(
          {error:'Faction application not found'},
          {status:404}
        );
      }

      if(
        application.status!=='pending' &&
        application.status!=='needs_info'
      ){
        return Response.json(
          {error:'Faction application is closed'},
          {status:409}
        );
      }

      const now=Date.now();

      await env.DB.batch([
        env.DB
          .prepare(`
            INSERT INTO faction_application_messages
            (
              message_id,
              application_id,
              sender_client_id,
              sender_type,
              message,
              created_at
            )
            VALUES (?, ?, ?, 'admin', ?, ?)
          `)
          .bind(
            crypto.randomUUID(),
            applicationId,
            client.clientId,
            message,
            now
          ),
        env.DB
          .prepare(`
            UPDATE faction_applications
            SET updated_at=?
            WHERE application_id=?
          `)
          .bind(now,applicationId)
      ]);

      return Response.json({
        success:true,
        messageAdded:true,
        applicationId,
        createdAt:now
      });
    }

    const factionApplicationRequestInfoMatch=
      url.pathname.match(
        /^\/admin\/faction-applications\/([0-9a-fA-F-]{36})\/request-info$/
      );

    if (
      factionApplicationRequestInfoMatch &&
      request.method === 'POST'
    ) {
      const client=await authenticateClient(request,env);

      if(!client){
        return Response.json(
          {error:'Unauthorized'},
          {status:401}
        );
      }

      if(client.role!=='admin'){
        return Response.json(
          {error:'Admin access required'},
          {status:403}
        );
      }

      let body;

      try{
        body=await request.json();
      }catch(e){
        return Response.json(
          {error:'Invalid JSON'},
          {status:400}
        );
      }

      const message=
        String(body?.message || '').trim();

      if(!message){
        return Response.json(
          {
            error:
              'A message explaining what information is needed is required'
          },
          {status:400}
        );
      }

      if(message.length>4000){
        return Response.json(
          {error:'Message is too long'},
          {status:400}
        );
      }

      const applicationId=
        factionApplicationRequestInfoMatch[1];

      const application=
        await env.DB
          .prepare(`
            SELECT status
            FROM faction_applications
            WHERE application_id=?
            LIMIT 1
          `)
          .bind(applicationId)
          .first();

      if(!application){
        return Response.json(
          {error:'Faction application not found'},
          {status:404}
        );
      }

      if(
        application.status!=='pending' &&
        application.status!=='needs_info'
      ){
        return Response.json(
          {error:'Faction application is closed'},
          {status:409}
        );
      }

      const now=Date.now();

      await env.DB.batch([
        env.DB
          .prepare(`
            INSERT INTO faction_application_messages
            (
              message_id,
              application_id,
              sender_client_id,
              sender_type,
              message,
              created_at
            )
            VALUES (?, ?, ?, 'admin', ?, ?)
          `)
          .bind(
            crypto.randomUUID(),
            applicationId,
            client.clientId,
            message,
            now
          ),
        env.DB
          .prepare(`
            UPDATE faction_applications
            SET
              status='needs_info',
              updated_at=?
            WHERE application_id=?
          `)
          .bind(now,applicationId)
      ]);

      return Response.json({
        success:true,
        applicationId,
        status:'needs_info',
        updatedAt:now
      });
    }

    const factionApplicationDeclineMatch=
      url.pathname.match(
        /^\/admin\/faction-applications\/([0-9a-fA-F-]{36})\/decline$/
      );

    if (
      factionApplicationDeclineMatch &&
      request.method === 'POST'
    ) {
      const client=await authenticateClient(request,env);

      if(!client){
        return Response.json(
          {error:'Unauthorized'},
          {status:401}
        );
      }

      if(client.role!=='admin'){
        return Response.json(
          {error:'Admin access required'},
          {status:403}
        );
      }

      let body={};

      try{
        body=await request.json();
      }catch(e){
        body={};
      }

      const message=
        String(body?.message || '').trim();

      if(message.length>4000){
        return Response.json(
          {error:'Message is too long'},
          {status:400}
        );
      }

      const applicationId=
        factionApplicationDeclineMatch[1];

      const application=
        await env.DB
          .prepare(`
            SELECT status
            FROM faction_applications
            WHERE application_id=?
            LIMIT 1
          `)
          .bind(applicationId)
          .first();

      if(!application){
        return Response.json(
          {error:'Faction application not found'},
          {status:404}
        );
      }

      if(
        application.status!=='pending' &&
        application.status!=='needs_info'
      ){
        return Response.json(
          {error:'Faction application is no longer open'},
          {status:409}
        );
      }

      const now=Date.now();
      const statements=[];

      if(message){
        statements.push(
          env.DB
            .prepare(`
              INSERT INTO faction_application_messages
              (
                message_id,
                application_id,
                sender_client_id,
                sender_type,
                message,
                created_at
              )
              VALUES (?, ?, ?, 'admin', ?, ?)
            `)
            .bind(
              crypto.randomUUID(),
              applicationId,
              client.clientId,
              message,
              now
            )
        );
      }

      statements.push(
        env.DB
          .prepare(`
            UPDATE faction_applications
            SET
              status='declined',
              updated_at=?,
              resolved_at=?,
              resolved_by_client_id=?
            WHERE application_id=?
          `)
          .bind(
            now,
            now,
            client.clientId,
            applicationId
          )
      );

      await env.DB.batch(statements);

      return Response.json({
        success:true,
        applicationId,
        status:'declined',
        resolvedAt:now
      });
    }

    const factionApplicationApproveMatch=
      url.pathname.match(
        /^\/admin\/faction-applications\/([0-9a-fA-F-]{36})\/approve$/
      );

    if (
      factionApplicationApproveMatch &&
      request.method === 'POST'
    ) {
      const client=await authenticateClient(request,env);

      if(!client){
        return Response.json(
          {error:'Unauthorized'},
          {status:401}
        );
      }

      if(client.role!=='admin'){
        return Response.json(
          {error:'Admin access required'},
          {status:403}
        );
      }

      let body={};

      try{
        body=await request.json();
      }catch(e){
        body={};
      }

      const message=
        String(body?.message || '').trim();

      if(message.length>4000){
        return Response.json(
          {error:'Message is too long'},
          {status:400}
        );
      }

      const applicationId=
        factionApplicationApproveMatch[1];

      const application=
        await env.DB
          .prepare(`
            SELECT
              application_id,
              faction_id,
              faction_name,
              status
            FROM faction_applications
            WHERE application_id=?
            LIMIT 1
          `)
          .bind(applicationId)
          .first();

      if(!application){
        return Response.json(
          {error:'Faction application not found'},
          {status:404}
        );
      }

      if(
        application.status!=='pending' &&
        application.status!=='needs_info'
      ){
        return Response.json(
          {error:'Faction application is no longer open'},
          {status:409}
        );
      }

      const factionId=
        String(application.faction_id);

      const config=
        await env.DB
          .prepare(`
            SELECT primary_faction_id
            FROM tracker_access_config
            WHERE id=1
            LIMIT 1
          `)
          .first();

      const isPrimary=
        String(
          config?.primary_faction_id || ''
        )===factionId;

      let factionName=
        String(
          application.faction_name || ''
        ).trim().slice(0,120);

      if(!factionName){
        factionName=
          await resolveCurrentFactionName(
            client,
            factionId,
            env
          );
      }

      if(!factionName){
        factionName='Faction '+factionId;
      }

      const existing=
        await env.DB
          .prepare(`
            SELECT
              access_code_hash,
              access_code_ciphertext,
              access_code_iv,
              code_created_at
            FROM registered_factions
            WHERE faction_id=?
            LIMIT 1
          `)
          .bind(factionId)
          .first();

      let accessCode=null;
      let codeHash=null;
      let ciphertext=null;
      let iv=null;
      let codeCreatedAt=null;

      if(!isPrimary){
        if(
          existing?.access_code_hash &&
          existing?.access_code_ciphertext &&
          existing?.access_code_iv
        ){
          try{
            accessCode=
              await decryptFactionAccessCode(
                existing.access_code_ciphertext,
                existing.access_code_iv,
                factionId,
                env
              );

            codeHash=
              existing.access_code_hash;

            ciphertext=
              existing.access_code_ciphertext;

            iv=
              existing.access_code_iv;

            codeCreatedAt=
              existing.code_created_at==null
                ? null
                : Number(existing.code_created_at);
          }catch(e){
            accessCode=null;
          }
        }

        if(!accessCode){
          accessCode=createInviteCode();
          codeHash=await sha256Hex(accessCode);

          const encrypted=
            await encryptFactionAccessCode(
              accessCode,
              factionId,
              env
            );

          ciphertext=encrypted.ciphertext;
          iv=encrypted.iv;
          codeCreatedAt=Date.now();
        }
      }

      const now=Date.now();
      const statements=[
        env.DB
          .prepare(`
            INSERT INTO registered_factions
            (
              faction_id,
              faction_name,
              active,
              is_primary,
              access_code_hash,
              access_code_ciphertext,
              access_code_iv,
              code_created_at,
              created_by_client_id,
              created_at,
              updated_at
            )
            VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(faction_id)
            DO UPDATE SET
              faction_name=excluded.faction_name,
              active=1,
              is_primary=excluded.is_primary,
              access_code_hash=excluded.access_code_hash,
              access_code_ciphertext=
                excluded.access_code_ciphertext,
              access_code_iv=
                excluded.access_code_iv,
              code_created_at=
                excluded.code_created_at,
              updated_at=excluded.updated_at
          `)
          .bind(
            factionId,
            factionName,
            isPrimary ? 1 : 0,
            codeHash,
            ciphertext,
            iv,
            codeCreatedAt,
            client.clientId,
            now,
            now
          )
      ];

      if(message){
        statements.push(
          env.DB
            .prepare(`
              INSERT INTO faction_application_messages
              (
                message_id,
                application_id,
                sender_client_id,
                sender_type,
                message,
                created_at
              )
              VALUES (?, ?, ?, 'admin', ?, ?)
            `)
            .bind(
              crypto.randomUUID(),
              applicationId,
              client.clientId,
              message,
              now
            )
        );
      }

      statements.push(
        env.DB
          .prepare(`
            UPDATE faction_applications
            SET
              faction_name=?,
              status='approved',
              updated_at=?,
              resolved_at=?,
              resolved_by_client_id=?
            WHERE application_id=?
          `)
          .bind(
            factionName,
            now,
            now,
            client.clientId,
            applicationId
          )
      );

      await env.DB.batch(statements);

      return Response.json({
        success:true,
        applicationId,
        status:'approved',
        factionId,
        factionName,
        factionRegistered:true,
        accessCode:
          isPrimary
            ? null
            : accessCode,
        codeRequired:
          !isPrimary,
        resolvedAt:now
      });
    }



    if (
      url.pathname === '/admin/access/requests' &&
      request.method === 'GET'
    ) {
      const client=
        await authenticateClient(
          request,
          env
        );

      if(!client){
        return Response.json(
          {error:'Unauthorized'},
          {status:401}
        );
      }

      if(client.role!=='admin'){
        return Response.json(
          {error:'Admin access required'},
          {status:403}
        );
      }

      const now=Date.now();

      const config=
        await env.DB
          .prepare(`
            SELECT grace_period_ms
            FROM tracker_access_config
            WHERE id=1
            LIMIT 1
          `)
          .first();

      const gracePeriodMs=
        Math.max(
          0,
          Number(
            config?.grace_period_ms ||
            86400000
          )
        );

      const result=
        await env.DB
          .prepare(`
            SELECT
              r.request_id,
              r.client_id,
              r.torn_user_id,
              r.request_type,
              r.status,
              r.requested_access_status,
              r.requested_faction_id,
              r.requested_at,
              r.resolved_at,
              r.resolved_by_client_id,
              r.activated_at,

              c.torn_name,
              c.access_type,
              c.access_status,
              c.registered_faction_id,
              c.faction_mismatch_since,
              c.access_suspended_at,

              f.faction_name
            FROM access_requests r
            INNER JOIN clients c
              ON c.client_id=r.client_id
            LEFT JOIN registered_factions f
              ON f.faction_id=
                c.registered_faction_id
            WHERE
              c.active=1
              OR
              (
                c.active=0
                AND r.status='declined'
                AND c.access_type='pending'
                AND c.access_status='declined'
              )
            ORDER BY
              CASE r.status
                WHEN 'pending' THEN 0
                WHEN 'approved' THEN 1
                ELSE 2
              END,
              r.requested_at DESC
            LIMIT 100
          `)
          .all();

      const requests=
        (result?.results || [])
          .map(row=>{
            const mismatchSince=
              row.faction_mismatch_since==null
                ? null
                : Number(
                    row.faction_mismatch_since
                  );

            const graceEndsAt=
              mismatchSince==null
                ? null
                : mismatchSince+
                  gracePeriodMs;

            const graceRemainingMs=
              graceEndsAt==null
                ? null
                : Math.max(
                    0,
                    graceEndsAt-now
                  );

            const tornUserId=
              row.torn_user_id==null
                ? null
                : String(
                    row.torn_user_id
                  );

            return {
              requestId:
                row.request_id,
              clientId:
                row.client_id,
              tornUserId,
              tornName:
                row.torn_name ||
                'Unknown User',
              profileUrl:
                tornUserId
                  ? 'https://www.torn.com/profiles.php?XID='+
                    encodeURIComponent(
                      tornUserId
                    )
                  : null,
              requestType:
                row.request_type,
              requestStatus:
                row.status,
              requestedAccessStatus:
                row.requested_access_status ||
                null,
              requestedFactionId:
                row.requested_faction_id ||
                null,
              requestedAt:
                Number(
                  row.requested_at
                ),
              resolvedAt:
                row.resolved_at==null
                  ? null
                  : Number(
                      row.resolved_at
                    ),
              activatedAt:
                row.activated_at==null
                  ? null
                  : Number(
                      row.activated_at
                    ),
              accessType:
                row.access_type ||
                'legacy',
              accessStatus:
                row.access_status ||
                'active',
              registeredFactionId:
                row.registered_faction_id ||
                null,
              factionName:
                row.faction_name ||
                null,
              factionMismatchSince:
                mismatchSince,
              suspendedAt:
                row.access_suspended_at==null
                  ? null
                  : Number(
                      row.access_suspended_at
                    ),
              graceEndsAt,
              graceRemainingMs,
              canSendPersonal:
                row.status==='pending' &&
                (
                  (
                    row.access_type==='faction' &&
                    (
                      row.access_status==='grace' ||
                      row.access_status==='suspended'
                    )
                  ) ||
                  (
                    row.access_type==='pending' &&
                    row.access_status==='pending'
                  )
                )
            };
          });

      const pendingCount=
        requests.filter(
          item=>
            item.requestStatus==='pending'
        ).length;

      const approvedCount=
        requests.filter(
          item=>
            item.requestStatus==='approved'
        ).length;

      return Response.json({
        success:true,
        pendingCount,
        approvedCount,
        requests
      });
    }


    const approveAccessRequestMatch=
      url.pathname.match(
        /^\/admin\/access\/requests\/([0-9a-fA-F-]{36})\/approve$/
      );

    if (
      approveAccessRequestMatch &&
      request.method === 'POST'
    ) {
      const client=
        await authenticateClient(
          request,
          env
        );

      if(!client){
        return Response.json(
          {error:'Unauthorized'},
          {status:401}
        );
      }

      if(client.role!=='admin'){
        return Response.json(
          {error:'Admin access required'},
          {status:403}
        );
      }

      const requestId=
        approveAccessRequestMatch[1];

      const requestRow=
        await env.DB
          .prepare(`
            SELECT
              request_id,
              client_id,
              status
            FROM access_requests
            WHERE request_id=?
            LIMIT 1
          `)
          .bind(requestId)
          .first();

      if(!requestRow){
        return Response.json(
          {error:'Access request not found'},
          {status:404}
        );
      }

      try{
        const result=
          await issueClientPersonalAccess(
            client,
            String(
              requestRow.client_id
            ),
            requestId,
            env
          );

        return Response.json({
          success:true,
          approved:true,
          personalAccessReady:true,
          ...result
        });
      }catch(error){
        return Response.json(
          {
            success:false,
            error:String(
              error?.message || error
            )
          },
          {
            status:
              Number(
                error?.httpStatus
              ) || 400
          }
        );
      }
    }


    const declineAccessRequestMatch=
      url.pathname.match(
        /^\/admin\/access\/requests\/([0-9a-fA-F-]{36})\/decline$/
      );

    if (
      declineAccessRequestMatch &&
      request.method === 'POST'
    ) {
      const client=
        await authenticateClient(
          request,
          env
        );

      if(!client){
        return Response.json(
          {error:'Unauthorized'},
          {status:401}
        );
      }

      if(client.role!=='admin'){
        return Response.json(
          {error:'Admin access required'},
          {status:403}
        );
      }

      const requestId=
        declineAccessRequestMatch[1];

      const requestRow=
        await env.DB
          .prepare(`
            SELECT
              r.request_id,
              r.client_id,
              r.status,
              c.access_type,
              c.access_status,
              c.active
            FROM access_requests r
            INNER JOIN clients c
              ON c.client_id=r.client_id
            WHERE r.request_id=?
            LIMIT 1
          `)
          .bind(requestId)
          .first();

      if(!requestRow){
        return Response.json(
          {error:'Access request not found'},
          {status:404}
        );
      }

      if(requestRow.status!=='pending'){
        return Response.json(
          {
            error:
              'Access request is no longer pending'
          },
          {status:409}
        );
      }

      const now=Date.now();

      const pendingRegistrationDeclined=
        requestRow.access_type==='pending' &&
        requestRow.access_status==='pending';

      const statements=[
        env.DB
          .prepare(`
            UPDATE access_requests
            SET
              status='declined',
              resolved_at=?,
              resolved_by_client_id=?
            WHERE request_id=?
              AND status='pending'
          `)
          .bind(
            now,
            client.clientId,
            requestId
          )
      ];

      if(pendingRegistrationDeclined){
        statements.push(
          env.DB
            .prepare(`
              UPDATE clients
              SET
                active=0,
                access_status='declined',
                api_key_ciphertext=NULL,
                api_key_iv=NULL,
                api_key_validated_at=NULL,
                access_updated_at=?
              WHERE client_id=?
                AND access_type='pending'
                AND access_status='pending'
            `)
            .bind(
              now,
              requestRow.client_id
            )
        );

        statements.push(
          env.DB
            .prepare(`
              UPDATE personal_access_codes
              SET active=0
              WHERE target_client_id=?
                AND active=1
            `)
            .bind(
              requestRow.client_id
            )
        );
      }

      await env.DB.batch(
        statements
      );

      return Response.json({
        success:true,
        declined:true,
        requestId,
        resolvedAt:now,
        pendingRegistrationDeclined,
        clientDisabled:
          pendingRegistrationDeclined,
        apiKeyRemoved:
          pendingRegistrationDeclined
      });
    }


    const directPersonalAccessMatch=
      url.pathname.match(
        /^\/admin\/access\/users\/([0-9a-fA-F-]{36})\/personal$/
      );

    if (
      directPersonalAccessMatch &&
      request.method === 'POST'
    ) {
      const client=
        await authenticateClient(
          request,
          env
        );

      if(!client){
        return Response.json(
          {error:'Unauthorized'},
          {status:401}
        );
      }

      if(client.role!=='admin'){
        return Response.json(
          {error:'Admin access required'},
          {status:403}
        );
      }

      const targetClientId=
        directPersonalAccessMatch[1];

      try{
        const result=
          await issueClientPersonalAccess(
            client,
            targetClientId,
            null,
            env
          );

        return Response.json({
          success:true,
          approved:true,
          direct:true,
          personalAccessReady:true,
          ...result
        });
      }catch(error){
        return Response.json(
          {
            success:false,
            error:String(
              error?.message || error
            )
          },
          {
            status:
              Number(
                error?.httpStatus
              ) || 400
          }
        );
      }
    }


    if (
      url.pathname === '/admin/create-invite' &&
      request.method === 'POST'
    ) {
      const suppliedSecret =
        request.headers.get('X-Server-Secret');

      if (
        !suppliedSecret ||
        suppliedSecret !== env.SERVER_SECRET
      ) {
        return Response.json(
          { error: 'Unauthorized' },
          { status: 401 }
        );
      }

      let body = {};

      try {
        body = await request.json();
      } catch (e) {}

      const label = String(
        body.label || 'Flight Tracker User'
      )
        .trim()
        .slice(0, 80);

      const inviteCode = createInviteCode();
      const codeHash = await sha256Hex(inviteCode);
      const now = Date.now();

      await env.DB
        .prepare(`
          INSERT INTO invite_codes
          (
            code_hash,
            label,
            active,
            max_uses,
            use_count,
            expires_at,
            created_at
          )
          VALUES (?, ?, 1, 1, 0, NULL, ?)
        `)
        .bind(codeHash, label, now)
        .run();

      return Response.json({
        success: true,
        inviteCode,
        label,
        maxUses: 1
      });
    }

    if (
      url.pathname === '/client/register-universal' &&
      request.method === 'POST'
    ) {
      let body;

      try{
        body=await request.json();
      }catch(e){
        return Response.json(
          {error:'Invalid JSON'},
          {status:400}
        );
      }

      let apiKey=String(
        body?.apiKey || ''
      ).trim();

      const accessCode=String(
        body?.accessCode || ''
      )
        .trim()
        .toUpperCase();

      if(!apiKey){
        return Response.json(
          {
            success:false,
            error:
              'FFScouter-registered Torn API key required'
          },
          {status:400}
        );
      }

      const validation=
        await validateTrackerApiKey(apiKey);

      if(!validation.ok){
        apiKey=null;

        return Response.json(
          {
            success:false,
            error:validation.error
          },
          {status:validation.status || 400}
        );
      }

      const duplicateClient=
        await env.DB
          .prepare(`
            SELECT
              client_id,
              access_type,
              access_status
            FROM clients
            WHERE torn_user_id=?
              AND active=1
            LIMIT 1
          `)
          .bind(validation.tornUserId)
          .first();

      if(duplicateClient){
        const existingClientId=String(
          duplicateClient.client_id || ''
        ).trim();

        if(!existingClientId){
          apiKey=null;

          return Response.json(
            {
              success:false,
              error:'Existing tracker account is invalid'
            },
            {status:500}
          );
        }

        const linkedDeviceId=
          'dev_'+crypto.randomUUID();

        const linkedDeviceSecret=
          createClientSecret();

        const linkedDeviceSecretHash=
          await sha256Hex(
            linkedDeviceSecret
          );

        const now=Date.now();

        const existingEncrypted=
          await encryptApiKey(
            apiKey,
            existingClientId,
            env
          );

        const currentFactionId=
          validation.ownFactionId==null
            ? null
            : String(
                validation.ownFactionId
              );

        await env.DB.batch([
          env.DB
            .prepare(`
              UPDATE clients
              SET
                torn_name=?,
                api_key_ciphertext=?,
                api_key_iv=?,
                own_faction_id=?,
                api_key_validated_at=?
              WHERE client_id=?
                AND active=1
            `)
            .bind(
              validation.tornName,
              existingEncrypted.ciphertext,
              existingEncrypted.iv,
              currentFactionId,
              now,
              existingClientId
            ),

          env.DB
            .prepare(`
              INSERT INTO client_devices (
                device_id,
                client_id,
                secret_hash,
                label,
                active,
                created_at,
                last_seen_at,
                revoked_at
              )
              VALUES (?, ?, ?, ?, 1, ?, NULL, NULL)
            `)
            .bind(
              linkedDeviceId,
              existingClientId,
              linkedDeviceSecretHash,
              'Linked device',
              now
            )
        ]);

        apiKey=null;

        const existingAccessStatus=String(
          duplicateClient.access_status ||
          'active'
        );

        return Response.json({
          success:true,
          registrationMode:'linked_device',
          linkedExisting:true,
          clientId:linkedDeviceId,
          clientSecret:linkedDeviceSecret,
          accountClientId:existingClientId,
          tornUserId:
            validation.tornUserId,
          tornName:
            validation.tornName,
          ownFactionId:
            currentFactionId,
          factionName:
            validation.factionName || null,
          accessType:
            duplicateClient.access_type ||
            'legacy',
          accessStatus:
            existingAccessStatus,
          pendingApproval:
            existingAccessStatus==='pending'
        });
      }

      const factionId=
        validation.ownFactionId==null
          ? null
          : String(
              validation.ownFactionId
            );

      let factionAccess=null;

      if(factionId){
        factionAccess=
          await env.DB
            .prepare(`
              SELECT
                f.faction_id,
                f.faction_name,
                f.active,
                f.is_primary,
                f.access_code_hash,
                c.primary_auto_access
              FROM registered_factions f
              LEFT JOIN tracker_access_config c
                ON c.id=1
              WHERE f.faction_id=?
              LIMIT 1
            `)
            .bind(factionId)
            .first();
      }

      const registeredFactionActive=
        !!factionAccess &&
        Number(factionAccess.active)===1;

      const primaryAutoAccess=
        registeredFactionActive &&
        Number(factionAccess.is_primary)===1 &&
        Number(
          factionAccess.primary_auto_access ?? 1
        )===1;

      const factionAuthorized=
        registeredFactionActive;


      const clientId=
        crypto.randomUUID();

      const clientSecret=
        createClientSecret();

      const secretHash=
        await sha256Hex(
          clientSecret
        );

      const encrypted=
        await encryptApiKey(
          apiKey,
          clientId,
          env
        );

      apiKey=null;

      const now=Date.now();

      if(factionAuthorized){
        try{
          await env.DB
            .prepare(`
              INSERT INTO clients
              (
                client_id,
                secret_hash,
                label,
                active,
                created_at,
                last_seen_at,
                role,
                torn_user_id,
                torn_name,
                api_key_ciphertext,
                api_key_iv,
                own_faction_id,
                api_key_validated_at,
                access_type,
                access_status,
                registered_faction_id,
                access_granted_at,
                access_updated_at
              )
              VALUES
              (
                ?, ?, ?, 1, ?, ?,
                'user',
                ?, ?, ?, ?, ?, ?,
                'faction',
                'active',
                ?, ?, ?
              )
            `)
            .bind(
              clientId,
              secretHash,
              validation.tornName,
              now,
              now,
              validation.tornUserId,
              validation.tornName,
              encrypted.ciphertext,
              encrypted.iv,
              factionId,
              now,
              factionId,
              now,
              now
            )
            .run();
        }catch(error){
          if(
            /unique|constraint/i.test(
              String(
                error?.message ||
                error
              )
            )
          ){
            return Response.json(
              {
                success:false,
                error:
                  'This Torn account is already registered to an active tracker client'
              },
              {status:409}
            );
          }

          throw error;
        }

        await env.DB
          .prepare(`
            INSERT INTO watched_factions
            (
              client_id,
              faction_id,
              faction_name,
              active,
              created_at,
              next_poll_at,
              is_own_faction
            )
            VALUES (?, ?, ?, 1, ?, 0, 1)
            ON CONFLICT(
              client_id,
              faction_id
            )
            DO UPDATE SET
              faction_name=
                COALESCE(
                  excluded.faction_name,
                  watched_factions.faction_name
                ),
              active=1,
              next_poll_at=0,
              is_own_faction=1
          `)
          .bind(
            clientId,
            factionId,
            factionAccess?.faction_name ||
              null,
            now
          )
          .run();

        await safeEnsureAndReconcileGlobalTarget(
          'faction',
          factionId,
          factionAccess?.faction_name ||
            null,
          env
        );

        const schedulerId=
          env.TRACKER_SCHEDULER.idFromName(
            clientId
          );

        const scheduler=
          env.TRACKER_SCHEDULER.get(
            schedulerId
          );

        const schedulerResult=
          await scheduler.start();

        return Response.json({
          success:true,
          registrationMode:'faction',
          pendingApproval:false,
          clientId,
          clientSecret,
          tornUserId:
            validation.tornUserId,
          tornName:
            validation.tornName,
          ownFactionId:
            factionId,
          factionName:
            factionAccess?.faction_name ||
            null,
          accessType:'faction',
          accessStatus:'active',
          scheduler:schedulerResult
        });
      }

      const requestId=
        crypto.randomUUID();

      const statements=[
        env.DB
          .prepare(`
            INSERT INTO clients
            (
              client_id,
              secret_hash,
              label,
              active,
              created_at,
              last_seen_at,
              role,
              torn_user_id,
              torn_name,
              api_key_ciphertext,
              api_key_iv,
              own_faction_id,
              api_key_validated_at,
              access_type,
              access_status,
              registered_faction_id,
              access_updated_at
            )
            VALUES
            (
              ?, ?, ?, 1, ?, ?,
              'user',
              ?, ?, ?, ?, ?, ?,
              'pending',
              'pending',
              NULL,
              ?
            )
          `)
          .bind(
            clientId,
            secretHash,
            validation.tornName,
            now,
            now,
            validation.tornUserId,
            validation.tornName,
            encrypted.ciphertext,
            encrypted.iv,
            factionId,
            now,
            now
          ),

        env.DB
          .prepare(`
            INSERT INTO access_requests
            (
              request_id,
              client_id,
              torn_user_id,
              request_type,
              status,
              requested_access_status,
              requested_faction_id,
              requested_at
            )
            VALUES
            (
              ?, ?, ?,
              'personal',
              'pending',
              'pending',
              ?,
              ?
            )
          `)
          .bind(
            requestId,
            clientId,
            validation.tornUserId,
            factionId,
            now
          )
      ];

      try{
        await env.DB.batch(
          statements
        );
      }catch(error){
        if(
          /unique|constraint/i.test(
            String(
              error?.message ||
              error
            )
          )
        ){
          return Response.json(
            {
              success:false,
              error:
                'This Torn account is already registered to an active tracker client'
            },
            {status:409}
          );
        }

        throw error;
      }

      return Response.json({
        success:true,
        registrationMode:
          'pending_personal',
        pendingApproval:true,
        requestSentToAdmin:true,
        clientId,
        clientSecret,
        tornUserId:
          validation.tornUserId,
        tornName:
          validation.tornName,
        ownFactionId:
          factionId,
        factionName:
          factionAccess?.faction_name ||
          null,
        accessType:'pending',
        accessStatus:'pending',
        requestId,
        message:
          'Personal Access request is awaiting admin approval'
      });
    }


    if (
      url.pathname === '/client/register-faction' &&
      request.method === 'POST'
    ) {
      let body;

      try{
        body=await request.json();
      }catch(e){
        return Response.json(
          {error:'Invalid JSON'},
          {status:400}
        );
      }

      const apiKey=String(
        body?.apiKey || ''
      ).trim();

      const accessCode=String(
        body?.accessCode || ''
      )
        .trim()
        .toUpperCase();

      if(!apiKey){
        return Response.json(
          {
            error:
              'FFScouter-registered Torn API key required'
          },
          {status:400}
        );
      }

      const validation=
        await validateTrackerApiKey(apiKey);

      if(!validation.ok){
        return Response.json(
          {
            success:false,
            error:validation.error
          },
          {status:validation.status || 400}
        );
      }

      if(!validation.ownFactionId){
        return Response.json(
          {
            success:false,
            error:
              'Your Torn account is not currently in a faction'
          },
          {status:403}
        );
      }

      const factionId=
        String(validation.ownFactionId);

      const factionAccess=
        await env.DB
          .prepare(`
            SELECT
              f.faction_id,
              f.faction_name,
              f.active,
              f.is_primary,
              f.access_code_hash,
              c.primary_auto_access
            FROM registered_factions f
            LEFT JOIN tracker_access_config c
              ON c.id=1
            WHERE f.faction_id=?
            LIMIT 1
          `)
          .bind(factionId)
          .first();

      if(
        !factionAccess ||
        Number(factionAccess.active)!==1
      ){
        return Response.json(
          {
            success:false,
            error:
              'Your faction is not registered for tracker access'
          },
          {status:403}
        );
      }

      const primaryAutoAccess=
        Number(factionAccess.is_primary)===1 &&
        Number(
          factionAccess.primary_auto_access ?? 1
        )===1;

      if(!primaryAutoAccess){
        if(!accessCode){
          return Response.json(
            {
              success:false,
              error:'Faction Access Code required'
            },
            {status:403}
          );
        }

        if(!factionAccess.access_code_hash){
          return Response.json(
            {
              success:false,
              error:
                'Faction registration is not currently enabled'
            },
            {status:403}
          );
        }

        const suppliedCodeHash=
          await sha256Hex(accessCode);

        if(
          suppliedCodeHash!==
          factionAccess.access_code_hash
        ){
          return Response.json(
            {
              success:false,
              error:'Invalid Faction Access Code'
            },
            {status:403}
          );
        }
      }

      const duplicateClient=
        await env.DB
          .prepare(`
            SELECT client_id
            FROM clients
            WHERE torn_user_id=?
              AND active=1
            LIMIT 1
          `)
          .bind(validation.tornUserId)
          .first();

      if(duplicateClient){
        return Response.json(
          {
            success:false,
            error:
              'This Torn account is already registered to an active tracker client'
          },
          {status:409}
        );
      }

      const clientId=crypto.randomUUID();
      const clientSecret=createClientSecret();
      const secretHash=
        await sha256Hex(clientSecret);

      const encrypted=
        await encryptApiKey(
          apiKey,
          clientId,
          env
        );

      const now=Date.now();

      try{
        await env.DB
          .prepare(`
            INSERT INTO clients
            (
              client_id,
              secret_hash,
              label,
              active,
              created_at,
              last_seen_at,
              role,
              torn_user_id,
              torn_name,
              api_key_ciphertext,
              api_key_iv,
              own_faction_id,
              api_key_validated_at,
              access_type,
              access_status,
              registered_faction_id,
              access_granted_at,
              access_updated_at
            )
            VALUES
            (
              ?, ?, ?, 1, ?, ?,
              'user',
              ?, ?, ?, ?, ?, ?,
              'faction',
              'active',
              ?, ?, ?
            )
          `)
          .bind(
            clientId,
            secretHash,
            validation.tornName,
            now,
            now,
            validation.tornUserId,
            validation.tornName,
            encrypted.ciphertext,
            encrypted.iv,
            factionId,
            now,
            factionId,
            now,
            now
          )
          .run();
      }catch(error){
        if(
          /unique|constraint/i.test(
            String(error?.message || error)
          )
        ){
          return Response.json(
            {
              success:false,
              error:
                'This Torn account is already registered to an active tracker client'
            },
            {status:409}
          );
        }

        throw error;
      }

      await env.DB
        .prepare(`
          INSERT INTO watched_factions
          (
            client_id,
            faction_id,
            faction_name,
            active,
            created_at,
            next_poll_at,
            is_own_faction
          )
          VALUES (?, ?, ?, 1, ?, 0, 1)
          ON CONFLICT(client_id,faction_id)
          DO UPDATE SET
            faction_name=COALESCE(
              excluded.faction_name,
              watched_factions.faction_name
            ),
            active=1,
            next_poll_at=0,
            is_own_faction=1
        `)
        .bind(
          clientId,
          factionId,
          factionAccess.faction_name || null,
          now
        )
        .run();

      await safeEnsureAndReconcileGlobalTarget(
        'faction',
        factionId,
        factionAccess.faction_name || null,
        env
      );

      const schedulerId=
        env.TRACKER_SCHEDULER.idFromName(
          clientId
        );

      const scheduler=
        env.TRACKER_SCHEDULER.get(
          schedulerId
        );

      const schedulerResult=
        await scheduler.start();

      return Response.json({
        success:true,
        registered:true,
        clientId,
        clientSecret,
        tornUserId:
          validation.tornUserId,
        tornName:
          validation.tornName,
        factionId,
        factionName:
          factionAccess.faction_name || null,
        accessType:'faction',
        accessStatus:'active',
        primaryFaction:
          Number(factionAccess.is_primary)===1,
        factionCodeRequired:
          !primaryAutoAccess,
        schedulerStarted:true,
        schedulerAlreadyRunning:
          schedulerResult.alreadyRunning===true
      });
    }


    if (
      url.pathname === '/client/register' &&
      request.method === 'POST'
    ) {
      let body;

      try {
        body = await request.json();
      } catch (e) {
        return Response.json(
          { error: 'Invalid JSON' },
          { status: 400 }
        );
      }

      const inviteCode = String(
        body?.inviteCode || ''
      )
        .trim()
        .toUpperCase();

      if (!inviteCode) {
        return Response.json(
          { error: 'Invite code required' },
          { status: 400 }
        );
      }

      const codeHash = await sha256Hex(inviteCode);
      const now = Date.now();

      const invite = await env.DB
        .prepare(`
          SELECT
            code_hash,
            label,
            active,
            max_uses,
            use_count,
            expires_at
          FROM invite_codes
          WHERE code_hash = ?
        `)
        .bind(codeHash)
        .first();

      if (!invite) {
        return Response.json(
          { error: 'Invalid invite code' },
          { status: 403 }
        );
      }

      if (
        !invite.active ||
        Number(invite.use_count) >=
          Number(invite.max_uses)
      ) {
        return Response.json(
          { error: 'Invite code already used' },
          { status: 403 }
        );
      }

      if (
        invite.expires_at &&
        Number(invite.expires_at) <= now
      ) {
        return Response.json(
          { error: 'Invite code expired' },
          { status: 403 }
        );
      }

      const clientId = crypto.randomUUID();
      const clientSecret = createClientSecret();
      const secretHash =
        await sha256Hex(clientSecret);

      await env.DB
        .prepare(`
          INSERT INTO clients
          (
            client_id,
            secret_hash,
            label,
            active,
            created_at,
            last_seen_at
          )
          VALUES (?, ?, ?, 1, ?, ?)
        `)
        .bind(
          clientId,
          secretHash,
          invite.label || 'Flight Tracker User',
          now,
          now
        )
        .run();

      await env.DB
        .prepare(`
          UPDATE invite_codes
          SET
            use_count = use_count + 1,
            active = CASE
              WHEN use_count + 1 >= max_uses
              THEN 0
              ELSE active
            END
          WHERE code_hash = ?
        `)
        .bind(codeHash)
        .run();

      return Response.json({
        success: true,
        clientId,
        clientSecret,
        label:
          invite.label || 'Flight Tracker User'
      });
    }

    if (
      url.pathname === '/client/api-key' &&
      request.method === 'POST'
    ) {
      const client=
        await authenticateClient(request,env);

      if(!client){
        return Response.json(
          {error:'Unauthorized'},
          {status:401}
        );
      }

      let body;

      try{
        body=await request.json();
      }catch(e){
        return Response.json(
          {error:'Invalid JSON'},
          {status:400}
        );
      }

      const apiKey=String(
        body?.apiKey || ''
      ).trim();

      if(!apiKey){
        return Response.json(
          {error:'FFScouter-registered Torn API key required'},
          {status:400}
        );
      }

      const validation=
        await validateTrackerApiKey(apiKey);

      if(!validation.ok){
        return Response.json(
          {
            success:false,
            error:validation.error
          },
          {status:validation.status || 400}
        );
      }

      if(
        client.tornUserId &&
        String(client.tornUserId)!==
          String(validation.tornUserId)
      ){
        return Response.json(
          {
            success:false,
            error:'Tracker account is already bound to another Torn user'
          },
          {status:409}
        );
      }

      const duplicateClient=await env.DB
        .prepare(`
          SELECT client_id
          FROM clients
          WHERE torn_user_id=?
            AND active=1
            AND client_id<>?
          LIMIT 1
        `)
        .bind(
          validation.tornUserId,
          client.clientId
        )
        .first();

      if(duplicateClient){
        return Response.json(
          {
            success:false,
            error:'This Torn account is already registered to an active tracker client'
          },
          {status:409}
        );
      }

      const encrypted=
        await encryptApiKey(
          apiKey,
          client.clientId,
          env
        );

      const now=Date.now();

      await env.DB
        .prepare(`
          UPDATE clients
          SET
            api_key_ciphertext=?,
            api_key_iv=?,
            torn_user_id=?,
            torn_name=?,
            own_faction_id=?,
            api_key_validated_at=?
          WHERE client_id=?
        `)
        .bind(
          encrypted.ciphertext,
          encrypted.iv,
          validation.tornUserId,
          validation.tornName,
          validation.ownFactionId,
          now,
          client.clientId
        )
        .run();

      await env.DB
        .prepare(`
          UPDATE watched_factions
          SET
            active=0,
            is_own_faction=0,
            next_poll_at=0
          WHERE client_id=?
            AND is_own_faction=1
        `)
        .bind(client.clientId)
        .run();

      // Previous automatic own-faction watch cleared.

      if(validation.ownFactionId){
        await env.DB
          .prepare(`
            INSERT INTO watched_factions
            (
              client_id,
              faction_id,
              faction_name,
              active,
              created_at,
              next_poll_at,
              is_own_faction
            )
            VALUES (?, ?, NULL, 1, ?, 0, 1)
            ON CONFLICT(client_id,faction_id)
            DO UPDATE SET
              active=1,
              next_poll_at=0,
              is_own_faction=1
          `)
          .bind(
            client.clientId,
            validation.ownFactionId,
            now
          )
          .run();
      }

      if(
        client.ownFactionId &&
        String(client.ownFactionId)!==
          String(validation.ownFactionId || '')
      ){
        await safeReconcileGlobalTarget(
          'faction',
          client.ownFactionId,
          env
        );
      }

      if(validation.ownFactionId){
        await safeEnsureAndReconcileGlobalTarget(
          'faction',
          validation.ownFactionId,
          null,
          env
        );
      }

      await safeReconcileGlobalTargetsForClient(
        client.clientId,
        env
      );

      // Automatically start this client tracker.
      const schedulerId=
        env.TRACKER_SCHEDULER.idFromName(
          client.clientId
        );

      const scheduler=
        env.TRACKER_SCHEDULER.get(
          schedulerId
        );

      const schedulerResult=
        await scheduler.start();

      return Response.json({
        success:true,
        configured:true,
        tornUserId:validation.tornUserId,
        tornName:validation.tornName,
        ownFactionId:validation.ownFactionId,
        ffscouterRegistered:true,
        validatedAt:now,
        schedulerStarted:true,
        schedulerAlreadyRunning:
          schedulerResult.alreadyRunning===true
      });
    }


    if (
      url.pathname === '/client/api-key/test' &&
      request.method === 'GET'
    ) {
      const client=
        await authenticateClient(request,env);

      if(!client){
        return Response.json(
          {error:'Unauthorized'},
          {status:401}
        );
      }

      if(client.role!=='admin'){
        return Response.json(
          {error:'Admin access required'},
          {status:403}
        );
      }

      let apiKey;

      try{
        apiKey=
          await getClientTrackerApiKey(
            client.clientId,
            env
          );
      }catch(e){
        return Response.json(
          {
            success:false,
            configured:false,
            error:'Stored API key unavailable'
          },
          {status:409}
        );
      }

      const validation=
        await validateTrackerApiKey(apiKey);

      apiKey=null;

      if(!validation.ok){
        return Response.json(
          {
            success:false,
            configured:true,
            valid:false,
            error:validation.error
          },
          {status:400}
        );
      }

      return Response.json({
        success:true,
        configured:true,
        valid:true,
        tornUserId:validation.tornUserId,
        tornName:validation.tornName,
        ownFactionId:validation.ownFactionId,
        ffscouterRegistered:
          validation.ffscouterRegistered===true
      });
    }


    if (
      url.pathname === '/client/test-faction-poll' &&
      request.method === 'POST'
    ) {
      const client=
        await authenticateClient(request,env);

      if(!client){
        return Response.json(
          {error:'Unauthorized'},
          {status:401}
        );
      }

      if(client.role!=='admin'){
        return Response.json(
          {error:'Admin access required'},
          {status:403}
        );
      }

      if(!client.apiKeyConfigured){
        return Response.json(
          {error:'API key not configured'},
          {status:409}
        );
      }

      const faction=await env.DB
        .prepare(`
          SELECT
            faction_id,
            faction_name,
            next_poll_at,
            is_own_faction
          FROM watched_factions
          WHERE client_id=?
            AND active=1
            AND is_own_faction=1
          LIMIT 1
        `)
        .bind(client.clientId)
        .first();

      if(!faction){
        return Response.json(
          {error:'Own faction not found'},
          {status:404}
        );
      }

      let runtime=null;

      try{
        const refreshed=
          await refreshClientRuntimeState(
            client,
            env
          );

        runtime={
          my_destination:
            refreshed.destination,
          my_travel_started:
            refreshed.travelStarted,
          my_travel_arrival:
            refreshed.travelArrival
        };
      }catch(e){
        return Response.json(
          {
            success:false,
            stage:'runtime',
            error:e.message
          },
          {status:500}
        );
      }

      try{
        const result=
          await pollClientFaction(
            client,
            faction,
            env,
            runtime
          );

        return Response.json({
          success:true,
          result
        });
      }catch(e){
        return Response.json(
          {
            success:false,
            stage:'faction',
            error:e.message,
            code:e.code || null
          },
          {status:500}
        );
      }
    }


    if (
      url.pathname === '/client/test-bs-refresh' &&
      request.method === 'POST'
    ) {
      const client=
        await authenticateClient(request,env);

      if(!client){
        return Response.json(
          {error:'Unauthorized'},
          {status:401}
        );
      }

      if(client.role!=='admin'){
        return Response.json(
          {error:'Admin access required'},
          {status:403}
        );
      }

      if(!client.apiKeyConfigured){
        return Response.json(
          {error:'API key not configured'},
          {status:409}
        );
      }

      const result=await env.DB
        .prepare(`
          SELECT DISTINCT m.player_id
          FROM client_faction_member_states m
          INNER JOIN watched_factions w
            ON w.client_id=m.client_id
           AND w.faction_id=m.faction_id
          WHERE m.client_id=?
            AND w.active=1
          UNION
          SELECT player_id
          FROM subscriptions
          WHERE client_id=?
            AND active=1
        `)
        .bind(
          client.clientId,
          client.clientId
        )
        .all();

      const playerIds=
        (result?.results || [])
          .map(row=>String(row.player_id))
          .filter(id=>/^\d+$/.test(id));

      try{
        const refresh=
          await refreshClientBsCache(
            client,
            playerIds,
            env
          );

        await syncClientBsCacheToStates(
          client.clientId,
          env
        );

        return Response.json({
          success:true,
          playerCount:playerIds.length,
          batchSize:TRACKER_BS_BATCH_SIZE,
          cacheTtlMs:TRACKER_BS_CACHE_TTL_MS,
          refresh,
          synced:true
        });
      }catch(e){
        return Response.json(
          {
            success:false,
            error:e.message,
            code:e.code || null,
            budget:e.budget || null
          },
          {status:500}
        );
      }
    }


    let useGlobalClientState=
      url.pathname==='/client/state-global';

    if(
      url.pathname==='/client/state' &&
      request.method==='GET'
    ){
      try{
        const poolConfig=
          await getGlobalPoolConfig(env);

        useGlobalClientState=
          poolConfig
            .legacyClientCollectionEnabled===false;
      }catch(error){
        useGlobalClientState=false;
      }
    }

    if (
      useGlobalClientState &&
      request.method === 'GET'
    ) {
      const client=
        await authenticateClient(request,env);

      if(!client){
        return Response.json(
          {error:'Unauthorized'},
          {status:401}
        );
      }

      const runtime=await env.DB
        .prepare(`
          SELECT
            my_destination,
            my_travel_started,
            my_travel_arrival,
            updated_at
          FROM client_runtime_state
          WHERE client_id=?
        `)
        .bind(client.clientId)
        .first();

      const factionResult=await env.DB
        .prepare(`
          SELECT
            w.faction_id,
            COALESCE(
              g.faction_name,
              w.faction_name
            ) AS faction_name
          FROM watched_factions w
          LEFT JOIN global_factions g
            ON g.faction_id=w.faction_id
          WHERE w.client_id=?
            AND w.active=1
          ORDER BY
            w.is_own_faction DESC,
            w.created_at ASC
        `)
        .bind(client.clientId)
        .all();

      const memberResult=await env.DB
        .prepare(`
          SELECT
            m.faction_id,
            m.player_id,
            m.player_name,
            m.status,
            m.raw_status,
            m.destination,
            m.origin,
            m.flight_type,
            m.travel_started,
            m.landed_at,
            b.tbs,
            b.tbs_human,
            m.last_action,
            m.updated_at
          FROM global_faction_members m
          INNER JOIN watched_factions w
            ON w.faction_id=m.faction_id
           AND w.client_id=?
           AND w.active=1
          LEFT JOIN global_bs_cache b
            ON b.player_id=m.player_id
        `)
        .bind(client.clientId)
        .all();

      const individualResult=await env.DB
        .prepare(`
          SELECT
            p.player_id,
            p.player_name,
            p.faction_id,
            p.status,
            p.raw_status,
            p.destination,
            p.origin,
            p.flight_type,
            p.travel_started,
            p.landed_at,
            b.tbs,
            b.tbs_human,
            p.last_action,
            p.updated_at
          FROM global_players p
          INNER JOIN subscriptions s
            ON s.player_id=p.player_id
           AND s.client_id=?
           AND s.active=1
          LEFT JOIN global_bs_cache b
            ON b.player_id=p.player_id
        `)
        .bind(client.clientId)
        .all();

      const globalSchedulerId=
        env.TRACKER_SCHEDULER.idFromName(
          'global-pool'
        );

      const globalScheduler=
        env.TRACKER_SCHEDULER.get(
          globalSchedulerId
        );

      const globalSchedulerStatus=
        await globalScheduler.status();


      const factions={};
      const individuals={};
      const completedGlobalCycleAt=
        globalSchedulerStatus
          ?.lastResult
          ?.finishedAt;

      const fallbackGlobalRunAt=
        globalSchedulerStatus
          ?.lastRunAt;

      let lastScanTime=
        Number.isFinite(
          Number(completedGlobalCycleAt)
        )
          ? Number(completedGlobalCycleAt)
          : Number.isFinite(
              Number(fallbackGlobalRunAt)
            )
            ? Number(fallbackGlobalRunAt)
            : 0;

      let myFactionName=null;

      for(const row of factionResult?.results || []){
        const factionId=String(row.faction_id);

        factions[factionId]={
          name:row.faction_name || null,
          members:{}
        };

        if(
          String(client.ownFactionId || '')===
          factionId
        ){
          myFactionName=
            row.faction_name || null;
        }
      }

      for(const row of memberResult?.results || []){
        const factionId=String(row.faction_id);
        const playerId=String(row.player_id);

        if(!factions[factionId]){
          factions[factionId]={
            name:null,
            members:{}
          };
        }

        const destination=
          row.destination || null;

        const origin=
          row.origin || null;

        const lookupDest=
          destination==='Torn'
            ? origin
            : destination || origin || null;

        const sameDestination=
          !!(
            runtime?.my_destination &&
            destination &&
            destination!=='Torn' &&
            destination===
              runtime.my_destination &&
            playerId!==
              String(client.tornUserId || '')
          );

        factions[factionId].members[playerId]={
          playerId,
          status:row.status || 'idle',
          playerName:
            row.player_name ||
            'User '+playerId,
          destination,
          origin,
          flightType:
            row.flight_type || null,
          lookupDest,
          travelStarted:
            row.travel_started==null
              ? null
              : Number(row.travel_started),
          landedAt:
            row.landed_at==null
              ? null
              : Number(row.landed_at),
          sameDestination,
          tbs:
            row.tbs==null
              ? null
              : Number(row.tbs),
          tbs_human:
            row.tbs_human || null,
          lastAction:
            row.last_action==null
              ? null
              : Number(row.last_action)
        };
      }

      for(const row of individualResult?.results || []){
        const playerId=String(row.player_id);

        const destination=
          row.destination || null;

        const origin=
          row.origin || null;

        const lookupDest=
          destination==='Torn'
            ? origin
            : destination || origin || null;

        individuals[playerId]={
          playerId,
          playerName:
            row.player_name ||
            'User '+playerId,
          factionId:
            row.faction_id || null,
          status:
            row.status || 'idle',
          destination,
          origin,
          flightType:
            row.flight_type || null,
          lookupDest,
          travelStarted:
            row.travel_started==null
              ? null
              : Number(row.travel_started),
          landedAt:
            row.landed_at==null
              ? null
              : Number(row.landed_at),
          tbs:
            row.tbs==null
              ? null
              : Number(row.tbs),
          tbs_human:
            row.tbs_human || null,
          lastAction:
            row.last_action==null
              ? null
              : Number(row.last_action)
        };
      }

      return Response.json({
        stateSource:'global',
        updated:new Date().toISOString(),
        myUserID:client.tornUserId,
        myFactionID:client.ownFactionId,
        myFactionName,
        myDestination:
          runtime?.my_destination || null,
        myTravelStarted:
          runtime?.my_travel_started==null
            ? null
            : Number(runtime.my_travel_started),
        myTravelArrival:
          runtime?.my_travel_arrival==null
            ? null
            : Number(runtime.my_travel_arrival),
        lastScanTime,
        factions,
        individuals
      });
    }

    if (
      url.pathname === '/client/state' &&
      request.method === 'GET'
    ) {
      const client=
        await authenticateClient(request,env);

      if(!client){
        return Response.json(
          {error:'Unauthorized'},
          {status:401}
        );
      }

      const runtime=await env.DB
        .prepare(`
          SELECT
            my_destination,
            my_travel_started,
            my_travel_arrival,
            updated_at
          FROM client_runtime_state
          WHERE client_id=?
        `)
        .bind(client.clientId)
        .first();

      const factionResult=await env.DB
        .prepare(`
          SELECT
            w.faction_id,
            COALESCE(
              s.faction_name,
              w.faction_name
            ) AS faction_name,
            s.updated_at
          FROM watched_factions w
          LEFT JOIN client_faction_states s
            ON s.client_id=w.client_id
           AND s.faction_id=w.faction_id
          WHERE w.client_id=?
            AND w.active=1
          ORDER BY
            w.is_own_faction DESC,
            w.created_at ASC
        `)
        .bind(client.clientId)
        .all();

      const memberResult=await env.DB
        .prepare(`
          SELECT
            m.faction_id,
            m.player_id,
            m.player_name,
            m.status,
            m.raw_status,
            m.destination,
            m.origin,
            m.flight_type,
            m.travel_started,
            m.landed_at,
            m.tbs,
            m.tbs_human,
            m.last_action,
            m.updated_at
          FROM client_faction_member_states m
          INNER JOIN watched_factions w
            ON w.client_id=m.client_id
           AND w.faction_id=m.faction_id
          WHERE m.client_id=?
            AND w.active=1
        `)
        .bind(client.clientId)
        .all();

      const individualResult=await env.DB
        .prepare(`
          SELECT
            p.player_id,
            p.player_name,
            p.faction_id,
            p.status,
            p.raw_status,
            p.destination,
            p.origin,
            p.flight_type,
            p.travel_started,
            p.landed_at,
            p.tbs,
            p.tbs_human,
            p.last_action,
            p.updated_at
          FROM client_player_states p
          INNER JOIN subscriptions s
            ON s.client_id=p.client_id
           AND s.player_id=p.player_id
          WHERE p.client_id=?
            AND s.active=1
        `)
        .bind(client.clientId)
        .all();

      const factions={};
      const individuals={};
      let lastScanTime=0;
      let myFactionName=null;

      for(const row of factionResult?.results || []){
        const factionId=String(row.faction_id);

        factions[factionId]={
          name:row.faction_name || null,
          members:{}
        };

        if(
          row.updated_at &&
          Number(row.updated_at)>lastScanTime
        ){
          lastScanTime=Number(row.updated_at);
        }

        if(
          String(client.ownFactionId || '')===
          factionId
        ){
          myFactionName=
            row.faction_name || null;
        }
      }

      for(const row of memberResult?.results || []){
        const factionId=String(row.faction_id);
        const playerId=String(row.player_id);

        if(!factions[factionId]){
          factions[factionId]={
            name:null,
            members:{}
          };
        }

        const destination=
          row.destination || null;

        const origin=
          row.origin || null;

        const lookupDest=
          destination==='Torn'
            ? origin
            : destination || origin || null;

        const sameDestination=
          !!(
            runtime?.my_destination &&
            destination &&
            destination!=='Torn' &&
            destination===
              runtime.my_destination &&
            playerId!==
              String(client.tornUserId || '')
          );

        factions[factionId].members[playerId]={
          playerId,
          status:row.status || 'idle',
          playerName:
            row.player_name ||
            'User '+playerId,
          destination,
          origin,
          flightType:
            row.flight_type || null,
          lookupDest,
          travelStarted:
            row.travel_started==null
              ? null
              : Number(row.travel_started),
          landedAt:
            row.landed_at==null
              ? null
              : Number(row.landed_at),
          sameDestination,
          tbs:
            row.tbs==null
              ? null
              : Number(row.tbs),
          tbs_human:
            row.tbs_human || null,
          lastAction:
            row.last_action==null
              ? null
              : Number(row.last_action)
        };

        if(
          row.updated_at &&
          Number(row.updated_at)>lastScanTime
        ){
          lastScanTime=Number(row.updated_at);
        }
      }

      for(const row of individualResult?.results || []){
        const playerId=String(row.player_id);

        const destination=
          row.destination || null;

        const origin=
          row.origin || null;

        const lookupDest=
          destination==='Torn'
            ? origin
            : destination || origin || null;

        individuals[playerId]={
          playerId,
          playerName:
            row.player_name ||
            'User '+playerId,
          factionId:
            row.faction_id || null,
          status:
            row.status || 'idle',
          destination,
          origin,
          flightType:
            row.flight_type || null,
          lookupDest,
          travelStarted:
            row.travel_started==null
              ? null
              : Number(row.travel_started),
          landedAt:
            row.landed_at==null
              ? null
              : Number(row.landed_at),
          tbs:
            row.tbs==null
              ? null
              : Number(row.tbs),
          tbs_human:
            row.tbs_human || null,
          lastAction:
            row.last_action==null
              ? null
              : Number(row.last_action)
        };

        if(
          row.updated_at &&
          Number(row.updated_at)>lastScanTime
        ){
          lastScanTime=Number(row.updated_at);
        }
      }

      return Response.json({
        stateSource:'legacy',
        updated:new Date().toISOString(),
        myUserID:client.tornUserId,
        myFactionID:client.ownFactionId,
        myFactionName,
        myDestination:
          runtime?.my_destination || null,
        myTravelStarted:
          runtime?.my_travel_started==null
            ? null
            : Number(runtime.my_travel_started),
        myTravelArrival:
          runtime?.my_travel_arrival==null
            ? null
            : Number(runtime.my_travel_arrival),
        lastScanTime,
        factions,
        individuals
      });
    }


    if (
      url.pathname === '/client/scheduler/status' &&
      request.method === 'GET'
    ) {
      const client=
        await authenticateClient(request,env);

      if(!client){
        return Response.json(
          {error:'Unauthorized'},
          {status:401}
        );
      }

      const id=
        env.TRACKER_SCHEDULER.idFromName(
          client.clientId
        );

      const scheduler=
        env.TRACKER_SCHEDULER.get(id);

      const status=
        await scheduler.status();

      return Response.json({
        success:true,
        clientId:client.clientId,
        ...status
      });
    }

    if (
      url.pathname === '/client/scheduler/start' &&
      request.method === 'POST'
    ) {
      const client=
        await authenticateClient(request,env);

      if(!client){
        return Response.json(
          {error:'Unauthorized'},
          {status:401}
        );
      }

      if(!client.apiKeyConfigured){
        return Response.json(
          {error:'Tracker API key is not configured'},
          {status:409}
        );
      }

      const id=
        env.TRACKER_SCHEDULER.idFromName(
          client.clientId
        );

      const scheduler=
        env.TRACKER_SCHEDULER.get(id);

      const result=
        await scheduler.start();

      return Response.json({
        success:true,
        clientId:client.clientId,
        ...result
      });
    }

    if (
      url.pathname === '/client/scheduler/stop' &&
      request.method === 'POST'
    ) {
      const client=
        await authenticateClient(request,env);

      if(!client){
        return Response.json(
          {error:'Unauthorized'},
          {status:401}
        );
      }

      const id=
        env.TRACKER_SCHEDULER.idFromName(
          client.clientId
        );

      const scheduler=
        env.TRACKER_SCHEDULER.get(id);

      const result=
        await scheduler.stop();

      return Response.json({
        success:true,
        clientId:client.clientId,
        ...result
      });
    }


    if (
      url.pathname === '/client/test-individual-poll' &&
      request.method === 'POST'
    ) {
      const client=await authenticateClient(request,env);

      if(!client){
        return Response.json({error:'Unauthorized'},{status:401});
      }

      if(client.role!=='admin'){
        return Response.json(
          {error:'Admin access required'},
          {status:403}
        );
      }

      const subscription=await env.DB
        .prepare(`
          SELECT player_id,next_poll_at
          FROM subscriptions
          WHERE client_id=?
            AND active=1
          ORDER BY created_at ASC
          LIMIT 1
        `)
        .bind(client.clientId)
        .first();

      if(!subscription){
        return Response.json(
          {error:'No tracked individual configured'},
          {status:404}
        );
      }

      const runtime=await env.DB
        .prepare(`
          SELECT
            my_destination,
            my_travel_started,
            my_travel_arrival
          FROM client_runtime_state
          WHERE client_id=?
        `)
        .bind(client.clientId)
        .first();

      try{
        const result=await pollClientIndividual(
          client,
          subscription,
          env,
          runtime
        );

        await refreshClientBsCache(
          client,
          [subscription.player_id],
          env
        );

        await syncClientBsCacheToStates(
          client.clientId,
          env
        );

        return Response.json({
          success:true,
          result
        });
      }catch(e){
        return Response.json(
          {
            success:false,
            error:e.message,
            code:e.code || null,
            budget:e.budget || null
          },
          {status:500}
        );
      }
    }

    if (
      url.pathname === '/client/faction-application' &&
      request.method === 'GET'
    ) {
      const client=await authenticateClient(request,env);

      if(!client){
        return Response.json(
          {error:'Unauthorized'},
          {status:401}
        );
      }

      const factionId=
        normalizeTrackerFactionId(client.ownFactionId);

      if(!factionId){
        return Response.json({
          success:true,
          currentFaction:null,
          registered:false,
          canApply:false,
          reason:'no-current-faction',
          application:null,
          messages:[]
        });
      }

      const factionName=
        await resolveCurrentFactionName(
          client,
          factionId,
          env
        );

      const registered=
        await env.DB
          .prepare(`
            SELECT
              faction_id,
              faction_name,
              active
            FROM registered_factions
            WHERE faction_id=?
            LIMIT 1
          `)
          .bind(factionId)
          .first();

      const application=
        await env.DB
          .prepare(`
            SELECT
              application_id,
              faction_id,
              faction_name,
              applicant_client_id,
              applicant_torn_user_id,
              applicant_torn_name,
              status,
              created_at,
              updated_at,
              resolved_at,
              resolved_by_client_id
            FROM faction_applications
            WHERE faction_id=?
            ORDER BY
              CASE
                WHEN status IN ('pending','needs_info') THEN 0
                ELSE 1
              END,
              created_at DESC
            LIMIT 1
          `)
          .bind(factionId)
          .first();

      const isApplicant=
        !!application &&
        String(application.applicant_client_id || '')===
          String(client.clientId);

      let messages=[];

      if(application && isApplicant){
        const messageResult=
          await env.DB
            .prepare(`
              SELECT
                message_id,
                sender_client_id,
                sender_type,
                message,
                created_at
              FROM faction_application_messages
              WHERE application_id=?
              ORDER BY created_at ASC
            `)
            .bind(application.application_id)
            .all();

        messages=(messageResult?.results || []).map(row=>({
          messageId:row.message_id,
          senderType:row.sender_type,
          message:row.message,
          createdAt:Number(row.created_at)
        }));
      }

      const registeredActive=
        !!registered &&
        Number(registered.active)===1;

      const openApplication=
        !!application &&
        (
          application.status==='pending' ||
          application.status==='needs_info'
        );

      return Response.json({
        success:true,
        currentFaction:{
          factionId,
          factionName:
            factionName ||
            registered?.faction_name ||
            null
        },
        registered:registeredActive,
        canApply:
          !registeredActive &&
          !openApplication,
        application:application
          ? {
              applicationId:application.application_id,
              factionId:application.faction_id,
              factionName:
                application.faction_name ||
                factionName ||
                null,
              status:application.status,
              isApplicant,
              applicant:isApplicant
                ? {
                    tornUserId:
                      application.applicant_torn_user_id ||
                      null,
                    tornName:
                      application.applicant_torn_name ||
                      null
                  }
                : {
                    tornUserId:null,
                    tornName:
                      application.applicant_torn_name ||
                      null
                  },
              createdAt:Number(application.created_at),
              updatedAt:Number(application.updated_at),
              resolvedAt:
                application.resolved_at==null
                  ? null
                  : Number(application.resolved_at)
            }
          : null,
        messages
      });
    }

    if (
      url.pathname === '/client/faction-application' &&
      request.method === 'POST'
    ) {
      const client=await authenticateClient(request,env);

      if(!client){
        return Response.json(
          {error:'Unauthorized'},
          {status:401}
        );
      }

      let body={};

      try{
        body=await request.json();
      }catch(e){
        body={};
      }

      const initialMessage=
        String(body?.message || '').trim();

      if(initialMessage.length>4000){
        return Response.json(
          {error:'Application message is too long'},
          {status:400}
        );
      }

      let runtime;

      try{
        runtime=
          await refreshClientRuntimeState(
            client,
            env
          );
      }catch(error){
        return Response.json(
          {
            success:false,
            error:
              'Unable to confirm your current Torn faction. Please try again.'
          },
          {status:502}
        );
      }

      if(runtime.currentFactionKnown!==true){
        return Response.json(
          {
            success:false,
            error:
              'Your current Torn faction could not be confirmed.'
          },
          {status:409}
        );
      }

      const factionId=
        normalizeTrackerFactionId(
          runtime.currentFactionId
        );

      if(!factionId){
        return Response.json(
          {
            success:false,
            error:
              'You must currently belong to a Torn faction to submit a faction application.'
          },
          {status:409}
        );
      }

      const registered=
        await env.DB
          .prepare(`
            SELECT
              faction_id,
              faction_name,
              active
            FROM registered_factions
            WHERE faction_id=?
            LIMIT 1
          `)
          .bind(factionId)
          .first();

      if(registered && Number(registered.active)===1){
        return Response.json({
          success:true,
          alreadyRegistered:true,
          factionId,
          factionName:
            registered.faction_name ||
            null
        });
      }

      const existing=
        await env.DB
          .prepare(`
            SELECT
              application_id,
              faction_id,
              faction_name,
              applicant_client_id,
              applicant_torn_user_id,
              applicant_torn_name,
              status,
              created_at,
              updated_at
            FROM faction_applications
            WHERE faction_id=?
              AND status IN ('pending','needs_info')
            ORDER BY created_at DESC
            LIMIT 1
          `)
          .bind(factionId)
          .first();

      if(existing){
        return Response.json({
          success:true,
          alreadyPending:true,
          applicationId:
            existing.application_id,
          factionId,
          factionName:
            existing.faction_name ||
            null,
          status:existing.status,
          isApplicant:
            String(existing.applicant_client_id || '')===
            String(client.clientId),
          applicantName:
            existing.applicant_torn_name ||
            null,
          createdAt:
            Number(existing.created_at)
        });
      }

      const factionName=
        await resolveCurrentFactionName(
          client,
          factionId,
          env
        );

      const applicationId=
        crypto.randomUUID();

      const now=Date.now();

      const statements=[
        env.DB
          .prepare(`
            INSERT INTO faction_applications
            (
              application_id,
              faction_id,
              faction_name,
              applicant_client_id,
              applicant_torn_user_id,
              applicant_torn_name,
              status,
              created_at,
              updated_at,
              resolved_at,
              resolved_by_client_id
            )
            VALUES (
              ?, ?, ?, ?, ?, ?,
              'pending',
              ?, ?, NULL, NULL
            )
          `)
          .bind(
            applicationId,
            factionId,
            factionName,
            client.clientId,
            client.tornUserId || null,
            client.tornName || null,
            now,
            now
          )
      ];

      if(initialMessage){
        statements.push(
          env.DB
            .prepare(`
              INSERT INTO faction_application_messages
              (
                message_id,
                application_id,
                sender_client_id,
                sender_type,
                message,
                created_at
              )
              VALUES (?, ?, ?, 'user', ?, ?)
            `)
            .bind(
              crypto.randomUUID(),
              applicationId,
              client.clientId,
              initialMessage,
              now
            )
        );
      }

      try{
        await env.DB.batch(statements);
      }catch(error){
        if(
          /unique|constraint/i.test(
            String(error?.message || error)
          )
        ){
          const competing=
            await env.DB
              .prepare(`
                SELECT
                  application_id,
                  status,
                  applicant_client_id,
                  applicant_torn_name,
                  created_at
                FROM faction_applications
                WHERE faction_id=?
                  AND status IN ('pending','needs_info')
                ORDER BY created_at DESC
                LIMIT 1
              `)
              .bind(factionId)
              .first();

          if(competing){
            return Response.json({
              success:true,
              alreadyPending:true,
              applicationId:
                competing.application_id,
              factionId,
              factionName,
              status:competing.status,
              isApplicant:
                String(competing.applicant_client_id || '')===
                String(client.clientId),
              applicantName:
                competing.applicant_torn_name ||
                null,
              createdAt:
                Number(competing.created_at)
            });
          }
        }

        throw error;
      }

      return Response.json({
        success:true,
        created:true,
        applicationId,
        factionId,
        factionName,
        status:'pending',
        createdAt:now
      });
    }

    if (
      url.pathname === '/client/faction-application/message' &&
      request.method === 'POST'
    ) {
      const client=await authenticateClient(request,env);

      if(!client){
        return Response.json(
          {error:'Unauthorized'},
          {status:401}
        );
      }

      let body;

      try{
        body=await request.json();
      }catch(e){
        return Response.json(
          {error:'Invalid JSON'},
          {status:400}
        );
      }

      const applicationId=
        String(body?.applicationId || '').trim();

      const message=
        String(body?.message || '').trim();

      if(!applicationId){
        return Response.json(
          {error:'Missing applicationId'},
          {status:400}
        );
      }

      if(!message){
        return Response.json(
          {error:'Message is required'},
          {status:400}
        );
      }

      if(message.length>4000){
        return Response.json(
          {error:'Message is too long'},
          {status:400}
        );
      }

      const application=
        await env.DB
          .prepare(`
            SELECT
              application_id,
              applicant_client_id,
              status
            FROM faction_applications
            WHERE application_id=?
            LIMIT 1
          `)
          .bind(applicationId)
          .first();

      if(!application){
        return Response.json(
          {error:'Faction application not found'},
          {status:404}
        );
      }

      if(
        String(application.applicant_client_id || '')!==
        String(client.clientId)
      ){
        return Response.json(
          {error:'Only the applicant can reply to this application'},
          {status:403}
        );
      }

      if(
        application.status!=='pending' &&
        application.status!=='needs_info'
      ){
        return Response.json(
          {
            error:
              'This faction application is no longer open for replies'
          },
          {status:409}
        );
      }

      const now=Date.now();

      await env.DB.batch([
        env.DB
          .prepare(`
            INSERT INTO faction_application_messages
            (
              message_id,
              application_id,
              sender_client_id,
              sender_type,
              message,
              created_at
            )
            VALUES (?, ?, ?, 'user', ?, ?)
          `)
          .bind(
            crypto.randomUUID(),
            applicationId,
            client.clientId,
            message,
            now
          ),

        env.DB
          .prepare(`
            UPDATE faction_applications
            SET
              status=
                CASE
                  WHEN status='needs_info'
                    THEN 'pending'
                  ELSE status
                END,
              updated_at=?
            WHERE application_id=?
          `)
          .bind(
            now,
            applicationId
          )
      ]);

      return Response.json({
        success:true,
        messageAdded:true,
        applicationId,
        status:'pending',
        createdAt:now
      });
    }



    if (
      url.pathname === '/client/access/status' &&
      request.method === 'GET'
    ) {
      const client=
        await authenticateClient(
          request,
          env,
          {allowPending:true}
        );

      if(!client){
        return Response.json(
          {error:'Unauthorized'},
          {status:401}
        );
      }

      const access=
        await getClientAccessSnapshot(
          client,
          env
        );

      return Response.json({
        success:true,
        tornUserId:
          client.tornUserId || null,
        tornName:
          client.tornName || null,
        ...access
      });
    }


    if (
      url.pathname === '/client/access/request-personal' &&
      request.method === 'POST'
    ) {
      const client=
        await authenticateClient(
          request,
          env
        );

      if(!client){
        return Response.json(
          {error:'Unauthorized'},
          {status:401}
        );
      }

      if(
        client.accessType!=='faction' ||
        (
          client.accessStatus!=='grace' &&
          client.accessStatus!=='suspended'
        )
      ){
        return Response.json(
          {
            error:
              'Personal access can only be requested while faction access is in GRACE or SUSPENDED status'
          },
          {status:409}
        );
      }

      const now=Date.now();

      const existingApproval=
        await env.DB
          .prepare(`
            SELECT code_hash
            FROM personal_access_codes
            WHERE target_client_id=?
              AND active=1
              AND (
                expires_at IS NULL OR
                expires_at>?
              )
            LIMIT 1
          `)
          .bind(
            client.clientId,
            now
          )
          .first();

      if(existingApproval){
        return Response.json({
          success:true,
          alreadyApproved:true,
          personalAccessReady:true
        });
      }

      const existingRequest=
        await env.DB
          .prepare(`
            SELECT
              request_id,
              requested_at
            FROM access_requests
            WHERE client_id=?
              AND status='pending'
            LIMIT 1
          `)
          .bind(client.clientId)
          .first();

      if(existingRequest){
        return Response.json({
          success:true,
          alreadyPending:true,
          requestId:
            existingRequest.request_id,
          requestedAt:
            Number(
              existingRequest.requested_at
            )
        });
      }

      const requestId=
        crypto.randomUUID();

      await env.DB
        .prepare(`
          INSERT INTO access_requests
          (
            request_id,
            client_id,
            torn_user_id,
            request_type,
            status,
            requested_access_status,
            requested_faction_id,
            requested_at
          )
          VALUES (
            ?, ?, ?,
            'personal',
            'pending',
            ?, ?, ?
          )
        `)
        .bind(
          requestId,
          client.clientId,
          client.tornUserId || null,
          client.accessStatus,
          client.registeredFactionId ||
            null,
          now
        )
        .run();

      return Response.json({
        success:true,
        requested:true,
        requestId,
        requestedAt:now,
        status:'pending'
      });
    }


    if (
      url.pathname === '/client/access/activate-approved' &&
      request.method === 'POST'
    ) {
      const client=
        await authenticateClient(
          request,
          env,
          {allowPending:true}
        );

      if(!client){
        return Response.json(
          {error:'Unauthorized'},
          {status:401}
        );
      }

      const now=Date.now();

      const codeRow=
        await env.DB
          .prepare(`
            SELECT
              code_hash,
              target_client_id,
              target_torn_user_id,
              active,
              created_by_client_id,
              created_at,
              expires_at,
              access_request_id
            FROM personal_access_codes
            WHERE target_client_id=?
              AND active=1
              AND (
                expires_at IS NULL OR
                expires_at>?
              )
            ORDER BY created_at DESC
            LIMIT 1
          `)
          .bind(
            client.clientId,
            now
          )
          .first();

      if(!codeRow){
        return Response.json(
          {
            error:
              'No approved personal access is waiting for this account'
          },
          {status:404}
        );
      }

      try{
        const result=
          await activateClientPersonalAccess(
            client,
            codeRow,
            env
          );

        return Response.json({
          success:true,
          ...result
        });
      }catch(error){
        return Response.json(
          {
            success:false,
            error:String(
              error?.message || error
            )
          },
          {status:400}
        );
      }
    }


    if (
      url.pathname === '/client/access/activate-code' &&
      request.method === 'POST'
    ) {
      const client=
        await authenticateClient(
          request,
          env
        );

      if(!client){
        return Response.json(
          {error:'Unauthorized'},
          {status:401}
        );
      }

      let body;

      try{
        body=await request.json();
      }catch(e){
        return Response.json(
          {error:'Invalid JSON'},
          {status:400}
        );
      }

      const accessCode=String(
        body?.accessCode || ''
      )
        .trim()
        .toUpperCase();

      if(!accessCode){
        return Response.json(
          {
            error:
              'Personal Access Code required'
          },
          {status:400}
        );
      }

      const codeHash=
        await sha256Hex(accessCode);

      const codeRow=
        await env.DB
          .prepare(`
            SELECT
              code_hash,
              target_client_id,
              target_torn_user_id,
              active,
              created_by_client_id,
              created_at,
              expires_at,
              access_request_id
            FROM personal_access_codes
            WHERE code_hash=?
              AND active=1
            LIMIT 1
          `)
          .bind(codeHash)
          .first();

      if(!codeRow){
        return Response.json(
          {
            error:
              'Invalid or already-used Personal Access Code'
          },
          {status:403}
        );
      }

      try{
        const result=
          await activateClientPersonalAccess(
            client,
            codeRow,
            env
          );

        return Response.json({
          success:true,
          ...result
        });
      }catch(error){
        return Response.json(
          {
            success:false,
            error:String(
              error?.message || error
            )
          },
          {status:403}
        );
      }
    }


    if (
      url.pathname === '/client/ping' &&
      request.method === 'GET'
    ) {
      const client =
        await authenticateClient(request, env);

      if (!client) {
        return Response.json(
          { error: 'Unauthorized' },
          { status: 401 }
        );
      }

      return Response.json({
        success: true,
        authenticated: true,
        clientId: client.clientId,
        label: client.label
      });
    }


    if (
      url.pathname === '/client/factions' &&
      request.method === 'POST'
    ) {
      const client=
        await authenticateClient(request,env);

      if(!client){
        return Response.json(
          {error:'Unauthorized'},
          {status:401}
        );
      }

      if(!client.apiKeyConfigured){
        return Response.json(
          {error:'FFScouter-registered Torn API key must be configured first'},
          {status:409}
        );
      }

      let body;

      try{
        body=await request.json();
      }catch(e){
        return Response.json(
          {error:'Invalid JSON'},
          {status:400}
        );
      }

      const factionId=String(
        body?.factionId || ''
      ).trim();

      if(!/^\d+$/.test(factionId)){
        return Response.json(
          {error:'Valid Torn faction ID required'},
          {status:400}
        );
      }

      const factionName=
        body?.factionName==null
          ? null
          : String(body.factionName)
              .trim()
              .slice(0,100);

      const isOwn=
        String(client.ownFactionId || '')===factionId;

      const existing=await env.DB
        .prepare(`
          SELECT
            active,
            is_own_faction
          FROM watched_factions
          WHERE client_id=?
            AND faction_id=?
        `)
        .bind(
          client.clientId,
          factionId
        )
        .first();

      if(!isOwn && (!existing || Number(existing.active)!==1)){
        const combined=
          await getClientCombinedTrackerCount(
            client.clientId,
            env
          );

        if(combined.total>=client.maxCombinedTrackers){
          return Response.json(
            {
              error:
                `Maximum of ${client.maxCombinedTrackers} combined trackers reached`,
              watchedFactions:combined.watchedFactions,
              trackedIndividuals:combined.trackedIndividuals,
              total:combined.total
            },
            {status:409}
          );
        }

        const countRow=await env.DB
          .prepare(`
            SELECT COUNT(*) AS count
            FROM watched_factions
            WHERE client_id=?
              AND active=1
              AND is_own_faction=0
          `)
          .bind(client.clientId)
          .first();

        const currentCount=
          Number(countRow?.count || 0);

        if(currentCount>=client.maxWatchedFactions){
          return Response.json(
            {
              error:
                `Maximum of ${client.maxWatchedFactions} watched factions reached`
            },
            {status:409}
          );
        }
      }

      const now=Date.now();

      await env.DB
        .prepare(`
          INSERT INTO watched_factions
          (
            client_id,
            faction_id,
            faction_name,
            active,
            created_at,
            next_poll_at,
            is_own_faction
          )
          VALUES (?, ?, ?, 1, ?, 0, ?)
          ON CONFLICT(client_id,faction_id)
          DO UPDATE SET
            faction_name=
              COALESCE(excluded.faction_name,watched_factions.faction_name),
            active=1,
            next_poll_at=0,
            is_own_faction=excluded.is_own_faction
        `)
        .bind(
          client.clientId,
          factionId,
          factionName,
          now,
          isOwn ? 1 : 0
        )
        .run();

      await safeEnsureAndReconcileGlobalTarget(
        'faction',
        factionId,
        factionName,
        env
      );

      return Response.json({
        success:true,
        factionId,
        factionName,
        watching:true,
        isOwnFaction:isOwn
      });
    }

    if (
      url.pathname === '/client/factions' &&
      request.method === 'GET'
    ) {
      const client=
        await authenticateClient(request,env);

      if(!client){
        return Response.json(
          {error:'Unauthorized'},
          {status:401}
        );
      }

      const result=await env.DB
        .prepare(`
          SELECT
            faction_id,
            faction_name,
            created_at,
            next_poll_at,
            is_own_faction
          FROM watched_factions
          WHERE client_id=?
            AND active=1
          ORDER BY
            is_own_faction DESC,
            created_at DESC
        `)
        .bind(client.clientId)
        .all();

      return Response.json({
        success:true,
        maxWatchedFactions:
          client.maxWatchedFactions,
        factions:
          result?.results || []
      });
    }

    const factionWatchMatch=
      url.pathname.match(
        /^\/client\/factions\/(\d+)$/
      );

    if (
      factionWatchMatch &&
      request.method === 'DELETE'
    ) {
      const client=
        await authenticateClient(request,env);

      if(!client){
        return Response.json(
          {error:'Unauthorized'},
          {status:401}
        );
      }

      const factionId=
        factionWatchMatch[1];

      if(
        String(client.ownFactionId || '')===
        factionId
      ){
        return Response.json(
          {
            error:
              'Your own faction is automatically watched and cannot be removed'
          },
          {status:409}
        );
      }

      await env.DB
        .prepare(`
          UPDATE watched_factions
          SET active=0
          WHERE client_id=?
            AND faction_id=?
            AND is_own_faction=0
        `)
        .bind(
          client.clientId,
          factionId
        )
        .run();

      await safeReconcileGlobalTarget(
        'faction',
        factionId,
        env
      );

      return Response.json({
        success:true,
        factionId,
        watching:false
      });
    }


    if (
      url.pathname === '/client/subscriptions' &&
      request.method === 'POST'
    ) {
      const client =
        await authenticateClient(request, env);

      if (!client) {
        return Response.json(
          { error: 'Unauthorized' },
          { status: 401 }
        );
      }

      let body;

      try {
        body = await request.json();
      } catch (e) {
        return Response.json(
          { error: 'Invalid JSON' },
          { status: 400 }
        );
      }

      const playerId = String(
        body?.playerId || ''
      ).trim();

      if (!/^\d+$/.test(playerId)) {
        return Response.json(
          { error: 'Valid Torn player ID required' },
          { status: 400 }
        );
      }

      const countRow = await env.DB
        .prepare(`
          SELECT COUNT(*) AS count
          FROM subscriptions
          WHERE client_id = ?
            AND active = 1
        `)
        .bind(client.clientId)
        .first();

      const currentCount =
        Number(countRow?.count || 0);

      const existing = await env.DB
        .prepare(`
          SELECT active
          FROM subscriptions
          WHERE client_id = ?
            AND player_id = ?
        `)
        .bind(client.clientId, playerId)
        .first();

      if(!existing || Number(existing.active)!==1){
        const combined=
          await getClientCombinedTrackerCount(
            client.clientId,
            env
          );

        if(combined.total>=client.maxCombinedTrackers){
          return Response.json(
            {
              error:
                `Maximum of ${client.maxCombinedTrackers} combined trackers reached`,
              watchedFactions:combined.watchedFactions,
              trackedIndividuals:combined.trackedIndividuals,
              total:combined.total
            },
            {status:409}
          );
        }
      }

      if (
        (!existing || Number(existing.active) !== 1) &&
        currentCount >= client.maxTrackedIndividuals
      ) {
        return Response.json(
          {
            error:
              `Maximum of ${client.maxTrackedIndividuals} tracked individuals reached`
          },
          { status: 409 }
        );
      }

      await env.DB
        .prepare(`
          INSERT INTO subscriptions
          (
            client_id,
            player_id,
            active,
            created_at,
            next_poll_at
          )
          VALUES (?, ?, 1, ?, 0)
          ON CONFLICT(client_id, player_id)
          DO UPDATE SET
            active = 1,
            next_poll_at = 0
        `)
        .bind(
          client.clientId,
          playerId,
          Date.now()
        )
        .run();

      await safeEnsureAndReconcileGlobalTarget(
        'player',
        playerId,
        null,
        env
      );

      let initialPlayer=null;
      let initialScanError=null;

      try{
        const runtime=await env.DB
          .prepare(`
            SELECT
              my_destination,
              my_travel_started,
              my_travel_arrival
            FROM client_runtime_state
            WHERE client_id=?
          `)
          .bind(client.clientId)
          .first();

        await pollClientIndividual(
          client,
          {player_id:playerId},
          env,
          runtime
        );

        await refreshClientBsCache(
          client,
          [playerId],
          env
        );

        await syncClientBsCacheToStates(
          client.clientId,
          env
        );

        initialPlayer=await env.DB
          .prepare(`
            SELECT
              player_id,
              player_name,
              faction_id,
              status,
              raw_status,
              destination,
              origin,
              flight_type,
              travel_started,
              landed_at,
              tbs,
              tbs_human,
              last_action,
              updated_at
            FROM client_player_states
            WHERE client_id=?
              AND player_id=?
          `)
          .bind(
            client.clientId,
            playerId
          )
          .first();
      }catch(e){
        initialScanError=trackerSafeError(e);
      }

      return Response.json({
        success:true,
        playerId,
        tracking:true,
        initialized:!!initialPlayer,
        player:initialPlayer || null,
        initialScanError
      });
    }


    if (
      url.pathname === '/client/subscriptions' &&
      request.method === 'GET'
    ) {
      const client =
        await authenticateClient(request, env);

      if (!client) {
        return Response.json(
          { error: 'Unauthorized' },
          { status: 401 }
        );
      }

      const result = await env.DB
        .prepare(`
          SELECT
            s.player_id,
            s.created_at,
            s.next_poll_at,
            p.player_name,
            p.faction_id,
            p.status,
            p.raw_status,
            p.destination,
            p.origin,
            p.flight_type,
            p.travel_started,
            p.landed_at,
            p.tbs,
            p.tbs_human,
            p.last_action,
            p.updated_at
          FROM subscriptions s
          LEFT JOIN client_player_states p
            ON p.client_id = s.client_id
           AND p.player_id = s.player_id
          WHERE s.client_id = ?
            AND s.active = 1
          ORDER BY s.created_at DESC
        `)
        .bind(client.clientId)
        .all();

      return Response.json({
        success: true,
        subscriptions: result?.results || []
      });
    }


    if (
      url.pathname === '/admin/tracked-ids' &&
      request.method === 'GET'
    ) {
      const suppliedSecret =
        request.headers.get('X-Server-Secret');

      if (
        !suppliedSecret ||
        suppliedSecret !== env.SERVER_SECRET
      ) {
        return Response.json(
          { error: 'Unauthorized' },
          { status: 401 }
        );
      }

      const result = await env.DB
        .prepare(`
          SELECT DISTINCT player_id
          FROM subscriptions
          WHERE active = 1
          ORDER BY player_id
        `)
        .all();

      const playerIds = (result?.results || [])
        .map(row => String(row.player_id));

      return Response.json({
        success: true,
        count: playerIds.length,
        playerIds
      });
    }


    if (
      url.pathname === '/admin/player-state' &&
      request.method === 'POST'
    ) {
      const suppliedSecret =
        request.headers.get('X-Server-Secret');

      if (
        !suppliedSecret ||
        suppliedSecret !== env.SERVER_SECRET
      ) {
        return Response.json(
          { error: 'Unauthorized' },
          { status: 401 }
        );
      }

      let body;

      try {
        body = await request.json();
      } catch (e) {
        return Response.json(
          { error: 'Invalid JSON' },
          { status: 400 }
        );
      }

      const playerId = String(
        body?.playerId || ''
      ).trim();

      if (!/^\d+$/.test(playerId)) {
        return Response.json(
          { error: 'Valid Torn player ID required' },
          { status: 400 }
        );
      }

      const playerName =
        body.playerName == null ? null :
        String(body.playerName).slice(0, 100);

      const status =
        body.status == null ? null :
        String(body.status).slice(0, 40);

      const destination =
        body.destination == null ? null :
        String(body.destination).slice(0, 80);

      const origin =
        body.origin == null ? null :
        String(body.origin).slice(0, 80);

      const flightType =
        body.flightType == null ? null :
        String(body.flightType).slice(0, 40);

      const travelStarted =
        body.travelStarted == null
          ? null
          : Number.isFinite(Number(body.travelStarted))
            ? Number(body.travelStarted)
            : null;

      const landedAt =
        body.landedAt == null
          ? null
          : Number.isFinite(Number(body.landedAt))
            ? Number(body.landedAt)
            : null;

      const tbs =
        body.tbs == null
          ? null
          : Number.isFinite(Number(body.tbs))
            ? Number(body.tbs)
            : null;

      const tbsHuman =
        body.tbsHuman == null ? null :
        String(body.tbsHuman).slice(0, 80);

      const lastAction =
        body.lastAction == null
          ? null
          : Number.isFinite(Number(body.lastAction))
            ? Number(body.lastAction)
            : null;

      const now = Date.now();

      await env.DB
        .prepare(`
          INSERT INTO tracked_players
          (
            player_id,
            player_name,
            status,
            destination,
            origin,
            flight_type,
            travel_started,
            landed_at,
            tbs,
            tbs_human,
            last_action,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(player_id)
          DO UPDATE SET
            player_name = excluded.player_name,
            status = excluded.status,
            destination = excluded.destination,
            origin = excluded.origin,
            flight_type = excluded.flight_type,
            travel_started = excluded.travel_started,
            landed_at = excluded.landed_at,
            tbs = excluded.tbs,
            tbs_human = excluded.tbs_human,
            last_action = excluded.last_action,
            updated_at = excluded.updated_at
        `)
        .bind(
          playerId,
          playerName,
          status,
          destination,
          origin,
          flightType,
          travelStarted,
          landedAt,
          tbs,
          tbsHuman,
          lastAction,
          now
        )
        .run();

      return Response.json({
        success: true,
        playerId,
        updatedAt: now
      });
    }


    const subscriptionMatch =
      url.pathname.match(/^\/client\/subscriptions\/(\d+)$/);

    if (
      subscriptionMatch &&
      request.method === 'DELETE'
    ) {
      const client =
        await authenticateClient(request, env);

      if (!client) {
        return Response.json(
          { error: 'Unauthorized' },
          { status: 401 }
        );
      }

      const playerId = subscriptionMatch[1];

      await env.DB
        .prepare(`
          UPDATE subscriptions
          SET active = 0
          WHERE client_id = ?
            AND player_id = ?
        `)
        .bind(
          client.clientId,
          playerId
        )
        .run();

      await safeReconcileGlobalTarget(
        'player',
        playerId,
        env
      );

      return Response.json({
        success: true,
        playerId,
        tracking: false
      });
    }

    return Response.json(
      { error: 'Not found' },
      { status: 404 }
    );
  }
};
