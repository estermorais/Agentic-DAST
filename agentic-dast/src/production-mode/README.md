# Modo Produção — Agentic DAST

Guia de uso do módulo `src/production-mode/`, que envolve o agente
principal com uma camada de guardas para uso em ambientes de produção
autorizados.

**Este módulo é opcional e não faz parte da rodada oficial do TCC 2
(Juice Shop, n=30).** Ele existe para permitir que o mesmo framework seja
aplicado em aplicações reais sem risco de causar dano, mediante aprovação
humana em cada ação destrutiva ou sensível.

---

## Índice

1. [Quando usar (e quando não usar)](#1-quando-usar-e-quando-não-usar)
2. [Pré-requisitos operacionais](#2-pré-requisitos-operacionais)
3. [Como funciona por dentro](#3-como-funciona-por-dentro)
4. [Setup passo a passo](#4-setup-passo-a-passo)
5. [Modos de uso](#5-modos-de-uso)
6. [Interface no terminal](#6-interface-no-terminal)
7. [Variáveis de ambiente](#7-variáveis-de-ambiente)
8. [Auditoria (CSV log)](#8-auditoria-csv-log)
9. [Troubleshooting](#9-troubleshooting)
10. [FAQ](#10-faq)

---

## 1. Quando usar (e quando não usar)

### Use este módulo se:

- Você tem **autorização escrita** para testar a aplicação-alvo
- A aplicação **não é** um alvo didático vulnerável-por-design (para essas,
  use `npm start` normal, que é o modo autônomo usado no TCC 2)
- Você aceita **rodar com humano no loop**, aprovando ações destrutivas
  ou sensíveis manualmente durante a execução
- Você aceita que o teste pode ser **interrompido a qualquer momento**
  se o operador humano digitar `q`

### **NÃO** use este módulo se:

- Você está rodando os experimentos do TCC 2 (usa `npm start` ou os
  scripts em `scripts/run-official-n30.ps1`)
- Você não tem autorização escrita do responsável pelo alvo
- O alvo é aplicação de terceiros (SaaS) sem autorização do fornecedor
- Você quer rodar sem intervenção humana (usa `npm start` normal)

---

## 2. Pré-requisitos operacionais

Antes de rodar em produção, marque cada item:

- [ ] **Autorização escrita** do responsável pelo alvo (email do CTO,
      CISO ou gestor). Guarde por escrito.
- [ ] **Conta de teste dedicada** no alvo (nunca sua conta real de
      trabalho). Se o sistema permitir criar workspace/tenant de
      sandbox dentro da mesma instância, use-o.
- [ ] **Contatos/dados de teste populados** — se aplicável, popule
      registros fictícios (nomes tipo "Agentic Test 001", emails
      `test-XXX@example.com`) antes de rodar. Se algo escapar do
      controle, é o registro fictício que é afetado.
- [ ] **SOC / time de segurança avisado** — email antes de rodar
      dizendo "vou executar teste automatizado no IP X, das H1 às H2,
      no alvo Y". Evita disparar incidente e chamar oncall.
- [ ] **Snapshot do banco** (se possível). Não é obrigatório em modo
      `READ_ONLY`, mas é boa prática antes de qualquer teste
      autorizado que envolva escrita.
- [ ] **Horário fora do pico** — sábado de manhã ou madrugada.
      Se algo der ruim, você tem tempo de reagir antes do time de
      operação chegar.
- [ ] **`.env`** com `TARGET_URL` apontando para o alvo autorizado
      (checar duas vezes; não apontar para produção de outro sistema
      por engano).

---

## 3. Como funciona por dentro

O `SafeDispatcher` classifica cada ação proposta pelo LLM em quatro
níveis de risco antes de executar. Se o nível não for `safe`, ele
bloqueia ou pede confirmação humana.

| Nível | Exemplos concretos | Comportamento padrão |
|---|---|---|
| **SAFE** | `GET`, `read_page`, `navigate`, `extract_tokens`, `report_finding`, `fill_field` | Executa direto, sem perguntar |
| **MEDIUM** | `POST` genérico em rota não-sensível, `click_element` em botão de submit | Pergunta uma vez; opção `[a]uto-approve` para os próximos MEDIUM da sessão |
| **HIGH** | `PUT`, `PATCH`, `DELETE`, `POST` em `/admin`/`/users`/`/config`, header JWT forjado, payload com padrão de SQLi/XSS | Sempre pergunta, sem opção de auto-approve |
| **CRITICAL** | Qualquer método em endpoints que casam com `/messages`, `/emails`, `/webhooks`, `/automations`, `/exports`, `/billing`, `/invoices`, `/payments` | Exige **confirmação dupla** (digitar `CONFIRMO`) |

Se `READ_ONLY=true`, tudo que não é `SAFE` é **bloqueado sem sequer
perguntar**. O LLM recebe uma observation dizendo que a ação foi bloqueada
e sugere alternativa (geralmente muda de estratégia sozinho).

---

## 4. Setup passo a passo

### 4.1 Compilar o projeto

```bash
cd agentic-dast
npm install       # apenas na primeira vez
npm run build
```

### 4.2 Configurar `.env`

Crie ou edite o arquivo `agentic-dast/.env`:

```bash
# LLM (mesmo do modo oficial)
LLM_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-v1-...
LLM_MODEL=anthropic/claude-haiku-4.5

# Alvo — MUITA ATENÇÃO: apontar apenas para o alvo autorizado
TARGET_URL=https://crm-staging.suaempresa.com
BROWSER_BASE_URL=https://crm-staging.suaempresa.com

# ZAP opcional. Se true, precisa do ZAP rodando localmente
USE_ZAP_PROXY=false

# Limite de iterações
MAX_REACT_ITERATIONS=40
```

### 4.3 Criar diretório de logs

```bash
mkdir -p logs
```

### 4.4 Testar em modo dry-run primeiro

Antes da rodada real, faça um teste de sanidade rápido:

```bash
READ_ONLY=true \
INTERACTIVE=false \
AUDIT_LOG=./logs/dry-run-test.csv \
SKIP_ABUSE_CASES=true \
MAX_REACT_ITERATIONS=3 \
npm run start:production
```

Isso executa apenas 3 iterações, tudo em read-only, sem interação
humana. Serve pra confirmar que o AppMap é construído corretamente
para o novo alvo, que o LLM consegue interpretar a aplicação, e que
o audit log está sendo gravado.

Se essas 3 iterações completarem sem erro e o CSV aparecer preenchido
em `./logs/dry-run-test.csv`, você está pronto para a rodada real.

---

## 5. Modos de uso

### 5.1 Primeira rodada em qualquer alvo novo (recomendado)

**Sempre comece em modo `READ_ONLY`**. É a única configuração que garante
que nenhum estado do alvo é alterado.

```bash
READ_ONLY=true \
INTERACTIVE=true \
AUDIT_LOG=./logs/prod-first-run.csv \
SKIP_ABUSE_CASES=true \
npm run start:production
```

O que esperar:

- O agente vai fazer somente requests `GET`
- Todos os `POST`/`PUT`/`PATCH`/`DELETE` propostos pelo LLM são
  bloqueados e o agente adapta a estratégia
- Você não precisa ficar no terminal (nada vai ser perguntado, pois
  read-only bloqueia antes de chegar a pergunta)
- Ao final, você vai ter um relatório em `reports/report-production-*.json`
  com findings que dependem apenas de leitura (exposição de dados,
  endpoints administrativos sem autenticação, JWT com validação
  inadequada em rotas GET)

### 5.2 Rodada com autorização humana em ações destrutivas

Depois que você validou a rodada read-only e confia na estratégia do
agente, pode liberar ações destrutivas com aprovação manual:

```bash
INTERACTIVE=true \
AUDIT_LOG=./logs/prod-run-002.csv \
CIRCUIT_BREAKER=5 \
RATE_LIMIT_MS=1000 \
SKIP_ABUSE_CASES=true \
npm run start:production
```

O que esperar:

- Você **precisa ficar no terminal** para responder as perguntas
- Cada `POST`/`PUT`/`PATCH`/`DELETE` vai pausar e pedir sua aprovação
- Endpoints CRITICAL (mensagens, webhooks, exports) vão pedir
  confirmação dupla
- Depois de 5 findings HIGH ou CRITICAL, o circuit breaker encerra
  a sessão automaticamente
- Rate limit de 1 segundo entre requests evita disparar WAF

### 5.3 Rodada agressiva (só depois de várias rodadas OK)

Se você já confia bastante e quer minimizar interrupções, pode aumentar
o auto-approve. Ainda assim, **HIGH e CRITICAL sempre pedem confirmação**:

```bash
INTERACTIVE=true \
AUDIT_LOG=./logs/prod-run-003.csv \
CIRCUIT_BREAKER=10 \
SKIP_ABUSE_CASES=true \
npm run start:production
```

Depois responder `a` na primeira pergunta MEDIUM, todas as MEDIUM
seguintes são auto-aprovadas até o fim da sessão.

---

## 6. Interface no terminal

Quando o LLM propõe uma ação MEDIUM/HIGH/CRITICAL, aparece assim:

```
────────────────────────────────────────────────────────────────────────
  ⚠️  HIGH — ação destrutiva ou sensível  Iteração 17
────────────────────────────────────────────────────────────────────────
  [Action]
    PATCH https://crm.suaempresa.com/api/v1/users/42
    Headers: {"Authorization":"Bearer eyJhbGciOiJIUzI1NiJ9..."}
    Body: {"role":"admin"}
  [Motivo da classificação]
    Método PATCH modifica estado no servidor.

  Autorizar? [y]es / [n]o / [q]uit
  >
```

### Respostas aceitas

| Você digita | O que acontece |
|---|---|
| `y`, `yes`, `s`, `sim` | Executa a ação, retorna observation ao LLM, próxima iteração |
| `n`, `no`, `nao`, `não` | Pula. Pergunta motivo opcional. Motivo é enviado ao LLM como observation ("Ação pulada. Motivo: ...") |
| `a` | Só disponível em MEDIUM. Auto-aprova esta ação e todas as MEDIUM seguintes da sessão. HIGH/CRITICAL continuam pedindo. |
| `q`, `quit`, `sair` | Encerra a sessão. Agente gera relatório com o que descobriu até aqui. |

### CRITICAL exige confirmação dupla

Para ações CRITICAL, responder `y` **não é suficiente**:

```
  Autorizar? [y]es / [n]o / [q]uit
  > y
  Ação classificada como CRITICAL. Digite CONFIRMO para prosseguir: CONFIRMO
```

Qualquer coisa diferente de `CONFIRMO` (case-sensitive) cancela a ação.

---

## 7. Variáveis de ambiente

| Variável | Default | O que faz |
|---|---|---|
| `READ_ONLY` | `false` | Se `true`, bloqueia qualquer `POST`/`PUT`/`PATCH`/`DELETE` **sem sequer perguntar** |
| `INTERACTIVE` | `true` | Se `true`, pede confirmação humana em MEDIUM/HIGH/CRITICAL |
| `AUDIT_LOG` | vazio | Path do CSV de audit. Vazio = não grava. Recomendado sempre preencher |
| `RATE_LIMIT_MS` | `500` | Delay em milissegundos entre `make_request` (evita disparar WAF) |
| `CIRCUIT_BREAKER` | `0` | Encerra sessão após N findings HIGH/CRITICAL. `0` = desativado |
| `SKIP_ABUSE_CASES` | `false` | Se `true`, pula a fase 3b (Abuse Cases foram feitos para Juice Shop). **Recomenda-se `true` em produção** |

### Combinações mais comuns

**Modo dry-run** (validação inicial, zero risco):
```
READ_ONLY=true INTERACTIVE=false SKIP_ABUSE_CASES=true
```

**Modo produção seguro** (recomendado para uso rotineiro):
```
INTERACTIVE=true CIRCUIT_BREAKER=5 RATE_LIMIT_MS=1000 SKIP_ABUSE_CASES=true
```

**Modo produção agressivo** (só após várias rodadas OK):
```
INTERACTIVE=true CIRCUIT_BREAKER=10 SKIP_ABUSE_CASES=true
```

---

## 8. Auditoria (CSV log)

Se `AUDIT_LOG` estiver preenchido, cada ação processada pelo
`SafeDispatcher` gera uma linha no CSV:

```csv
timestamp_iso,iteration,action,method,url,risk_level,outcome
2026-08-17T14:23:11.421Z,3,make_request,GET,https://crm.../api/v1/leads,safe,executed
2026-08-17T14:23:12.883Z,4,make_request,POST,https://crm.../api/v1/leads,medium,executed
2026-08-17T14:23:45.112Z,7,make_request,DELETE,https://crm.../api/v1/leads/42,high,skipped-by-human
2026-08-17T14:24:02.556Z,9,make_request,POST,https://crm.../api/v1/messages,critical,blocked-readonly
```

### Coluna `outcome`

| Valor | Significado |
|---|---|
| `executed` | Ação passou por todas as guardas e foi executada com sucesso |
| `skipped-by-human` | Operador digitou `n` no prompt |
| `quit-by-human` | Operador digitou `q` — sessão foi encerrada nesta iteração |
| `blocked-readonly` | `READ_ONLY=true` bloqueou antes de perguntar |

Esse CSV é o **registro forense** da sessão. Guarde junto com o relatório
JSON gerado em `reports/report-production-*.json`. Se algo der ruim, você
tem prova do que foi (e do que não foi) enviado ao alvo.

---

## 9. Troubleshooting

### O agente para na primeira iteração dizendo "Ação bloqueada por modo READ_ONLY"

Comportamento esperado se `READ_ONLY=true`. O LLM propôs algo que
não era `GET` e foi bloqueado. Deixa continuar — o agente vai adaptar
a estratégia. Se depois de 10 iterações não conseguir fazer nada útil,
significa que a aplicação-alvo exige escrita para ser explorada
(caso raro, comum em SPAs muito autenticadas).

### O terminal fica parado esperando resposta e eu não estava vendo

`INTERACTIVE=true` exige que você fique no terminal. Se você sair
para outra janela, o agente fica parado esperando o input. Nenhum
timeout — ele espera indefinidamente.

Solução: mantenha o terminal visível durante a sessão ou use
`INTERACTIVE=false` (com `READ_ONLY=true` sempre para segurança).

### O rate limit está muito alto e o teste demora muito

Diminui `RATE_LIMIT_MS`. O default de 500ms é conservador para evitar
disparar WAF; se o alvo tolera mais tráfego, pode baixar para 200 ou
até 100. Não recomendo tirar por completo (`RATE_LIMIT_MS=0`) — vira
DoS involuntário se o LLM entrar em loop.

### Circuit breaker fecha antes de eu ver findings suficientes

Aumenta `CIRCUIT_BREAKER` para um valor maior ou desativa (`0`).
O default de 5 é conservador; se quiser explorar mais a fundo, use
10 ou 20.

### O agente propõe ações contra URLs que não são do meu alvo

Isso é bug — o SYSTEM_PROMPT declara o escopo, mas o LLM às vezes
inventa endpoints. Se o `TARGET_URL` do `.env` estiver correto,
essas ações vão falhar por resolução de DNS ou serem executadas
no host correto. Confira o CSV de audit para ver se realmente algo
saiu para fora do alvo. Se sim, abra uma issue no repositório
com o log.

### O CSV não está sendo gravado

Confira que:
- `AUDIT_LOG` está com um path válido (relativo ao diretório onde
  você rodou `npm run start:production`, não ao `src/`)
- O diretório existe (`mkdir -p logs` antes de rodar)
- O processo tem permissão de escrita no diretório

---

## 10. FAQ

**Q: Se eu rodar `READ_ONLY=false` sem `INTERACTIVE=true`, o que acontece?**

R: Comportamento equivalente ao modo oficial (`npm start`), sem
nenhuma proteção. O `production-runner` avisa isso no início. Continue
apenas se for intencional.

**Q: Posso rodar isso contra o Juice Shop também?**

R: Pode. Funciona. Mas não é a configuração usada nos experimentos do
TCC 2 (que usam `npm start`). Se você rodar o modo produção contra o
Juice Shop, vai gerar relatórios em `reports/report-production-*.json`
que não devem ser misturados com os relatórios oficiais.

**Q: O modo produção afeta as métricas do experimento do TCC?**

R: Não. Este módulo não altera nenhum arquivo dos módulos principais
(`src/cognitive/`, `src/executor/`). Os experimentos do TCC 2
continuam rodando exatamente como antes, com a mesma reprodutibilidade.

**Q: E se o LLM tentar burlar o classificador (por exemplo, usando POST
em URL que não bate com nenhum padrão CRITICAL)?**

R: A regex de risco é heurística, então falsos negativos são possíveis
(o LLM propõe um POST em rota que passa como MEDIUM quando deveria ser
HIGH/CRITICAL). Por isso: (a) prefira `READ_ONLY=true` sempre que
possível, (b) revise o CSV de audit ao final para ver se algo escapou,
(c) se identificar padrão que deveria ser CRITICAL e não está,
adicione em `RiskClassifier.ts` na lista `CRITICAL_PATH_PATTERNS`.

**Q: Posso pré-aprovar algumas ações via arquivo, sem interação no
terminal?**

R: Não implementado. Requer whitelist de URLs autorizadas — pode ser
adicionado depois se você precisar. Por hora, a única forma de
pré-aprovar é usando `READ_ONLY=true` (aprova tudo que é `GET`).

**Q: A empresa exige que eu documente tudo que foi executado. O
CSV de audit é suficiente?**

R: O CSV lista cada ação com timestamp, método, URL, risco e resultado.
Junto com o relatório JSON (que tem os `steps` completos do agente,
incluindo `thought`), você tem registro suficiente para auditoria.
Guarde os dois arquivos após cada sessão.

---

## Contato

Reportar problemas, sugerir melhorias ou discutir uso:
Ester Morais Neves — estermoraisneves@gmail.com
