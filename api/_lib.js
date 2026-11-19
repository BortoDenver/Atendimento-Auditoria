// Funções compartilhadas pelas rotas /api (arquivos com "_" não viram rota na Vercel).
const crypto = require("crypto");

// ---------- Redis (Upstash, criado pelo painel da Vercel) ----------
const R_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const R_TOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const P = "pbc:";
async function redis(...cmd) {
  if (!R_URL || !R_TOK) throw Object.assign(new Error("Redis não configurado (KV_REST_API_URL / KV_REST_API_TOKEN)."), { status: 500 });
  const r = await fetch(R_URL, { method: "POST", headers: { Authorization: `Bearer ${R_TOK}`, "Content-Type": "application/json" }, body: JSON.stringify(cmd.map(String)) });
  const j = await r.json().catch(() => ({ error: `resposta inesperada (HTTP ${r.status})` }));
  if (j.error) throw Object.assign(new Error("Redis: " + j.error), { status: 500 });
  return j.result;
}
async function pipeline(cmds) {
  if (!cmds.length) return [];
  if (!R_URL || !R_TOK) throw Object.assign(new Error("Redis não configurado (KV_REST_API_URL / KV_REST_API_TOKEN)."), { status: 500 });
  const r = await fetch(R_URL + "/pipeline", { method: "POST", headers: { Authorization: `Bearer ${R_TOK}`, "Content-Type": "application/json" }, body: JSON.stringify(cmds.map((c) => c.map(String))) });
  const j = await r.json().catch(() => null);
  if (!Array.isArray(j)) throw Object.assign(new Error("Redis: " + ((j && j.error) || `resposta inesperada (HTTP ${r.status})`)), { status: 500 });
  return j.map((x) => { if (x.error) throw Object.assign(new Error("Redis: " + x.error), { status: 500 }); return x.result; });
}
const hashParaObj = (arr) => { const o = {}; for (let i = 0; arr && i < arr.length; i += 2) o[arr[i]] = arr[i + 1]; return o; };

// ---------- feed de mudanças (a página consulta ?desde=REV para atualizar a tela) ----------
const MAX_MUD = 3000;
async function registraMudanca(paths) {
  const rev = await redis("INCRBY", P + "rev", paths.length);
  const cmds = paths.map((p, i) => ["ZADD", P + "mudancas", rev - paths.length + 1 + i, p]);
  cmds.push(["ZREMRANGEBYRANK", P + "mudancas", 0, -(MAX_MUD + 1)]);
  await pipeline(cmds);
  return rev;
}

// ---------- senhas ----------
function hashSenha(senha, sal = crypto.randomBytes(16).toString("hex")) {
  return { sal, hash: crypto.scryptSync(String(senha), sal, 64).toString("hex") };
}
function confereSenha(senha, sal, hash) {
  if (!sal || !hash) return false;
  const a = Buffer.from(crypto.scryptSync(String(senha), sal, 64).toString("hex")), b = Buffer.from(String(hash));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- sessão (cookie assinado) ----------
const COOKIE = "pbc_s", DURACAO = 7 * 24 * 3600;
function segredo() {
  const s = process.env.SESSION_SECRET || "";
  if (s.length < 32) throw Object.assign(new Error("Defina SESSION_SECRET (32+ caracteres) nas variáveis da Vercel."), { status: 500 });
  return s;
}
const b64 = (s) => Buffer.from(s).toString("base64url");
function criaSessao(res, email) {
  const corpo = b64(JSON.stringify({ e: email, x: Math.floor(Date.now() / 1000) + DURACAO }));
  const sig = crypto.createHmac("sha256", segredo()).update(corpo).digest("base64url");
  const seguro = process.env.COOKIE_INSEGURO === "1" ? "" : "; Secure";
  res.setHeader("Set-Cookie", `${COOKIE}=${corpo}.${sig}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${DURACAO}${seguro}`);
}
function apagaSessao(res) {
  const seguro = process.env.COOKIE_INSEGURO === "1" ? "" : "; Secure";
  res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${seguro}`);
}
function lerCookie(req) {
  const c = String(req.headers.cookie || "").split(/;\s*/).find((x) => x.startsWith(COOKIE + "="));
  return c ? c.slice(COOKIE.length + 1) : "";
}
function emailDaSessao(req) {
  const [corpo, sig] = lerCookie(req).split(".");
  if (!corpo || !sig) return null;
  const esperado = crypto.createHmac("sha256", segredo()).update(corpo).digest("base64url");
  if (sig.length !== esperado.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(esperado))) return null;
  try { const d = JSON.parse(Buffer.from(corpo, "base64url").toString()); return d.x > Date.now() / 1000 ? d.e : null; } catch (e) { return null; }
}

// ---------- membros ----------
// cache curto (30 s) por instância: reduz comandos no Redis nas consultas periódicas
const cacheMembros = new Map();
async function lerMembro(email, semCache) {
  const e = String(email || "").toLowerCase(), c = cacheMembros.get(e);
  if (!semCache && c && c.ate > Date.now()) return c.m;
  const v = await redis("HGET", P + "membros", e), m = v ? JSON.parse(v) : null;
  // só guarda quem existe: "não é membro" nunca fica em cache (o primeiro dono é criado logo depois dessa leitura)
  if (m) cacheMembros.set(e, { m, ate: Date.now() + 30000 }); else cacheMembros.delete(e);
  return m;
}
const esqueceMembro = (email) => cacheMembros.delete(String(email || "").toLowerCase());
// devolve {email, nome, papel} de quem está logado (ou responde 401 e devolve null)
async function exigeMembro(req, res) {
  const email = emailDaSessao(req);
  const m = email ? await lerMembro(email) : null;
  if (!m) { res.status(401).json({ code: "needs_reauth", message: "Sessão expirada. Entre de novo." }); return null; }
  return { email, nome: m.nome || email, papel: m.papel };
}
const podeEscrever = (m) => m && (m.papel === "contribuidor" || m.papel === "dono");

// ---------- utilidades HTTP ----------
function corpoJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  try { return JSON.parse(req.body || "{}"); } catch (e) { return {}; }
}
function rota(fn) {
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try { await fn(req, res); }
    catch (e) { if (!res.headersSent) res.status(e.status || 500).json({ code: e.code || "upstream_error", message: e.message }); }
  };
}

module.exports = { redis, pipeline, hashParaObj, P, registraMudanca, MAX_MUD, hashSenha, confereSenha, criaSessao, apagaSessao, emailDaSessao, lerMembro, esqueceMembro, exigeMembro, podeEscrever, corpoJson, rota };
