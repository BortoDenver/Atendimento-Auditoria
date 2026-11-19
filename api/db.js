// Banco de documentos (mesmo modelo do claude.ai: coleção/id → JSON), guardado no Redis.
// GET  ?col=fundos[&campo=dia&op=>=&valor=2026-11-01]  → lista a coleção
// GET  ?path=fundos/123                                → um documento
// GET  ?desde=REV                                      → mudanças desde a revisão REV (para atualizar a tela)
// POST {op:"set"|"update"|"delete", path, data}        → grava (contribuidor ou dono)
// POST {op:"importar", itens:[{path,col,id,data}]}     → carga inicial (dono)
const { redis, pipeline, hashParaObj, P, exigeMembro, podeEscrever, corpoJson, rota } = require("./_lib");
const MAX_MUD = 3000;

// a Caixa de entrada cresce todo dia: guarda por mês (id = canal_AAAA-MM-DD_origem)
const chaveCol = (col, id) => (col === "caixa" ? `${P}col:caixa:${String(id).split("_")[1]?.slice(0, 7) || "sem-data"}` : `${P}col:${col}`);
const separa = (path) => { const i = String(path).lastIndexOf("/"); return i > 0 ? [path.slice(0, i), path.slice(i + 1)] : [null, null]; };
const valido = (s) => /^[A-Za-z0-9_\-.~:@+]{1,200}$/.test(s);
const podeLer = (m, col) => col !== "cofre" || podeEscrever(m);
const mergeProfundo = (a, b) => {
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const o = { ...a }; for (const k of Object.keys(b)) o[k] = k in a ? mergeProfundo(a[k], b[k]) : b[k]; return o;
  }
  return b;
};
function mesesDesde(valor) {
  const out = [], hoje = new Date(); let d = new Date(String(valor).slice(0, 7) + "-01T00:00:00Z");
  if (isNaN(d)) d = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth() - 3, 1));
  while (d <= hoje && out.length < 36) { out.push(d.toISOString().slice(0, 7)); d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)); }
  return out;
}
async function registraMudanca(paths) {
  const rev = await redis("INCRBY", P + "rev", paths.length);
  const cmds = paths.map((p, i) => ["ZADD", P + "mudancas", rev - paths.length + 1 + i, p]);
  cmds.push(["ZREMRANGEBYRANK", P + "mudancas", 0, -(MAX_MUD + 1)]);
  await pipeline(cmds);
  return rev;
}
async function comTrava(path, fn) {
  const trava = P + "trava:" + path;
  for (let i = 0; i < 40; i++) {
    if (await redis("SET", trava, "1", "NX", "PX", "4000")) { try { return await fn(); } finally { await redis("DEL", trava); } }
    await new Promise((r) => setTimeout(r, 75));
  }
  throw Object.assign(new Error("Documento ocupado, tente de novo."), { status: 503, code: "server_unavailable" });
}
const proibido = (res, msg) => res.status(403).json({ code: "invalid_argument", message: msg || "Sem permissão para gravar." });

