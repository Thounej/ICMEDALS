// seed.js — Illan Cup Medals leaderboard generator
// Run: node seed.js
// Set up .env first — see .env.example

require('dotenv').config();
const fetch = require('node-fetch');
const fs    = require('fs');

const CLUB_ID    = process.env.CLUB_ID    || '56614';
const CF_ACCOUNT = process.env.CF_ACCOUNT_ID;
const CF_TOKEN   = process.env.CF_API_TOKEN;
const CF_KV_NS   = process.env.CF_KV_NAMESPACE_ID;

// ── Auth ──────────────────────────────────────────────────────────────────────
let _liveToken = null, _coreToken = null;

async function getToken(audience) {
  const res = await fetch('https://prod.trackmania.core.nadeo.online/v2/authentication/token/basic', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Basic ${Buffer.from(`${process.env.TM_SERVICE_LOGIN}:${process.env.TM_SERVICE_PASSWORD}`).toString('base64')}`,
      'User-Agent':    'IllanCupMedals-Seed/1.0'
    },
    body: JSON.stringify({ audience })
  });
  if (!res.ok) throw new Error(`Auth ${audience}: ${res.status} ${await res.text()}`);
  return (await res.json()).accessToken;
}

async function liveToken() {
  if (!_liveToken) { _liveToken = await getToken('NadeoLiveServices'); console.log('[auth] NadeoLiveServices OK'); }
  return _liveToken;
}
async function coreToken() {
  if (!_coreToken) {
    await new Promise(r => setTimeout(r, 800)); // gap between auth calls
    try { _coreToken = await getToken('NadeoServices'); console.log('[auth] NadeoServices OK'); }
    catch { console.warn('[auth] NadeoServices 401 — will skip map metadata'); _coreToken = 'SKIP'; }
  }
  return _coreToken === 'SKIP' ? null : _coreToken;
}

async function liveGet(url) {
  const token = await liveToken();
  const res   = await fetch(url, { headers: { 'Authorization': `nadeo_v1 t=${token}`, 'User-Agent': 'IllanCupMedals-Seed/1.0' } });
  if (!res.ok) throw new Error(`Live ${res.status}: ${await res.text()}`);
  return res.json();
}

// ── Strip TM formatting ───────────────────────────────────────────────────────
function strip(str) {
  return (str || '').replace(/\$[0-9a-fA-F]{3}/g,'').replace(/\$[iIoObBuUsSlLnNmMwWpPzZ<>]/g,'').replace(/\$\$/g,'$').trim();
}

// ── Cloudflare KV ─────────────────────────────────────────────────────────────
async function kvPut(key, value) {
  if (!CF_ACCOUNT || !CF_TOKEN || !CF_KV_NS) {
    console.warn('[kv] No CF credentials — saving to local files only');
    return;
  }
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/storage/kv/namespaces/${CF_KV_NS}/values/${encodeURIComponent(key)}`,
    {
      method:  'PUT',
      headers: { 'Authorization': `Bearer ${CF_TOKEN}`, 'Content-Type': 'application/json' },
      body:    typeof value === 'string' ? value : JSON.stringify(value)
    }
  );
  if (!res.ok) throw new Error(`KV put [${key}] failed: ${await res.text()}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n🏆  Illan Cup Medals — Seed Script');
  console.log('─'.repeat(50) + '\n');

  // ── Step 1: Get all campaign IDs from club ─────────────────────────────────
  // Use maxPage from response to paginate correctly
  console.log('[step 1] Fetching club activities...');

  const activities = [];
  let page = 0;
  while (true) {
    const data = await liveGet(
      `https://live-services.trackmania.nadeo.live/api/token/club/${CLUB_ID}/activity?length=250&offset=${page * 250}&active=true`
    );
    if (!data.activityList?.length) break;
    activities.push(...data.activityList);
    console.log(`  Page ${page + 1}: ${data.activityList.length} activities (total: ${activities.length})`);
    // Stop if we've got all pages
    if (data.maxPage !== undefined && page >= data.maxPage - 1) break;
    if (activities.length >= data.itemCount) break;
    page++;
  }
  console.log(`  Total activities: ${activities.length}`);

  // Keep campaigns that are inside a folder (have folderId) — these are the IC maps
  // Also keep top-level campaigns if you want everything
  const campaigns = activities.filter(a => a.activityType === 'campaign');
  const folderCampaigns = campaigns.filter(a => a.folderId); // in a folder
  const allCampaigns    = campaigns; // use all campaigns

  console.log(`  Campaigns total: ${campaigns.length} (${folderCampaigns.length} in folders)\n`);

  // ── Step 2: Get map UIDs from each campaign ────────────────────────────────
  console.log('[step 2] Fetching map UIDs from campaigns...');

  const mapsByCampaign = []; // { campaignId, campaignName, seasonUid, mapUids: [] }
  const allMapUids     = new Set();

  for (const act of allCampaigns) {
    try {
      const data = await liveGet(
        `https://live-services.trackmania.nadeo.live/api/token/club/${CLUB_ID}/campaign/${act.campaignId}`
      );
      const campaignName = strip(data.name || '');
      const seasonUid    = data.campaign?.seasonUid || null;
      const mapUids      = (data.campaign?.playlist || []).map(p => p.mapUid).filter(Boolean);

      mapsByCampaign.push({ campaignId: act.campaignId, campaignName, seasonUid, mapUids });
      for (const uid of mapUids) allMapUids.add(uid);
    } catch (e) {
      console.warn(`  Campaign ${act.campaignId} failed: ${e.message}`);
    }
  }

  const uniqueMapUids = [...allMapUids];
  console.log(`  ${uniqueMapUids.length} unique maps across ${mapsByCampaign.length} campaigns\n`);

  // ── Step 3: Get map info (names, author times, thumbnails) ─────────────────
  // Uses Live API map info endpoint (100 at a time)
  console.log('[step 3] Fetching map info...');

  const mapInfoById = {};

  for (let i = 0; i < uniqueMapUids.length; i += 100) {
    const chunk = uniqueMapUids.slice(i, i + 100);
    try {
      // Core API is confirmed to return correct map data
      // Fields: mapUid, name, author, authorScore, goldScore, silverScore, bronzeScore, thumbnailUrl, fileUrl
      const ct = await coreToken();
      if (ct) {
        const res = await fetch(
          `https://prod.trackmania.core.nadeo.online/maps/?mapUidList=${chunk.join(',')}`,
          { headers: { 'Authorization': `nadeo_v1 t=${ct}`, 'User-Agent': 'IllanCupMedals-Seed/1.0' } }
        );
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data)) for (const m of data) mapInfoById[m.mapUid] = m;
          else console.warn(`  Unexpected map info shape:`, JSON.stringify(data).substring(0, 100));
        } else {
          console.warn(`  Core API ${res.status}: ${await res.text()}`);
        }
      } else {
        // Core API unavailable — try Live API
        const token = await liveToken();
        const res = await fetch(
          `https://live-services.trackmania.nadeo.live/api/token/map?mapUidList=${chunk.join(',')}`,
          { headers: { 'Authorization': `nadeo_v1 t=${token}`, 'User-Agent': 'IllanCupMedals-Seed/1.0' } }
        );
        if (res.ok) {
          const raw = await res.text();
          if (chunk.indexOf(0) === 0) console.log('  Live map info sample:', raw.substring(0, 200));
          const data = JSON.parse(raw);
          const list = Array.isArray(data) ? data : (data.mapList || []);
          for (const m of list) mapInfoById[m.mapUid || m.uid] = m;
        }
      }
    } catch (e) { console.warn(`  Map info chunk ${i}: ${e.message}`); }
    const resolved = Object.keys(mapInfoById).length;
    if (i === 0) console.log(`  First chunk: got ${resolved} map infos`);
    if ((i / 100 + 1) % 5 === 0) console.log(`  ${Math.min(i + 100, uniqueMapUids.length)}/${uniqueMapUids.length} maps — ${resolved} with info`);
  }
  console.log(`  Got info for ${Object.keys(mapInfoById).length} maps`);

  // Build full map list
  const maps = [];
  for (const camp of mapsByCampaign) {
    for (const uid of camp.mapUids) {
      const info = mapInfoById[uid] || {};
      // Field names differ between Live and Core API — handle both
      // Core API confirmed field names: authorScore, goldScore, silverScore, bronzeScore
      // 'author' field is the authorAccountId
      const authorTime = info.authorScore || info.authorTime || null;
      const name       = strip(info.name || uid);
      const authorId   = info.author || info.authorAccountId || null;

      maps.push({
        uid,
        name,
        authorId,
        authorTime,
        campaignName: camp.campaignName,
        campaignId:   camp.campaignId,
        seasonUid:    camp.seasonUid,
        thumbnailUrl: info.thumbnailUrl || null,
        fileUrl:      info.fileUrl      || null,
      });
    }
  }

  // Deduplicate (same map can appear in multiple campaigns)
  const seen = new Set();
  const uniqueMaps = maps.filter(m => { if (seen.has(m.uid)) return false; seen.add(m.uid); return true; });
  console.log(`  ${uniqueMaps.length} unique maps ready`);

  // Resolve author display names via trackmania.io (1.6s each, cached)
  const uniqueAuthorIds = [...new Set(uniqueMaps.map(m => m.authorId).filter(Boolean))];
  const authorNameCache = {};
  console.log(`  Resolving ${uniqueAuthorIds.length} author names...`);
  for (let i = 0; i < uniqueAuthorIds.length; i++) {
    const id = uniqueAuthorIds[i];
    try {
      await new Promise(r => setTimeout(r, 1600));
      const res = await fetch(`https://trackmania.io/api/player/${id}`, {
        headers: { 'User-Agent': 'IllanCupMedals-Seed/1.0 contact@example.com' }
      });
      if (res.ok) {
        const data = await res.json();
        const name = data?.displayname || data?.player?.name || id;
        authorNameCache[id] = name;
      }
    } catch {}
    if ((i + 1) % 10 === 0) process.stdout.write(`\r  Authors: ${i+1}/${uniqueAuthorIds.length}`);
  }
  console.log(`\n  ${Object.keys(authorNameCache).length} author names resolved`);
  for (const map of uniqueMaps) {
    map.authorName = authorNameCache[map.authorId] || map.authorId || 'Unknown';
  }
  console.log('');

  // ── Step 4: Scan leaderboards for AT holders ───────────────────────────────
  // KEY OPTIMIZATION: stop fetching pages once a score exceeds authorTime
  // Leaderboards are sorted best→worst, so first score > AT means we're done

  console.log('[step 4] Scanning leaderboards for AT holders...');
  console.log('  (Stops early per map when scores exceed author time)\n');

  const records = {}; // accountId → { count, maps: [uid] }
  const scannable = uniqueMaps.filter(m => m.seasonUid && m.authorTime);
  console.log(`  ${scannable.length} maps have seasonUid + authorTime (can be scanned)`);
  console.log(`  ${uniqueMaps.length - scannable.length} maps will be skipped\n`);

  let done = 0, totalATRecords = 0;
  const startTime = Date.now();

  for (const map of scannable) {
    let page = 0;
    let pagesScanned = 0;
    let foundOnThisMap = 0;

    while (page < 100) { // max 100 pages = 10,000 entries per map
      try {
        const token = await liveToken();
        const res   = await fetch(
          `https://live-services.trackmania.nadeo.live/api/token/leaderboard/group/${map.seasonUid}/map/${map.uid}/top?length=100&onlyWorld=true&offset=${page * 100}`,
          { headers: { 'Authorization': `nadeo_v1 t=${token}`, 'User-Agent': 'IllanCupMedals-Seed/1.0' } }
        );
        if (!res.ok) break;

        const data    = await res.json();
        const entries = data.tops?.[0]?.top || [];
        if (!entries.length) break; // no more entries

        pagesScanned++;
        let foundWorseScore = false;

        for (const entry of entries) {
          if (!entry.accountId) continue;

          if (entry.score <= map.authorTime) {
            // This player has an AT
            if (!records[entry.accountId]) records[entry.accountId] = { count: 0, maps: [] };
            records[entry.accountId].count++;
            records[entry.accountId].maps.push(map.uid);
            foundOnThisMap++;
            totalATRecords++;
          } else {
            // Score is worse than AT — everyone below is also worse, stop
            foundWorseScore = true;
            break;
          }
        }

        if (foundWorseScore) break; // early exit
        if (entries.length < 100) break; // last page
        page++;
      } catch (e) {
        console.warn(`  Map ${map.uid} page ${page}: ${e.message}`);
        break;
      }
    }

    done++;
    if (done % 100 === 0) {
      const elapsed  = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
      const eta      = ((Date.now() - startTime) / done * (scannable.length - done) / 1000 / 60).toFixed(0);
      console.log(`  ${done}/${scannable.length} maps — ${Object.keys(records).length} AT holders — ${elapsed}min elapsed, ~${eta}min left`);
    }
  }

  console.log(`\n  Scan complete!`);
  console.log(`  ${Object.keys(records).length} unique AT holders`);
  console.log(`  ${totalATRecords} total AT records`);
  console.log(`  Took ${((Date.now() - startTime) / 1000 / 60).toFixed(1)} minutes\n`);

  // Count ATs per map and attach to map objects
  const atCountByMap = {};
  for (const pd of Object.values(records)) {
    for (const uid of pd.maps) {
      atCountByMap[uid] = (atCountByMap[uid] || 0) + 1;
    }
  }
  for (const map of uniqueMaps) {
    map.atCount = atCountByMap[map.uid] || 0;
  }
  console.log(`  AT counts attached to maps (${Object.keys(atCountByMap).length} maps have at least 1 AT)`);

  // ── Step 5: Save raw records to file ──────────────────────────────────────
  fs.writeFileSync('records.json', JSON.stringify(records, null, 2));
  console.log('[step 5] Raw records saved to records.json');

  // ── Step 6: Build top 100 leaderboard ─────────────────────────────────────
  console.log('\n[step 6] Building top 100...');

  const top100 = Object.entries(records)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 100)
    .map(([accountId, data], idx) => ({ rank: 0, accountId, ats: data.count, name: accountId }));

  // Assign ranks (shared rank for ties)
  let rank = 1;
  for (let i = 0; i < top100.length; i++) {
    top100[i].rank = (i > 0 && top100[i].ats === top100[i-1].ats) ? top100[i-1].rank : rank;
    rank++;
  }

  // Resolve names for top 100 via trackmania.io
  console.log('[step 6] Resolving names for top 100 (1.6s each)...');
  for (let i = 0; i < top100.length; i++) {
    const { accountId } = top100[i];
    try {
      await new Promise(r => setTimeout(r, 1600));
      const res = await fetch(`https://trackmania.io/api/player/${accountId}`, {
        headers: { 'User-Agent': 'IllanCupMedals-Seed/1.0 contact@example.com' }
      });
      if (res.ok) {
        const data = await res.json();
        const name = data?.displayname || data?.player?.name || accountId;
        top100[i].name = name;
      }
    } catch {}
    process.stdout.write(`\r  ${i+1}/100: ${top100[i].name.padEnd(30)}`);
  }
  console.log('\n');

  // ── Step 7: Save everything ───────────────────────────────────────────────
  const leaderboard = { leaderboard: top100, totalMaps: uniqueMaps.length, updatedAt: Date.now() };
  const mapData     = { maps: uniqueMaps, updatedAt: Date.now() };

  // Save locally
  fs.writeFileSync('leaderboard.json', JSON.stringify(leaderboard, null, 2));
  fs.writeFileSync('maps.json', JSON.stringify(mapData, null, 2));
  console.log('[step 7] Saved leaderboard.json and maps.json locally');

  // Save to Cloudflare KV
  try {
    await kvPut('leaderboard', leaderboard);
    await kvPut('maps', mapData);

    // Cache names in KV for the worker to use
    for (const p of top100) {
      await kvPut(`name:${p.accountId}`, p.name);
    }
    console.log('[step 7] Saved to Cloudflare KV');
  } catch (e) {
    console.warn('[step 7] KV save failed:', e.message);
    console.warn('  (Local files saved — you can manually upload them)');
  }

  // ── Done ──────────────────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(50));
  console.log('✅  Done!\n');
  console.log('Top 5:');
  top100.slice(0, 5).forEach(p => console.log(`  #${p.rank} ${p.name.padEnd(25)} ${p.ats} ATs`));
  console.log('');
}

main().catch(e => {
  console.error('\n❌ Fatal error:', e.message);
  process.exit(1);
});
