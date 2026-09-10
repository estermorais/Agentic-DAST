# HANDOFF — Agentic DAST para Red Team

Documento de entrega do framework Agentic DAST em modo produção,
para uso pelo time de segurança ofensiva.

**Autora do framework:** Ester Morais Neves
**Contato:** estermoraisneves@gmail.com
**Repositório:** https://github.com/estermorais/Agentic-DAST
**Versão:** 1.0 (validada sobre OWASP Juice Shop v17.2.0, n=30 rodadas)

---

## O que é

Agente autônomo baseado em LLM (Claude Haiku 4.5 por padrão) que faz
DAST em SPAs autenticadas. Foi construído para o TCC da autora e
validado empiricamente sobre o OWASP Juice Shop, atingindo F1 médio
de 0,635 e cobertura de 16/19 vulnerabilidades documentadas.

O módulo `src/production-mode/` é uma camada de segurança opcional
que envolve o agente principal com aprovação humana antes de ações
destrutivas ou sensíveis. Foi construído especificamente para permitir
uso em ambientes autorizados sem risco de causar dano ao alvo.

---

## Estado atual do framework para uso em produção

| Item | Status |
|---|---|
| Módulo `production-mode` implementado e compila | ✅ |
| Testes unitários do classificador de risco | ❌ (não escritos) |
| Rodada real em alvo de produção autorizado | ❌ (nunca executada) |
| Rodada de sanity check contra alvo público (httpbin, etc.) | ❌ (recomendada antes da primeira rodada real) |
| Documentação de uso | ✅ ([README.md](./README.md)) |

**Implicação:** o red team será o **primeiro grupo a usar em alvo real.**
Comportamento em produção não foi validado empiricamente. Trate como
alpha, não como release.

---

## Quickstart

Assumindo Node 20+ instalado, Claude Code CLI instalado
(`claude login` feito com a conta Pro corporativa) e o alvo com
autorização:

```bash
git clone https://github.com/estermorais/Agentic-DAST.git
cd Agentic-DAST/agentic-dast
npm install
npm run build

# Configure .env
cat > .env <<EOF
LLM_PROVIDER=claude-cli
LLM_MODEL=claude-haiku-4-5-20251001
TARGET_URL=https://alvo-autorizado.empresa.com
BROWSER_BASE_URL=https://alvo-autorizado.empresa.com
USE_ZAP_PROXY=false
MAX_REACT_ITERATIONS=15

# Autenticacao no alvo (escolha UMA das linhas abaixo):
INTERACTIVE_LOGIN=true               # abre browser, voce loga uma vez
# MANUAL_JWT=eyJhbGciOi...           # ou cole o Bearer token
# MANUAL_COOKIES=SESSIONID=abc; ...  # ou cole os cookies de sessao
EOF

mkdir -p logs reports

# Primeira rodada obrigatoria: read-only, com humano no loop
READ_ONLY=true \
INTERACTIVE=true \
AUDIT_LOG=./logs/first-run.csv \
SKIP_ABUSE_CASES=true \
npm run start:production
```

Ao iniciar, o framework vai abrir uma janela do Chromium (por
causa do `INTERACTIVE_LOGIN=true`) e pedir que voce faca login
manualmente. Depois de logada, volte ao terminal e pressione
ENTER. O restante da rodada segue automatico com a sessao
capturada.

> **Sobre `INTERACTIVE` vs `INTERACTIVE_LOGIN`**: sao coisas
> diferentes. `INTERACTIVE=true` pede aprovacao humana `[y/n]`
> em cada acao destrutiva do agente durante a rodada.
> `INTERACTIVE_LOGIN=true` abre o browser uma vez no inicio para
> voce fazer o login manual e capturar a sessao. As duas podem
> (e devem) ser usadas juntas em producao.

Documentação completa: [`README.md`](./README.md) neste diretório.

---

## Escolha do LLM (decisão importante antes de rodar)

O framework é agnóstico ao provedor de LLM. Suporta três configurações,
escolhidas via variável de ambiente `LLM_PROVIDER`. **Antes de rodar
contra qualquer sistema da empresa, defina qual usar em conjunto com o
DPO/time de segurança**, porque a escolha afeta onde os dados do alvo
vão trafegar.

