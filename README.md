# Agentic DAST

*Framework* de Teste Dinâmico de Segurança de Aplicações (DAST) baseado em **agentes autônomos LLM** para detecção de vulnerabilidades em *Single Page Applications* (SPAs).

Trabalho de Conclusão de Curso em Engenharia de Computação — CEFET-MG.
**Autora:** Ester Morais Neves   |   **Orientador:** Prof. Mateus Felipe Tymburibá Ferreira

---

## O que é

Ferramentas DAST convencionais, como o OWASP ZAP, operam por varredura sintática de URLs e injeção automatizada de *payloads*. Essa abordagem é estruturalmente inadequada para SPAs construídas com Angular, React ou Vue, porque a maior parte dos estados da aplicação só é alcançada após interação dinâmica com o DOM, e porque vulnerabilidades como Lógica de Negócio, IDOR e *bypass* de JWT exigem **compreensão semântica do domínio** da aplicação.

O Agentic DAST integra o raciocínio semântico de Modelos de Linguagem de Grande Porte (LLMs) com automação de navegador via Puppeteer e o padrão Screenplay, operando em um *loop* **ReAct** autônomo. O *framework* detecta vulnerabilidades em seis categorias do OWASP Top 10 que escapam à automação sintática:

| Categoria | Exemplos detectados pelos *Abuse Cases* |
|---|---|
| Lógica de Negócio (BLV) | Quantidade negativa no carrinho, *rating* fora do intervalo válido |
| *Broken Access Control* | IDOR em `/api/Baskets`, acesso indevido a rotas administrativas |
| XSS armazenado | *Payload* em `/api/Feedbacks` e `PATCH /api/Users/:id` |
| Ataques a JWT | `alg:none`, adulteração de *payload* com elevação de privilégio |
| Exposição de dados sensíveis | Diretório `/ftp/`, `/api/Users` sem autenticação |
| SQL Injection | *Bypass* de autenticação no *login* |

---

## Arquitetura

```
Percepção ─→ Cognitivo ─→ Executor ─→ Auditoria ─→ Relatório
```

| Módulo | Tecnologia | Responsabilidade |
|---|---|---|
| **Percepção** | Puppeteer + *Chrome DevTools Protocol* | Navega a SPA, intercepta XHR/Fetch, captura JWT e produz o `AppMap` |
| **Cognitivo** | `LLMClient` (Anthropic ou Ollama) + ReAct | Decide ações a cada iteração com base no `AppMap` e nas observações acumuladas |
| **Executor** | Padrão Screenplay (Actor + Abilities) | Despacha cada ação ao Puppeteer ou ao Axios; inclui 8 *Abuse Cases* determinísticos |
| **Auditoria** | OWASP ZAP em modo *daemon* | *Proxy* passivo + recuperação de alertas via API REST |

A camada `LLMClient` desacopla o *loop* ReAct do provedor concreto de LLM. As duas implementações disponíveis são `AnthropicClient` (experimentos finais, com *prompt caching*) e `OllamaClient` (testes de fumaça com modelos locais como Llama 3.2 ou Qwen 2.5, sem custo financeiro). A escolha é feita por variável de ambiente.

---

## Estrutura do repositório

```
.
├── README.md
│
└── agentic-dast/                              ← Código do framework
    ├── src/                                   ← TypeScript (fonte autoritativo)
    │   ├── index.ts                           ← Orquestrador do Cenário C
    │   ├── config.ts
    │   ├── perception/                        ← DOMExtractor + AppMap
    │   ├── cognitive/                         ← ReActAgent + LLMClient
    │   ├── executor/                          ← Actor, Abilities, Abuse Cases
    │   ├── auditor/                           ← ZapClient
    │   ├── production-mode/                   ← Camada de produção + Target Profile
    │   ├── scenarios/                         ← Cenários A, B e D
    │   │   ├── scenario-a.ts                  ← ZAP tradicional
    │   │   ├── scenario-b.ts                  ← ZAP + Puppeteer E2E
    │   │   ├── scenario-d.ts                  ← PentestGPT (controle)
    │   │   └── pentestgpt/                    ← Adaptador Python do PentestGPT
    │   └── evaluation/                        ← Pipeline de avaliação
    │       ├── ground-truth.json              ← 18 vulnerabilidades de referência
    │       ├── categories.ts
    │       ├── classify.ts                    ← TP / FP / FN
    │       ├── metrics.ts                     ← Precisão, Revocação, F1, F2
    │       └── evaluate.ts                    ← CLI de avaliação
    ├── dist/                                  ← JavaScript compilado
    ├── docs/                                  ← Documentação técnica
    ├── targets/                               ← Target Profiles (perfis de alvo)
    ├── docker-compose.yml                     ← Juice Shop + ZAP
    ├── package.json
    └── tsconfig.json
```

