# Agentic DAST — Documento de Apresentação ao Orientador

**Aluna:** Ester Morais
**Orientador:** Mateus Tymburibá
**TCC 1 — Engenharia de Computação / CEFET-MG**

---

## 1. Visão Geral em Um Parágrafo

O **Agentic DAST** é um *framework* de Teste Dinâmico de Segurança de Aplicações (DAST)
que utiliza um **agente baseado em Modelo de Linguagem de Grande Porte (LLM)** —
especificamente o Claude da Anthropic — para detectar autonomamente vulnerabilidades
em **Single Page Applications (SPAs)**. Diferentemente de ferramentas convencionais
como o OWASP ZAP, que dependem de varredura sintática de URLs, o Agentic DAST navega
a aplicação pelo **Chrome DevTools Protocol (CDP)** e raciocina sobre o domínio de
negócio usando o padrão **ReAct** (*Reason + Act*), permitindo detectar classes de
vulnerabilidade que exigem compreensão semântica — falhas de lógica de negócio,
controle de acesso quebrado (IDOR), ataques a JWT, entre outras seis categorias do
OWASP Top 10. O alvo de validação é o **OWASP Juice Shop**, e a eficácia é medida
em três cenários experimentais comparativos.

---

## 2. Arquitetura do Framework

O sistema é organizado em **quatro módulos** com responsabilidades isoladas:

```
                    ┌──────────────────────────────────────────┐
                    │          ALVO (Juice Shop SPA)           │
                    │       http://localhost:3000              │
                    └────────────────┬─────────────────────────┘
                                     │
       ┌─────────────────────────────┼─────────────────────────────┐
       │                             │                             │
┌──────▼──────┐              ┌───────▼───────┐             ┌───────▼────────┐
│ PERCEPÇÃO   │   AppMap     │   COGNIÇÃO    │   ações     │   EXECUÇÃO     │
│             │ ───────────► │               │ ──────────► │                │
│ DOMExtractor│              │  ReActAgent   │             │ Actor +        │
│ (Puppeteer  │              │  (Claude API) │             │ Abilities +    │
│  + CDP)     │              │               │             │ Abuse Cases    │
└─────────────┘              └───────┬───────┘             └────────┬───────┘
                                     │ observações                  │
                                     └──────────────────────────────┘
                                                │
                                                ▼
                                     ┌─────────────────────┐
                                     │      AUDITORIA      │
                                     │     ZapClient       │
                                     │  (OWASP ZAP API)    │
                                     └─────────────────────┘
                                                │
                                                ▼
                                     ┌─────────────────────┐
                                     │     RELATÓRIO       │
                                     │       JSON          │
                                     └─────────────────────┘
```

### 2.1. Módulo de Percepção — `src/perception/DOMExtractor.ts`

Constrói o **AppMap**: estrutura semântica da aplicação contendo rotas, endpoints
de API, formulários, elementos interativos e contexto de autenticação. Usa
**Puppeteer** para controlar o Chrome via CDP, intercepta todas as chamadas XHR/Fetch
e extrai formulários do DOM Angular renderizado dinamicamente.

**Saída:** objeto `AppMap` com:
- `routes`: lista de rotas Angular (`/#/login`, `/#/basket`, etc.) com formulários e elementos
- `apiEndpoints`: lista de endpoints `/api/*` e `/rest/*` interceptados
- `auth`: JWT, cookies e credenciais de teste capturados via login automático
- `metadata`: framework detectado, totais, timestamp

### 2.2. Módulo Cognitivo — `src/cognitive/ReActAgent.ts`

Implementa o **loop ReAct** sobre a API do Claude. Recebe o AppMap, conduz uma
conversa multi-turno com o LLM, parseia as respostas e despacha ações para o
Executor. Usa **Prompt Caching** da Anthropic para reduzir custo até 90% em
*system prompts* longos.

**Componentes:**
- `prompts.ts`: define o `SYSTEM_PROMPT` (descrição das categorias OWASP, ações
  disponíveis, formato de resposta) e os *user prompts*
- `ReActAgent.run(appMap)`: executa o loop até `finish` ou `MAX_REACT_ITERATIONS`
- `parseReActOutput()`: extrai `Thought`, `Action` e `Action Input` da resposta
  textual do LLM

### 2.3. Módulo Executor — `src/executor/`

