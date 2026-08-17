# Modo Produção — Agentic DAST

Módulo **opcional** que envolve o agente principal com uma camada de guardas
para uso em ambientes de produção autorizados. **Não faz parte da rodada
oficial do TCC 2** (Juice Shop, n=30) e não altera nenhum arquivo do módulo
principal.

## Quando usar

Use apenas quando **todas as condições** abaixo forem verdadeiras:

1. Você tem autorização escrita para testar o alvo
2. O alvo não é aplicação sintética/vulnerável-por-design (para essa,
   use `npm start` normal)
3. Você aceita rodar com humano no loop, aprovando ações destrutivas
4. Você aceita a possibilidade de o teste ser interrompido a qualquer momento

## Como funciona

O `SafeDispatcher` classifica cada ação proposta pelo LLM em quatro níveis:

| Nível | Exemplos | Comportamento padrão |
|---|---|---|
| **SAFE** | `GET`, `read_page`, `navigate`, `extract_tokens` | Executa direto |
| **MEDIUM** | `POST` genérico, `click` em submit | Pergunta, opção `[a]uto-approve` |
| **HIGH** | `PUT`/`PATCH`/`DELETE`, `POST` em `/admin`, JWT forjado | Sempre pergunta |
| **CRITICAL** | Endpoints de mensagem, webhook, exportação, billing | Exige confirmação dupla (`CONFIRMO`) |

Se `READ_ONLY=true`, tudo que não é SAFE é **bloqueado sem sequer perguntar**
— o LLM recebe uma observation dizendo que a ação foi bloqueada e sugere
alternativa. Isso é o modo recomendado para a primeira rodada em qualquer
alvo novo.

## Configuração via variáveis de ambiente

| Var | Default | O que faz |
|---|---|---|
| `READ_ONLY` | `false` | Bloqueia qualquer `POST`/`PUT`/`PATCH`/`DELETE` |
| `INTERACTIVE` | `true` | Pede confirmação em MEDIUM/HIGH/CRITICAL |
| `AUDIT_LOG` | vazio | Path do CSV com log de todas as ações executadas/puladas/bloqueadas |
| `RATE_LIMIT_MS` | `500` | Delay entre `make_request` (evita disparar WAF) |
| `CIRCUIT_BREAKER` | `0` | Encerra após N findings HIGH/CRITICAL (`0` = desativado) |
| `SKIP_ABUSE_CASES` | `false` | Se `true`, pula a fase de Abuse Cases (que não passa pelo SafeDispatcher) |

## Uso recomendado

**Primeira rodada em qualquer alvo novo — sempre modo read-only:**

```bash
READ_ONLY=true \
INTERACTIVE=true \
AUDIT_LOG=./logs/prod-first-run.csv \
SKIP_ABUSE_CASES=true \
npm run start:production
```

Isso executa uma sessão inteira onde o agente só pode fazer `GET`.
Tudo mais é bloqueado. Você valida:
- Se o AppMap foi construído corretamente para o novo alvo
- Se os endpoints listados no CSV de audit fazem sentido
- Se o agente encontrou algum finding só com leitura (SDE, exposição de
  dados, endpoints administrativos sem auth, etc.)

**Rodadas subsequentes com autorização humana em ações destrutivas:**

```bash
INTERACTIVE=true \
AUDIT_LOG=./logs/prod-run-002.csv \
CIRCUIT_BREAKER=5 \
RATE_LIMIT_MS=1000 \
npm run start:production
```

Aqui `READ_ONLY` está desativado, mas cada `POST`/`PUT`/`PATCH`/`DELETE`
vai passar pela sua aprovação no terminal. Você digita `y` para autorizar
ou `n` para pular. Circuit breaker encerra após 5 findings de severidade
alta — evita o agente aprofundar quando já achou o suficiente.

## Interface no terminal (exemplo)

Quando o LLM propõe uma ação MEDIUM/HIGH/CRITICAL, aparece assim:

```
────────────────────────────────────────────────────────────────────────
  ⚠️  HIGH — ação destrutiva ou sensível  Iteração 17
────────────────────────────────────────────────────────────────────────
  [Action]
    PATCH https://crm.empresa.com/api/v1/users/42
    Headers: {"Authorization":"Bearer eyJ..."}
    Body: {"role":"admin"}
  [Motivo da classificação]
    Método PATCH modifica estado no servidor.

  Autorizar? [y]es / [n]o / [q]uit
  >
```

Respostas aceitas:
- `y` / `yes` / `s` / `sim` — executa
- `n` / `no` / `nao` / `não` — pula, opcionalmente registra motivo
- `a` — só em MEDIUM: auto-approve para todos os MEDIUM restantes
- `q` — encerra a sessão gracioso, agente gera relatório com o que descobriu

Para CRITICAL, além de responder `y`, é preciso digitar `CONFIRMO`.

## Checklist antes de rodar em produção

- [ ] Autorização escrita do responsável pelo alvo (email do CTO/CISO/gestor)
- [ ] Conta de teste dedicada (nunca sua conta real de trabalho)
- [ ] SOC / time de segurança avisado do horário e IP de origem
- [ ] Snapshot do banco (se o alvo permitir)
- [ ] `.env` apontando `targetUrl` para o alvo autorizado (não para produção
      de outro sistema por engano)
- [ ] Primeira rodada com `READ_ONLY=true`
- [ ] `AUDIT_LOG` habilitado desde a primeira rodada

## Limitações declaradas

- **A fase de Abuse Cases** (`runAbuseCases`) chama o `HttpClient` direto,
  sem passar pelo `SafeDispatcher`. Isso ocorre por design — os Abuse Cases
  foram feitos sob medida para o Juice Shop e assumem alvo vulnerável. Em
  produção autorizada, **sempre use `SKIP_ABUSE_CASES=true`**.

- **Rate limit é aplicado apenas em `make_request`**. Ações do Puppeteer
  (`navigate`, `click_element`, `fill_field`) não têm delay adicional.

- **Detecção de payload suspeito** é heurística. Falsos positivos aqui
  são intencionais (leva a mais confirmações, nunca menos).

- **`SafeDispatcher` não modifica o `SYSTEM_PROMPT` do agente**. Se você
  quer restringir o escopo do teste (por exemplo, dizer ao agente "só
  teste rotas em `/api/v1/leads`"), edite o prompt do agente antes de
  rodar.
