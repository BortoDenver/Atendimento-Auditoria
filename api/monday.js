// Sincronização com o Monday: acrescenta à ferramenta os fundos que existem no Monday e ainda não existem aqui.
// Nunca altera nem apaga fundos já existentes (grava com HSETNX).
// O token fica só no servidor (variável MONDAY_TOKEN). A página chama em passos curtos, por causa do limite de tempo da Vercel:
//   {acao:"quadros"}                       → lista dos quadros lidos
//   {acao:"listar", quadro, cursor}        → uma página do quadro: ids dos fundos novos (ignora grupos "Concluídos")
//   {acao:"importar", itens:[ids]}         → lê esses itens (com subitens), converte e grava os que ainda não existem
//   {acao:"registrar", adicionados}        → grava o resumo da sincronização em config/monday
const { redis, pipeline, P, exigeMembro, podeEscrever, corpoJson, rota, registraMudanca } = require("./_lib");

const QUADROS = [
  { id: "18402497518", nome: "Controle Auditoria 2026" },
  { id: "18402498338", nome: "Controle Auditoria Eventos" },
  { id: "18403098487", nome: "Controle Auditoria 2025" },
  { id: "18429762575", nome: "Horizon FIP" },
];
const EVENTOS = ["Transferência", "Liquidação", "Cisão", "Incorporação", "Transformação"];
// colunas de cartas (título no Monday → chave na ferramenta)
const CARTAS = {
  "rep. bancos": "rep_bancos", "circ. bancos": "circ_bancos", "rep. advogados": "rep_advogados", "circ. advogados": "circ_advogados",
  "rep. de atas": "rep_atas", "rep. de partes relacionadas": "rep_partes", "circ. de partes relacionadas": "circ_partes",
  "circ. consultoria": "circ_consultoria", "circ. cobranca": "circ_cobranca", "circ. cia. investida": "circ_cia_investida",
  "circ. cedentes/inquilinos": "circ_cedentes", "circ. b3": "circ_b3",
};
const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
function statusCarta(t) {
  const n = norm(t);
  if (!n || n.startsWith("nao inici")) return "nao_iniciada";
  if (n === "n/a" || n.startsWith("nao aplic")) return "na";
  if (n.includes("enviado ao auditor") || n.startsWith("disponibilizado")) return "enviada";
  if (n.startsWith("negativa") || n.startsWith("respondid")) return "respondida";
  if (n.includes("coletando assinatura") || n.includes("coletar assinatura")) return "assinatura";
  if (n.includes("adm")) return "adm";
  return "elaboracao";
}
function statusDoc(t) {
  const n = norm(t);
  if (!n || n === "pendente") return "afazer";
  if (n === "n/a") return "na";
  if (n === "feito" || n.startsWith("conclu") || n === "circularizado") return "enviado";
  if (n.startsWith("travado")) return "travado";
  if (n.startsWith("em andamento") || n.startsWith("parcial") || n.startsWith("recebido parcial") || n.startsWith("em reprocess")) return "andamento";
  if (n.startsWith("solicitado") || n.startsWith("aguardando")) return "aguardando";
  return "afazer";
}
const pagina = (quadro, grupo, auditor) => {
  const g = norm(grupo), a = norm(auditor);
  if (g.includes("reemiss")) return "reemissoes";
  if (g.includes("dispensad")) return "dispensados";
  if (quadro === "Controle Auditoria Eventos" || g.includes("evento")) return "eventos";
  if (a.includes("pendente") || a.includes("aguardando contrat")) return "pendente";
  return "exercicio";
};
const valores = (cvs) => {
  const v = {};
  for (const c of cvs || []) { const t = (c.text || c.display_value || "").trim(); if (t && c.column) v[norm(c.column.title)] = t; }
  return v;
};
const dia = (s) => (s ? String(s).slice(0, 10) : null);

function montaFundo(item, quadro) {
  const v = valores(item.column_values), pega = (...ts) => { for (const t of ts) if (v[norm(t)]) return v[norm(t)]; return null; };
  const grupo = (item.group && item.group.title) || "";
  let auditor = pega("Auditor");
  if (auditor && /^outro/i.test(auditor)) auditor = pega("Auditor Outro") || auditor;
  if (auditor && /aguardando contrat|pendente contrat/i.test(auditor)) auditor = "Pendente contratação";
  const ev = pega("Tipo do Evento", "Evento");
  const adm = pega("ADM") || (quadro === "Horizon FIP" ? "HORIZON TRUST" : null);
  const cartas = {};
  for (const [titulo, k] of Object.entries(CARTAS)) { const t = v[titulo]; cartas[k] = t ? { orig: t, s: statusCarta(t) } : { s: "nao_iniciada" }; }
  const docs = (item.subitems || []).map((s) => {
    const sv = valores(s.column_values), st = sv["status"] || null;
    const d = { id: String(s.id), nome: s.name, s: statusDoc(st), pedidoEm: dia(s.created_at), atualizadoEm: dia(s.updated_at) };
    if (st) d.origStatus = st;
    if (sv["responsavel"]) d.area = sv["responsavel"];
    if (sv["via:"]) d.via = sv["via:"];
    if (sv["comentarios"]) d.obs = sv["comentarios"];
    return d;
  });
  const f = {
    nome: item.name, cnpj: pega("CNPJ"), adm, aba: adm || "Sem administrador", auditor,
    tipo: pega("Tipo de Fundo") || (quadro === "Horizon FIP" ? "FIP" : null),
    exercicio: pega("Exercício Social"), ano: pega("Ano data base", "Ano data-base"), entrega: pega("Entrega"),
    tipoEvento: EVENTOS.includes(ev) ? ev : null, dataEvento: pega("Data!!!", "Data do Evento", "Data"),
    docInicial: pega("Doc. Inicial"), disponibilizar: pega("Disponibilizar no:"), andamentoMonday: pega("Andamento da Auditoria", "Andamento"),
    eiNei: pega("NEI/EI", "EI/NEI", "EI / NEI"),
    cartas, docs, etapa: "inbox", pagina: pagina(quadro, grupo, auditor), criadoEm: dia(item.created_at),
    monday: { quadro, grupo, url: item.url }, sincronizadoEm: new Date().toISOString(),
  };
  for (const k of Object.keys(f)) if (f[k] == null) delete f[k];
  return f;
}