Executa as ações decididas pelo agente sobre o mundo real. Implementa o
**padrão Screenplay** (Actor + Abilities) para isolar capacidades.

- `screenplay/Actor.ts`: representa o "ator" que executa ações
- `abilities/BrowseTheWeb.ts`: encapsula Puppeteer (navegar, clicar, preencher)
- `abilities/HttpClient.ts`: encapsula axios (requisições HTTP arbitrárias)
- `ActionDispatcher.ts`: roteia cada `ParsedAction` para a Ability correta
- `tasks/`: oito **Casos de Abuso** pré-definidos (ver Seção 4)

### 2.4. Módulo de Auditoria — `src/auditor/ZapClient.ts`

Cliente da API REST do **OWASP ZAP** (em modo *daemon*, dentro de container
Docker). Coleta alertas do scan passivo após o agente navegar pela aplicação,
e opcionalmente dispara scan ativo + spider tradicional (usado nos Cenários
A e B).

---

## 3. Como o Loop ReAct Funciona

O loop ReAct é o coração da abordagem. A cada iteração:

```
   ┌─────────────────────────┐
   │  System + Histórico     │
   │  (enviado ao Claude)    │
   └──────────┬──────────────┘
              │
              ▼
       ┌─────────────┐
       │   Claude    │  (raciocina e decide)
       │ (LLM)       │
       └──────┬──────┘
              │ resposta no formato:
              │   Thought: ...
              │   Action: navigate
              │   Action Input: { "url": "..." }
              ▼
   ┌─────────────────────────┐
   │   parseReActOutput()    │
   └──────────┬──────────────┘
              │
              ▼
   ┌─────────────────────────┐
   │ ActionDispatcher.       │
   │   dispatch(action)      │
   └──────────┬──────────────┘
              │
              ▼
   ┌─────────────────────────┐
   │  Browser ou HttpClient  │
   │    executa no alvo      │
   └──────────┬──────────────┘
              │
              ▼
   ┌─────────────────────────┐
   │     Observation         │
   │  (resposta HTTP, DOM)   │
   └──────────┬──────────────┘
              │  appended ao histórico
              └──► volta ao topo do loop
```

### 3.1. Exemplo concreto de iteração

**Iteração 7:**

```
Thought: O AppMap mostra que /#/basket exige autenticação. O JWT do customer
foi extraído. Vou tentar acessar uma cesta de outro usuário trocando o ID
no endpoint /api/Baskets/{id} para verificar se há IDOR.

Action: make_request
Action Input:
{
  "method": "GET",
  "url": "http://localhost:3000/api/Baskets/2",
  "headers": { "Authorization": "Bearer eyJhbGc..." }
}
```

→ `ActionDispatcher` chama `HttpClient.request()`, que retorna:

```
Observation: HTTP 200 OK
{
  "data": {
    "id": 2,
    "UserId": 2,  ← cesta de outro usuário, mas eu acessei!
    "Products": [...]
  }
}
```

**Iteração 8:**

```
Thought: Confirmado IDOR. Acessei a cesta do usuário ID 2 com o JWT do
usuário ID 1. Vou registrar como vulnerabilidade CRITICAL.

Action: report_finding
Action Input:
{
  "title": "IDOR em /api/Baskets/{id}",
  "severity": "CRITICAL",
  "category": "BROKEN_ACCESS_CONTROL",
  "description": "Endpoint /api/Baskets/{id} não valida ownership...",
  "steps": ["Login como customer", "GET /api/Baskets/2", "Resposta 200 com cesta alheia"],
  "evidence": "{ data: { UserId: 2 } }"
}
```

### 3.2. Ações disponíveis para o LLM

| Ação | Função |
|---|---|
| `navigate` | Vai para uma URL no browser |
| `fill_field` | Preenche um campo de formulário |
| `click_element` | Clica em um elemento via seletor CSS |
| `read_page` | Lê o texto visível da página atual |
| `make_request` | Dispara HTTP arbitrário (GET, POST, PATCH, etc.) |
| `extract_tokens` | Lê JWT/cookies do `localStorage` |
| `report_finding` | Registra uma vulnerabilidade encontrada |
| `finish` | Encerra a sessão |

### 3.3. Por que Prompt Caching importa