---

## Quick start

### Pré-requisitos

- Node.js 20+
- Docker e Docker Compose
- Pelo menos uma das opções de LLM:
  - **API da Anthropic** (Claude) — recomendado para os experimentos finais
  - **Ollama local** — para *smoke tests* e validação sem custo
- Python 3.10+ (opcional, apenas para o Cenário D)

### Configuração

```bash
cd agentic-dast
cp .env.example .env
# edite .env com ANTHROPIC_API_KEY ou ajuste para Ollama
npm install
npm run build
```

O `.env.example` documenta todas as variáveis. As principais:

| Variável | Valor recomendado | Observação |
|---|---|---|
| `LLM_PROVIDER` | `anthropic` ou `ollama` | Seleciona o *backend* do agente |
| `ANTHROPIC_API_KEY` | `sk-ant-...` | Necessária se `LLM_PROVIDER=anthropic` |
| `LLM_MODEL` | `claude-haiku-4-5-20251001` | Modelo Claude usado nos experimentos finais |
| `OLLAMA_MODEL` | `llama3.2:3b` | Modelo local para *smoke tests* |
| `TARGET_URL` | `http://localhost:3000` | Alvo (Juice Shop) |

### Subir o ambiente

```bash
docker compose up -d   # sobe Juice Shop em :3000 e ZAP em :8080/:8888
```

### Executar os cenários

```bash
npm run scenario:a                          # ZAP tradicional
npm run scenario:b                          # ZAP + Puppeteer E2E
npm run scenario:c                          # Agentic DAST (cenário experimental)
PENTESTGPT_MOCK=1 npm run scenario:d        # PentestGPT em modo mock (gratuito)
```

Os relatórios JSON são salvos em `agentic-dast/reports/`.

### Avaliar os resultados

```bash
npm run evaluate                # processa todos os relatórios de reports/
```

O `evaluate` lê todos os JSONs em `reports/`, classifica cada *finding* contra a matriz *Ground Truth* (18 vulnerabilidades), calcula Precisão, Revocação, F1 e F2 por cenário e por categoria, e grava um resumo agregado em `reports/_evaluation-summary.json`.

---

## Experimento

O *framework* é avaliado em **quatro cenários comparativos** sobre o OWASP Juice Shop, com **n = 30 rodadas independentes por cenário** (totalizando 120 execuções controladas):

| Cenário | Descrição | Papel |
|---|---|---|
| **A** | OWASP ZAP com *spider* tradicional + *scan* ativo | *Baseline* sintático |
| **B** | ZAP guiado por *script* E2E de navegação humana | *Baseline* guiado |
| **C** | Agentic DAST autônomo em modo *black-box* | Cenário experimental |
| **D** | PentestGPT (agente LLM generalista) | Controle tecnológico de LLM |

O Cenário D existe para **isolar a contribuição arquitetural** do trabalho: sem ele, qualquer superioridade do C sobre A e B poderia ser atribuída apenas à presença de um LLM, e não às escolhas arquiteturais do *framework*.

### Métricas reportadas

- **Eficácia:** Precisão, Revocação, F1-*Score*, F2-*Score* — *overall* e por categoria
- **Eficiência:** custo por TP (USD) e *tokens* por TP — comparação entre os Cenários C e D
- **Cobertura:** três contadores operacionais distintos (*endpoints* únicos, estados de UI únicos via *hash* do DOM dentro de `<router-outlet>`, formulários únicos)

