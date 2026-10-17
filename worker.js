// Lissé : serveur de synchronisation bancaire (Cloudflare Worker + Enable Banking)
//
// Réglages à créer dans Cloudflare (Worker > Settings > Variables and Secrets) :
//   EB_APP_ID       (texte)  identifiant de l'application Enable Banking
//   EB_PRIVATE_KEY  (secret) contenu complet du fichier .pem
//   LISSE_TOKEN     (secret) code secret de votre choix, à saisir aussi dans Lissé
// Liaison à créer (Worker > Settings > Bindings) :
//   KV namespace, nom de variable : LISSE_KV
//
// Adresse de retour à déclarer dans Enable Banking : https://<votre-worker>.workers.dev/callback

const EB = "https://api.enablebanking.com";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
    try {
      if (url.pathname === "/callback") return await callback(url, env);
      if (url.pathname === "/" || url.pathname === "") return html("Serveur Lissé", "Ce serveur fonctionne. Saisissez son adresse dans Lissé › Réglages › Banques.");
      if (!env.LISSE_TOKEN || request.headers.get("X-Lisse-Token") !== env.LISSE_TOKEN) return json({ error: "Code secret incorrect." }, 401);
      checkConfig(env);
      switch (url.pathname) {
        case "/ping": return json(await ping(url, env));
        case "/banks": return json(await banks(url, env));
        case "/connect": return json(await connect(request, url, env));
        case "/result": return json(await result(url, env));
        case "/transactions": return json(await transactions(url, env));
        case "/balances": return json(await balances(url, env));
        case "/disconnect": return json(await disconnect(url, env));
      }
      return json({ error: "Adresse inconnue." }, 404);
    } catch (e) {
      return json({ error: e.message || String(e) }, e.status || 500);
    }
  }
};

/* ---------- Routes ---------- */
async function ping(url, env) {
  const app = await eb(env, "/application");
  const cb = url.origin + "/callback";
  return { ok: true, name: app.name, environment: app.environment, active: app.active, redirectOk: (app.redirect_urls || []).includes(cb), redirect: cb, kv: !!env.LISSE_KV };
}

async function banks(url, env) {
  const country = (url.searchParams.get("country") || "FR").toUpperCase();
  const r = await eb(env, "/aspsps?country=" + encodeURIComponent(country) + "&psu_type=personal");
  return (r.aspsps || []).map(a => ({ name: a.name, country: a.country, logo: a.logo || "", maxValidity: a.maximum_consent_validity || 0 }))
    .sort((a, b) => a.name.localeCompare(b.name, "fr"));
}

async function connect(request, url, env) {
  if (!env.LISSE_KV) throw err(500, "La liaison LISSE_KV n'est pas configurée dans Cloudflare.");
  const b = await request.json();
  if (!b.bank || !b.country) throw err(400, "Banque manquante.");
  const max = Math.min(Number(b.maxValidity) || 90 * 86400, 180 * 86400);
  const validUntil = new Date(Date.now() + (max - 3600) * 1000).toISOString();
  const state = crypto.randomUUID();
  const r = await eb(env, "/auth", { method: "POST", body: {
    access: { valid_until: validUntil }, aspsp: { name: b.bank, country: b.country },
    state, redirect_url: url.origin + "/callback", psu_type: "personal", language: "fr"
  } });
  await env.LISSE_KV.put("s:" + state, JSON.stringify({ status: "pending" }), { expirationTtl: 3600 });
  return { url: r.url, state };
}

async function callback(url, env) {
  const state = url.searchParams.get("state") || "", code = url.searchParams.get("code");
  const fail = async msg => {
    if (env.LISSE_KV && state) await env.LISSE_KV.put("s:" + state, JSON.stringify({ status: "error", error: msg }), { expirationTtl: 3600 });
    return html("Connexion interrompue", msg + " Retournez dans Lissé pour réessayer.");
  };
  if (!env.LISSE_KV || !state || !(await env.LISSE_KV.get("s:" + state))) return html("Lien expiré", "Cette demande de connexion n'est plus valable. Recommencez depuis Lissé.");
  if (!code) return fail(url.searchParams.get("error_description") || "La banque n'a pas donné son accord.");
  try {
    const s = await eb(env, "/sessions", { method: "POST", body: { code } });
    const session = {
      id: s.session_id, bank: s.aspsp?.name || "", country: s.aspsp?.country || "", validUntil: s.access?.valid_until || "",
      accounts: (s.accounts || []).map(a => ({ uid: a.uid, name: a.name || a.details || a.product || "Compte", iban: a.account_id?.iban || "", currency: a.currency || "EUR" }))
    };
    await env.LISSE_KV.put("s:" + state, JSON.stringify({ status: "done", session }), { expirationTtl: 3600 });
    return html("Banque connectée", `${session.bank} est reliée à Lissé (${session.accounts.length} compte${session.accounts.length > 1 ? "s" : ""}). Retournez dans l'app Lissé : la synchronisation démarre toute seule.`);
  } catch (e) { return fail(e.message); }
}

async function result(url, env) {
  const key = "s:" + (url.searchParams.get("state") || "");
  const v = env.LISSE_KV && await env.LISSE_KV.get(key);
  if (!v) return { status: "expired" };
  const r = JSON.parse(v);
  if (r.status !== "pending") await env.LISSE_KV.delete(key);
  return r;
}