module.exports = rota(async (req, res) => {
  const m = await exigeMembro(req, res); if (!m) return;
  const q = new URL(req.url, "http://x").searchParams;

  if (req.method === "GET") {
    if (q.has("desde")) {
      const desde = +q.get("desde") || 0, rev = +(await redis("GET", P + "rev")) || 0;
      if (rev <= desde) return res.status(200).json({ rev, mudancas: [] });
      const menor = await redis("ZRANGE", P + "mudancas", 0, 0, "WITHSCORES");
      if (desde && menor && menor.length && +menor[1] > desde + 1 && (await redis("ZCARD", P + "mudancas")) >= MAX_MUD) return res.status(200).json({ rev, recarregar: true });
      const paths = (await redis("ZRANGEBYSCORE", P + "mudancas", `(${desde}`, "+inf")).filter((p) => podeLer(m, separa(p)[0]));
      const vals = await pipeline(paths.map((p) => { const [c, i] = separa(p); return ["HGET", chaveCol(c, i), i]; }));
      return res.status(200).json({ rev, mudancas: paths.map((p, i) => ({ path: p, data: vals[i] ? JSON.parse(vals[i]) : null })) });
    }
    if (q.has("path")) {
      const [col, id] = separa(q.get("path"));
      if (!col || !podeLer(m, col)) return res.status(200).json({ exists: false });
      const v = await redis("HGET", chaveCol(col, id), id);
      return res.status(200).json(v ? { exists: true, data: JSON.parse(v) } : { exists: false });
    }
    const col = q.get("col");
    if (!col || !valido(col)) return res.status(400).json({ code: "bad_request" });
    if (!podeLer(m, col)) return res.status(200).json({ rev: +(await redis("GET", P + "rev")) || 0, docs: [] });
    const rev = +(await redis("GET", P + "rev")) || 0;
    const campo = q.get("campo"), op = q.get("op"), valor = q.get("valor");
    let chaves = [chaveCol(col, "")];
    if (col === "caixa") chaves = mesesDesde(campo === "dia" && valor ? valor : "").map((mes) => `${P}col:caixa:${mes}`);
    const blocos = await pipeline(chaves.map((k) => ["HGETALL", k]));
    let docs = [];
    for (const b of blocos) for (const [id, v] of Object.entries(hashParaObj(b))) docs.push({ id, data: JSON.parse(v) });
    if (campo && op && valor !== null) {
      const cmp = { ">=": (a) => String(a ?? "") >= valor, ">": (a) => String(a ?? "") > valor, "<=": (a) => String(a ?? "") <= valor, "<": (a) => String(a ?? "") < valor, "==": (a) => String(a) === valor };
      if (cmp[op]) docs = docs.filter((d) => cmp[op](d.data && d.data[campo]));
    }
    return res.status(200).json({ rev, docs });
  }

  if (req.method !== "POST") return res.status(405).json({ code: "bad_request" });
  const b = corpoJson(req);

  if (b.op === "importar") {
    if (m.papel !== "dono") return proibido(res, "Só o dono importa dados.");
    const itens = Array.isArray(b.itens) ? b.itens : [];
    const cmds = [], paths = [];
    for (const it of itens) {
      const [col, id] = separa(it.path);
      if (!col || !valido(col) || !valido(id) || typeof it.data !== "object") continue;
      cmds.push(["HSET", chaveCol(col, id), id, JSON.stringify(it.data)]); paths.push(it.path);
    }
    for (let i = 0; i < cmds.length; i += 200) await pipeline(cmds.slice(i, i + 200));
    const rev = paths.length ? await registraMudanca(paths) : 0;
    return res.status(200).json({ ok: true, importados: paths.length, rev });
  }

  if (!podeEscrever(m)) return proibido(res);
  const [col, id] = separa(b.path);
  if (!col || !valido(col) || !valido(id)) return res.status(400).json({ code: "bad_request", message: "Caminho inválido." });
  const chave = chaveCol(col, id);

  if (b.op === "set") {
    if (!b.data || typeof b.data !== "object") return res.status(400).json({ code: "bad_request" });
    await redis("HSET", chave, id, JSON.stringify(b.data));
    return res.status(200).json({ ok: true, rev: await registraMudanca([b.path]) });
  }
  if (b.op === "update") {
    const novo = await comTrava(b.path, async () => {
      const v = await redis("HGET", chave, id);
      if (!v) return null;
      const d = mergeProfundo(JSON.parse(v), b.data || {});
      await redis("HSET", chave, id, JSON.stringify(d));
      return d;
    });
    if (!novo) return res.status(404).json({ code: "invalid_argument", message: "Documento inexistente." });
    return res.status(200).json({ ok: true, data: novo, rev: await registraMudanca([b.path]) });
  }
  if (b.op === "delete") {
    await redis("HDEL", chave, id);
    return res.status(200).json({ ok: true, rev: await registraMudanca([b.path]) });
  }
  res.status(400).json({ code: "bad_request" });
});
