import fs from "node:fs/promises";

const cfg = JSON.parse(await fs.readFile("characters.json", "utf8"));

const REGION = cfg.region || "us";
const LOCALE = cfg.locale || "en_US";
const NAMESPACES = cfg.namespaces?.length ? cfg.namespaces : ["profile-classic1x-us", "profile-classic-us"];

const CLIENT_ID = process.env.BNET_CLIENT_ID;
const CLIENT_SECRET = process.env.BNET_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  throw new Error("Missing BNET_CLIENT_ID or BNET_CLIENT_SECRET env vars.");
}

function b64(s) {
  return Buffer.from(s, "utf8").toString("base64");
}

async function getToken() {
  const res = await fetch(`https://${REGION}.battle.net/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${b64(`${CLIENT_ID}:${CLIENT_SECRET}`)}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });
  if (!res.ok) throw new Error(`Token failed: ${res.status} ${await res.text()}`);
  const j = await res.json();
  return j.access_token;
}

async function fetchProfile(token, realm, nameLower, namespace) {
  const url =
    `https://${REGION}.api.blizzard.com/profile/wow/character/${encodeURIComponent(realm)}/${encodeURIComponent(nameLower)}` +
    `?namespace=${encodeURIComponent(namespace)}&locale=${encodeURIComponent(LOCALE)}`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  return { res, url };
}

async function fetchWithFallbackNamespaces(token, realm, nameLower) {
  for (const ns of NAMESPACES) {
    const { res, url } = await fetchProfile(token, realm, nameLower, ns);
    if (res.ok) return { ok: true, ns, data: await res.json() };
    // If the namespace is wrong, you'll often see 404/403 — try next namespace
    if (![403, 404].includes(res.status)) {
      return { ok: false, status: res.status, detail: await res.text(), url, ns };
    }
  }
  return { ok: false, status: 404, detail: "Not found in provided namespaces" };
}

const token = await getToken();

const results = await Promise.all(
  cfg.characters.map(async (c) => {
    const nameLower = c.name.toLowerCase();
    const realm = c.realm;

    try {
      const out = await fetchWithFallbackNamespaces(token, realm, nameLower);
      if (!out.ok) {
        return {
          name: c.name,
          realm: c.realm,
          ok: false,
          error: { status: out.status, detail: out.detail }
        };
      }

      const j = out.data;
      return {
        name: j.name ?? c.name,
        realm: j.realm?.name ?? c.realm,
        level: j.level,
        class: j.character_class?.name,
        race: j.race?.name,
        ok: true,
        namespace_used: out.ns
      };
    } catch (e) {
      return { name: c.name, realm: c.realm, ok: false, error: { status: "fetch_error", detail: String(e) } };
    }
  })
);

const payload = {
  generated_at: new Date().toISOString(),
  region: REGION,
  results
};

await fs.mkdir("docs", { recursive: true });
await fs.writeFile("docs/levels.json", JSON.stringify(payload, null, 2) + "\n", "utf8");

console.log("Wrote docs/levels.json");
