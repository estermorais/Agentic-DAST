# Documentação Técnica — Agentic DAST

## Visão Geral

O **Agentic DAST** é um framework de testes de segurança dinâmicos (Dynamic Application Security Testing) que usa um LLM (Large Language Model) como agente autônomo para detectar múltiplas categorias de vulnerabilidades em Single Page Applications (SPAs): **Lógica de Negócio (BLV)**, **Broken Access Control**, **XSS**, **JWT Attacks**, **Sensitive Data Exposure** e **SQL Injection**.

O framework é dividido em **quatro módulos** que operam em sequência:

```
Percepção → Executor → Cognição → Abuse Cases → Auditoria → Relatório
```

---

## Estrutura de Arquivos

```
src/
├── index.ts                              ← Orquestrador principal
├── config.ts                             ← Configurações centralizadas (.env)
│
├── perception/
│   ├── types.ts                          ← Tipos do AppMap
│   └── DOMExtractor.ts                   ← Navegação automática e extração do DOM
│
├── cognitive/
│   ├── prompts.ts                        ← Prompt do sistema + funções de mensagem
│   └── ReActAgent.ts                     ← Loop ReAct (LLM autônomo via Claude API)
│
├── executor/
│   ├── ActionDispatcher.ts               ← Despachante de ações
│   ├── screenplay/
│   │   └── Actor.ts                      ← Padrão Screenplay: o agente de segurança
│   ├── abilities/
│   │   ├── BrowseTheWeb.ts               ← Controla o browser via Puppeteer
│   │   └── HttpClient.ts                 ← Faz requisições HTTP diretas (Axios)
│   └── tasks/
│       ├── AbuseNegativeQuantity.ts      ← Abuse Case [BLV]: quantidade negativa
│       ├── AbuseZeroStarReview.ts        ← Abuse Case [BLV]: rating zero via API
│       ├── AbuseIDOR.ts                  ← Abuse Case [Access Control]: carrinho alheio
│       ├── AbuseAdminRoute.ts            ← Abuse Case [Access Control]: endpoints admin
│       ├── AbuseXSS.ts                   ← Abuse Case [XSS]: stored XSS via feedback/perfil
│       ├── AbuseJWT.ts                   ← Abuse Case [JWT]: alg:none + payload adulterado
│       ├── AbuseSensitiveDataExposure.ts ← Abuse Case [Data Exposure]: FTP, config, /api/Users
│       ├── AbuseSQLInjection.ts          ← Abuse Case [Injection]: SQLi no endpoint de login
│       └── runner.ts                     ← Executa todos os Abuse Cases por categoria
│
└── auditor/
    └── ZapClient.ts                      ← Cliente da API REST do OWASP ZAP
```

---

## 1. `index.ts` — Orquestrador

**O que faz:** Ponto de entrada. Chama todos os módulos em sequência e gera o relatório consolidado.

**Fases de execução:**

| Fase | Módulo | O que faz |
|---|---|---|
| 1 | `DOMExtractor` | Navega pelo Juice Shop, captura DOM e endpoints, faz login, retorna AppMap |
| 2 | `ActionDispatcher.create()` | Inicializa browser Chrome + cliente HTTP para o agente |
| 3 | `ReActAgent.run(appMap)` | Executa o loop ReAct autônomo com o LLM (Claude) |
| 3b | `runAbuseCases(jwt, baseUrl)` | Executa os 4 Abuse Cases predefinidos |
| 3c | `ZapClient.getPassiveAlerts()` | Coleta alertas do scan passivo acumulados pelo ZAP |
| 4 | `printReport` / `saveReport` | Consolida e salva findings em `reports/report-<timestamp>.json` |

**Deduplicação:** Antes de salvar, `deduplicateFindings()` remove findings com título igual que possam ter sido encontrados por mais de um módulo.

**`finally`:** Garante que `dispatcher.teardown()` sempre fecha o Chrome, mesmo em caso de erro.

---

## 2. `config.ts` — Configurações

