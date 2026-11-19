# Denver PBC — hospedagem própria (Vercel + Redis)

A mesma ferramenta do claude.ai, adaptada para rodar na sua conta da Vercel, com os dados num Redis (Upstash) conectado pela própria Vercel. Não há Supabase nem outro serviço externo de banco.

| Parte | Onde roda |
|---|---|
| Telas (`public/index.html`) | Vercel (site estático) |
| Banco de dados | Redis (Upstash), conectado em **Storage** na Vercel |
| Login, equipe e permissões | Funções `api/` da Vercel (senha por pessoa, sessão em cookie seguro) |
| Atualização entre usuários | A página consulta mudanças a cada 30 s, só com a aba aberta e visível |
| Outlook e Teams (Caixa de entrada) | Microsoft Graph, com o login Microsoft de quem clica em "Conectar Microsoft" |
| Slack (Caixa de entrada) | Função `api/slack.js`, com o token guardado só no servidor |
| PDFs anexos | `public/anexos/` |

O arquivo `public/shim.js` faz a ponte: a página continua chamando `window.claude.use("db" | "user" | "mcp")`, e o shim responde usando as funções `api/`, o Microsoft Graph e `/api/slack`.

## Estrutura

```
public/index.html     a ferramenta
public/shim.js        ponte: login, banco, equipe, Microsoft e Slack
public/anexos/*.pdf   anexos do Passo a passo
api/_lib.js           acesso ao Redis, senhas e sessão
api/auth.js           entrar, sair, trocar senha
api/membros.js        equipe e papéis (só o dono altera)
api/db.js             leitura, gravação, importação e feed de mudanças
api/config.js         diz à página se Microsoft e Slack estão configurados
api/slack.js          leitura dos canais do Slack
vercel.json, package.json, .env.example, .gitignore
```

Os dados exportados do claude.ai (`dados/docs.json` e `dados/cofre.json`) **não ficam no repositório**: o `cofre.json` tem senhas em texto aberto. Eles vêm num pacote separado.

---

## Passo 1 — Criar o projeto na Vercel

1. Na Vercel: **Add New → Project → Import** este repositório.
2. Framework Preset: **Other**. Não precisa de comando de build nem de instalar pacotes.
3. Faça o primeiro deploy (vai abrir, mas ainda sem banco).

## Passo 2 — Conectar o Redis

1. No projeto da Vercel: **Storage → Create Database → Upstash for Redis** (ou Marketplace → Upstash → Redis).
2. Região: a mais próxima (ex.: `São Paulo` / `us-east-1`). Plano **Free** atende.
3. **Connect Project** a este projeto. A Vercel cria sozinha as variáveis `KV_REST_API_URL` e `KV_REST_API_TOKEN`.

## Passo 3 — Variáveis de ambiente

Em **Settings → Environment Variables** (Production), cadastre (modelo em `.env.example`):

| Variável | Valor |
|---|---|
| `SESSION_SECRET` | texto aleatório com 32+ caracteres. Se trocar, todos precisam entrar de novo |
| `ADMIN_EMAIL` | `matheus@denvercontabil.com.br` |
| `ADMIN_SENHA` | senha inicial do dono (8+ caracteres); só vale no primeiro login |
| `ADMIN_NOME` | `Matheus Bortolansa` |
| `MS_CLIENT_ID`, `MS_TENANT_ID` | opcional, Passo 6 |
| `SLACK_TOKEN` | opcional, Passo 7 |
| `SLACK_CANAIS` | `C08BRNPQGSE,C08CMGGLDUN,C0697HS2KS8,C08BKLUSUM9` |

Depois de salvar, faça **Redeploy**.

## Passo 4 — Primeiro acesso e importação dos dados

1. Abra o endereço da Vercel e entre com `ADMIN_EMAIL` e `ADMIN_SENHA`. Esse primeiro login cria você como **dono** (só acontece enquanto não há nenhum membro).
2. Com a base vazia, a **Visão geral** já mostra a área de importação (também fica em **Configurações → Dados e sincronização**). Arraste `docs.json` e `cofre.json` do pacote de dados, ou clique e escolha os dois. O progresso aparece na hora, ali e no cartão da barra lateral (esperado: 506 registros). Importar de novo não duplica, mas substitui os registros pelo conteúdo do arquivo.
3. **Apague o pacote de dados do seu computador** depois de conferir.
4. Opcional: depois do primeiro login, você pode apagar `ADMIN_SENHA` da Vercel.

## Passo 5 — Cadastrar a equipe