O `SYSTEM_PROMPT` tem cerca de 4.000 tokens (descreve OWASP Top 10, formato
ReAct, lista de ações). Sem cache, cada uma das ~25 iterações pagaria por
esses tokens. Com cache (`cache_control: 'ephemeral'`), o system prompt é
cobrado apenas na primeira iteração — reduz custo em até 90%.

---

## 4. Os 8 Casos de Abuso

Os Casos de Abuso são **testes determinísticos** que complementam o raciocínio
livre do agente. Garantem cobertura mínima reproduzível em todas as execuções.
Localizados em `src/executor/tasks/`.

| # | Arquivo | Categoria | O que testa |
|---|---|---|---|
| 1 | `AbuseNegativeQuantity.ts` | Lógica de Negócio | Adiciona `quantity: -10` ao carrinho via `PUT /api/BasketItems/:id`. Se aceito → vuln |
| 2 | `AbuseZeroStarReview.ts` | Lógica de Negócio | Submete review com `rating: 0` (deveria ser 1-5) |
| 3 | `AbuseIDOR.ts` | Broken Access Control | Tenta acessar `/api/Baskets/2` com JWT do user ID 1 |
| 4 | `AbuseAdminRoute.ts` | Broken Access Control | Acessa `/api/Users/` sem credenciais de admin |
| 5 | `AbuseXSS.ts` | XSS Armazenado | Envia `<iframe src="javascript:alert('xss')">` via `POST /api/Feedbacks` e `PATCH /api/Users/:id` |
| 6 | `AbuseJWT.ts` | JWT Bypass | Forja token com `alg: none` (sem assinatura) + payload tamper com `role: admin` |
| 7 | `AbuseSensitiveDataExposure.ts` | Sensitive Data | Tenta acessar `/ftp/`, `/ftp/package.json.bak`, `/rest/admin/application-configuration`, `/api/Users` sem auth |
| 8 | `AbuseSQLInjection.ts` | Injection | Testa `admin'--`, `' OR 1=1--`, `admin' OR '1'='1` em `POST /rest/user/login` |

Cada caso retorna `Finding | null`. Se retornar `Finding`, é adicionado ao
relatório final.

---

## 5. Os 3 Cenários Experimentais

A avaliação compara três configurações usando o **mesmo alvo** (Juice Shop em
Docker) e o **mesmo Ground Truth**.

| Cenário | Arquivo | O que faz | Hipótese |
|---|---|---|---|
| **A — Baseline automático** | `scenarios/scenario-a.ts` | OWASP ZAP roda spider tradicional + scan ativo. Sem navegador, sem LLM. | Limite inferior — ZAP não enxerga rotas Angular |
| **B — Baseline guiado** | `scenarios/scenario-b.ts` | Puppeteer roda script E2E pré-escrito (15 passos: login, basket, feedback, etc.) com proxy ZAP. Depois ZAP analisa. | Isola o efeito da navegação humana sem LLM |
| **C — Experimental** | `index.ts` | Agentic DAST completo: Percepção → ReAct + Abuse Cases → ZAP passivo | Tese: detecta mais que A e B |

### 5.1. Protocolo experimental

- Cada cenário é executado **n = 3 rodadas** independentes
- *Findings* são classificados manualmente em **TP** (verdadeiro positivo),
  **FP** (falso positivo) ou **FN** (falso negativo) com base na matriz
  Ground Truth
- Métricas: **Precisão**, **Revocação**, **F1-Score** por cenário e por
  categoria de vulnerabilidade
- Comparação estatística: **teste de Wilcoxon signed-rank** (não-paramétrico),
  α = 0,05, para os pares A×C e B×C

### 5.2. Hipóteses

- **H1:** F1(C) > F1(A) — o agente supera o ZAP automático
- **H2:** F1(C) > F1(B) — o agente supera o ZAP + navegação humana
- **H3:** A distribuição de categorias detectadas pelo Cenário C difere
  significativamente dos Cenários A e B

---

## 6. Como Rodar Localmente

### 6.1. Pré-requisitos

