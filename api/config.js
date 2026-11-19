// Configuração pública para o navegador.
module.exports = (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const ms = process.env.MS_CLIENT_ID && process.env.MS_TENANT_ID ? { clientId: process.env.MS_CLIENT_ID, tenantId: process.env.MS_TENANT_ID } : null;
  res.status(200).json({ microsoft: ms, slack: !!process.env.SLACK_TOKEN, monday: !!process.env.MONDAY_TOKEN });
};