Lê variáveis do `.env` e exporta um objeto `config` tipado. Campos com `required()` lançam erro imediatamente se ausentes.

| Variável | Padrão | Descrição |
|---|---|---|
| `ANTHROPIC_API_KEY` | obrigatória | Chave da API Claude |
| `LLM_MODEL` | `claude-haiku-4-5-20251001` | Modelo LLM |
| `TARGET_URL` | `http://localhost:3000` | URL do alvo |
| `ZAP_API_URL` | `http://localhost:8080` | API REST do ZAP |
| `ZAP_API_KEY` | `zapkey123` | Chave do ZAP |
| `ZAP_PROXY_HOST` | `localhost` | Host do proxy ZAP |
| `ZAP_PROXY_PORT` | `8888` | Porta do proxy ZAP |
| `MAX_REACT_ITERATIONS` | `25` | Limite do loop ReAct |
| `USE_ZAP_PROXY` | `true` | Roteia browser pelo ZAP |

---

## 3. Módulo de Percepção

### `perception/types.ts`

Interfaces TypeScript que formam o **AppMap** — o mapa semântico da aplicação:

- **`FormField`** — campo de formulário com seu seletor CSS
- **`AppForm`** — formulário completo com campos e botão de submit
- **`ApiEndpoint`** — chamada HTTP interceptada (método, URL, status, body)
- **`AppRoute`** — rota da SPA com formulários e elementos interativos
- **`InteractiveElement`** — botão ou link clicável
- **`AuthContext`** — JWT, cookies e email coletados no login
- **`AppMap`** — estrutura raiz passada ao LLM

### `perception/DOMExtractor.ts`

**O que faz:** Abre o Chrome, navega por 10 rotas do Juice Shop, captura o DOM e as chamadas HTTP, faz login e retorna um `AppMap`.

**Métodos principais:**

**`launch()`** — inicia o Puppeteer. Com `USE_ZAP_PROXY=true`, passa `--proxy-server` ao Chrome para rotear o tráfego pelo ZAP.

**`extract()`** — itera sobre `JUICE_SHOP_ROUTES`. Por rota: abre aba, ativa interceptação de rede, aguarda SPA renderizar (`networkidle2` + 1,5s), extrai formulários e elementos, fecha aba.

**`enableNetworkInterception(page)`** — escuta `page.on('response')`. Filtra URLs com `/api/` ou `/rest/`, registra método, status, body. Marca `authRequired=true` se resposta foi 401/403.

**`extractRoute(page, path)`** — executa `page.evaluate()` dentro do browser (código corre no Chrome, não no Node). Extrai `<form>`, `mat-card`, inputs, botões e links. Gera seletores CSS automáticos: prefere `#id` > `[name="..."]` > posição no DOM.

**`collectAuthTokens()`** — faz login com `customer@juice-sh.op / customer`. Escuta a resposta de `/rest/user/login` para capturar o JWT. Fallback: lê `localStorage.token`.

**`collectAuthenticatedEndpoints(auth)`** — repete a navegação com JWT no header para capturar endpoints que só aparecem autenticado.

**`deduplicateEndpoints()`** — Set com chave `"MÉTODO:URL"`.

---

## 4. Módulo Executor

Implementa o **Screenplay Pattern**: Actor → Abilities → Tasks.

### `executor/screenplay/Actor.ts`

Representa o "atacante sintético". Interface fluente:
```typescript
Actor.named('SecurityAgent')
  .withBrowser(await BrowseTheWeb.launch())
  .withHttpClient(new HttpClient())
```
Construtor privado. `teardown()` fecha o browser.

### `executor/abilities/BrowseTheWeb.ts`

Encapsula o Puppeteer. Cada método retorna `string` (Observation para o LLM). Factory assíncrono via `BrowseTheWeb.launch()`.

| Método | O que faz |
|---|---|
| `navigate(url)` | `page.goto()` com `waitUntil: 'networkidle2'` |
| `fillField(selector, value)` | Limpa o campo e digita o novo valor |
| `clickElement(selector)` | Clica e aguarda 800ms para re-render Angular |
| `readPage()` | Retorna URL + título + até 2000 chars do body |
| `extractTokens()` | JWT do `localStorage` + cookies, retorna JSON |
| `close()` | `browser.close()` |