| Provider | `LLM_PROVIDER` | Modelo padrão | Custo | Onde os dados trafegam |
|---|---|---|---|---|
| **OpenRouter** (default) | `openrouter` | Claude Haiku 4.5 | ~US$ 0,82 por rodada | Sua máquina → OpenRouter (EUA) → Anthropic (EUA) |
| **Anthropic direto** | `anthropic` | Claude Haiku 4.5 | ~US$ 0,82 por rodada | Sua máquina → Anthropic (EUA) |
| **Claude Code CLI** | `claude-cli` | Configurável via `LLM_MODEL` | Zero (usa assinatura Claude Pro da empresa) | Sua máquina → Anthropic (EUA) |
| **Ollama local** | `ollama` | Llama 3.1 / Qwen 2.5 (a definir) | Zero (compute local) | Nada sai da sua máquina |

### Implicação de LGPD

O CRM da empresa provavelmente contém dados pessoais de clientes
brasileiros. Se rodar com `openrouter` ou `anthropic`, cada resposta
`GET /api/leads`, `GET /api/contacts`, etc. **é enviada para servidores
nos EUA** como parte do prompt do LLM. Isso configura transferência
internacional de dados pessoais (art. 33 da LGPD) e precisa estar
alinhado com o DPO da empresa.

**Se essa aprovação não for possível**, use `LLM_PROVIDER=ollama`.
Trade-off: modelos locais (Llama 3.1 8B, Qwen 2.5 14B) têm qualidade
menor que o Claude Haiku 4.5 no raciocínio ReAct estruturado. Vão errar
formato com mais frequência, entrar em loop com mais frequência e
detectar menos vulnerabilidades. Ainda vale a pena se a alternativa é
não rodar.

### Configuração via `.env`

**OpenRouter (default):**
```env
LLM_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-v1-...      # obter em openrouter.ai/keys
LLM_MODEL=claude-haiku-4-5-20251001
```

**Anthropic direto:**
```env
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...          # obter em console.anthropic.com
LLM_MODEL=claude-haiku-4-5-20251001
```

**Claude Code CLI (usa assinatura Pro da empresa, sem custo adicional):**
```env
LLM_PROVIDER=claude-cli
LLM_MODEL=claude-haiku-4-5-20251001   # ver aviso científico abaixo
```

