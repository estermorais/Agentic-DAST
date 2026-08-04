# Análise Estatística — Rodada Oficial n=30

## 1. Intervalos de confiança bootstrap (95%) para F1 médio

Reamostragem com reposição, 10.000 iterações, seed = 42.

| Cenário | n | F1 médio | IC 95% | Amplitude |
|---|---|---|---|---|
| A | 30 | 0.000 | [0.000; 0.000] | 0.000 |
| B | 30 | 0.000 | [0.000; 0.000] | 0.000 |
| C | 30 | 0.635 | [0.614; 0.657] | 0.043 |
| D | 30 | 0.312 | [0.272; 0.356] | 0.084 |

## 2. Teste de Wilcoxon signed-rank (C vs D)

Pareamento por índice de rodada, justificado pelo round-robin: a i-ésima rodada do Cenário C foi executada no mesmo ciclo temporal da i-ésima rodada do Cenário D. Hipótese nula: distribuição das diferenças F1(C)_i − F1(D)_i é simétrica em torno de zero.

- Pares analisados: **30**
- Diferença média (C − D): **0.323** (desvio 0.143)
- Estatística W: **463.0**
- p-valor (unicaudal, C > D): **2.79e-09**
- Rejeita H0 ao nível α=0,05? **SIM**

## 3. Teste de Mann-Whitney U (C vs D)

Trata as amostras como independentes, sem exigir pareamento. Usado como checagem de robustez do teste anterior.

- Estatística U: **883.5**
- p-valor (unicaudal, C > D): **7.45e-11**
- Rejeita H0 ao nível α=0,05? **SIM**

## 4. Cliff's delta (tamanho do efeito)

Métrica não-paramétrica que quantifica a magnitude da dominância estocástica. Faixas de Vargha e Delaney (2000): |d| < 0,147 negligível; 0,147–0,33 pequeno; 0,33–0,474 médio; ≥ 0,474 grande.

- **C vs D:** δ = **0.963** (magnitude: **grande**)
- **C vs A:** δ = **1.000** (magnitude: **grande**)
- Interpretação: quase toda das rodadas do Cenário C excede o valor observado no Cenário D.

## 5. Teste de Fisher exato: distribuição de detecções por categoria (RQ4)

Compara, para cada categoria OWASP, se a proporção de vulnerabilidades detectadas pelo Cenário C difere significativamente da proporção detectada pelo Cenário D. Fisher exato é apropriado devido ao tamanho pequeno das contagens por categoria (2 a 4 GTs por célula).

| Categoria | C detectou | D detectou | Total | p-valor (Fisher) |
|---|---|---|---|---|
| SQL Injection | 3/3 | 3/3 | 1.000 |
| JSON Web Token | 2/2 | 0/2 | 0.333 |
| Sensitive Data Exposure | 4/4 | 4/4 | 1.000 |
| Cross-Site Scripting | 3/3 | 3/3 | 1.000 |
| Broken Access Control | 3/4 | 2/4 | 1.000 |
| Business Logic | 1/3 | 0/3 | 1.000 |

## 6. Comparativo global de cobertura (qui-quadrado)

- Tabela de contingência 2×2: C = 16/19, D = 12/19
- χ² = **1.221** (gl = 1)
- p-valor bilateral: **0.269**
- Rejeita H0 (proporções iguais)? **NÃO** ao nível α=0,05
