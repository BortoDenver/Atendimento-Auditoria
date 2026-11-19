// Login por e-mail e senha. Ações: entrar, sair, eu, trocar (senha).
const { redis, P, hashSenha, confereSenha, criaSessao, apagaSessao, emailDaSessao, lerMembro, esqueceMembro, corpoJson, rota } = require("./_lib");

module.exports = rota(async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ code: "bad_request" });
  const b = corpoJson(req), acao = b.acao;

  if (acao === "entrar") {
    const email = String(b.email || "").trim().toLowerCase(), senha = String(b.senha || "");
    if (!email || !senha) return res.status(400).json({ code: "bad_request", message: "Informe e-mail e senha." });
    // limita tentativas: 10 a cada 15 minutos por e-mail
    const chave = P + "tent:" + email, n = await redis("INCR", chave);
    if (n === 1) await redis("EXPIRE", chave, 900);
    if (n > 10) return res.status(429).json({ code: "rate_limited", message: "Muitas tentativas. Aguarde 15 minutos." });

    let m = await lerMembro(email, true);
    // primeiro acesso: se ainda não há nenhum membro, o dono definido nas variáveis da Vercel é criado
    if (!m && (await redis("HLEN", P + "membros")) === 0 && email === String(process.env.ADMIN_EMAIL || "").toLowerCase() && senha === process.env.ADMIN_SENHA) {
      const { sal, hash } = hashSenha(senha);
      m = { nome: process.env.ADMIN_NOME || email, papel: "dono", sal, hash, criadoEm: new Date().toISOString() };
      await redis("HSET", P + "membros", email, JSON.stringify(m));
    }
    if (!m || !confereSenha(senha, m.sal, m.hash)) return res.status(401).json({ code: "invalid_argument", message: "E-mail ou senha incorretos." });
    await redis("DEL", chave);
    criaSessao(res, email);
    return res.status(200).json({ email, nome: m.nome || email, papel: m.papel, trocarSenha: !!m.trocarSenha });
  }

  if (acao === "sair") { apagaSessao(res); return res.status(200).json({ ok: true }); }

  const email = emailDaSessao(req), m = email ? await lerMembro(email, true) : null;
  if (!m) return res.status(401).json({ code: "needs_reauth", message: "Sessão expirada." });

  if (acao === "eu") return res.status(200).json({ email, nome: m.nome || email, papel: m.papel, trocarSenha: !!m.trocarSenha });

  if (acao === "trocar") {
    if (!confereSenha(String(b.atual || ""), m.sal, m.hash)) return res.status(400).json({ code: "invalid_argument", message: "Senha atual incorreta." });
    if (String(b.nova || "").length < 8) return res.status(400).json({ code: "bad_request", message: "A nova senha precisa ter pelo menos 8 caracteres." });
    const { sal, hash } = hashSenha(b.nova);
    await redis("HSET", P + "membros", email, JSON.stringify({ ...m, sal, hash, trocarSenha: false })); esqueceMembro(email);
    return res.status(200).json({ ok: true });
  }
  res.status(400).json({ code: "bad_request" });
});
