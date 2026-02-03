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

function upsertDailyPoint(arr, date, level) {
  // keep at most one entry per day
  const idx = arr.findIndex(x => x.date === date);
  if (idx >= 0) arr[idx].level = level;
  else arr.push({ date, level });
  arr.sort((a, b) => a.date.localeCompare(b.date));
}

function pruneOlderThan(arr, cutoffDate) {
  // dates are YYYY-MM-DD; lex compare works
  return arr.filter(x => x.date >= cutoffDate);
}

function deltaFromWindow(arr, windowStartDate, currentLevel) {
  if (!arr?.length || !Number.isFinite(currentLevel)) return null;

  // baseline = last point on/before window start; else earliest point after start
  let baseline = null;

  for (const p of arr) {
    if (p.date <= windowStartDate) baseline = p;
    else break;
  }
  if (!baseline) {
    baseline = arr.find(p => p.date >= windowStartDate) || null;
  }
  if (!baseline || !Number.isFinite(baseline.level)) return null;

  return currentLevel - baseline.level;
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

// ---- load history (daily points) ----
await fs.mkdir("docs", { recursive: true });

const historyPath = "docs/history.json";
const history = (await readJsonIfExists(historyPath)) ?? { version: 1, by_id: {} };
history.by_id = history.by_id || {};

const today = utcDateString();
const cutoffKeep = utcDateDaysAgo(90);       // keep ~90 days of daily points
const windowStart = utcDateDaysAgo(7);       // rolling 7-day window

const token = await getToken();

const results = await Promise.all(
  cfg.characters.map(async (c) => {
    const nameLower = String(c.name || "").toLowerCase();
    const realmSlug = String(c.realm || "").toLowerCase(); // should be slug in your config
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
          error: { status: out.status, detail: out.detail },
        };
      }

      const j = out.data;
      const level = j.level;

      // update history for ok characters
      if (Number.isFinite(level)) {
        const arr = history.by_id[id] ?? [];
        upsertDailyPoint(arr, today, level);
        history.by_id[id] = pruneOlderThan(arr, cutoffKeep);
      }

      // compute 7-day delta from history
      const arr = history.by_id[id] ?? [];
      const delta_7d = deltaFromWindow(arr, windowStart, level);

      return {
        id,
        name: j.name ?? c.name,
        realm: j.realm?.name ?? c.realm,
        level,
        delta_7d,
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
        error: { status: "fetch_error", detail: String(e) },
      };
    }
  })
);

// write outputs
const payload = {
  generated_at: new Date().toISOString(),
  region: REGION,
  results,
};

history.updated_at = new Date().toISOString();

await fs.writeFile("docs/levels.json", JSON.stringify(payload, null, 2) + "\n", "utf8");
await fs.writeFile(historyPath, JSON.stringify(history, null, 2) + "\n", "utf8");

console.log("Wrote docs/levels.json and docs/history.json");