async function transactions(url, env) {
  const acc = url.searchParams.get("account");
  if (!acc) throw err(400, "Compte manquant.");
  const from = url.searchParams.get("from") || new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
  const out = []; let key = null, pages = 0;
  do {
    const q = new URLSearchParams({ date_from: from }); if (key) q.set("continuation_key", key);
    const r = await eb(env, `/accounts/${encodeURIComponent(acc)}/transactions?` + q);
    for (const t of r.transactions || []) {
      let amount = Number(t.transaction_amount?.amount); if (!isFinite(amount)) continue;
      let dir = t.credit_debit_indicator || (amount < 0 ? "DBIT" : "CRDT");
      out.push({
        ref: t.entry_reference || t.transaction_id || "",
        amount: Math.abs(amount), currency: t.transaction_amount?.currency || "EUR", dir,
        status: t.status || "BOOK",
        date: t.booking_date || t.value_date || t.transaction_date || "",
        text: [].concat(t.remittance_information || []).join(" ").trim(),
        counterpart: (dir === "CRDT" ? t.debtor?.name : t.creditor?.name) || ""
      });
    }
    key = r.continuation_key; pages++;
  } while (key && pages < 30);
  return out;
}

async function balances(url, env) {
  const r = await eb(env, `/accounts/${encodeURIComponent(url.searchParams.get("account") || "")}/balances`);
  const b = (r.balances || [])[0];
  return b ? { amount: Number(b.balance_amount?.amount), currency: b.balance_amount?.currency || "EUR", type: b.balance_type || "" } : {};
}

async function disconnect(url, env) {
  const id = url.searchParams.get("session");
  if (id) { try { await eb(env, "/sessions/" + encodeURIComponent(id), { method: "DELETE" }); } catch (_) {} }
  return { ok: true };
}

/* ---------- Appels Enable Banking (jeton JWT signé RS256) ---------- */
let keyCache = null, jwtCache = { token: "", exp: 0 };

async function eb(env, path, opts = {}) {
  const r = await fetch(EB + path, {
    method: opts.method || "GET",
    headers: { Authorization: "Bearer " + await jwt(env), "Content-Type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch (_) { j = {}; }
  if (!r.ok) {
    const detail = j.message || (typeof j.detail === "string" ? j.detail : "") || text.slice(0, 200);
    const hint = r.status === 401 || r.status === 403 ? " Vérifiez EB_APP_ID, la clé privée et que vos comptes sont liés dans Enable Banking." : "";
    throw err(r.status === 401 ? 502 : r.status, "Enable Banking : " + (detail || "erreur " + r.status) + hint);
  }
  return j;
}

async function jwt(env) {
  const now = Math.floor(Date.now() / 1000);
  if (jwtCache.token && jwtCache.exp - 60 > now) return jwtCache.token;
  const header = { typ: "JWT", alg: "RS256", kid: env.EB_APP_ID.trim() };
  const payload = { iss: "enablebanking.com", aud: "api.enablebanking.com", iat: now, exp: now + 3600 };
  const data = b64url(JSON.stringify(header)) + "." + b64url(JSON.stringify(payload));
  keyCache ||= await importKey(env.EB_PRIVATE_KEY);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyCache, new TextEncoder().encode(data));
  jwtCache = { token: data + "." + b64url(new Uint8Array(sig)), exp: now + 3600 };
  return jwtCache.token;
}

async function importKey(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/[^A-Za-z0-9+/=]/g, "");
  let der = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  if (/BEGIN RSA PRIVATE KEY/.test(pem)) der = pkcs1to8(der);
  try { return await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]); }
  catch (_) { throw err(500, "La clé privée EB_PRIVATE_KEY est illisible. Recopiez tout le contenu du fichier .pem, lignes BEGIN et END comprises."); }
}
function derLen(n) { if (n < 128) return [n]; const b = []; while (n) { b.unshift(n & 255); n >>= 8; } return [0x80 | b.length, ...b]; }
function pkcs1to8(p1) {
  const ver = [0x02, 0x01, 0x00];
  const algo = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const oct = [0x04, ...derLen(p1.length)];
  const head = [0x30, ...derLen(ver.length + algo.length + oct.length + p1.length), ...ver, ...algo, ...oct];
  const out = new Uint8Array(head.length + p1.length); out.set(head); out.set(p1, head.length); return out;
}
function b64url(x) {
  const bytes = typeof x === "string" ? new TextEncoder().encode(x) : x;
  let s = ""; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/* ---------- Utilitaires ---------- */
function checkConfig(env) {
  const miss = ["EB_APP_ID", "EB_PRIVATE_KEY"].filter(k => !env[k]);
  if (miss.length) throw err(500, "Réglage manquant dans Cloudflare : " + miss.join(", ") + ".");
}
function err(status, message) { const e = new Error(message); e.status = status; return e; }
function cors() { return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type,X-Lisse-Token", "Access-Control-Max-Age": "86400" }; }
function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...cors() } }); }
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function html(title, msg) {
  return new Response(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{margin:0;font:17px/1.5 -apple-system,system-ui,sans-serif;background:#F2F4F1;color:#16211C;display:grid;place-items:center;min-height:100vh;padding:24px;box-sizing:border-box}
@media (prefers-color-scheme:dark){body{background:#111814;color:#E8EEEA}}main{max-width:420px}h1{font-size:26px;margin:0 0 8px}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(msg)}</p></main></body></html>`, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