Todos os métodos têm `try/catch` — erros voltam como string para o LLM analisar.

### `executor/abilities/HttpClient.ts`

Axios para requisições HTTP diretas (sem browser). `validateStatus: () => true` — nunca lança exceção em 4xx/5xx, o LLM analisa o status. `setDefaultHeader()` injeta JWT após login.

### `executor/ActionDispatcher.ts`

Conecta o LLM ao mundo real. Recebe `ParsedAction` e delega à Ability correta.

**`ParsedAction` — União Discriminada:**
```typescript
type ParsedAction =
  | { action: 'navigate'; url: string }
  | { action: 'fill_field'; selector: string; value: string }
  | { action: 'click_element'; selector: string }
  | { action: 'read_page' }
  | { action: 'make_request'; method: string; url: string; headers?: ...; body?: ... }
  | { action: 'extract_tokens' }
  | { action: 'report_finding'; title: string; severity: string; ... }
  | { action: 'finish'; summary?: string }
```

**Comportamentos especiais:**
- `extract_tokens`: além de retornar ao LLM, propaga JWT para `HttpClient` automaticamente
- `report_finding`: acumula `Finding[]` internamente, imprime banner no console
- `finish`: detectado pelo `ReActAgent` antes de chamar `dispatch()`, encerra o loop

### `executor/tasks/` — Abuse Cases

Testes estruturados que garantem cobertura dos challenges documentados do Juice Shop, independente do que o LLM descobriu.

Cada task é uma função `async (jwt: string, baseUrl: string): Promise<Finding | null>` que usa axios diretamente (não o `HttpClient` do LLM, pois precisa parsear JSON).

#### `AbuseNegativeQuantity.ts`
Testa POST `/api/BasketItems` com `quantity: -100`. O frontend Angular valida apenas valores positivos, mas a API não revalida no backend. Se o servidor aceitar (HTTP 200/201), é vulnerável.

**Passos internos:**
1. GET `/api/Products` → obtém `productId` do primeiro produto
2. GET `/rest/user/whoami` → obtém `userId` para montar o `BasketId`
3. POST `/api/BasketItems` com `{ quantity: -100 }`

#### `AbuseZeroStarReview.ts`
Testa POST `/api/Feedbacks` com `rating: 0`. A UI permite apenas 1-5 estrelas, mas o backend não valida o range. Retorna `Finding` se HTTP 200/201.

#### `AbuseIDOR.ts`
Testa acesso ao carrinho de outro usuário. Descobre o `userId` atual via `/rest/user/whoami`, depois tenta acessar `/api/Baskets/{targetId}` onde `targetId ≠ userId`. Se retornar HTTP 200 com dados, é IDOR confirmado.

#### `AbuseAdminRoute.ts`
Testa acesso a endpoints administrativos com JWT de usuário comum:
- GET `/api/Users` (listagem de todos os usuários)
- GET `/api/Complaints` (reclamações internas)

Se qualquer um retornar HTTP 200 com dados, registra um Finding `CRITICAL`.

#### `runner.ts`
Executa os 4 Abuse Cases em sequência, coleta os Findings não-nulos e retorna. Imprime o resultado de cada task no console (`VULNERÁVEL` / `seguro` / `ERRO`).

---

## 5. Módulo Cognitivo

### `cognitive/prompts.ts`

**`SYSTEM_PROMPT`:** Instrui o LLM sobre seu papel (pesquisador de segurança), as 7 categorias de BLV, as ações disponíveis com exemplos JSON e o formato de resposta obrigatório (`Thought → Action → Action Input`). Marcado com `cache_control: ephemeral` para Prompt Caching da Anthropic (até 90% de redução de custo nas iterações 2-N).

**`buildInitialUserMessage(appMap)`:** Serializa o AppMap como JSON compacto, inclui o JWT completo.

