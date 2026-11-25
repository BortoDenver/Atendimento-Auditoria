// Portal ID Corretora (juraudit.idcorretora.com.br) → Caixa de entrada de tarefas do Denver PBC.
// A leitura acontece no navegador de quem está logado no portal (favorito "Enviar ao Denver PBC"); o servidor nunca acessa o portal.
// O portal NÃO é copiado para a ferramenta: guardamos só uma "fotografia" mínima de cada ciclo (pidBase) para saber o que mudou,
// e cada novidade enviada por terceiros (auditor ou ID) vira uma tarefa em pidTarefas, com responsável e status aberta/concluída.
//   {acao:"lote", inicio, ciclos:[{lista, det}]}  → compara com a fotografia, cria as tarefas novas e atualiza a fotografia
//   {acao:"finalizar", inicio, resumo}           → grava o resumo da atualização em config/pidSync
// Tarefas nunca são sobrescritas (HSETNX): responsável e conclusão definidos na ferramenta são preservados.
const { redis, pipeline, P, exigeMembro, podeEscrever, corpoJson, rota, registraMudanca } = require("./_lib");

const BASE = P + "col:pidBase", TAREFAS = P + "col:pidTarefas", FUNDOS = P + "col:pidFundos", CFG = "pidSync";
const JANELA_INICIAL_DIAS = 15; // na primeira carga, comentários e mensagens mais antigos que isso não viram tarefa
const idOk = (s) => /^[A-Za-z0-9_\-.~:@+]{1,200}$/.test(String(s || ""));
const chave = (s) => String(s || "").replace(/[^A-Za-z0-9_\-.]/g, "_").slice(0, 150);
const txt = (s, max) => (s == null ? null : String(s).replace(/\s+/g, " ").trim().slice(0, max || 2000) || null);
const iso = (s) => (s && !isNaN(Date.parse(s)) ? new Date(s).toISOString() : null);
function cnpjFmt(v) {
  const d = String(v || "").replace(/\D/g, "");
  return d.length === 14 ? d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5") : d || null;
}
// "terceiro" = qualquer um que não seja a Denver (auditor ou equipe da ID)
const daDenver = (autor, tipo) => /denver/i.test(String(autor || "")) || String(tipo || "").toUpperCase() === "CONTADOR";
const nomeAutor = (a) => txt(String(a || "").replace(/\s*\(.*$/, ""), 200);
const semAcento = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
// "Conciliações mensais" (com ou sem acento, no singular ou plural)
const ehConciliacaoMensal = (t) => /conciliac(ao|oes)\s+mensa(l|is)/.test(semAcento(t));
// balancetes mensais e razão contábil do fundo (ex.: "1.1 Balancete contábil mensal…", "11. Balancetes mensais…",
// "12. Razão contábil do período…", "3. Razão do período auditado"). Não vale para a própria conciliação
// (há itens "Conciliações mensais (balancete, razão, …)") nem para balancete de empresas investidas.
const cobertoPelaConciliacao = (t) => {
  const n = semAcento(t);
  if (ehConciliacaoMensal(t) || /investid/.test(n)) return false;
  return /balancete/.test(n) || /\brazao\b/.test(n);
};
const MOTIVO_CONCILIACAO = "Feito: Conciliações mensais com anexo no portal";
// Regra da equipe: quando a pendência não se aplica, alguém comenta no item "Não aplicável" no portal
// (ex.: "Não Aplicável", "Não aplicavel", "Não se aplica", "N/A"). O subitem conta como resolvido.
// Vale o comentário que COMEÇA assim; "Não aplicável?" (com interrogação) não conta, porque é pergunta.
const ehNaoAplicavel = (t) => {
  const n = semAcento(t).replace(/^[\s"'“”*\-–—:.]+/, "").trim();
  if (/^[^\n]{0,40}\?/.test(n)) return false;
  return /^(n\s*\/\s*a|n\.a\.|nao\s+(e\s+)?(se\s+)?aplic(a|avel|aveis)?)(?![a-z0-9])/.test(n);
};
// "jose.lipinski@denvercontabil.com.br" → "Jose Lipinski"
const nomeLegivel = (a) => { const n = nomeAutor(a) || ""; const m = /^([^@\s]+)@/.exec(n); return m ? m[1].split(/[._-]+/).filter(Boolean).map((x) => x.charAt(0).toUpperCase() + x.slice(1)).join(" ") : n; };
const motivoNA = (o) => `Não aplicável: comentado no portal${nomeLegivel(o.autor) ? " por " + nomeLegivel(o.autor) : ""}${iso(o.em) ? " em " + iso(o.em).slice(0, 10).split("-").reverse().join("/") : ""}`;

// Compara um ciclo com a fotografia anterior e devolve {base, tarefas, fechar}.
// tarefas: novas tarefas (só são gravadas se ainda não existirem); fechar: ids de tarefas de subitem que o portal já resolveu.
function analisaCiclo(bruto, ant, agora, inicial) {
  const L = (bruto && bruto.lista) || {}, D = (bruto && bruto.det) || {}, C = D.ciclo || {};
  const cicloId = String(L.id || C.id || "");
  const fundo = { cicloId, fundo: txt(C.fundoNome || L.fundoNome, 300) || "(sem nome)", cnpj: cnpjFmt(C.cnpj || L.cnpj), auditor: txt(C.auditor, 200),
    mesFindo: txt(C.mesFindo || L.mesFindo, 10), modalidade: txt(C.modalidade || L.modalidade, 40), analista: txt(C.analista || L.analista, 200), tipoFundo: txt(C.tipo || L.tipo, 40) };
  const antItens = (ant && ant.itens) || {}, antObs = new Set((ant && ant.obs) || []), antConv = new Set((ant && ant.conv) || []);
  const corte = inicial ? new Date(Date.parse(agora) - JANELA_INICIAL_DIAS * 86400000).toISOString() : "";
  const recente = (em) => !inicial || (em && em >= corte);
  const tarefas = [], fechar = [];
  const nova = (tipo, origemId, t) => tarefas.push({ id: chave(`${tipo}-${cicloId}-${origemId}`), tipo, ...fundo, chegouEm: agora, status: "aberta", resp: null, cargaInicial: inicial, ...t });

  // Regra da equipe: se o item "Conciliações mensais" do fundo tem anexo, os balancetes mensais e o razão contábil
  // já estão entregues junto. Esses subitens não ficam na caixa de entrada (entram direto em Concluídos).
  const conciliacaoComAnexo = (D.itens || []).some((it) => it && !it.secao && ehConciliacaoMensal(it.texto) && (it.anexos || []).length > 0);

  // subitens com comentário "Não aplicável" (de qualquer pessoa: equipe Denver, ID ou auditor); vale o mais recente
  const naItem = {};
  for (const o of D.observacoes || []) {
    if (!o || !o.itemId || !ehNaoAplicavel(o.texto)) continue;
    const k = String(o.itemId);
    if (!naItem[k] || String(iso(o.em) || "") > String(iso(naItem[k].em) || "")) naItem[k] = o;
  }

  const nomeItem = {}, itensBase = {};
  for (const it of D.itens || []) {
    if (!it || !it.id || it.secao) continue;
    const iid = String(it.id), st = String(it.status || "PENDENTE").toUpperCase(), antes = antItens[iid];
    const nome = txt(it.texto, 500) || "(sem nome)";
    nomeItem[iid] = nome; itensBase[iid] = st;
    if (st === "PENDENTE") {
      const na = naItem[iid], motivo = na ? motivoNA(na) : MOTIVO_CONCILIACAO;
      const coberto = !!na || (conciliacaoComAnexo && cobertoPelaConciliacao(nome));
      // subitem pedido (novo) ou devolvido para pendente pelo auditor
      if (!antes && !it.criadoPeloContador) nova("item", iid, { titulo: nome, texto: "Documento solicitado no checklist do portal.", itemId: iid, em: null,
        ...(coberto ? { status: "concluida", concluidaEm: agora, concluidaPor: null, auto: motivo } : {}) });
      else if (antes && antes !== "PENDENTE" && !coberto) nova("devolvido", `${iid}-${agora}`, { titulo: nome, texto: `Voltou para pendente (antes: ${antes === "RECEBIDO" ? "recebido" : "validado"}).`, itemId: iid, em: null });
      // a conciliação pode ter recebido o anexo depois: conclui a tarefa do subitem que ainda estiver aberta
      if (coberto) fechar.push({ id: chave(`item-${cicloId}-${iid}`), motivo });
    } else if (antes === "PENDENTE" || !antes) {
      // o portal registrou o documento: a tarefa do subitem (se houver) pode ser concluída
      fechar.push({ id: chave(`item-${cicloId}-${iid}`), motivo: st === "VALIDADO" ? "Validado no portal" : "Recebido no portal" });
    }
  }

  const obsIds = [];
  for (const o of D.observacoes || []) {
    if (!o || !o.id) continue;
    const oid = String(o.id); obsIds.push(oid);
    if (antObs.has(oid) || o.minha || daDenver(o.autor) || !recente(iso(o.em))) continue;
    nova("comentario", oid, { titulo: nomeItem[o.itemId] || "Subitem do checklist", texto: txt(o.texto, 4000), autor: nomeAutor(o.autor), itemId: o.itemId || null, em: iso(o.em),
      ...(ehNaoAplicavel(o.texto) ? { status: "concluida", concluidaEm: agora, concluidaPor: null, auto: motivoNA(o) } : {}) });
  }

  const convIds = [];
  for (const m of Array.isArray(D.conversas) ? D.conversas : []) {
    if (!m || !m.id) continue;
    const mid = String(m.id); convIds.push(mid);
    if (antConv.has(mid) || daDenver(m.autor, m.autorTipo) || !recente(iso(m.criadoEm))) continue;
    const pedido = m.tipo === "PEDIDO_DOCUMENTO";
    nova(pedido ? "pedido" : "mensagem", mid, { titulo: pedido ? "Pedido avulso de documento" : "Mensagem na conversa do fundo", texto: txt(m.mensagem, 4000), autor: nomeAutor(m.autor), autorTipo: txt(m.autorTipo, 40), em: iso(m.criadoEm) });
  }

  return { fundo, base: { ...fundo, itens: itensBase, obs: obsIds, conv: convIds, vistoEm: agora }, tarefas, fechar };
}

module.exports = rota(async (req, res) => {
  const m = await exigeMembro(req, res); if (!m) return;
  if (req.method !== "POST") return res.status(405).json({ code: "bad_request" });
  if (!podeEscrever(m)) return res.status(403).json({ code: "invalid_argument", message: "Só contribuidores e o dono atualizam o Portal ID." });
  const b = corpoJson(req);
  const agora = iso(b.inicio) && Math.abs(Date.parse(b.inicio) - Date.now()) < 86400000 ? iso(b.inicio) : new Date().toISOString();

  if (b.acao === "lote") {
    const ciclos = (Array.isArray(b.ciclos) ? b.ciclos : []).filter((c) => c && idOk((c.lista && c.lista.id) || (c.det && c.det.ciclo && c.det.ciclo.id))).slice(0, 40);
    if (!ciclos.length) return res.status(200).json({ tarefas: 0 });
    const inicial = !(await redis("HGET", P + "col:config", CFG));
    const ids = ciclos.map((c) => String((c.lista && c.lista.id) || c.det.ciclo.id));
    const antes = await pipeline(ids.map((id) => ["HGET", BASE, id]));
    const fundosAnt = await pipeline(ids.map((id) => ["HGET", FUNDOS, id]));
    const novas = [], fechar = [], baseCmds = [], fundoPaths = [];
    ciclos.forEach((c, i) => {
      const r = analisaCiclo(c, antes[i] ? JSON.parse(antes[i]) : null, agora, inicial);
      novas.push(...r.tarefas); fechar.push(...r.fechar);
      baseCmds.push(["HSET", BASE, r.base.cicloId, JSON.stringify(r.base)]);
      // dados do fundo (nome, CNPJ, mês findo, modalidade, analista…) ficam num cadastro à parte, sempre atualizado,
      // para as tarefas já existentes também mostrarem a informação mais recente
      const f = JSON.stringify(r.fundo);
      if (fundosAnt[i] !== f) { baseCmds.push(["HSET", FUNDOS, r.fundo.cicloId, f]); fundoPaths.push("pidFundos/" + r.fundo.cicloId); }
    });
    // cria só as tarefas que ainda não existem
    const criadas = novas.length ? await pipeline(novas.map((t) => ["HSETNX", TAREFAS, t.id, JSON.stringify(t)])) : [];
    const criadasLista = novas.filter((_, i) => +criadas[i] === 1);
    const paths = criadasLista.map((t) => "pidTarefas/" + t.id);
    let concluidasAuto = 0;
    // conclui automaticamente as tarefas de subitem que o portal já marcou como recebido/validado
    if (fechar.length) {
      const atuais = await pipeline(fechar.map((f) => ["HGET", TAREFAS, f.id])), cmds = [];
      fechar.forEach((f, i) => {
        const t = atuais[i] ? JSON.parse(atuais[i]) : null;
        // reaberta à mão pela equipe: a decisão da equipe prevalece sobre a conclusão automática
        if (!t || t.status !== "aberta" || t.reabertaManual) return;
        Object.assign(t, { status: "concluida", concluidaEm: agora, concluidaPor: null, auto: f.motivo });
        cmds.push(["HSET", TAREFAS, f.id, JSON.stringify(t)]); paths.push("pidTarefas/" + f.id);
      });
      if (cmds.length) await pipeline(cmds);
      concluidasAuto = cmds.length;
    }
    await pipeline(baseCmds);
    if (paths.length || fundoPaths.length) await registraMudanca([...paths, ...fundoPaths]);
    const porTipo = {};
    const abertas = criadasLista.filter((t) => t.status === "aberta");
    for (const t of abertas) porTipo[t.tipo] = (porTipo[t.tipo] || 0) + 1;
    // subitens que já nascem concluídos (regra das conciliações mensais) contam como concluídos automaticamente
    return res.status(200).json({ inicial, tarefas: abertas.length, porTipo, concluidasAuto: concluidasAuto + criadasLista.length - abertas.length });
  }

  if (b.acao === "finalizar") {
    const ant = await redis("HGET", P + "col:config", CFG);
    const r = b.resumo && typeof b.resumo === "object" ? b.resumo : {};
    const doc = {
      ultima: agora, fim: new Date().toISOString(), por: m.email, porNome: m.nome, usuarioPortal: txt(b.usuarioPortal, 200),
      primeira: (ant && JSON.parse(ant).primeira) || agora, inicial: !ant, ciclos: Math.max(0, +b.ciclos || 0),
      tarefas: Math.max(0, +r.tarefas || 0), concluidasAuto: Math.max(0, +r.concluidasAuto || 0),
    };
    await redis("HSET", P + "col:config", CFG, JSON.stringify(doc));
    await registraMudanca(["config/" + CFG]);
    return res.status(200).json({ ok: true, ...doc });
  }
  res.status(400).json({ code: "bad_request" });
});
// exportado para testes
module.exports.analisaCiclo = analisaCiclo;
module.exports.ehNaoAplicavel = ehNaoAplicavel;
