// Portal ID Corretora (juraudit.idcorretora.com.br): grava no Redis as demandas lidas do portal.
// A leitura acontece no navegador de quem está logado no portal (favorito "Enviar ao Denver PBC"); o servidor nunca acessa o portal.
// A página manda os ciclos em lotes:
//   {acao:"lote", inicio, ciclos:[{lista, det}]}  → converte e grava em portalid/<cicloId>, preservando o que já se sabia
//   {acao:"finalizar", inicio, ids:[cicloId]}     → marca os ciclos que sumiram do portal e grava o resumo em config/portalid
// Nada é apagado: itens e ciclos que deixam de aparecer ficam marcados com "removidoEm".
const { redis, pipeline, P, exigeMembro, podeEscrever, corpoJson, rota, registraMudanca } = require("./_lib");

const COL = P + "col:portalid";
const ADM = "ID";
const STATUS = { PENDENTE: "afazer", RECEBIDO: "enviado", VALIDADO: "enviado" };
const idOk = (s) => /^[A-Za-z0-9_\-.~:@+]{1,200}$/.test(String(s || ""));
const txt = (s, max) => (s == null ? null : String(s).replace(/\s+/g, " ").trim().slice(0, max || 2000) || null);
const iso = (s) => (s && !isNaN(Date.parse(s)) ? new Date(s).toISOString() : null);
function cnpjFmt(v) {
  const d = String(v || "").replace(/\D/g, "");
  return d.length === 14 ? d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5") : d || null;
}

// Converte um ciclo do portal no formato da ferramenta.
// ant: versão já gravada (ou null); agora: instante desta atualização; inicial: true na primeira carga (histórico).
function montaCiclo(bruto, ant, agora, inicial) {
  const L = (bruto && bruto.lista) || {}, D = (bruto && bruto.det) || {}, C = D.ciclo || {};
  const id = String(L.id || C.id || "");
  const antItens = new Map(((ant && ant.itens) || []).map((i) => [i.id, i]));
  const antPed = new Map(((ant && ant.pedidos) || []).map((p) => [p.id, p]));
  const cont = { itensNovos: 0, statusMudou: 0, pedidosNovos: 0, obsNovas: 0 };

  const obsPor = new Map();
  for (const o of D.observacoes || []) {
    if (!o || !o.itemId) continue;
    const l = obsPor.get(o.itemId) || [];
    l.push({ id: String(o.id || ""), autor: txt(o.autor, 200), texto: txt(o.texto), em: iso(o.em), editadoEm: iso(o.editadoEm) });
    obsPor.set(o.itemId, l);
  }

  const itens = [], vistos = new Set();
  let area = null;
  for (const it of D.itens || []) {
    if (!it || !it.id) continue;
    if (it.secao) { area = txt(it.texto, 200); continue; }
    const iid = String(it.id), a = antItens.get(iid), status = String(it.status || "PENDENTE").toUpperCase();
    vistos.add(iid);
    const obs = (obsPor.get(iid) || []).sort((x, y) => String(x.em).localeCompare(String(y.em)));
    const mudou = a && a.status !== status;
    const novo = {
      id: iid, nome: txt(it.texto, 500) || "(sem nome)", status, s: STATUS[status] || "afazer", area,
      obs, anexos: (it.anexos || []).map((x) => ({ nome: txt(x.nome, 300), enviadoPor: txt(x.enviadoPor, 200), enviadoEm: iso(x.enviadoEm), origem: txt(x.origem, 40) })),
      manual: !!it.criadoPeloContador,
      vistoEm: (a && a.vistoEm) || agora,
      cargaInicial: a ? !!a.cargaInicial : inicial,
      statusEm: mudou ? agora : (a && a.statusEm) || null,
      statusAnt: mudou ? a.status : (a && a.statusAnt) || null,
    };
    // pedidoEm: dia em que o item apareceu no portal pela primeira vez (desconhecido para o que veio na carga inicial)
    novo.pedidoEm = novo.cargaInicial ? null : novo.vistoEm.slice(0, 10);
    if (!a && !inicial) cont.itensNovos++;
    if (mudou) cont.statusMudou++;
    if (a) cont.obsNovas += Math.max(0, obs.length - ((a.obs || []).length));
    itens.push(novo);
  }
  // itens que sumiram do portal continuam guardados, marcados
  for (const [iid, a] of antItens) if (!vistos.has(iid)) itens.push({ ...a, removidoEm: a.removidoEm || agora });

  const conv = Array.isArray(D.conversas) ? D.conversas : [];
  const pedidos = conv.filter((m) => m && m.tipo === "PEDIDO_DOCUMENTO").map((m) => {
    const pid = String(m.id || ""), a = antPed.get(pid);
    if (!a && !inicial) cont.pedidosNovos++;
    return { id: pid, autor: txt(m.autor, 200), autorTipo: txt(m.autorTipo, 40), texto: txt(m.mensagem, 4000), em: iso(m.criadoEm), vistoEm: (a && a.vistoEm) || agora, cargaInicial: a ? !!a.cargaInicial : inicial };
  });
  const mensagens = conv.filter((m) => m && m.tipo !== "PEDIDO_DOCUMENTO").map((m) => ({ autor: txt(m.autor, 200), autorTipo: txt(m.autorTipo, 40), texto: txt(m.mensagem, 4000), em: iso(m.criadoEm) }))
    .sort((x, y) => String(y.em).localeCompare(String(x.em))).slice(0, 30);

  const doc = {
    id, nome: txt(C.fundoNome || L.fundoNome, 300) || "(sem nome)", cnpj: cnpjFmt(C.cnpj || L.cnpj), adm: ADM,
    auditor: txt(C.auditor, 200), emailsAuditor: (C.emailsAuditor || []).map((e) => txt(e, 200)).filter(Boolean),
    tipo: txt(C.tipo || L.tipo, 40), mesFindo: txt(C.mesFindo || L.mesFindo, 10), modalidade: txt(C.modalidade || L.modalidade, 40),
    tipoDf: txt(C.tipoDf, 40), dataEvento: txt(C.dataEvento || L.dataEvento, 40), analista: txt(C.analista || L.analista, 200),
    gestor: txt(C.gestor, 200), novidadesPortal: +L.novidades || 0,
    itens, pedidos, mensagens,
    vistoEm: (ant && ant.vistoEm) || agora, cargaInicial: ant ? !!ant.cargaInicial : inicial,
    sincronizadoEm: agora, removidoEm: null,
  };
  const novoCiclo = !ant && !inicial;
  const mudouAlgo = novoCiclo || cont.itensNovos || cont.statusMudou || cont.pedidosNovos || cont.obsNovas || (ant && ant.removidoEm);
  doc.atualizadoEm = !ant || mudouAlgo ? agora : ant.atualizadoEm || agora;
  return { doc, cont, novoCiclo };
}

