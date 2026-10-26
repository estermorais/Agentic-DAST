# Análise de sensibilidade ao modelo — Cenário C com Kimi K2.7

Replicação do Cenário C (Agentic DAST) trocando o LLM de **Claude Haiku 4.5**
(rodada oficial, ago/2026) por **Moonshot AI Kimi K2.7 Code** (out/2026), via
OpenRouter. Mesmo código da rodada oficial (commit `debc5ab`), mesmas imagens
Docker, mesmo `classify()` congelado, `n = 30` rodadas. Os Cenários A, B e D
**não** foram refeitos: usam os dados oficiais de ago/2026 (D continua no
Claude Sonnet, pois o PentestGPT roda sobre o Claude Code e não opera com Kimi).

## Adaptações de infraestrutura (em `patches-kimi.diff`)

1. **Reescrita de origem de loopback** (`HttpClient`/`BrowseTheWeb`): com o proxy
   ZAP ativo, uma URL absoluta em `localhost:3000` chegava literal ao ZAP e, de
   dentro do contêiner, `localhost` é o próprio ZAP (HTTP 502). Passou a ser
   reescrita para `juice-shop:3000`, como já era feito para URLs relativas. Esse
   502 também afetava a rodada com Haiku (29/30 rodadas), então é correção de
   ambiente, não específica do Kimi.
2. **Limite de tokens de saída** 2048 -> 3072 (`LLM_MAX_TOKENS`): o Kimi raciocina
   antes de responder; 2048 cortava respostas.
3. **Fallback para o campo `reasoning`**: o Kimi às vezes devolve `content` nulo
   com a resposta em `reasoning`; o cliente passou a usar `reasoning` quando
   `content` vem vazio.
4. Temperatura: não enviada (padrão do provedor), igual à rodada oficial.
5. Período posterior (out/2026) e comparação C(Kimi) x D(Sonnet) entre períodos
   diferentes — por isso o teste principal é o Mann-Whitney (não pareado).

## Resultados (Cenário C, 30 rodadas)

|                     | Haiku (oficial) | **Kimi (robustez)** | D (Sonnet) |
|---------------------|-----------------|---------------------|------------|
| F1 (média ± dp)     | 0,635 ± 0,062   | **0,648 ± 0,046**   | 0,312 ± 0,118 |
| Precisão            | 0,828           | 0,855               | 0,559      |
| Revocação           | 0,523           | 0,526               | 0,225      |
| Cobertura acumulada | 16/19           | **11/19**           | 12/19      |

### Decomposição por fonte (Kimi)

| Fonte isolada            | F1 (média ± dp)   | Cobertura |
|--------------------------|-------------------|-----------|
| Só loop ReAct            | 0,202 ± 0,150     | 9/19      |
| Só Abuse Cases           | 0,643 ± 0,000     | 9/19      |
| Só ZAP passivo           | 0,000             | 0/19      |

- ReAct do Kimi melhorou frente ao Haiku (0,152 -> 0,202), mas **continua abaixo
  do PentestGPT** (0,312): Mann-Whitney bicaudal p = 0,013; Cliff δ = −0,376
  (efeito médio). A conclusão central do trabalho (vantagem vem dos Abuse Cases,
  não do raciocínio autônomo) **se mantém com um modelo mais forte e de outra
  família**.

### C (Kimi) x D (Sonnet)

- Mann-Whitney U = 889,5; p = 4,1 × 10⁻¹¹ (unicaudal, C > D).
- Cliff δ = 0,977 (efeito grande, maior que os 0,963 do Haiku).
- IC 95% (bootstrap, seed 42): C [0,631; 0,665]; D [0,272; 0,355] — sem
  sobreposição.

### Cobertura: sem dominância estrita

- Kimi C (11): GT-BAC-01, GT-BAC-03, GT-JWT-01, GT-JWT-02, GT-SDE-01..04,
  GT-SQLI-01..03.
- D (12): GT-BAC-01, GT-BAC-03, GT-SDE-01..04, GT-SQLI-01..03, GT-XSS-01..03.
- Só em C: GT-JWT-01, GT-JWT-02. Só em D: GT-XSS-01, GT-XSS-02, GT-XSS-03.
- Diferente da rodada com Haiku (C ⊇ D, 16 vs 12), **não há dominância estrita**:
  é uma troca (JWT no C, XSS no D), e D cobre uma a mais. A queda de 16 para 11
  vem de detecções raras (XSS e GT-BLV-02 eram 1–2 rodadas em 30 no Haiku) que
  não ocorreram com o Kimi — ilustra a fragilidade da cobertura acumulada.

### Estabilidade, custo e tempo

- 9 das 11 vulnerabilidades do Kimi C apareceram em 100% das 30 rodadas.
- Cobertura por categoria: SQLI 3/3, SDE 4/4, JWT 2/2, BAC 2/4, XSS 0/3, BLV 0/3.
- Duração: média 220 s/rodada (mín 140, máx 731), total 110 min.
- Custo (OpenRouter, Kimi K2.7, cache ~98%): ~US$ 0,22/rodada, ~US$ 6,7 nas 30 —
  bem abaixo dos US$ 0,82/rodada do Haiku.

## Reprodução

- Relatórios brutos: `report-2026-10-23*.json` (30).
- Agregado: `_evaluation-summary-kimi.json`. Log: `_run-log-kimi.csv`.
- F1 do ReAct por rodada: `_react_f1_kimi.json`.
- Patches de infraestrutura: `patches-kimi.diff` (aplicar sobre o commit da
  rodada oficial; só muda cliente LLM, resolução de URL e limite de tokens).
