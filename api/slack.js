// Lê os canais do Slack para a Caixa de entrada (token só no servidor; só membros logados).
// Resposta no mesmo formato que o conector do claude.ai devolvia.
const { exigeMembro, corpoJson, rota } = require("./_lib");
const CANAIS = (process.env.SLACK_CANAIS || "C08BRNPQGSE,C08CMGGLDUN,C0697HS2KS8,C08BKLUSUM9").split(",").map((s) => s.trim());
const nomes = new Map();
async function slack(metodo, params) {
  const r = await fetch(`https://slack.com/api/${metodo}?${new URLSearchParams(params)}`, { headers: { Authorization: `Bearer ${process.env.SLACK_TOKEN}` } });
  return r.json();
}
async function nomeDe(uid) {
  if (!uid) return "";
  if (nomes.has(uid)) return nomes.get(uid);
  const j = await slack("users.info", { user: uid }).catch(() => null), u = j && j.ok ? j.user : null;
  const n = u ? u.profile?.display_name || u.real_name || u.name || uid : uid;
  nomes.set(uid, n); return n;
}
const dataBR = (ts) => new Date(parseFloat(ts) * 1000 - 3 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19) + " -03";

module.exports = rota(async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ code: "bad_request" });
  if (!(await exigeMembro(req, res))) return;
  if (!process.env.SLACK_TOKEN) return res.status(501).json({ code: "server_not_connected", message: "O Slack não está configurado no servidor (variável SLACK_TOKEN)." });
  const { channel_id, oldest, limit = 100, cursor } = corpoJson(req);
  if (!CANAIS.includes(channel_id)) return res.status(403).json({ code: "blocked_by_policy", message: "Canal não liberado em SLACK_CANAIS." });
  const params = { channel: channel_id, limit: String(Math.min(+limit || 100, 200)) };
  if (oldest) params.oldest = String(oldest);
  if (cursor) params.cursor = cursor;
  const j = await slack("conversations.history", params);
  if (!j.ok) return res.status(502).json({ code: ["not_in_channel", "channel_not_found"].includes(j.error) ? "blocked_by_policy" : "upstream_error", message: `Slack: ${j.error}` });
  const partes = [];
  for (const m of j.messages || []) {
    if (m.subtype && !["bot_message", "thread_broadcast", "file_share"].includes(m.subtype)) continue;
    const nome = m.user ? await nomeDe(m.user) : m.username || m.bot_profile?.name || "bot";
    let texto = String(m.text || "");
    for (const uid of new Set([...texto.matchAll(/<@(U[A-Z0-9]+)>/g)].map((x) => x[1]))) texto = texto.split(`<@${uid}>`).join(`<@${uid}|${await nomeDe(uid)}>`);
    let p = `=== Message from ${nome}${m.bot_id ? " [BOT]" : ""} (${m.user || "U0BOT"}) at ${dataBR(m.ts)} === \nMessage TS: ${m.ts}\n${texto}`;
    if (m.reply_count) p += `\nThread: ${m.reply_count} replies`;
    if (m.files && m.files.length) p += `\nFiles: ${m.files.map((f) => f.name).join(", ")}`;
    partes.push(p);
  }
  const prox = j.response_metadata && j.response_metadata.next_cursor;
  res.status(200).json({ content: [{ type: "text", text: JSON.stringify({ messages: `Channel: ${channel_id}\n\n` + partes.join("\n\n"), pagination_info: prox ? `For the next page use cursor: \`${prox}\`` : "End of results" }) }] });
});