Pré-requisitos:
- `claude` CLI instalado e disponível no PATH
  ([code.claude.com/docs/en/install-claude-code](https://code.claude.com/docs/en/install-claude-code))
- Login OAuth previamente feito com `claude login` usando a conta
  Pro da empresa

Trade-offs em relação ao OpenRouter/Anthropic:

- **Rate limit do plano Pro** vai bater durante rodadas longas. Aconteceu
  no Cenário D do TCC 2 e exigiu pausas e retomadas. O framework detecta
  e reporta, mas o red team precisa estar pronto para esperar.
- **Overhead de ~1s por iteração** (cada Action do agente vira um
  `subprocess spawn`).
- **Prompt caching Anthropic-style não funciona** por este canal, o que
  em rodadas longas pode consumir mais quota do Pro do que o esperado.
- **Cada invocação aparece nos logs de uso** da conta Pro.

> ⚠️ **Aviso científico**: para que rodadas do red team possam alimentar
> o estudo de generalização do artigo, o `LLM_MODEL` **deve ser
> exatamente** `claude-haiku-4-5-20251001` (o mesmo do TCC 2). Se usarem
> outro modelo (Sonnet, Opus), os dados servem como pentest interno mas
> **não** como replicação científica direta — o desempenho medido
> refletiria o modelo escolhido, não o mesmo LLM que gerou os resultados
> publicados. A ideia do estudo é testar o **agente**, não o LLM
> substituído. Deixe isto claro no CSV de audit para não confundir
> análises futuras.

**Ollama local (nada sai da máquina):**
```env
LLM_PROVIDER=ollama
OLLAMA_MODEL=qwen2.5:14b
OLLAMA_HOST=http://localhost:11434
```

Requer Ollama instalado localmente (`ollama pull qwen2.5:14b`) e uma
GPU decente (RTX 3060+) para performance razoável.

### Custo estimado para o red team

Se optarem por OpenRouter ou Anthropic, o consumo esperado por rodada
`READ_ONLY=true` é **inferior a US$ 0,82** (menos ações executadas =
menos tokens processados). Para 10 rodadas de avaliação inicial no
CRM, orçar **US$ 10 em créditos** já cobre com folga. Custo pode ser
compartilhado como despesa de projeto de segurança.

---

## Autenticação em alvos com MFA / SSO / CAPTCHA

> **Nota (modo produção):** a Fase 1 em `npm run start:production` usa o
> `ProductionPerception` (não o `DOMExtractor`, que é o extrator validado
> sobre o Juice Shop e permanece **intocado**). O `ProductionPerception`
> **não** tenta login automático com credenciais hardcoded — em alvo real
> quem faz o login é você (via `INTERACTIVE_LOGIN` ou `MANUAL_*`). Ele
> também descobre as rotas por **crawl real** do alvo, em vez da lista
> fixa de rotas do Juice Shop.

Em qualquer alvo real com MFA ou SSO, login automatizado **não funciona**
— Puppeteer não consegue passar o segundo fator sozinho.

**Solução**: três alternativas, escolha a mais prática pro seu contexto.
Todas resultam na mesma coisa (sessão autenticada disponível no
`AppMap.auth`); a diferença é como você fornece as credenciais.

- **Login interativo** (`INTERACTIVE_LOGIN=true`) — o framework abre
  o browser visível, você faz login manualmente uma vez, ele captura
  a sessão. Recomendado quando é mais prático logar do que copiar
  tokens. **Requer display no laptop** (não funciona em servidor
  headless).
- **JWT manual** (`MANUAL_JWT=...`) — você cola o Bearer token
  copiado do DevTools. Bom pra scripts automatizados e para servidor
  headless.
- **Cookies manuais** (`MANUAL_COOKIES=...`) — você cola os cookies
  de sessão copiados do DevTools. Idem.

Prioridade se mais de uma estiver preenchida: `INTERACTIVE_LOGIN`
vence `MANUAL_JWT`/`MANUAL_COOKIES`.

Em qualquer dos três, o framework:
- Não executa login automático (não há credenciais hardcoded no modo
  produção)
- Injeta a sessão no Puppeteer antes da Fase 1 (Percepção autenticada)
- Injeta JWT e Cookie como headers default no HttpClient (todas as
  requests `make_request` do agente saem já autenticadas)
- **Propaga a sessão completa** (cookies de todos os domínios +
  `localStorage`/`sessionStorage`) para o **browser do agente** na Fase 2,
  antes do loop ReAct. Sem esse handoff, o browser do agente subia limpo e
  as ações `navigate` caíam de volta no login em SPAs OAuth/SSO (onde o
  token vive no storage, não em header). Se nenhuma sessão foi capturada, o
  runner emite um aviso `Nenhuma sessao de browser capturada para o
  handoff` — sinal de que você rodou sem `INTERACTIVE_LOGIN`/`MANUAL_*`.

### Opção 1 — Login interativo (recomendado)

Usar quando você prefere logar no browser em vez de copiar tokens.
Contorna MFA/SSO/CAPTCHA naturalmente porque quem faz o login é
você.

**Como usar:**

```env
INTERACTIVE_LOGIN=true
```

Ou em PowerShell antes de rodar:

```powershell
$env:INTERACTIVE_LOGIN = "true"
```

Ao iniciar `npm run start:production`, o framework vai:

1. Abrir uma janela do Chromium visível na URL do `TARGET_URL`
2. Mostrar no terminal a mensagem:
   ```
   MODO INTERATIVO — LOGIN MANUAL
   Abrindo <URL> no browser visivel.
   Faca login normalmente (senha + MFA + SSO conforme aplicavel).
   Quando estiver DENTRO da aplicacao autenticada, volte ao
   terminal e pressione ENTER.
   ```
3. Aguardar você fazer o login manualmente na janela
4. Após você pressionar ENTER no terminal, capturar automaticamente:
   - **Todos os cookies de todos os domínios** (via CDP
     `Network.getAllCookies`) — inclui cookies de sessão emitidos por
     subdomínios de auth/SSO, não só do host do alvo
   - `localStorage` **e** `sessionStorage` da origem autenticada (onde
     ficam os tokens OAuth de SPAs modernas)
5. **Fechar a janela visível** e reabrir o browser em modo headless
   (invisível), restaurando a sessão completa: cookies com o
   domínio/path originais **e** o storage reescrito na origem correta.
   Em seguida **verifica** se a sessão sobreviveu — se o alvo carregar
   autenticado, mostra `Sessão verificada: alvo carregou autenticado. ✓`;
   se redirecionar para o login/OAuth, emite um **aviso** explícito (o
   token pode estar num cookie/origem que ainda escapou). A partir daqui
   a rodada segue sem janelas na sua tela.

**Requisitos:**
- Máquina com display para a janela de login (não funciona em
  servidor headless / SSH sem X forwarding)
- Você fica no laptop **apenas até apertar o ENTER**. Depois disso
  o browser fecha e a rodada continua totalmente headless — pode
  deixar o laptop de lado ou trabalhar em outra coisa.

### Opção 2 — JWT (Bearer token)

Usar quando você prefere colar o token manualmente, ou quando roda
em servidor headless. Padrão em SPAs modernas e APIs REST.

**Como obter:**
1. Faça login no CRM pelo seu Chrome normalmente (senha + MFA)
2. Abra **DevTools → aba Network**
3. Faça qualquer ação autenticada (recarregar tela, clicar em menu)
4. Clique numa das requests → aba **Headers** → procure `Authorization: Bearer <token>`
5. Copie **só a parte do token** (o texto depois de `Bearer `)

**Como passar:**
```env
MANUAL_JWT=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

### Opção 3 — Cookies de sessão

Usar quando o CRM autentica via cookies HTTP (comum em apps
tradicionais com `SESSIONID`, `PHPSESSID`, `connect.sid`, etc.).

**Como obter:**
1. Faça login no CRM pelo seu Chrome normalmente (senha + MFA)
2. Abra **DevTools → aba Application → Cookies → domínio do CRM**
3. Você vai ver uma tabela com Name / Value para cada cookie
4. Monte uma string no formato do header HTTP:
   `nome1=valor1; nome2=valor2; nome3=valor3`
5. Inclua **todos** os cookies do CRM (session, csrf, tenant id, etc.) —
   se em dúvida, cole todos, o servidor ignora os desnecessários

**Como passar:**
```env
MANUAL_COOKIES=SESSIONID=abc123; XSRF-TOKEN=def456; tenant=acme
```

Em PowerShell (aspas duplas na string toda):
```powershell
$env:MANUAL_COOKIES = "SESSIONID=abc123; XSRF-TOKEN=def456; tenant=acme"
```

### Opção 4 — JWT + Cookies combinados

Se o CRM usa cookies **e** header (comum em APIs com CSRF token no
cookie e Bearer no header), passa as duas variáveis. O framework usa
as duas.

```env
MANUAL_JWT=eyJhbGciOi...
MANUAL_COOKIES=XSRF-TOKEN=def456; tenant=acme
```

### Proteção automática contra logout

Uma vez autenticado, o agente **não pode deslogar sozinho**. O browser do
agente recusa qualquer `navigate` ou `click_element` que aponte para uma
página de logout/signout/sair (path, hash `#/logout`, endpoints de SSO como
`/v2/logout` do Auth0 ou `end-session` do OIDC, e rótulos como "Sair" /
"Logout" / "Encerrar sessão"). Isso evita que o agente destrua no meio da
rodada a sessão que você levou um login manual + MFA para obter — sem ela,
todas as ações seguintes cairiam no login.

- É **ligado por padrão** e vale para todos os modos (não só produção).
- Quando bloqueia, o agente recebe uma Observation explicando que a sessão
  foi preservada e que ele deve continuar em rotas autenticadas.
- Independe do `scope.excludePaths` do Target Profile (que continua útil,
  mas atua só no crawl da Fase 1; este guard cobre o loop ReAct da Fase 3).

**Para desligar** — apenas se o objetivo do teste for exatamente exercitar
o logout (ex.: session fixation, verificar invalidação de token):

```env
ALLOW_LOGOUT_NAV=true
```

### Ressalvas importantes

- **Expiração**: JWTs e cookies de sessão corporativos duram tipicamente
  de 15 minutos a algumas horas. Se a rodada for longa, o token/cookie
  pode expirar no meio e todas as requests seguintes retornarão `401`.
  O framework não faz relogin sozinho; encerra a sessão sem detectar
  as vulnerabilidades autenticadas. **Mitigação**: obter nova sessão
  imediatamente antes de iniciar cada rodada e usar
  `MAX_REACT_ITERATIONS` reduzido (10-15) pra caber dentro da janela.
- **Escopo da sessão**: o agente vai operar com as **permissões do
  usuário que gerou o token/cookie**. Se você quer testar vulnerabilidades
  de administrador, precisa gerar a sessão com uma conta admin. Se quer
  testar como usuário comum, use uma conta comum.
- **Dados da sessão vão pro LLM**: token, cookies e as respostas
  autenticadas passam pelo prompt do LLM (Anthropic, EUA se estiver
  usando `openrouter`/`anthropic`/`claude-cli`). Considere isso na
  análise de LGPD/confidencialidade.
- **Sessão no `.env`**: se colocar no arquivo, adicione o `.env` ao
  `.gitignore` (já está por padrão neste projeto) e apague depois
  da rodada. **Nunca comite JWT ou cookies de sessão.**

---

## Perfil do alvo (Target Profile) — opcional, recomendado

Um alvo atrás de OAuth/SSO só revela, pelo crawl, os endpoints que a UI
dispara. Endpoints admin-only, versões antigas de API e rotas sem link
na tela não aparecem. Como o red team costuma ter acesso ao **código-fonte
do alvo**, dá para descrever a superfície de ataque **autoritativa** num
arquivo JSON — o *Target Profile* — que o `ProductionPerception` semeia no
AppMap antes do crawl (perfil = verdade; crawl = confirma e traz os tokens
de sessão vivos).

Benefícios: cobre a superfície que o crawl não alcança, **reduz alucinação**
(o agente recebe a lista real de endpoints legítimos, em vez de inventar) e
mantém o teste **on-scope** via `scope.excludePaths`.

> É **opcional**: sem `TARGET_PROFILE`, a rodada roda normalmente só com o
> crawl. O perfil só torna o agente mais certeiro.

### Passo 1 — gerar o perfil a partir do código-fonte do alvo

Aponte o gerador para o checkout do repositório do alvo. Ele **detecta a
stack sozinho** (Angular/React/Vue no front; Express/NestJS/Flask/FastAPI/
Django/Rails no back) e extrai rotas e endpoints:

```bash
npm run gen:profile -- /caminho/do/repo-do-alvo targets/meu-alvo.json meu-alvo
```

Saída: `targets/meu-alvo.json` com as rotas e endpoints encontrados
(com `authRequired` inferido por-rota).

> A extração é **heurística** (regex sobre o fonte) — é um ponto de
> partida para revisar, não uma fonte final.

### Passo 2 — revisar o JSON

Abra o arquivo e ajuste principalmente:
- `authRequired` de cada endpoint (confirme os que exigem sessão);
- `params` (query/body/path) que o agente deve enviar;
- marque `idor: true` em recursos com id direto na URL (candidatos a
  IDOR/BOLA);
- `scope.excludePaths` — paths que **nunca** devem ser tocados
  (ex.: `"*/logout"`, `"/api/*/delete"`).

Veja [`../../targets/dito-survey.example.json`](../../targets/dito-survey.example.json)
como referência de formato. O schema completo está em
[`TargetProfile.ts`](./TargetProfile.ts).

### Passo 3 — rodar apontando para o perfil

Mesmo comando de sempre, com **uma** variável a mais no começo:

```bash
TARGET_PROFILE=targets/meu-alvo.json \
INTERACTIVE_LOGIN=true \
READ_ONLY=true INTERACTIVE=true \
AUDIT_LOG=./logs/target-run-001.csv \
SKIP_ABUSE_CASES=true \
MAX_REACT_ITERATIONS=15 \
npm run start:production
```

Variáveis relacionadas:
- `TARGET_PROFILE` — caminho do JSON do perfil (ausente = só crawl).
- `CRAWL_MAX_PAGES` — limite de páginas do crawl (default 25).

> **Limitação honesta:** hoje o prompt do agente (núcleo, intocado) só
> expõe `method`/`url`/`authRequired` dos endpoints e `path`/`title`/
> `requiresAuth` das rotas. Por isso `params`/`roles`/`notes` do perfil são
> embutidos nesses campos (exemplos de query na `url`, papéis no `title`) e
> o restante fica guardado no AppMap para relatório. Levar o perfil inteiro
> ao LLM exigiria estender o prompt do núcleo — decisão à parte.

---

## Limitações que o red team precisa conhecer

Cinco pontos que o módulo `production-mode` NÃO resolve:

1. **Não valida `TARGET_URL`.** Se o `.env` apontar para o alvo errado,
   o agente ataca o alvo errado. Confira duas vezes.

2. **Read-only não impede vazamento de dados.** `GET` ainda retorna
   payloads que passam pelo LLM. Se o provedor for OpenRouter/Anthropic,
   os dados são enviados para servidores nos EUA. Considere `LLM_PROVIDER=ollama`
   se o alvo tem dados sensíveis sob LGPD.

3. **`RiskClassifier` é heurístico.** Regex de path cobre padrões
   comuns (`/messages`, `/webhooks`, `/billing`) mas pode ter falso
   negativo para convenções específicas do alvo. Ajustar
   `CRITICAL_PATH_PATTERNS` em [`RiskClassifier.ts`](./RiskClassifier.ts)
   conforme necessário.

4. **`Abuse Cases` (fase 3b) rodam via HttpClient direto**, sem passar
   pelo `SafeDispatcher`. **Sempre use `SKIP_ABUSE_CASES=true` em
   produção.** Se esquecer, 8 exploits específicos do Juice Shop
   vão tentar executar contra o alvo.

5. **`ProductionPerception` (fase 1) faz o crawl inicial sem passar
   pelo `SafeDispatcher`.** O crawl é só navegação (GET) na mesma origem
   do alvo, respeitando `scope.excludePaths` do perfil quando fornecido.
   Ainda assim, se o alvo tem lógica de negócio que dispara efeito
   colateral só de abrir uma rota (webhook de "user logged in", contador
   de visita, etc.), avalie limitar o crawl com `CRAWL_MAX_PAGES` ou
   restringir o escopo no Target Profile.

---

## Configurações recomendadas por cenário

### Sanity check (validar setup, alvo público)

```bash
TARGET_URL=https://httpbin.org \
READ_ONLY=true INTERACTIVE=false SKIP_ABUSE_CASES=true \
MAX_REACT_ITERATIONS=3 npm run start:production
```

### Primeira rodada em alvo autorizado (com MFA/SSO)

```bash
INTERACTIVE_LOGIN=true \
READ_ONLY=true INTERACTIVE=true \
AUDIT_LOG=./logs/target-run-001.csv \
SKIP_ABUSE_CASES=true \
MAX_REACT_ITERATIONS=15 \
npm run start:production
```

Ao iniciar, uma janela do Chromium abre para voce logar
manualmente. Depois de dentro do CRM autenticada, ENTER no
terminal e a rodada continua com a sessao capturada.

> Para um teste mais certeiro, gere antes um **Target Profile** do alvo
> (`npm run gen:profile`) e adicione `TARGET_PROFILE=targets/meu-alvo.json`
> ao comando. Ver seção "Perfil do alvo (Target Profile)".

### Primeira rodada em alvo autorizado (sem MFA, JWT copiado)

```bash
MANUAL_JWT="eyJhbGciOi..." \
READ_ONLY=true INTERACTIVE=true \
AUDIT_LOG=./logs/target-run-001.csv \
SKIP_ABUSE_CASES=true \
MAX_REACT_ITERATIONS=15 \
npm run start:production
```

### Rodada com aprovação humana em ações destrutivas

```bash
INTERACTIVE=true \
AUDIT_LOG=./logs/target-run-002.csv \
CIRCUIT_BREAKER=5 RATE_LIMIT_MS=1000 \
SKIP_ABUSE_CASES=true \
npm run start:production
```

---

## Alimentando o estudo científico da autora

Se o red team autorizar, os resultados das rodadas em ambiente
autorizado podem alimentar um estudo de generalização do framework
(o TCC foi validado só em Juice Shop; um alvo real é dado científico
valioso). Como colaborar:

1. **Antes da rodada:** preencher o arquivo
   [`ground-truth-target-template.json`](./ground-truth-target-template.json)
   listando as vulnerabilidades já conhecidas do alvo (categoria,
   endpoint, severidade). Não precisa ser exaustivo, só as principais.

2. **Após a rodada:** rodar o script de comparação:
   ```bash
   python3 scripts/compare-findings-vs-gt.py \
     reports/report-production-<timestamp>.json \
     src/production-mode/ground-truth-target-filled.json
   ```

   Ele imprime: quantas vulns do GT foram redescobertas, quais foram,
   quais foram missed, e quais findings do agente são potencialmente
   novos (não estavam no GT).

3. **Enviar o output** (não os dados sensíveis) por email para a
   autora. Formato mínimo:
   - Tipo genérico da aplicação (ex: "CRM comercial", sem nome)
   - Stack (linguagem, framework)
   - Métricas: TP, FP, FN, cobertura, F1
   - Findings anonimizados (categoria e endpoint genérico, sem
     payload real)

Esse dado, se autorizado, aparecerá anonimizado no artigo que a
autora pretende submeter após a defesa do TCC 2. O nome da empresa
ou do produto não será mencionado.

---

## Reporte de bugs / sugestões

- **Bug no framework:** issue no GitHub ou email direto
- **Comportamento inesperado do agente:** enviar o log da sessão
  (JSON do relatório + CSV de audit) por email. **Remover dados
  sensíveis antes.**
- **Sugestão de melhoria no `RiskClassifier`:** PR no repositório
  ou descrição por email

---

## O que a autora garante e o que não garante

**Garante:**
- Framework compila e roda sem erros contra Juice Shop
- Módulo `production-mode` foi testado unitariamente durante
  desenvolvimento (dry-runs contra endpoints locais)
- `SafeDispatcher` bloqueia efetivamente ações não-GET em modo
  `READ_ONLY=true`

**Não garante:**
- Comportamento correto em qualquer alvo real (nunca foi testado)
- Cobertura de vulnerabilidades comparável ao Juice Shop em outros alvos
- Detecção de todas as ações destrutivas via `RiskClassifier` (é
  heurístico)
- Isolamento absoluto do alvo (o red team é responsável pelo
  ambiente de execução, autorização e escopo)

---

## Checklist final antes de rodar em produção

- [ ] Autorização escrita do responsável pelo alvo (interno da empresa)
- [ ] **Provedor de LLM escolhido em alinhamento com DPO** (OpenRouter/
      Anthropic exigem aprovação para transferência internacional de
      dados; Ollama local não exige)
- [ ] **Chave de API do provedor obtida e configurada no `.env`** (ou
      Ollama servindo modelo local)
- [ ] Alvo confirmado no `.env` (`TARGET_URL` visto por 2 pessoas)
- [ ] **Modo de autenticação escolhido** (`INTERACTIVE_LOGIN=true`
      se o alvo tem MFA/SSO; `MANUAL_JWT` ou `MANUAL_COOKIES` se
      preferir colar token; conta usada tem as permissões que você
      quer testar)
- [ ] Time de operação/SOC avisado do horário e IP de origem
- [ ] Snapshot do banco (se aplicável)
- [ ] Sanity check já executado (contra httpbin ou similar)
- [ ] Primeira rodada será `READ_ONLY=true`
- [ ] `SKIP_ABUSE_CASES=true` presente no comando
- [ ] `AUDIT_LOG` configurado
- [ ] Alguém do red team disponível no terminal para responder aprovações
- [ ] Plano de resposta se algo der errado (contato para reverter, DBA
      de plantão, etc.)