Em **Configurações → Equipe e acessos → Adicionar usuário** (ou **Equipe → Cadastrar novo usuário**): nome, e-mail e papel. A senha provisória já vem gerada, e ao salvar aparece uma mensagem pronta para copiar e enviar à pessoa. Na primeira entrada, ela é obrigada a trocar a senha.

Papéis:
- **leitor**: só visualiza; não vê "Senhas e logins".
- **contribuidor**: edita tudo e vê "Senhas e logins".
- **dono**: tudo, e administra a equipe.

Esqueceu a senha? O dono clica em **Redefinir senha** na lista de pessoas. Na mesma lista o dono troca o papel ou remove o acesso.

## Passo 6 — Microsoft (Outlook e Teams na Caixa de entrada)

Peça ao TI para registrar um aplicativo no **Microsoft Entra ID** (portal.azure.com → App registrations → New registration):

1. Tipo de plataforma **Single-page application (SPA)**, Redirect URI = endereço da Vercel com barra no final (ex.: `https://denver-pbc.vercel.app/`).
2. **API permissions → Microsoft Graph → Delegated**: `User.Read`, `Mail.Read`, `Mail.Read.Shared`, `Chat.Read` → **Grant admin consent**.
3. Anote o **Application (client) ID** → `MS_CLIENT_ID` e o **Directory (tenant) ID** → `MS_TENANT_ID`. Não precisa de client secret.

Redeploy. Na ferramenta, vá em **Configurações → Integrações → Conectar conta Microsoft** (o acesso dura cerca de 1 hora e é renovado sozinho enquanto a sessão Microsoft estiver ativa).

Quem clicar em "Buscar novidades" precisa ter acesso à caixa compartilhada **auditoriafundos@denvercontabil.com.br** e participar das conversas do Teams **Atendimento a Auditoria** e **Contabilidade de Fundos**.

## Passo 7 — Slack

1. Em https://api.slack.com/apps → **Create New App → From scratch** (workspace da Denver).
2. **OAuth & Permissions → User Token Scopes**: `channels:history`, `groups:history`, `users:read`.
3. **Install to Workspace**, feito por alguém que participa dos 4 canais (`#id-aud-follow-up`, `#id-auditoria-next`, `#id-contabilidade-de-fundos`, `#id-upload-na-df`). O token lê o que essa pessoa enxerga.
4. Copie o **User OAuth Token** (`xoxp-…`) para `SLACK_TOKEN` e faça Redeploy.

Para incluir ou trocar canais, ajuste `SLACK_CANAIS` (servidor) e a lista `FONTES` em `public/index.html` (tela).

---

## Configurações e barra lateral

- **Configurações** (rodapé da barra lateral ou menu do seu nome, no topo) tem as seções Aparência (tema claro, escuro ou automático e densidade), Minha conta (senha e sair), Equipe e acessos, Dados e sincronização, e Integrações. Tema e densidade valem para cada pessoa, no próprio navegador.
- O cartão **Fundos do Monday**, no rodapé da barra lateral, mostra quantos fundos estão em cada etapa e o percentual concluído. Ele se atualiza sozinho a cada sincronização. Durante uma importação, vira uma barra de progresso.
- O botão de sol/lua no topo alterna o tema. A tecla `/` leva direto para a busca.

## Segurança

- Senhas guardadas com scrypt; sessão em cookie `HttpOnly`/`Secure` assinado com `SESSION_SECRET`; 10 tentativas de login a cada 15 minutos por e-mail.
- Todas as rotas `api/` exigem login. Leitor não grava e não lê "Senhas e logins"; só o dono altera a equipe e importa dados.
- `KV_REST_API_TOKEN`, `SESSION_SECRET` e `SLACK_TOKEN` ficam só nas variáveis da Vercel. Nunca no código nem no Git.
- Os PDFs em `public/anexos/` são públicos para quem tiver o link. São tutoriais, sem credenciais.

## Custos e limites

- **Upstash Free**: 500 mil comandos/mês e 256 MB. Uma consulta de mudanças sem novidades gasta cerca de 2 comandos. Com a aba visível 8 h/dia, 22 dias/mês, cada pessoa gasta cerca de 42 mil comandos/mês; uma equipe de até ~8 pessoas cabe no gratuito. Acima disso, o plano pago do Upstash cobra por uso (centavos de dólar por 100 mil comandos).
- O intervalo de consulta fica em `INTERVALO` no início de `public/shim.js`.
- **Teams**: cada busca lê as 50 mensagens mais recentes de cada conversa.

## Atualizações

A versão do claude.ai continua existindo. Mudanças feitas lá não chegam aqui automaticamente, e vice-versa. Para evoluir esta versão, edite `public/index.html` (telas) e faça push: a Vercel publica sozinha.