**`buildObservationMessage(result)`:** Formata o retorno de cada ação: `Observation: <string>`.

### `cognitive/ReActAgent.ts`

Implementa o padrão **ReAct** (Yao et al., ICLR 2023).

**Loop principal:**
```
1. Envia AppMap como primeira mensagem
2. Repete até MAX_REACT_ITERATIONS:
   a. callLLM() → resposta do Claude
   b. Adiciona ao conversationHistory
   c. parseReActOutput() → extrai Thought + Action
   d. Se 'finish' → encerra com findings
   e. dispatcher.dispatch(action) → Observation
   f. Registra ReActStep
   g. Adiciona Observation ao histórico
3. Limite atingido → finishedCleanly = false
```

**`callLLM()`:** `client.messages.create()` com o histórico completo. O histórico cresce a cada iteração — o LLM tem memória de toda a sessão.

**`parseReActOutput(text)`:** Regex para extrair `Thought:`, `Action:` e `Action Input:` (JSON). Lida com JSON dentro de blocos Markdown.

---

## 6. Módulo de Auditoria

### `auditor/ZapClient.ts`

**O que faz:** Consulta a API REST do OWASP ZAP (porta 8080) para recuperar os alertas acumulados durante a navegação.

**Como o ZAP acumula alertas:** O Chrome foi configurado com `--proxy-server=localhost:8888`. Todo o tráfego gerado pela Fase 1 (Percepção) e pela Fase 3 (loop ReAct) passou pelo ZAP, que analisou cada requisição/resposta passivamente em busca de problemas de segurança (headers ausentes, informações sensíveis expostas, etc.).

**Métodos:**

**`getPassiveAlerts(targetBaseUrl)`** — GET `/JSON/alert/view/alerts/` com o baseurl do alvo. Filtra alertas com `confidence=0` (falsos positivos prováveis). Converte cada alerta para o formato `Finding`.

**`startActiveScan(url)`** — GET `/JSON/ascan/action/scan/` para iniciar um scan ativo no endpoint especificado. Retorna o `scanId`.

**`waitForScanCompletion(scanId)`** — polling a cada 5s em `/JSON/ascan/view/status/`. Timeout padrão de 3 minutos.

**Mapeamento de severidade ZAP → Finding:**

| ZAP riskcode | Severity |
|---|---|
| 3 | HIGH |
| 2 | MEDIUM |
| 1 | LOW |
| 0 | INFO |

Findings do ZAP têm o prefixo `[ZAP]` no título e a categoria `ZAP_PLUGIN_<pluginId>` para distinguir da origem.

---

## 7. Fluxo Completo de Dados

```
index.ts
  │
  ├─ [Fase 1] DOMExtractor.extract()
  │     └─ Chrome com proxy ZAP ativo
  │     └─ Navega 10 rotas → captura DOM + endpoints
  │     └─ Login automático → captura JWT
  │     └─ Retorna AppMap
  │
  ├─ [Fase 2] ActionDispatcher.create()
  │     └─ BrowseTheWeb.launch() → Chrome headless
  │     └─ new HttpClient() → Axios configurado
  │     └─ Actor.named('SecurityAgent')
  │
  ├─ [Fase 3] ReActAgent.run(appMap)
  │     └─ Claude analisa AppMap e raciocina
  │     └─ Loop Thought → Action → Observation:
  │           navigate / fill_field / click_element → BrowseTheWeb
  │           make_request → HttpClient
  │           extract_tokens → BrowseTheWeb + injeta JWT no HttpClient
  │           report_finding → acumula Finding[]
  │     └─ finish → AgentResult com findings + steps
  │
  ├─ [Fase 3b] runAbuseCases(jwt, baseUrl)
  │     └─ AbuseNegativeQuantity → POST /api/BasketItems qty=-100
  │     └─ AbuseZeroStarReview   → POST /api/Feedbacks rating=0
  │     └─ AbuseIDOR             → GET /api/Baskets/{outroId}
  │     └─ AbuseAdminRoute       → GET /api/Users, /api/Complaints
  │     └─ Retorna Finding[] confirmados
  │
  ├─ [Fase 3c] ZapClient.getPassiveAlerts()
  │     └─ GET /JSON/alert/view/alerts/ na API do ZAP
  │     └─ Converte alertas ZAP → Finding[]
  │
  └─ [Fase 4] saveReport()
        └─ deduplicateFindings(ReAct + AbuseCases + ZAP)
        └─ JSON consolidado → reports/report-<timestamp>.json
```