- **Node.js** 20+ (`node -v`)
- **Docker Desktop** rodando
- **API key da Anthropic** (https://console.anthropic.com/)

### 6.2. Setup inicial

```bash
# Clonar o repositório
git clone https://github.com/estermorais/Agentic-DAST.git
cd Agentic-DAST/agentic-dast

# Instalar dependências
npm install

# Configurar a API key da Anthropic
cp .env.example .env
# Editar .env e colocar: ANTHROPIC_API_KEY=sk-ant-...

# Subir os containers (Juice Shop + ZAP)
docker compose up -d

# Verificar que estão no ar
curl http://localhost:3000          # Juice Shop
curl http://localhost:8080          # ZAP API
```

### 6.3. Rodar os cenários

```bash
# Cenário A — ZAP spider tradicional (~10 min)
npm run scenario:a

# Cenário B — ZAP + navegação E2E com Puppeteer (~10 min)
npm run scenario:b

# Cenário C — Agentic DAST completo (~3-5 min, dependendo do LLM)
npm run scenario:c
```

Os relatórios são salvos em `agentic-dast/reports/` no formato JSON.

### 6.4. Estrutura do relatório

```json
{
  "scenario": "C",
  "description": "Agentic DAST autônomo com loop ReAct + Casos de Abuso",
  "generatedAt": "2026-05-04T15:30:00.000Z",
  "durationMs": 187000,
  "targetUrl": "http://localhost:3000",
  "findingsCount": 12,
  "findings": [
    {
      "title": "IDOR em /api/Baskets/{id}",
      "severity": "CRITICAL",
      "category": "BROKEN_ACCESS_CONTROL",
      "description": "...",
      "evidence": "...",
      "discoveredAt": "..."
    }
  ]
}
```

---

## 7. Status Atual — O Que Está Pronto e o Que Falta

### ✓ Implementado (TCC 1)

| Item | Localização |
|---|---|
| Módulo de Percepção (DOMExtractor + AppMap) | `src/perception/` |
| Módulo Cognitivo (ReActAgent + prompts) | `src/cognitive/` |
| Módulo Executor (Actor, Abilities, Dispatcher) | `src/executor/` |
| 8 Casos de Abuso (6 categorias OWASP) | `src/executor/tasks/` |
| Módulo de Auditoria (ZapClient: passivo, ativo, spider) | `src/auditor/` |
| Cenário A (ZAP spider) | `src/scenarios/scenario-a.ts` |
| Cenário B (E2E + ZAP) | `src/scenarios/scenario-b.ts` |
| Cenário C (Agentic DAST) | `src/index.ts` |
| Docker Compose (Juice Shop + ZAP) | `docker-compose.yml` |
| Build TypeScript → JavaScript | `dist/` (versionado) |
| Artigo TCC | `artigo_agentic_dast.tex` |
| Documentação técnica | `agentic-dast/DOCUMENTACAO.md` |

### ✗ A Fazer (TCC 1 → TCC 2)

| Item | Prioridade | Estimativa |
|---|---|---|
| **Matriz Ground Truth** — mapear desafios do Juice Shop oficiais para as 6 categorias, com critério de detecção formal | Alta | 1 semana |
| **Script de classificação** — ler `reports/*.json`, casar cada finding com o Ground Truth, calcular TP/FP/FN | Alta | 3 dias |
| **Script de cálculo de métricas** — Precisão, Revocação, F1 por cenário e por categoria | Alta | 2 dias |
| **Execução do experimento** — 3 rodadas × 3 cenários = 9 execuções, com captura de tempo e custo | Alta (TCC 2) | 1 semana |
| **Análise estatística** — teste de Wilcoxon, geração de gráficos, tabelas finais | Alta (TCC 2) | 1 semana |
| **Seção de Resultados do artigo** — preencher com os números reais do experimento | Alta (TCC 2) | 1 semana |

### Recomendação para a apresentação

Para o orientador, é importante ressaltar:

1. **O framework está funcionalmente completo** — os 3 cenários rodam fim-a-fim
2. **A próxima entrega é o protocolo de avaliação** (Ground Truth + scripts de
   métricas), que é a Fase 4 da metodologia descrita na AA2
3. **A execução do experimento e análise estatística ficam para o TCC 2**,
   conforme cronograma original

---

## 8. Repositório

- **GitHub:** https://github.com/estermorais/Agentic-DAST
- **Stack:** TypeScript + Node.js 20 + Puppeteer + Anthropic SDK + axios + Docker
- **Modelo LLM padrão:** Claude Haiku 4.5 (`claude-haiku-4-5-20251001`)

A pasta `dist/` no repositório contém a versão JavaScript compilada do código,
gerada via `npm run build`. Os arquivos TypeScript em `src/` são a fonte
autoritativa.
