# Dados experimentais

Relatórios brutos e artefatos consolidados do experimento do TCC. Todos os
números do artigo são reproduzíveis a partir destes arquivos com os *scripts*
em [`../scripts/`](../scripts/).

## Rodada oficial (n = 30 por cenário, 120 execuções)

Alvo: OWASP Juice Shop v17.2.0, em contêiner Docker. Cada relatório é uma
execução independente, com a lista de *findings* e metadados.

| Arquivos | Cenário | Modelo |
|---|---|---|
| `scenario-a-*.json` | A — OWASP ZAP (*spider* + *scan* ativo) | — |
| `scenario-b-*.json` | B — OWASP ZAP passivo sobre navegação E2E | — |
| `report-2026-07*.json`, `report-2026-08*.json` | C — Agentic DAST | Claude Haiku 4.5 |
| `scenario-d-*.json` | D — PentestGPT | Claude Sonnet |

Consolidados:

- `_evaluation-summary.json` — métricas agregadas e por rodada (saída de `npm run evaluate`).
- `_run-log.csv` — log oficial das execuções (cenário, arquivo, *findings*, duração, status).
- `tcc-artifacts/` — tabelas (`tables.tex`), figuras (`*.pdf`) e resumos usados no artigo.

## Replicação com Kimi K2.7 — `robustez-kimi/`

Análise de sensibilidade ao modelo: o Cenário C repetido com o Moonshot AI
Kimi K2.7 Code (30 rodadas), descrita na subseção de robustez do artigo. Contém
os 30 relatórios, o agregado, o log, os F1 do ReAct por rodada, as adaptações de
infraestrutura (`patches-kimi.diff`) e um `README.md` com toda a metodologia e os
números. A conclusão central se mantém: o *loop* ReAct continua abaixo do
PentestGPT e a vantagem do *framework* vem dos *Abuse Cases*.

## Como reproduzir

```bash
cd ..                      # agentic-dast/
npm run evaluate           # recalcula _evaluation-summary.json a partir dos relatórios
node scripts/decomposicao-por-fonte.js     # decomposição por fonte (ReAct/Abuse/ZAP)
python scripts/statistical-analysis.py     # Wilcoxon, Mann-Whitney, Cliff, bootstrap
python scripts/cost-time-analysis.py       # custo e tempo
```

## Observações

- Os relatórios da **validação exploratória em produção** (SPA comercial real,
  seção 7 do artigo) **não** estão versionados, por conterem dados de um alvo
  real; o artigo os reporta de forma anonimizada e agregada.
- Arquivos auxiliares (`*.log`, transcripts, *backups*, `_archive/`) são
  ignorados pelo *git* e não fazem parte do conjunto oficial.
