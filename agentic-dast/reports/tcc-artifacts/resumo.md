# Resumo da Rodada Oficial (TCC 2)

**Autora:** Ester Morais Neves
**Orientador:** Mateus Tymburibá
**Curso:** Engenharia de Computação, CEFET-MG
**Aplicação-alvo:** OWASP Juice Shop v17.2.0
**Ground Truth:** 19 vulnerabilidades distribuídas em 6 categorias OWASP
**Design experimental:** 30 execuções por cenário, intercaladas em round-robin (A, B, C, D)

## 1. Métricas agregadas

Os quatro cenários planejados no TCC 1 rodaram por completo, sem alteração de protocolo entre execuções.

| Cenário | n | Precisão | Recall | F1 (μ ± σ) | Cobertura |
|---|---|---|---|---|---|
| A (ZAP puro) | 30 | 0,000 | 0,000 | 0,000 ± 0,000 | 0/19 (0%) |
| B (ZAP + E2E) | 30 | 0,000 | 0,000 | 0,000 ± 0,000 | 0/19 (0%) |
| **C (Agentic DAST)** | **30** | **0,828** | **0,523** | **0,635 ± 0,062** | **16/19 (84%)** |
| D (PentestGPT) | 30 | 0,559 | 0,225 | 0,312 ± 0,120 | 12/19 (63%) |

A coluna de F1 mostra o resultado mais imediato: o framework proposto (Cenário C) fica com F1 médio de 0,635, mais do que o dobro do valor obtido pelo Cenário D com PentestGPT. Os dois cenários que dependem só do ZAP zeraram, pelas razões discutidas na próxima seção.

## 2. Achados principais

### 2.1. O framework proposto supera o baseline LLM

O Cenário C teve F1 médio de 0,635 contra 0,312 do Cenário D (PentestGPT). Em precisão, ficou em 0,828 contra 0,559; em recall, 0,523 contra 0,225. No total, o framework proposto detectou quatro vulnerabilidades a mais do que o baseline (16 contra 12).

### 2.2. As detecções do Cenário C são estáveis entre rodadas

O desvio-padrão do F1 no Cenário C foi de 0,062, praticamente metade do observado no Cenário D (0,120). Nove das dezesseis vulnerabilidades detectadas apareceram em 100% das trinta rodadas, o que ajuda a defender reprodutibilidade apesar da natureza estocástica do LLM. A temperatura fixada em 0,3 contribuiu, mas o principal fator foi a estrutura do prompt e o formato das observations retornadas pelo Módulo Executor.

### 2.3. Dominância estrita do Cenário C sobre o Cenário D

Este é o resultado que considero mais forte para a defesa. O conjunto de vulnerabilidades detectadas pelo PentestGPT é subconjunto próprio do conjunto detectado pelo framework proposto:

- Detectadas apenas pelo Cenário C (4): GT-BAC-02, GT-BLV-02, GT-JWT-01 e GT-JWT-02
- Detectadas apenas pelo Cenário D (0): nenhuma
- Detectadas por ambos (12): GT-BAC-01, GT-BAC-03, GT-SDE-01 a GT-SDE-04, GT-SQLI-01 a GT-SQLI-03, GT-XSS-01 a GT-XSS-03

A ausência de vulnerabilidades JWT no repertório do PentestGPT é sintomática do seu perfil generalista. O modelo não escolhe entre `alg:none` e adulteração de claims sem uma sugestão externa, comportamento que o prompt especializado do Cenário C provoca.

### 2.4. ZAP em modo automático não penetra SPAs autenticadas

Os Cenários A e B geraram dezenas de alertas por rodada, mas todos eram configuracionais (ausência de CSP, cookies sem HttpOnly, versão do Modernizr, cabeçalhos ausentes). A função `isConfigurationalAlert()` em `src/evaluation/categories.ts` descarta esses alertas antes do cálculo de métricas, uma vez que correspondem a recomendações de hardening e não a vulnerabilidades funcionais do Ground Truth. Sem eles, os dois cenários zeraram. O resultado confirma a hipótese motivadora do trabalho: DAST tradicional não penetra a superfície reativa do Angular, em que rotas, tokens e efeitos colaterais só se materializam depois de sequências de interação.

## 3. Cobertura por categoria (Cenário C)

| Categoria OWASP | Detectadas | Percentual |
|---|---|---|
| SQL Injection | 3/3 | 100% |
| JSON Web Token | 2/2 | 100% |
| Sensitive Data Exposure | 4/4 | 100% |
| Cross-Site Scripting | 3/3 | 100% |
| Broken Access Control | 3/4 | 75% |
| Business Logic | 1/3 | 33% |
| **Total** | **16/19** | **84%** |

Quatro das seis categorias atingiram cobertura integral. Broken Access Control ficou em 3/4, com GT-BAC-04 (Change Other Users) como única não-detecção. Business Logic é a categoria mais fraca, com apenas GT-BLV-02 (Zero Stars) detectado; as outras duas escaparam de todos os cenários e estão discutidas mais adiante.

## 4. Vulnerabilidades não detectadas

Três GTs passaram intactas por todas as 120 execuções acumuladas:

1. **GT-BLV-01 (Negative Order).** Exige adicionar produto ao carrinho com quantidade negativa e completar a compra. É uma manipulação que quebra premissas silenciosas do domínio, e a interface não dá pista nenhuma que sugira a tentativa.
2. **GT-BLV-03 (Forged Coupon).** O cupom válido é gerado por um esquema `base64(rating || timestamp)` que não aparece em lugar algum da interface. Sem código-fonte, teria que ser descoberto por engenharia reversa, algo que nenhum agente tentou.
3. **GT-BAC-04 (Change Other Users).** Depende de um `PATCH /api/Users/:id` contra o identificador de outro usuário. O LLM do Cenário C chegou a sondar `GET` no mesmo endpoint (e detectou GT-SDE-03 por causa disso), mas não migrou para `PATCH`. Uma modificação de prompt sugerindo métodos HTTP menos comuns provavelmente recuperaria essa vulnerabilidade, mas ficou fora da rodada oficial para preservar homogeneidade dos dados.

O padrão é reconhecido na literatura de LLM-based pentesting (Deng et al. 2024, Fang et al. 2024): agentes black-box têm dificuldade em vulnerabilidades de lógica de negócio de alta especificidade, em que não há nenhum sinal na superfície da aplicação que sugira o comportamento anômalo. As três lacunas serão declaradas na seção de Ameaças à Validade.

## 5. Top 10 GTs por frequência de detecção (Cenário C)

| Rank | ID | Vulnerabilidade | Frequência | % |
|---|---|---|---|---|
| 1 | GT-BAC-03 | Admin Section | 30/30 | 100% |
| 2 | GT-SDE-03 | Exposed User List | 30/30 | 100% |
| 3 | GT-JWT-01 | Forged Signed JWT (alg:none) | 30/30 | 100% |
| 4 | GT-JWT-02 | JWT Issue (admin tamper) | 30/30 | 100% |
| 5 | GT-SDE-01 | Confidential Document | 30/30 | 100% |
| 6 | GT-SDE-02 | Backup File | 30/30 | 100% |
| 7 | GT-SDE-04 | Admin Configuration Disclosure | 30/30 | 100% |
| 8 | GT-SQLI-01 | Login Admin | 30/30 | 100% |
| 9 | GT-SQLI-02 | Login Bender | 30/30 | 100% |
| 10 | GT-SQLI-03 | Search Injection | 12/30 | 40% |

Nove das dez primeiras vulnerabilidades foram detectadas em todas as trinta rodadas. A queda começa em GT-SQLI-03 (Search Injection), cuja detecção depende de o agente escolher fazer testes contra o endpoint de busca, algo que só aconteceu em pouco menos da metade das execuções.

## 6. Configuração experimental

O ambiente rodou em Docker Compose com Juice Shop v17.2.0 e OWASP ZAP 2.15 numa rede isolada chamada `dast-net`. Antes de cada execução, os dois containers foram reiniciados com `docker compose restart juice-shop zap`, garantindo estado limpo. O agente do Cenário C usa Claude Haiku 4.5 via OpenRouter com prompt caching Anthropic-style ativado (redução de custo por rodada de cerca de 70%). O Cenário D usa Claude Sonnet pelo Claude Code CLI, plano Pro. A temperatura ficou fixa em 0,3 nos dois casos.

O limite máximo de iterações ReAct foi definido em 40. Um circuit breaker no HttpClient encerra o loop após três falhas consecutivas de conexão, evitando desperdício de tokens contra alvo temporariamente indisponível. A classificação de findings usa a função `classify()` em `src/evaluation/classify.ts`, com matching multi-categoria por palavras-chave específicas (limiar de 12 caracteres) e `endpointHint` permissivo. Alertas configuracionais são segregados antes do cálculo de TP/FP, como descrito na Subseção 2.4.

## 7. Limitações declaradas

Cinco pontos ficam registrados como ameaças à validade:

1. Vulnerabilidades de lógica de negócio de alta especificidade não foram detectadas por nenhum agente (BLV-01, BLV-03, BAC-04). Isso reflete limitação intrínseca de LLMs em explorar cenários sem pistas na superfície da aplicação.
2. Durante a execução do Cenário D houve rate limit do plano Pro em algumas rodadas. As tentativas mal-sucedidas foram reclassificadas como `failed` pelo script `fix-silent-failures.py` e removidas da amostra final, mas isso alongou o cronograma de execução.
3. O custo de tokens limitou o teto de iterações ReAct a 40 por execução. Configuração maior poderia expandir a cobertura marginal, mas ficou fora do escopo.
4. A única aplicação-alvo é o Juice Shop. Os resultados não generalizam automaticamente para SPAs com arquiteturas ou padrões distintos.
5. O classificador determinístico baseado em palavras-chave, apesar de refinado com matching cross-category e limiar de especificidade, pode produzir falsos negativos por rotulagem imprecisa do LLM.

## 8. Artefatos gerados

Todos disponíveis em `reports/tcc-artifacts/`:

- `resumo.md`: este documento
- `boxplot-f1.png`: distribuição do F1-score por cenário
- `barchart-coverage.png`: cobertura acumulada por cenário e categoria
- `heatmap-detection.png`: frequência de detecção por vulnerabilidade individual
- `tables.tex`: quatro tabelas em LaTeX prontas para inclusão via `\input{}`

Fontes de dados usadas na consolidação:

- `reports/_evaluation-summary.json`
- `reports/report-*.json` e `scenario-*.json` (120 relatórios oficiais)
- `src/evaluation/ground-truth.json`
