// Equipe. GET: lista (qualquer membro). POST (só dono): salvar | remover.
const { redis, P, hashParaObj, hashSenha, exigeMembro, esqueceMembro, corpoJson, rota } = require("./_lib");
const PAPEIS = ["leitor", "contribuidor", "dono"];

module.exports = rota(async (req, res) => {
  const eu = await exigeMembro(req, res); if (!eu) return;
  if (req.method === "GET") {
    const todos = hashParaObj(await redis("HGETALL", P + "membros"));
    return res.status(200).json(Object.entries(todos).map(([email, v]) => { const m = JSON.parse(v); return { email, nome: m.nome || email, papel: m.papel }; }).sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR")));
  }
  if (eu.papel !== "dono") return res.status(403).json({ code: "invalid_argument", message: "Só o dono gerencia membros." });
  const b = corpoJson(req), email = String(b.email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ code: "bad_request", message: "E-mail inválido." });

  if (b.acao === "remover") {
    if (email === eu.email) return res.status(400).json({ code: "bad_request", message: "Você não pode remover a si mesmo." });
    await redis("HDEL", P + "membros", email); esqueceMembro(email);
    return res.status(200).json({ ok: true });
  }
  if (b.acao === "salvar") {
    const atual = JSON.parse((await redis("HGET", P + "membros", email)) || "null");
    const papel = PAPEIS.includes(b.papel) ? b.papel : (atual && atual.papel) || "contribuidor";
    if (email === eu.email && papel !== "dono") return res.status(400).json({ code: "bad_request", message: "Você não pode tirar o seu próprio papel de dono." });
    let m = { ...(atual || {}), nome: String(b.nome || (atual && atual.nome) || email).trim(), papel };
    if (b.senha) {
      if (String(b.senha).length < 8) return res.status(400).json({ code: "bad_request", message: "A senha precisa ter pelo menos 8 caracteres." });
      m = { ...m, ...hashSenha(b.senha), trocarSenha: true };
    } else if (!atual) return res.status(400).json({ code: "bad_request", message: "Defina uma senha provisória para o novo membro." });
    await redis("HSET", P + "membros", email, JSON.stringify(m)); esqueceMembro(email);
    return res.status(200).json({ ok: true });
  }
  res.status(400).json({ code: "bad_request" });
});