async function monday(query, variables) {
  const tok = process.env.MONDAY_TOKEN;
  if (!tok) throw Object.assign(new Error("Integração com o Monday não configurada: falta a variável MONDAY_TOKEN na Vercel."), { status: 400, code: "server_not_connected" });
  const r = await fetch("https://api.monday.com/v2", { method: "POST", headers: { Authorization: tok, "Content-Type": "application/json", "API-Version": "2024-10" }, body: JSON.stringify({ query, variables }) });
  if (r.status === 401 || r.status === 403) throw Object.assign(new Error("O Monday recusou o token (MONDAY_TOKEN inválido ou sem acesso aos quadros)."), { status: 502 });
  const j = await r.json().catch(() => ({}));
  if (j.errors && j.errors.length) throw Object.assign(new Error("Monday: " + j.errors.map((e) => e.message).join("; ")), { status: 502 });
  if (j.error_message) throw Object.assign(new Error("Monday: " + j.error_message), { status: 502 });
  if (!r.ok || !j.data) throw Object.assign(new Error(`Monday respondeu ${r.status}.`), { status: 502 });
  return j.data;
}
const CAMPOS_ITEM = "id name group { title }";
const ignorado = (item) => /^conclu/i.test(norm(item.group && item.group.title));

module.exports = rota(async (req, res) => {
  const m = await exigeMembro(req, res); if (!m) return;
  if (req.method !== "POST") return res.status(405).json({ code: "bad_request" });
  if (!podeEscrever(m)) return res.status(403).json({ code: "invalid_argument", message: "Só contribuidores e o dono sincronizam com o Monday." });
  const b = corpoJson(req);

  if (b.acao === "quadros") return res.status(200).json({ quadros: QUADROS });

  if (b.acao === "listar") {
    const q = QUADROS.find((x) => x.id === String(b.quadro));
    if (!q) return res.status(400).json({ code: "bad_request", message: "Quadro desconhecido." });
    const d = b.cursor
      ? (await monday(`query($c:String!){ next_items_page(limit:250, cursor:$c){ cursor items { ${CAMPOS_ITEM} } } }`, { c: b.cursor })).next_items_page
      : ((await monday(`query($b:[ID!]){ boards(ids:$b){ items_page(limit:250){ cursor items { ${CAMPOS_ITEM} } } } }`, { b: [q.id] })).boards[0] || {}).items_page;
    const itens = ((d && d.items) || []).filter((i) => !ignorado(i));
    const existe = itens.length ? await pipeline(itens.map((i) => ["HEXISTS", P + "col:fundos", String(i.id)])) : [];
    const novos = itens.filter((i, k) => !+existe[k]).map((i) => ({ id: String(i.id), nome: i.name }));
    return res.status(200).json({ novos, lidos: (d && d.items || []).length, cursor: (d && d.cursor) || null });
  }

  if (b.acao === "importar") {
    const ids = (Array.isArray(b.itens) ? b.itens : []).map(String).filter((x) => /^\d{1,20}$/.test(x)).slice(0, 25);
    if (!ids.length) return res.status(200).json({ adicionados: 0 });
    const d = await monday(`query($ids:[ID!]){ items(ids:$ids, limit:25){ id name url created_at group { title } board { id }
      column_values { text column { title } ... on MirrorValue { display_value } }
      subitems { id name created_at updated_at column_values { text column { title } } } } }`, { ids });
    const cmds = [], paths = [];
    for (const it of d.items || []) {
      const q = QUADROS.find((x) => x.id === String(it.board && it.board.id));
      if (!q || ignorado(it)) continue;
      cmds.push(["HSETNX", P + "col:fundos", String(it.id), JSON.stringify(montaFundo(it, q.nome))]);
      paths.push("fundos/" + it.id);
    }
    const r = cmds.length ? await pipeline(cmds) : [];
    const gravados = paths.filter((_, i) => +r[i] === 1);
    if (gravados.length) await registraMudanca(gravados);
    return res.status(200).json({ adicionados: gravados.length, nomes: (d.items || []).filter((it) => gravados.includes("fundos/" + it.id)).map((it) => it.name) });
  }

  if (b.acao === "registrar") {
    const doc = { ultima: new Date().toISOString(), por: m.email, porNome: m.nome, adicionados: +b.adicionados || 0, lidos: +b.lidos || 0 };
    await redis("HSET", P + "col:config", "monday", JSON.stringify(doc));
    await registraMudanca(["config/monday"]);
    return res.status(200).json({ ok: true, ...doc });
  }
  res.status(400).json({ code: "bad_request" });
});
// exportado para testes
module.exports.montaFundo = montaFundo;