---

## 8. Padrões de Design Utilizados

| Padrão | Onde | Por quê |
|---|---|---|
| **ReAct** (Yao et al. 2023) | `ReActAgent.ts` | LLM raciocina antes de agir; Observations alimentam o próximo Thought |
| **Screenplay Pattern** | `Actor`, `BrowseTheWeb`, `HttpClient`, `tasks/` | Separa quem age (Actor), do que pode fazer (Ability), do que faz (Task) |
| **Factory Method Assíncrono** | `BrowseTheWeb.launch()`, `ActionDispatcher.create()` | Garante recursos async prontos antes do objeto ser exposto |
| **Discriminated Union** | `ParsedAction` | TypeScript estreita o tipo dentro de cada `case` — sem casts |
| **Prompt Caching** | `callLLM()` | Reduz custo em até 90% no loop ReAct (system prompt estático cacheado) |
| **Strategy implícita** | `runner.ts` com `TaskFn[]` | Novas tasks são adicionadas apenas ao array, sem alterar o runner |

---

## 9. Como Executar

### Pré-requisitos
- Node.js 18+
- Docker (Juice Shop + ZAP)
- Chave de API Anthropic

### Passo a passo

```bash
# 1. Subir o ambiente
cd agentic-dast
docker-compose up -d

# 2. Instalar dependências (apenas na primeira vez)
npm install

# 3. Configurar .env
cp .env.example .env
# preencha ANTHROPIC_API_KEY

# 4. Compilar
npx tsc

# 5. Executar
node dist/index.js
```

### `.env` mínimo

```env
ANTHROPIC_API_KEY=sk-ant-...
TARGET_URL=http://localhost:3000
USE_ZAP_PROXY=true
MAX_REACT_ITERATIONS=25
LLM_MODEL=claude-haiku-4-5-20251001
```

### Saída esperada

```
[ FASE 1 ] Percepção — construindo AppMap...
  Rotas encontradas : 10
  Endpoints de API  : 47
  Formulários       : 8
  JWT coletado      : sim

[ FASE 2 ] Executor — iniciando Actor...
[ FASE 3 ] Cognição — executando loop ReAct...
  [Cognitivo] ── Iteração 1/25 ──
  ...

[ FASE 3b ] Abuse Cases — testes estruturados...
  → AbuseNegativeQuantity... VULNERÁVEL [HIGH]
  → AbuseZeroStarReview...   VULNERÁVEL [MEDIUM]
  → AbuseIDOR...             VULNERÁVEL [HIGH]
  → AbuseAdminRoute...       VULNERÁVEL [CRITICAL]

[ FASE 3c ] Auditoria — coletando alertas ZAP...

[ FASE 4 ] Relatório final
  ...
  Relatório salvo em: reports/report-2026-03-16T...json
```

---

## 10. Como Adicionar um Novo Abuse Case

1. Crie `src/executor/tasks/AbuseNomeDoAtaque.ts` com a função:
```typescript
export async function abuseNomeDoAtaque(
  jwt: string,
  baseUrl: string,
): Promise<Finding | null> {
  // ... lógica do ataque com axios direto
  // retorne Finding se vulnerável, null se seguro
}
```

2. Importe e adicione ao array em `runner.ts`:
```typescript
import { abuseNomeDoAtaque } from './AbuseNomeDoAtaque';

const ABUSE_TASKS = [
  // ... tasks existentes
  { name: 'AbuseNomeDoAtaque', fn: abuseNomeDoAtaque },
];
```

Só isso. O runner executa automaticamente.
