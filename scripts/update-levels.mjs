import fs from "node:fs/promises";

const cfg = JSON.parse(await fs.readFile("characters.json", "utf8"));

const REGION = cfg.region || "us";
const LOCALE = cfg.locale || "en_US";
const NAMESPACES = (cfg.namespaces?.length ? cfg.namespaces : ["profile-classic1x-us", "profile-classic-us"]);

const CLIENT_ID = process.env.BNET_CLIENT_ID;
const CLIENT_SECRET = process.env.BNET_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  throw new Error("Missing BNET_CLIENT_ID or BNET_CLIENT_SECRET env vars.");
}

function b64(s) {
  return Buffer.from(s, "utf8").toString("base64");
}

function utcDateString(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function utcDateDaysAgo(days) {
  return utcDateString(new Date(Date.now() - days * 86400000));
}

function makeId(realmSlug, nameLower) {
  return `${String(realmSlug).toLowerCase()}:${String(nameLower).toLowerCase()}`;
}

async function readJsonIfExists(path) {
  try {
    return JSON.parse(await fs.readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

/**
 * Vanilla / Classic XP to next level (1–60).
 * Index = current level. Value = XP required to reach next level.
 */
const XP_TO_NEXT_CLASSIC = [
  null,   // 0
  400,    // 1
  900,    // 2
  1400,   // 3
  2100,   // 4
  2800,   // 5
  3600,   // 6
  4500,   // 7
  5400,   // 8
  6500,   // 9
  7600,   // 10
  8800,   // 11
  10100,  // 12
  11400,  // 13
  12900,  // 14
  14400,  // 15
  16000,  // 16
  17700,  // 17
  19400,  // 18
  21300,  // 19
  23200,  // 20
  25200,  // 21
  27300,  // 22
  29400,  // 23
  31700,  // 24
  34000,  // 25
  36400,  // 26
  38900,  // 27
  41400,  // 28
  44300,  // 29
  47400,  // 30
  50800,  // 31
  54500,  // 32
  58600,  // 33
  62800,  // 34
  67100,  // 35
  71600,  // 36
  76100,  // 37
  80800,  // 38
  85700,  // 39
  90700,  // 40
  95800,  // 41
  101000, // 42
  106300, // 43
  111800, // 44
  117500, // 45
  123200, // 46
  129100, // 47
  135100, // 48
  141200, // 49
  147500, // 50
  153900, // 51
  160400, // 52
  167100, // 53
  173900, // 54
  180800, // 55
  187900, // 56
  195000, // 57
  202300, // 58
  209800, // 59
  217400, // 60 (not used beyond 60)
];

// XP_START[level] = total XP needed to reach the START of this level.
const XP_START = (() => {
  const start = Array(61).fill(0);
  start[1] = 0;
  for (let lvl = 2; lvl <= 60; lvl++) {
    const prev = XP_TO_NEXT_CLASSIC[lvl - 1];
    start[lvl] = start[lvl - 1] + (Number.isFinite(prev) ? prev : 0);
  }
  return start;
})();

function xpMeta(level, experience) {
  if (level >= 60) return { xp_to_next: null, xp_percent: 1 };

  const xp_to_next = XP_TO_NEXT_CLASSIC[level] ?? null;
  if (!Number.isFinite(experience) || !Number.isFinite(xp_to_next) || xp_to_next <= 0) {
    return { xp_to_next, xp_percent: null };
  }
  return { xp_to_next, xp_percent: clamp01(experience / xp_to_next) };
}

function totalXpClassic(level, experience) {
  if (!Number.isFinite(level) || level < 1) return null;
  const base = XP_START[Math.min(level, 60)] ?? null;
  if (!Number.isFinite(base)) return null;
  const exp = Number.isFinite(experience) ? experience : 0;
  return base + exp;
}

// ---- weekly level history helpers (daily points) ----
function upsertDailyPoint(arr, date, level) {
  const idx = arr.findIndex(x => x.date === date);
  if (idx >= 0) arr[idx].level = level;
  else arr.push({ date, level });
  arr.sort((a, b) => a.date.localeCompare(b.date));
}
function pruneDailyOlderThan(arr, cutoffDate) {
  return arr.filter(x => x.date >= cutoffDate);
}
function deltaFromWindow(arr, windowStartDate, currentLevel) {
  if (!arr?.length || !Number.isFinite(currentLevel)) return null;

  let baseline = null;
  for (const p of arr) {
    if (p.date <= windowStartDate) baseline = p;
    else break;
  }
  if (!baseline) baseline = arr.find(p => p.date >= windowStartDate) || null;
  if (!baseline || !Number.isFinite(baseline.level)) return null;

  return currentLevel - baseline.level;
}

// ---- xp history helpers (timestamped points) ----
function pruneXpOlderThan(arr, cutoffMs) {
  return arr.filter(x => Number.isFinite(x.t) && x.t >= cutoffMs && Number.isFinite(x.xp));
}
function pushXpPoint(arr, tMs, totalXp) {
  const last = arr[arr.length - 1];
  if (last && Math.abs(last.t - tMs) < 60000) {
    last.xp = totalXp;
    last.t = tMs;
  } else {
    arr.push({ t: tMs, xp: totalXp });
  }
}

/**
 * Build a fixed-length spark series (0..100) from XP points in last 7d.
 * We bin to 56 points (~3 hours per point).
 */
function buildSpark7d(points, nowMs) {
  const WINDOW_MS = 7 * 24 * 3600 * 1000; // 7 days
  const BIN_COUNT = 56;                   // ~3-hour bins
  const BIN_MS = WINDOW_MS / BIN_COUNT;

  const startMs = nowMs - WINDOW_MS;

  const relevant = points
    .filter(p => p.t >= startMs && p.t <= nowMs && Number.isFinite(p.xp))
    .sort((a, b) => a.t - b.t);

  if (relevant.length < 2) return { spark: null, gained: null };

  // Fill bins with the latest xp observed up to bin end
  let idx = 0;
  let lastXp = relevant[0].xp;
  const series = [];

  for (let i = 0; i < BIN_COUNT; i++) {
    const binEnd = startMs + (i + 1) * BIN_MS;
    while (idx < relevant.length && relevant[idx].t <= binEnd) {
      lastXp = relevant[idx].xp;
      idx++;
    }
    series.push(lastXp);
  }

  const first = series.find(v => Number.isFinite(v));
  const last = series[series.length - 1];
  const gained = (Number.isFinite(first) && Number.isFinite(last)) ? (last - first) : null;

  const min = Math.min(...series);
  const max = Math.max(...series);

  let spark;
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    spark = null;
  } else if (max === min) {
    spark = series.map(() => 50);
  } else {
    spark = series.map(v => Math.round(((v - min) / (max - min)) * 100));
  }

  return { spark, gained };
}

async function getToken() {
  const res = await fetch(`https://${REGION}.battle.net/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${b64(`${CLIENT_ID}:${CLIENT_SECRET}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`Token failed: ${res.status} ${await res.text()}`);
  const j = await res.json();
  return j.access_token;
}

async function fetchProfile(token, realmSlug, nameLower, namespace) {
  const url =
    `https://${REGION}.api.blizzard.com/profile/wow/character/${encodeURIComponent(realmSlug)}/${encodeURIComponent(nameLower)}` +
    `?namespace=${encodeURIComponent(namespace)}&locale=${encodeURIComponent(LOCALE)}`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  return { res, url };
}

async function fetchWithFallbackNamespaces(token, realmSlug, nameLower) {
  for (const ns of NAMESPACES) {
    const { res, url } = await fetchProfile(token, realmSlug, nameLower, ns);
    if (res.ok) return { ok: true, ns, data: await res.json() };
    if (![403, 404].includes(res.status)) {
      return { ok: false, status: res.status, detail: await res.text(), url, ns };
    }
  }
  return { ok: false, status: 404, detail: "Not found in provided namespaces" };
}

// ---- load history files ----
await fs.mkdir("docs", { recursive: true });

// daily level history (for delta_7d)
const levelHistoryPath = "docs/history.json";
const levelHistory = (await readJsonIfExists(levelHistoryPath)) ?? { version: 1, by_id: {} };
levelHistory.by_id = levelHistory.by_id || {};

// xp history (for sparkline)
const xpHistoryPath = "docs/xp_history.json";
const xpHistory = (await readJsonIfExists(xpHistoryPath)) ?? { version: 1, by_id: {} };
xpHistory.by_id = xpHistory.by_id || {};

const today = utcDateString();
const cutoffKeepDaily = utcDateDaysAgo(90);
const windowStart = utcDateDaysAgo(7);

const nowMs = Date.now();
const xpCutoffMs = nowMs - (10 * 24 * 3600 * 1000); // keep ~10 days of xp points

const token = await getToken();

const results = await Promise.all(
  cfg.characters.map(async (c) => {
    const nameLower = String(c.name || "").toLowerCase();
    const realmSlug = String(c.realm || "").toLowerCase(); // slug in your config
    const id = makeId(realmSlug, nameLower);

    try {
      const out = await fetchWithFallbackNamespaces(token, realmSlug, nameLower);
      if (!out.ok) {
        return {
          id,
          name: c.name,
          realm: c.realm,
          ok: false,
          delta_7d: null,
          experience: null,
          xp_to_next: null,
          xp_percent: null,
          spark_7d: null,
          xp_gained_7d: null,
          error: { status: out.status, detail: out.detail },
        };
      }

      const j = out.data;
      const level = j.level;
      const experience = j.experience; // XP into current level

      // --- update daily level history ---
      if (Number.isFinite(level)) {
        const arr = levelHistory.by_id[id] ?? [];
        upsertDailyPoint(arr, today, level);
        levelHistory.by_id[id] = pruneDailyOlderThan(arr, cutoffKeepDaily);
      }

      const dailyArr = levelHistory.by_id[id] ?? [];
      const delta_7d = deltaFromWindow(dailyArr, windowStart, level);

      // --- xp ring meta ---
      const { xp_to_next, xp_percent } = xpMeta(level, experience);

      // --- xp time series for sparkline (cumulative XP) ---
      const total_xp = totalXpClassic(level, experience);
      if (Number.isFinite(total_xp)) {
        const arr = xpHistory.by_id[id] ?? [];
        const pruned = pruneXpOlderThan(arr, xpCutoffMs);
        pushXpPoint(pruned, nowMs, total_xp);
        xpHistory.by_id[id] = pruned;
      }

      const xpArr = xpHistory.by_id[id] ?? [];
      const { spark, gained } = buildSpark7d(xpArr, nowMs);

      return {
        id,
        name: j.name ?? c.name,
        realm: j.realm?.name ?? c.realm,
        level,
        delta_7d,
        experience: Number.isFinite(experience) ? experience : null,
        xp_to_next,
        xp_percent,           // 0..1
        spark_7d: spark,      // array of 0..100 (or null)
        xp_gained_7d: gained, // raw xp gained (or null)
        class: j.character_class?.name,
        race: j.race?.name,
        ok: true,
        namespace_used: out.ns,
      };
    } catch (e) {
      return {
        id,
        name: c.name,
        realm: c.realm,
        ok: false,
        delta_7d: null,
        experience: null,
        xp_to_next: null,
        xp_percent: null,
        spark_7d: null,
        xp_gained_7d: null,
        error: { status: "fetch_error", detail: String(e) },
      };
    }
  })
);

const payload = {
  generated_at: new Date().toISOString(),
  region: REGION,
  results,
};

levelHistory.updated_at = new Date().toISOString();
xpHistory.updated_at = new Date().toISOString();

await fs.writeFile("docs/levels.json", JSON.stringify(payload, null, 2) + "\n", "utf8");
await fs.writeFile(levelHistoryPath, JSON.stringify(levelHistory, null, 2) + "\n", "utf8");
await fs.writeFile(xpHistoryPath, JSON.stringify(xpHistory, null, 2) + "\n", "utf8");

console.log("Wrote docs/levels.json, docs/history.json, docs/xp_history.json");