### Análise estatística

Teste de **Wilcoxon *signed-rank*** pareado para os pares (A, C), (B, C) e (C, D), com α = 0,05 unicaudal. Cada métrica primária é acompanhada de **Intervalo de Confiança a 95 %** calculado por *bootstrap* com 10.000 reamostragens.

---

## Status do projeto

**Concluído (TCC I):**

- Implementação completa do *framework* (4 módulos, ~3 mil linhas de TypeScript)
- Adaptador `LLMClient` com suporte a Anthropic e Ollama
- 8 *Abuse Cases* cobrindo 6 categorias do OWASP Top 10
- Cenários A, B, C e D implementados e validados em *smoke tests*
- Matriz *Ground Truth* com 18 vulnerabilidades sobre o Juice Shop
- *Pipeline* de avaliação automática (Wilcoxon-*ready*, IC 95 % por *bootstrap*)
- Protocolo experimental revisado, incorporando *feedback* do orientador
- Artigo no formato SBC com Introdução, Fundamentação Teórica, Trabalhos Relacionados, Framework e Plano de Avaliação

**A fazer (TCC II):**

- Execução das 120 rodadas (30 × 4 cenários) com modelos definidos com o orientador
- Análise estatística completa (Wilcoxon + IC 95 %)
- Geração dos gráficos finais (Matplotlib + Seaborn + SciencePlots, estilo IEEE)
- Redação das seções de Resultados e Discussão
- Espelhamento anônimo do repositório para submissão duplamente cega
- Submissão a conferência (alvo inicial: **SBSeg**)

---

## Documentação

| Documento | Conteúdo |
|---|---|
| [`agentic-dast/docs/DOCUMENTACAO.md`](agentic-dast/docs/DOCUMENTACAO.md) | Documentação técnica do *framework* |
| [`agentic-dast/docs/PSEUDOCODIGO.md`](agentic-dast/docs/PSEUDOCODIGO.md) | Pseudocódigo dos componentes principais |
| [`agentic-dast/src/production-mode/HANDOFF.md`](agentic-dast/src/production-mode/HANDOFF.md) | Guia de uso em produção (red team) |
| [`agentic-dast/src/production-mode/README.md`](agentic-dast/src/production-mode/README.md) | Referência do modo produção e do Target Profile |
| [`agentic-dast/src/scenarios/pentestgpt/README.md`](agentic-dast/src/scenarios/pentestgpt/README.md) | Setup do adaptador do Cenário D |

---

## Referências principais

- YAO, S. *et al*. **ReAct: Synergizing Reasoning and Acting in Language Models.** ICLR, 2023.
- DENG, G. *et al*. **PentestGPT: An LLM-Empowered Automatic Penetration Testing Framework.** USENIX Security, 2024.
- DAVID, I.; GERVAIS, A. **Multi-Agent Penetration Testing AI for the Web.** arXiv:2508.20816, 2025.
- JASWAL, A. S.; BAGHEL, A. **AWE: Adaptive Agents for Dynamic Web Penetration Testing.** arXiv:2603.00960, 2026.
- ERDEM, G. T. **How Reliable Are AI Attackers Against a Fixed Vulnerable Target?** arXiv:2605.30096, 2026.
- WAZLAWICK, R. S. **Metodologia de pesquisa para ciência da computação.** 2 ed. Elsevier, 2014.
- OWASP FOUNDATION. **OWASP Juice Shop** e **OWASP Top 10**, 2024.

---

## Licença e ética

Os experimentos são conduzidos integralmente em ambiente isolado (contêineres Docker locais), sobre o OWASP Juice Shop, uma aplicação intencionalmente vulnerável para fins didáticos. Não há interação com infraestrutura de terceiros e nenhum *exploit* novo é divulgado. O *framework* destina-se a pesquisa e a auditorias de segurança autorizadas.