module.exports = rota(async (req, res) => {
  const m = await exigeMembro(req, res); if (!m) return;
  if (req.method !== "POST") return res.status(405).json({ code: "bad_request" });
  if (!podeEscrever(m)) return res.status(403).json({ code: "invalid_argument", message: "Só contribuidores e o dono atualizam os dados do Portal ID." });
  const b = corpoJson(req);
  const agora = iso(b.inicio) && Math.abs(Date.parse(b.inicio) - Date.now()) < 86400000 ? iso(b.inicio) : new Date().toISOString();

  if (b.acao === "lote") {
    const ciclos = (Array.isArray(b.ciclos) ? b.ciclos : []).filter((c) => c && idOk((c.lista && c.lista.id) || (c.det && c.det.ciclo && c.det.ciclo.id))).slice(0, 40);
    if (!ciclos.length) return res.status(200).json({ gravados: 0 });
    const cfg = await redis("HGET", P + "col:config", "portalid");
    const inicial = !cfg;
    const ids = ciclos.map((c) => String((c.lista && c.lista.id) || c.det.ciclo.id));
    const antes = await pipeline(ids.map((id) => ["HGET", COL, id]));
    const tot = { ciclosNovos: 0, itensNovos: 0, statusMudou: 0, pedidosNovos: 0, obsNovas: 0 }, cmds = [], paths = [], novos = [];
    ciclos.forEach((c, i) => {
      const ant = antes[i] ? JSON.parse(antes[i]) : null;
      const { doc, cont, novoCiclo } = montaCiclo(c, ant, agora, inicial);
      for (const k of Object.keys(cont)) tot[k] += cont[k];
      if (novoCiclo) { tot.ciclosNovos++; novos.push(doc.nome); }
      // só grava (e avisa as telas) o que mudou; o carimbo de sincronização sozinho não conta como mudança
      if (ant && JSON.stringify({ ...doc, sincronizadoEm: ant.sincronizadoEm }) === antes[i]) return;
      cmds.push(["HSET", COL, doc.id, JSON.stringify(doc)]); paths.push("portalid/" + doc.id);
    });
    if (cmds.length) { await pipeline(cmds); await registraMudanca(paths); }
    return res.status(200).json({ gravados: cmds.length, inicial, ...tot, novos });
  }

  if (b.acao === "finalizar") {
    const ids = new Set((Array.isArray(b.ids) ? b.ids : []).map(String).filter(idOk));
    const todos = await redis("HKEYS", COL) || [];
    const sumiram = ids.size ? todos.filter((id) => !ids.has(id)) : [];
    const paths = [];
    if (sumiram.length) {
      const vals = await pipeline(sumiram.map((id) => ["HGET", COL, id])), cmds = [];
      sumiram.forEach((id, i) => {
        const d = vals[i] ? JSON.parse(vals[i]) : null;
        if (!d || d.removidoEm) return;
        d.removidoEm = agora; d.atualizadoEm = agora;
        cmds.push(["HSET", COL, id, JSON.stringify(d)]); paths.push("portalid/" + id);
      });
      if (cmds.length) await pipeline(cmds);
    }
    const ant = await redis("HGET", P + "col:config", "portalid");
    const r = b.resumo && typeof b.resumo === "object" ? b.resumo : {};
    const num = (k) => Math.max(0, +r[k] || 0);
    const doc = {
      ultima: agora, fim: new Date().toISOString(), por: m.email, porNome: m.nome, usuarioPortal: txt(b.usuarioPortal, 200),
      primeira: (ant && JSON.parse(ant).primeira) || agora, inicial: !ant,
      ciclos: ids.size, removidos: paths.length,
      ciclosNovos: num("ciclosNovos"), itensNovos: num("itensNovos"), statusMudou: num("statusMudou"), pedidosNovos: num("pedidosNovos"), obsNovas: num("obsNovas"),
    };
    await redis("HSET", P + "col:config", "portalid", JSON.stringify(doc));
    await registraMudanca([...paths, "config/portalid"]);
    return res.status(200).json({ ok: true, ...doc });
  }
  res.status(400).json({ code: "bad_request" });
});
// exportado para testes
module.exports.montaCiclo = montaCiclo;
