/*
 * Denver PBC — ponte para hospedagem própria (Vercel + Redis da Vercel).
 *
 * A página (index.html) foi escrita para o claude.ai e chama window.claude.use("db" | "user" | "mcp").
 * Este arquivo oferece essas três funções usando as rotas /api desta hospedagem:
 *   db   → /api/db (Redis), com atualização periódica das mudanças feitas por outras pessoas
 *   user → /api/auth (login por e-mail e senha) e /api/membros
 *   mcp  → Microsoft Graph pelo navegador (Outlook e Teams, login Microsoft via MSAL) e /api/slack
 * Também acrescenta: tela de login, "Trocar senha", "Sair" e, para o dono, "Administração" (membros e importação).
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

  // ---------- telas (login, troca de senha, administração) ----------
  const CSS = `#pbc-cap{position:fixed;inset:0;z-index:100;display:grid;place-items:center;background:color-mix(in srgb,var(--bg,#f4f6f4) 92%,transparent);font:14px/1.45 "IBM Plex Sans",system-ui,sans-serif;color:var(--ink,#1a2422);padding:16px;overflow:auto}
    #pbc-cap .box{background:var(--surface,#fff);border:1px solid var(--line,#e1e5e1);border-radius:12px;padding:24px;max-width:440px;width:100%;display:flex;flex-direction:column;gap:12px;box-shadow:0 10px 30px rgba(0,0,0,.08)}
    #pbc-cap .box.larga{max-width:820px}#pbc-cap h1{margin:0;font-size:21px}#pbc-cap h2{margin:6px 0 0;font-size:15px}#pbc-cap p{margin:0;color:var(--muted,#5a6763)}
    #pbc-cap input,#pbc-cap select{padding:8px 10px;border:1px solid var(--line,#e1e5e1);border-radius:8px;font:inherit;background:var(--surface,#fff);color:inherit;min-width:0}
    #pbc-cap button{padding:8px 13px;border-radius:8px;border:1px solid var(--line,#e1e5e1);background:var(--surface,#fff);font:inherit;font-weight:600;cursor:pointer;color:inherit}
    #pbc-cap button.pri{background:var(--accent,#1d5c54);border-color:var(--accent,#1d5c54);color:var(--accent-ink,#fff)}#pbc-cap .msg{font-size:13px;min-height:18px}
    #pbc-cap table{width:100%;border-collapse:collapse;font-size:13px}#pbc-cap th,#pbc-cap td{text-align:left;padding:7px 6px;border-bottom:1px solid var(--line,#e1e5e1)}
    #pbc-cap .linha{display:flex;flex-wrap:wrap;gap:8px;align-items:center}#pbc-cap .x{margin-left:auto;border:none;background:none;font-size:20px;line-height:1;padding:2px 6px}`;
  function capa(html, larga) {
    let el = document.getElementById("pbc-cap");
    if (!el) { el = document.createElement("div"); el.id = "pbc-cap"; document.body.appendChild(el); }
    el.innerHTML = `<style>${CSS}</style><div class="box${larga ? " larga" : ""}"><div class="linha"><div style="width:32px;height:32px;border-radius:8px;background:var(--accent,#1d5c54);color:#fff;display:grid;place-items:center;font-weight:700">D</div><div><b>Denver PBC</b><div style="font-size:12px;color:var(--muted,#5a6763)">Atendimento a Auditoria</div></div></div>${html}</div>`;
    return el;
  }
  const fechaCapa = () => { const el = document.getElementById("pbc-cap"); if (el) el.remove(); };
  function telaLogin(aviso) {
    return new Promise((ok) => {
      const el = capa(`<h1>Entrar</h1>${aviso ? `<p>${esc(aviso)}</p>` : ""}<form id="pbcF" style="display:flex;flex-direction:column;gap:8px">
        <input type="email" id="pbcE" required placeholder="seu.nome@denvercontabil.com.br" autocomplete="username">
        <input type="password" id="pbcS" required placeholder="Senha" autocomplete="current-password">
        <button class="pri" type="submit">Entrar</button></form><div class="msg" id="pbcM"></div><p style="font-size:12px">Sem acesso? Peça ao responsável pela ferramenta para cadastrar seu e-mail.</p>`);
      el.querySelector("#pbcF").onsubmit = async (e) => {
        e.preventDefault(); const msg = el.querySelector("#pbcM"); msg.textContent = "Entrando…";
        try { const eu = await post("/api/auth", { acao: "entrar", email: el.querySelector("#pbcE").value, senha: el.querySelector("#pbcS").value }); ok(eu); }
        catch (er) { msg.textContent = er.message; }
      };
      setTimeout(() => el.querySelector("#pbcE").focus(), 50);
    });
  }
  function telaTrocarSenha(obrigatoria) {
    return new Promise((ok) => {
      const el = capa(`<div class="linha"><h1>${obrigatoria ? "Defina sua senha" : "Trocar senha"}</h1>${obrigatoria ? "" : `<button class="x" id="pbcX" title="Fechar">×</button>`}</div>
        ${obrigatoria ? "<p>Você entrou com uma senha provisória. Escolha uma senha pessoal (mínimo 8 caracteres).</p>" : ""}
        <form id="pbcT" style="display:flex;flex-direction:column;gap:8px"><input type="password" id="pbcA" required placeholder="Senha atual" autocomplete="current-password">
        <input type="password" id="pbcN" required minlength="8" placeholder="Nova senha" autocomplete="new-password"><input type="password" id="pbcN2" required minlength="8" placeholder="Repita a nova senha" autocomplete="new-password">
        <button class="pri" type="submit">Salvar</button></form><div class="msg" id="pbcM"></div>`);
      const x = el.querySelector("#pbcX"); if (x) x.onclick = () => { fechaCapa(); ok(false); };
      el.querySelector("#pbcT").onsubmit = async (e) => {
        e.preventDefault(); const msg = el.querySelector("#pbcM");
        if (el.querySelector("#pbcN").value !== el.querySelector("#pbcN2").value) { msg.textContent = "As senhas não conferem."; return; }
        try { await post("/api/auth", { acao: "trocar", atual: el.querySelector("#pbcA").value, nova: el.querySelector("#pbcN").value }); fechaCapa(); ok(true); }
        catch (er) { msg.textContent = er.message; }
      };
    });
  }
  async function telaAdmin() {
    const desenha = async (aviso) => {
      st.membros = await api("/api/membros");
      const el = capa(`<div class="linha"><h1>Administração</h1><button class="x" id="pbcX" title="Fechar">×</button></div>
        <h2>Membros da equipe</h2><p>Leitor: só visualiza. Contribuidor: edita e vê “Senhas e logins”. Dono: tudo, inclusive esta tela.</p>
        <div style="overflow:auto"><table><thead><tr><th>Nome</th><th>E-mail</th><th>Papel</th><th></th></tr></thead><tbody>
        ${st.membros.map((m) => `<tr data-e="${esc(m.email)}"><td>${esc(m.nome)}</td><td>${esc(m.email)}</td><td><select data-papel>${["leitor", "contribuidor", "dono"].map((p) => `<option${p === m.papel ? " selected" : ""}>${p}</option>`).join("")}</select></td>
          <td style="white-space:nowrap"><button data-acao="senha">Nova senha</button> ${m.email === st.eu.email ? "" : `<button data-acao="remover">Remover</button>`}</td></tr>`).join("")}</tbody></table></div>
        <form id="pbcNovo" class="linha"><input id="pbcNn" placeholder="Nome" required style="flex:1 1 140px"><input id="pbcNe" type="email" placeholder="e-mail" required style="flex:2 1 200px">
          <select id="pbcNp"><option>contribuidor</option><option>leitor</option><option>dono</option></select><input id="pbcNs" placeholder="Senha provisória (8+)" minlength="8" required style="flex:1 1 150px"><button class="pri" type="submit">Adicionar</button></form>
        <h2>Importar dados</h2><p>Use os arquivos <b>docs.json</b> e <b>cofre.json</b> exportados do claude.ai. Pode importar de novo: os registros são substituídos pelo mesmo caminho.</p>
        <div class="linha"><input type="file" id="pbcArq" accept=".json,application/json" multiple><button id="pbcImp" class="pri">Importar</button></div>
        <div class="msg" id="pbcM">${esc(aviso || "")}</div>`, true);
      const msg = el.querySelector("#pbcM");
      el.querySelector("#pbcX").onclick = fechaCapa;
      el.querySelectorAll("[data-papel]").forEach((s) => (s.onchange = async () => {
        const email = s.closest("tr").dataset.e;
        try { await post("/api/membros", { acao: "salvar", email, papel: s.value }); desenha("Papel atualizado."); } catch (er) { msg.textContent = er.message; }
      }));
      el.querySelectorAll("[data-acao]").forEach((b) => (b.onclick = async () => {
        const email = b.closest("tr").dataset.e;
        try {
          if (b.dataset.acao === "remover") { if (!confirm(`Remover ${email} da equipe?`)) return; await post("/api/membros", { acao: "remover", email }); desenha("Membro removido."); }
          else { const s = prompt(`Senha provisória para ${email} (mínimo 8 caracteres). A pessoa vai trocar no próximo acesso.`); if (!s) return; await post("/api/membros", { acao: "salvar", email, senha: s }); desenha("Senha provisória definida."); }
        } catch (er) { msg.textContent = er.message; }
      }));
      el.querySelector("#pbcNovo").onsubmit = async (e) => {
        e.preventDefault();
        try { await post("/api/membros", { acao: "salvar", nome: el.querySelector("#pbcNn").value, email: el.querySelector("#pbcNe").value, papel: el.querySelector("#pbcNp").value, senha: el.querySelector("#pbcNs").value }); desenha("Membro adicionado. Passe a senha provisória por um canal seguro."); }
        catch (er) { msg.textContent = er.message; }
      };
      el.querySelector("#pbcImp").onclick = async () => {
        const arqs = [...el.querySelector("#pbcArq").files]; if (!arqs.length) { msg.textContent = "Escolha os arquivos."; return; }
        let total = 0;
        try {
          for (const a of arqs) {
            const itens = JSON.parse(await a.text()); if (!Array.isArray(itens)) throw new Error(`${a.name} não está no formato esperado.`);
            for (let i = 0; i < itens.length; i += 100) {
              const r = await post("/api/db", { op: "importar", itens: itens.slice(i, i + 100) }); total += r.importados;
              msg.textContent = `Importando ${a.name}: ${Math.min(i + 100, itens.length)}/${itens.length}…`;
            }
          }
          msg.textContent = `Pronto: ${total} registros importados. Recarregue a página para ver tudo.`;
        } catch (er) { msg.textContent = "Falha na importação: " + er.message; }
      };
    };
    try { await desenha(); } catch (er) { alert(er.message); }
  }
  function sessaoExpirou() { if (!document.getElementById("pbc-cap")) telaLogin("Sua sessão expirou. Entre de novo.").then(() => location.reload()); }
  function barraUsuario() {
    const alvo = document.querySelector(".top-right"); if (!alvo || document.getElementById("pbcBarra")) return;
    const span = document.createElement("span"); span.id = "pbcBarra"; span.style.cssText = "display:inline-flex;gap:8px;align-items:center;flex-wrap:wrap";
    span.innerHTML = `${st.cfg.microsoft ? `<button class="btn" id="pbcMs" title="Necessário para buscar e-mails e mensagens do Teams na Caixa de entrada"${st.msConta ? " hidden" : ""}>Conectar Microsoft</button>` : ""}
      ${st.eu.papel === "dono" ? `<button class="btn" id="pbcAdm">Administração</button>` : ""}<button class="btn" id="pbcSenha">Trocar senha</button><button class="btn" id="pbcSair">Sair</button>`;
    alvo.appendChild(span);
    const ms = span.querySelector("#pbcMs"); if (ms) ms.onclick = () => conectarMicrosoft().then(() => { ms.hidden = true; }).catch((e) => alert(e.message));
    const adm = span.querySelector("#pbcAdm"); if (adm) adm.onclick = telaAdmin;
    span.querySelector("#pbcSenha").onclick = () => telaTrocarSenha(false);
    span.querySelector("#pbcSair").onclick = async () => { try { await post("/api/auth", { acao: "sair" }); } catch (e) {} location.reload(); };
  }

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
    if (eu.trocarSenha) { await domPronto(); await telaTrocarSenha(true); }
    st.membros = await api("/api/membros").catch(() => []);
    iniciaMsal().catch(() => {});
    domPronto().then(() => setTimeout(barraUsuario, 300));
    return true;
  })();

  // ---------- db (com atualização periódica) ----------
  const ouvintesCol = new Set(), ouvintesDoc = new Set();
  const opsJs = { ">=": (a, b) => String(a ?? "") >= String(b), ">": (a, b) => String(a ?? "") > String(b), "<=": (a, b) => String(a ?? "") <= String(b), "<": (a, b) => String(a ?? "") < String(b), "==": (a, b) => a === b, "!=": (a, b) => a !== b };
  const separa = (p) => [p.slice(0, p.lastIndexOf("/")), p.slice(p.lastIndexOf("/") + 1)];
  const snapCol = (o) => ({ docs: [...o.map.entries()].filter(([, d]) => !o.filtro || o.filtro(d)).map(([id, d]) => ({ id, data: () => d, exists: true })), metadata: { fromCache: false } });
  function aplica(path, data) {
    const [col, id] = separa(path);
    for (const o of ouvintesCol) if (o.col === col && o.pronto) { if (data == null) o.map.delete(id); else o.map.set(id, data); o.cb(snapCol(o)); }
    for (const o of ouvintesDoc) if (o.path === path && o.pronto) o.cb({ exists: data != null, data: () => (data == null ? undefined : data) });
  }
  let consultando = false, proxima = null;
  async function consultaMudancas() {
    if (consultando || !st.eu) return; consultando = true;
    try {
      const r = await api("/api/db?desde=" + st.rev);
      if (r.recarregar) { location.reload(); return; }
      for (const m of r.mudancas || []) aplica(m.path, m.data);
      st.rev = Math.max(st.rev, r.rev || 0);
    } catch (e) {} finally { consultando = false; }
  }
  function agenda(ms) { clearTimeout(proxima); proxima = setTimeout(async () => { if (document.visibilityState === "visible") await consultaMudancas(); agenda(INTERVALO); }, ms); }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") agenda(300); });
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
          o.pronto = true; cb(snapCol(o)); agenda(INTERVALO);
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
