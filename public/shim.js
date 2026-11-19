/*
 * Denver PBC — ponte para hospedagem própria (Vercel + Redis da Vercel).
 *
 * A página (index.html) foi escrita para o claude.ai e chama window.claude.use("db" | "user" | "mcp").
 * Este arquivo oferece essas três funções usando as rotas /api desta hospedagem:
 *   db   → /api/db (Redis), com atualização periódica das mudanças feitas por outras pessoas
 *   user → /api/auth (login por e-mail e senha) e /api/membros
 *   mcp  → Microsoft Graph pelo navegador (Outlook e Teams, login Microsoft via MSAL) e /api/slack
 * Também acrescenta a tela de login e expõe window.pbc (conta, equipe, importação, sincronização e Microsoft)
 * para a tela de Configurações da página, além dos eventos "pbc:sync", "pbc:import", "pbc:membros" e "pbc:microsoft".
 */
(function () {
  "use strict";
  const INTERVALO = 30000; // ms entre consultas de mudanças (só com a aba visível)
  const MS_SCOPES = ["User.Read", "Mail.Read", "Mail.Read.Shared", "Chat.Read"];
  const st = { eu: null, membros: [], cfg: null, rev: 0, msal: null, msConta: null };

  // ---------- utilidades ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const erro = (code, message) => Object.assign(new Error(message || code), { code, message: message || code });
  async function api(caminho, opcoes) {
    const r = await fetch(caminho, { credentials: "same-origin", ...(opcoes || {}), headers: { "Content-Type": "application/json", ...((opcoes && opcoes.headers) || {}) } });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && caminho !== "/api/auth") { sessaoExpirou(); throw erro("needs_reauth", j.message); }
    if (!r.ok) throw erro(j.code || "upstream_error", j.message || `Erro ${r.status}`);
    return j;
  }
  const post = (caminho, corpo) => api(caminho, { method: "POST", body: JSON.stringify(corpo) });
  const PALETA = ["#2f6fb0", "#7c4dc4", "#2e8a57", "#b8457e", "#0f7d71", "#c2410c", "#8a6d0b", "#4a5fc1", "#9a4a2a", "#5b7f2a"];
  const cor = (v) => { let h = 0; for (const c of String(v)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return PALETA[h % PALETA.length]; };
  const perfil = (email) => { const m = st.membros.find((x) => x.email === email); return { id: email, name: (m && m.nome) || email, email, color: cor(email) }; };
  const domPronto = () => new Promise((ok) => (document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", ok, { once: true }) : ok()));
  const merge = (a, b) => {
    if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
      const o = { ...a }; for (const k of Object.keys(b)) o[k] = k in a ? merge(a[k], b[k]) : b[k]; return o;
    }
    return b;
  };

  // ---------- avisos para a página (sincronização e importação) ----------
  const emite = (nome, detalhe) => { try { window.dispatchEvent(new CustomEvent(nome, { detail: detalhe })); } catch (e) {} };
  const estadoSync = () => ({ ultima: st.ultimaSync || 0, erro: st.syncErro || "", intervalo: INTERVALO, visivel: document.visibilityState === "visible", rev: st.rev });
  const avisaSync = () => emite("pbc:sync", estadoSync());

  // ---------- tela de login (antes de a ferramenta abrir) ----------
  const CSS = `#pbc-cap{position:fixed;inset:0;z-index:100;display:grid;place-items:center;background:var(--bg,#f4f6f4);font:14px/1.45 "IBM Plex Sans",system-ui,sans-serif;color:var(--ink,#1a2422);padding:16px;overflow:auto}
    #pbc-cap .box{background:var(--surface,#fff);border:1px solid var(--line,#e1e5e1);border-radius:14px;padding:28px;max-width:400px;width:100%;display:flex;flex-direction:column;gap:14px;box-shadow:0 18px 50px rgba(0,0,0,.10)}
    #pbc-cap h1{margin:4px 0 0;font-size:21px}#pbc-cap p{margin:0;color:var(--muted,#5a6763);font-size:13px}
    #pbc-cap label{font-size:12px;font-weight:600;color:var(--muted,#5a6763);display:flex;flex-direction:column;gap:5px}
    #pbc-cap input{padding:10px 12px;border:1px solid var(--line,#e1e5e1);border-radius:8px;font:inherit;background:var(--surface-2,#f7f8f7);color:var(--ink,#1a2422);width:100%;box-sizing:border-box}
    #pbc-cap input:focus{outline:2px solid var(--accent,#1d5c54);outline-offset:0;border-color:transparent}
    #pbc-cap .pw{position:relative}#pbc-cap .pw button{position:absolute;right:6px;top:50%;transform:translateY(-50%);border:none;background:none;color:var(--muted,#5a6763);font:600 12px/1 inherit;padding:6px;cursor:pointer}
    #pbc-cap .go{padding:11px 14px;border-radius:8px;border:none;background:var(--accent,#1d5c54);color:var(--accent-ink,#fff);font:600 14px/1 inherit;cursor:pointer}
    #pbc-cap .go:disabled{opacity:.6;cursor:default}#pbc-cap .msg{font-size:13px;min-height:18px;color:var(--late,#a8221a)}
    #pbc-cap .x{margin-left:auto;border:none;background:none;font-size:22px;line-height:1;padding:2px 6px;cursor:pointer;color:inherit}
    #pbc-cap .marca{display:flex;align-items:center;gap:10px}#pbc-cap .marca i{width:36px;height:36px;border-radius:9px;background:var(--accent,#1d5c54);color:var(--accent-ink,#fff);display:grid;place-items:center;font:700 15px/1 inherit;font-style:normal}`;
  function capa(html) {
    let el = document.getElementById("pbc-cap");
    if (!el) { el = document.createElement("div"); el.id = "pbc-cap"; document.body.appendChild(el); }
    el.innerHTML = `<style>${CSS}</style><div class="box" role="dialog" aria-modal="true"><div class="marca"><i>D</i><div><b>Denver PBC</b><div style="font-size:12px;color:var(--muted,#5a6763)">Atendimento a Auditoria</div></div></div>${html}</div>`;
    el.querySelectorAll("[data-ver]").forEach((b) => (b.onclick = () => { const i = b.previousElementSibling; i.type = i.type === "password" ? "text" : "password"; b.textContent = i.type === "password" ? "Mostrar" : "Ocultar"; }));
    return el;
  }
  const fechaCapa = () => { const el = document.getElementById("pbc-cap"); if (el) el.remove(); };
  const campoSenha = (id, ph, ac, extra) => `<div class="pw"><input type="password" id="${id}" required placeholder="${ph}" autocomplete="${ac}" ${extra || ""}><button type="button" data-ver tabindex="-1">Mostrar</button></div>`;
  function telaLogin(aviso) {
    return new Promise((ok) => {
      const el = capa(`<div><h1>Entrar</h1><p>${esc(aviso || "Use o e-mail e a senha cadastrados pelo responsável da ferramenta.")}</p></div>
        <form id="pbcF" style="display:flex;flex-direction:column;gap:12px">
        <label>E-mail<input type="email" id="pbcE" required placeholder="nome@denvercontabil.com.br" autocomplete="username"></label>
        <label>Senha${campoSenha("pbcS", "Sua senha", "current-password")}</label>
        <button class="go" type="submit">Entrar</button></form><div class="msg" id="pbcM" role="alert"></div>`);
      const f = el.querySelector("#pbcF"), bt = f.querySelector(".go");
      f.onsubmit = async (e) => {
        e.preventDefault(); const msg = el.querySelector("#pbcM"); msg.textContent = ""; bt.disabled = true; bt.textContent = "Entrando…";
        try { ok(await post("/api/auth", { acao: "entrar", email: el.querySelector("#pbcE").value, senha: el.querySelector("#pbcS").value })); }
        catch (er) { msg.textContent = er.message; bt.disabled = false; bt.textContent = "Entrar"; }
      };
      setTimeout(() => el.querySelector("#pbcE").focus(), 50);
    });
  }
  function telaTrocarSenha() {
    return new Promise((ok) => {
      const el = capa(`<div><h1>Defina sua senha</h1><p>Você entrou com uma senha provisória. Escolha uma senha pessoal com pelo menos 8 caracteres.</p></div>
        <form id="pbcT" style="display:flex;flex-direction:column;gap:12px">
        <label>Senha provisória${campoSenha("pbcA", "Senha recebida", "current-password")}</label>
        <label>Nova senha${campoSenha("pbcN", "Mínimo 8 caracteres", "new-password", 'minlength="8"')}</label>
        <label>Repita a nova senha${campoSenha("pbcN2", "Repita", "new-password", 'minlength="8"')}</label>
        <button class="go" type="submit">Salvar e continuar</button></form><div class="msg" id="pbcM" role="alert"></div>`);
      el.querySelector("#pbcT").onsubmit = async (e) => {
        e.preventDefault(); const msg = el.querySelector("#pbcM");
        if (el.querySelector("#pbcN").value !== el.querySelector("#pbcN2").value) { msg.textContent = "As senhas não conferem."; return; }
        try { await post("/api/auth", { acao: "trocar", atual: el.querySelector("#pbcA").value, nova: el.querySelector("#pbcN").value }); fechaCapa(); ok(true); }
        catch (er) { msg.textContent = er.message; }
      };
    });
  }
  function sessaoExpirou() { if (!document.getElementById("pbc-cap")) telaLogin("Sua sessão expirou. Entre de novo.").then(() => location.reload()); }

  // ---------- importação dos arquivos exportados (docs.json e cofre.json) ----------
  let importando = null;
  async function importarArquivos(arquivos) {
    if (importando) throw erro("busy", "Já existe uma importação em andamento.");
    const lotes = [];
    for (const a of arquivos) {
      let itens;
      try { itens = JSON.parse(await a.text()); } catch (e) { throw erro("bad_request", `${a.name} não é um arquivo JSON válido.`); }
      if (!Array.isArray(itens) || !itens.every((x) => x && typeof x.path === "string" && x.data && typeof x.data === "object"))
        throw erro("bad_request", `${a.name} não está no formato exportado da ferramenta (lista de {path, data}).`);
      lotes.push({ nome: a.name, itens });
    }
    const total = lotes.reduce((n, l) => n + l.itens.length, 0);
    if (!total) throw erro("bad_request", "Os arquivos estão vazios.");
    importando = { feito: 0, total, arquivo: "", erro: "", fim: false };
    const avisa = () => emite("pbc:import", { ...importando });
    avisa();
    try {
      for (const l of lotes) {
        importando.arquivo = l.nome;
        for (let i = 0; i < l.itens.length; i += 50) {
          const parte = l.itens.slice(i, i + 50);
          for (let t = 1; ; t++) {
            try { await post("/api/db", { op: "importar", itens: parte }); importando.erro = ""; break; }
            catch (e) {
              if (t >= 4 || e.code === "invalid_argument" || e.code === "needs_reauth") throw e;
              importando.erro = "Conexão instável, tentando de novo…"; avisa(); await new Promise((r) => setTimeout(r, 1200 * t));
            }
          }
          importando.feito += parte.length; avisa();
        }
      }
      importando.fim = true; avisa();
      await consultaMudancas(); // traz os registros novos para a tela, sem recarregar
      return total;
    } catch (e) {
      importando.erro = e.message || "Falha na importação."; importando.fim = true; avisa(); throw e;
    } finally { importando = null; }
  }

  // ---------- funções da tela de Configurações ----------
  async function recarregaMembros() { st.membros = await api("/api/membros"); emite("pbc:membros", st.membros); return st.membros; }
  window.pbc = {
    eu: () => ({ ...st.eu }),
    config: () => ({ microsoft: !!(st.cfg && st.cfg.microsoft), slack: !!(st.cfg && st.cfg.slack) }),
    membros: () => st.membros.slice(),
    recarregaMembros,
    salvarMembro: async (o) => { await post("/api/membros", { acao: "salvar", ...o }); return recarregaMembros(); },
    removerMembro: async (email) => { await post("/api/membros", { acao: "remover", email }); return recarregaMembros(); },
    trocarSenha: (atual, nova) => post("/api/auth", { acao: "trocar", atual, nova }),
    sair: async () => { try { await post("/api/auth", { acao: "sair" }); } catch (e) {} location.reload(); },
    importar: importarArquivos,
    importando: () => (importando ? { ...importando } : null),
    sync: estadoSync,
    sincronizarAgora: () => consultaMudancas(true),
    microsoft: {
      conectado: () => (st.msConta ? st.msConta.username || "conectado" : ""),
      conectar: async () => { await conectarMicrosoft(); emite("pbc:microsoft", {}); },
      desconectar: async () => { if (st.msal && st.msConta) { try { st.msal.setActiveAccount && st.msal.setActiveAccount(null); } catch (e) {} } st.msConta = null; try { for (const k of Object.keys(sessionStorage)) if (/msal|login\.windows|microsoftonline/i.test(k)) sessionStorage.removeItem(k); } catch (e) {} emite("pbc:microsoft", {}); },
    },
  };

  // ---------- Microsoft (MSAL no navegador) ----------
  function carregaScript(src) { return new Promise((ok, falha) => { const s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = () => falha(new Error("Falha ao carregar " + src)); document.head.appendChild(s); }); }
  async function iniciaMsal() {
    if (!st.cfg.microsoft || st.msal) return;
    await carregaScript("https://cdn.jsdelivr.net/npm/@azure/msal-browser@2.38.3/lib/msal-browser.min.js");
    st.msal = new window.msal.PublicClientApplication({ auth: { clientId: st.cfg.microsoft.clientId, authority: "https://login.microsoftonline.com/" + st.cfg.microsoft.tenantId, redirectUri: location.origin + "/" }, cache: { cacheLocation: "sessionStorage" } });
    if (st.msal.initialize) await st.msal.initialize();
    st.msConta = st.msal.getAllAccounts()[0] || null;
  }
  async function conectarMicrosoft() {
    await iniciaMsal();
    if (!st.msal) throw erro("server_not_connected", "Login Microsoft não configurado (MS_CLIENT_ID / MS_TENANT_ID).");
    const r = await st.msal.loginPopup({ scopes: MS_SCOPES, loginHint: st.eu.email });
    st.msConta = r.account;
  }
  async function tokenMs() {
    await iniciaMsal().catch(() => {});
    if (!st.msal) throw erro("server_not_connected", "Login Microsoft não configurado (MS_CLIENT_ID / MS_TENANT_ID).");
    if (!st.msConta) throw erro("needs_reauth", "Conecte a conta Microsoft.");
    try { return (await st.msal.acquireTokenSilent({ scopes: MS_SCOPES, account: st.msConta })).accessToken; }
    catch (e) { return (await st.msal.acquireTokenPopup({ scopes: MS_SCOPES, account: st.msConta })).accessToken; }
  }

  // ---------- inicialização ----------
  const pronto = (async () => {
    st.cfg = await fetch("/api/config").then((r) => r.json()).catch(() => ({}));
    let eu = null;
    try { eu = await post("/api/auth", { acao: "eu" }); } catch (e) {}
    if (!eu) { await domPronto(); eu = await telaLogin(); fechaCapa(); }
    st.eu = eu;
    if (eu.trocarSenha) { await domPronto(); await telaTrocarSenha(); }
    st.membros = await api("/api/membros").catch(() => []);
    iniciaMsal().then(() => emite("pbc:microsoft", {})).catch(() => {});
    return true;
  })();

  // ---------- db (com atualização periódica) ----------
  const ouvintesCol = new Set(), ouvintesDoc = new Set();
  const opsJs = { ">=": (a, b) => String(a ?? "") >= String(b), ">": (a, b) => String(a ?? "") > String(b), "<=": (a, b) => String(a ?? "") <= String(b), "<": (a, b) => String(a ?? "") < String(b), "==": (a, b) => a === b, "!=": (a, b) => a !== b };
  const separa = (p) => [p.slice(0, p.lastIndexOf("/")), p.slice(p.lastIndexOf("/") + 1)];
  const snapCol = (o) => ({ docs: [...o.map.entries()].filter(([, d]) => !o.filtro || o.filtro(d)).map(([id, d]) => ({ id, data: () => d, exists: true })), metadata: { fromCache: false } });
  // aplica várias mudanças de uma vez e avisa cada ouvinte uma única vez
  function aplicaLote(lista) {
    const tocados = new Set();
    for (const { path, data } of lista) {
      const [col, id] = separa(path);
      for (const o of ouvintesCol) if (o.col === col && o.pronto) { if (data == null) o.map.delete(id); else o.map.set(id, data); tocados.add(o); }
      for (const o of ouvintesDoc) if (o.path === path && o.pronto) { o.ultimo = data; tocados.add(o); }
    }
    for (const o of tocados) {
      if (o.map) o.cb(snapCol(o));
      else { const d = o.ultimo; o.cb({ exists: d != null, data: () => (d == null ? undefined : d) }); }
    }
  }
  const aplica = (path, data) => aplicaLote([{ path, data }]);
  let consultando = null, proxima = null;
  function consultaMudancas(forcar) {
    if (!st.eu) return Promise.resolve();
    if (consultando) return forcar ? consultando.then(() => consultaMudancas()) : consultando;
    consultando = (async () => {
      try {
        const r = await api("/api/db?desde=" + st.rev);
        if (r.recarregar) { location.reload(); return; }
        if ((r.mudancas || []).length) aplicaLote(r.mudancas);
        st.rev = Math.max(st.rev, r.rev || 0);
        st.ultimaSync = Date.now(); st.syncErro = "";
      } catch (e) { st.syncErro = e.message || "sem conexão"; }
      finally { consultando = null; avisaSync(); }
    })();
    return consultando;
  }
  function agenda(ms) { clearTimeout(proxima); proxima = setTimeout(async () => { if (document.visibilityState === "visible") await consultaMudancas(); agenda(INTERVALO); }, ms); }
  document.addEventListener("visibilitychange", () => { avisaSync(); if (document.visibilityState === "visible") agenda(300); });
  window.addEventListener("focus", () => agenda(300));
  function colecao(col, where) {
    const filtro = where ? (d) => (opsJs[where[1]] || opsJs["=="])(d && d[where[0]], where[2]) : null;
    return {
      where: (f, op, v) => colecao(col, [f, op, v]),
      onSnapshot(cb, err) {
        const o = { col, filtro, cb, map: new Map(), pronto: false };
        ouvintesCol.add(o);
        const qs = new URLSearchParams({ col }); if (where) { qs.set("campo", where[0]); qs.set("op", where[1]); qs.set("valor", where[2]); }
        api("/api/db?" + qs).then((r) => {
          for (const d of r.docs || []) o.map.set(d.id, d.data);
          st.rev = st.rev ? Math.min(st.rev, r.rev || 0) : r.rev || 0;
          o.pronto = true; cb(snapCol(o)); st.ultimaSync = Date.now(); avisaSync(); agenda(INTERVALO);
        }).catch((e) => err && err(e));
        return () => ouvintesCol.delete(o);
      },
    };
  }
  function documento(path) {
    const buscar = () => api("/api/db?path=" + encodeURIComponent(path));
    const grava = async (corpo, local) => {
      const r = await post("/api/db", { ...corpo, path });
      aplica(path, r.data !== undefined ? r.data : local());
      agenda(800);
    };
    return {
      async get() { const r = await buscar(); return { exists: !!r.exists, data: () => r.data }; },
      set: (data) => grava({ op: "set", data }, () => data),
      update: (data) => grava({ op: "update", data }, () => data),
      delete: () => grava({ op: "delete" }, () => null),
      onSnapshot(cb, err) {
        const o = { path, cb, pronto: false };
        ouvintesDoc.add(o);
        buscar().then((r) => { o.pronto = true; cb({ exists: !!r.exists, data: () => r.data }); agenda(INTERVALO); }).catch((e) => err && err(e));
        return () => ouvintesDoc.delete(o);
      },
    };
  }
  const db = { collection: (c) => colecao(c), doc: (p) => documento(p) };

  // ---------- user ----------
  const user = {
    me: async () => perfil(st.eu.email),
    id: async () => st.eu.email,
    can: async (o) => (o === "data.write" ? ["contribuidor", "dono"].includes(st.eu.papel) : null),
    canEdit: async () => ["contribuidor", "dono"].includes(st.eu.papel),
    isOwner: async () => st.eu.papel === "dono",
    profiles: async (ids) => Object.fromEntries((ids || []).map((id) => [id, perfil(id)])),
    search: async (q) => { const n = String(q || "").toLowerCase(); return st.membros.filter((m) => !n || m.nome.toLowerCase().includes(n) || m.email.includes(n)).slice(0, 20).map((m) => perfil(m.email)); },
  };

  // ---------- mcp (Outlook, Teams, Slack) ----------
  const bloco = (o) => ({ type: "text", text: JSON.stringify(o) });
  async function graph(caminho) {
    const t = await tokenMs();
    const r = await fetch("https://graph.microsoft.com/v1.0" + caminho, { headers: { Authorization: "Bearer " + t } });
    if (r.status === 401) throw erro("needs_reauth", "A conexão com a Microsoft expirou.");
    if (r.status === 403) throw erro("blocked_by_policy", "Sem permissão no Microsoft 365 para essa caixa ou conversa.");
    if (!r.ok) throw erro("upstream_error", "Microsoft Graph respondeu " + r.status);
    return r.json();
  }
  async function outlook(i) {
    const top = Math.min(+i.limit || 25, 50), skip = +i.offset || 0;
    const desde = new Date(i.afterDateTime || Date.now() - 7 * 864e5).toISOString().replace(/\.\d{3}Z$/, "Z");
    const pasta = !i.folderName || /^inbox$/i.test(i.folderName) ? "inbox" : encodeURIComponent(i.folderName);
    const base = i.mailboxOwnerEmail ? "/users/" + encodeURIComponent(i.mailboxOwnerEmail) : "/me";
    const sel = "id,internetMessageId,subject,from,receivedDateTime,sentDateTime,bodyPreview,hasAttachments,webLink,isRead";
    const j = await graph(`${base}/mailFolders/${pasta}/messages?$top=${top}&$skip=${skip}&$orderby=receivedDateTime desc&$filter=receivedDateTime ge ${desde}&$select=${sel}`);
    const out = (j.value || []).map((m) => bloco({ id: m.id, internetMessageId: m.internetMessageId, subject: m.subject, sender: m.from?.emailAddress?.address || "", senderName: m.from?.emailAddress?.name || "",
      receivedDateTime: m.receivedDateTime, sentDateTime: m.sentDateTime, summary: m.bodyPreview || "", hasAttachments: !!m.hasAttachments, webLink: m.webLink, isRead: m.isRead }));
    if (j["@odata.nextLink"]) out.push(bloco({ moreResults: true, nextOffset: skip + top }));
    return { content: out };
  }
  async function teams(i) {
    const m = /^teams:\/\/\/chats\/([^/]+)\/messages$/.exec(i.uri || "");
    if (!m) throw erro("bad_request", "Recurso não suportado: " + i.uri);
    const chat = decodeURIComponent(m[1]);
    const j = await graph(`/me/chats/${encodeURIComponent(chat)}/messages?$top=50`);
    return { content: (j.value || []).map((x) => bloco({ id: x.id, messageType: x.messageType, from: x.from?.user?.displayName || x.from?.application?.displayName || "Unknown",
      createdDateTime: x.createdDateTime, webUrl: x.webUrl || "", subject: x.subject, bodyPreview: x.body?.content || "" })) };
  }
  const mcp = {
    async callTool(server, tool, input) {
      if (tool === "outlook_email_search") return outlook(input || {});
      if (tool === "read_resource") return teams(input || {});
      if (tool === "slack_read_channel") return post("/api/slack", input || {});
      throw erro("not_in_manifest", `Ferramenta não disponível: ${server} · ${tool}`);
    },
    watchTool(server, tool, input, handler) { mcp.callTool(server, tool, input).then((r) => handler({ type: "data", result: r }), (e) => handler({ type: "error", error: e })); return () => {}; },
    async invalidate() {},
  };

  window.claude = { use: async (nome) => { await pronto; return nome === "db" ? db : nome === "user" ? user : nome === "mcp" ? mcp : null; } };
})();
