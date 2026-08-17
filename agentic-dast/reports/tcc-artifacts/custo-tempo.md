# Análise de Custo e Tempo — Rodada Oficial n=30

## 1. Tempo de execução por rodada

Extraído do log oficial `_run-log.csv`. Cada valor corresponde ao tempo de parede entre o disparo do container do agente e a gravação do relatório.

| Cenário | n | Média (s) | Mediana (s) | Mín | Máx | Desvio | Total (min) |
|---|---|---|---|---|---|---|---|
| A | 30 | 345,0 | 343,0 | 167,5 | 385,5 | 37,2 | 172,5 |
| B | 30 | 90,7 | 90,6 | 89,3 | 92,7 | 0,7 | 45,3 |
| D | 30 | 251,8 | 234,2 | 129,6 | 519,4 | 93,8 | 125,9 |
| C | 30 | 397,3 | 387,6 | 68,8 | 799,6 | 163,2 | 198,7 |

**Tempo total de execução da rodada oficial:** 542,4 minutos (9,04 horas).

## 2. Iterações ReAct por rodada (Cenário C)

O agente do Cenário C usa loop ReAct com teto de 40 iterações. Encerramento antecipado ocorre quando o LLM emite `Action: finish` ou quando o circuit breaker do HttpClient detecta que o alvo caiu.

- Rodadas analisadas: **30**
- Média de iterações: **31,4**
- Mediana: **33,5**
- Mínimo: **3** / Máximo: **40**
- Desvio-padrão: **9,5**

Rodadas que bateram o teto de 40 iterações: **12/30 (40%)**. As demais encerraram voluntariamente via `Action: finish`.

## 3. Custo estimado do Cenário C

Modelo: **Claude Haiku 4.5 via OpenRouter**. Taxas oficiais: US\$ 1.00/MTok de input, US\$ 5.00/MTok de output, US\$ 0.10/MTok de cache read.

O custo por rodada foi observado empiricamente em 12 execuções de calibração após ativação do prompt caching Anthropic-style. Faixa observada: US\$ 0,68 a US\$ 1,02 por rodada, com mediana em US\$ 0,82. A telemetria completa está preservada no stdout dos runs individuais (`[LLM] input=N (cache_read=X/Y%) output=N custo≈$V`).

- Custo médio por rodada: **US\$ 0,82** (R\$ 4,26)
- Custo total (30 rodadas): **US\$ 24,60** (R\$ 127,92)
- Vulnerabilidades únicas detectadas: **16** (cobertura acumulada)
- **Custo por vulnerabilidade única detectada: US\$ 1,54** (R\$ 7,99)

## 4. Custo dos demais cenários

- **Cenário A e B (OWASP ZAP):** custo variável nulo. Infraestrutura local em Docker Compose.
- **Cenário D (PentestGPT via Claude Code CLI):** operado sob assinatura Claude Pro (US\$ 20/mês, uso não medido per-request). Rate limit da quota Pro foi atingido em algumas rodadas, exigindo pausas de espera. O custo variável por rodada é efetivamente zero até o limite da quota; após ele, novas execuções ficam bloqueadas até o reset de 5 horas. Não há métrica comparável ao billing per-token do Haiku 4.5.

## 5. Comparação de eficiência C vs D

Como o Cenário D não tem billing per-token acessível, a comparação direta de custo é restrita. Em termos de tempo, no entanto:

- Tempo médio C: 397,3 s
- Tempo médio D: 251,8 s
- Razão C/D: **1,58** — o framework proposto é mais lento por rodada.
- Findings brutos totais — C: **692** (média 23,1/rodada). D: **175** (média 5,8/rodada).

Um cálculo justo de custo por vulnerabilidade detectada favorece o Cenário C mesmo se, hipoteticamente, o custo do Claude Pro fosse dividido linearmente por rodada: US\$ 20 dividido pelas 30 rodadas produziria US\$ 0,67 por rodada do D, com apenas 12 vulnerabilidades únicas (US\$ 1,67 por vulnerabilidade única), enquanto o Cenário C custa US\$ 1,54 por vulnerabilidade única detectada.
