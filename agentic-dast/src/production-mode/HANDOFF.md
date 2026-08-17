# HANDOFF — Agentic DAST para Red Team

Documento de entrega do framework Agentic DAST em modo produção,
para uso pelo time de segurança ofensiva.

**Autora do framework:** Ester Morais Neves
**Contato:** estermoraisneves@gmail.com
**Repositório:** https://github.com/estermorais/Agentic-DAST
**Versão:** 1.0 (validada sobre OWASP Juice Shop v17.2.0, n=30 rodadas)

---

## O que é

Agente autônomo baseado em LLM (Claude Haiku 4.5 por padrão) que faz
DAST em SPAs autenticadas. Foi construído para o TCC da autora e
validado empiricamente sobre o OWASP Juice Shop, atingindo F1 médio
de 0,635 e cobertura de 16/19 vulnerabilidades documentadas.

O módulo `src/production-mode/` é uma camada de segurança opcional
que envolve o agente principal com aprovação humana antes de ações
destrutivas ou sensíveis. Foi construído especificamente para permitir
uso em ambientes autorizados sem risco de causar dano ao alvo.

---

## Estado atual do framework para uso em produção

| Item | Status |
|---|---|
| Módulo `production-mode` implementado e compila | ✅ |
| Testes unitários do classificador de risco | ❌ (não escritos) |
| Rodada real em alvo de produção autorizado | ❌ (nunca executada) |
| Rodada de sanity check contra alvo público (httpbin, etc.) | ❌ (recomendada antes da primeira rodada real) |
| Documentação de uso | ✅ ([README.md](./README.md)) |

**Implicação:** o red team será o **primeiro grupo a usar em alvo real.**
Comportamento em produção não foi validado empiricamente. Trate como
alpha, não como release.

---

## Quickstart

Assumindo Node 20+ instalado e OpenRouter API key disponível:

```bash
git clone https://github.com/estermorais/Agentic-DAST.git
cd Agentic-DAST/agentic-dast
npm install
npm run build

# Configure .env
cat > .env <<EOF
LLM_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-v1-...
LLM_MODEL=claude-haiku-4-5-20251001
TARGET_URL=https://alvo-autorizado.empresa.com
BROWSER_BASE_URL=https://alvo-autorizado.empresa.com
USE_ZAP_PROXY=false
MAX_REACT_ITERATIONS=15
EOF

mkdir -p logs reports

# Primeira rodada obrigatória: read-only, com humano no loop
READ_ONLY=true \
INTERACTIVE=true \
AUDIT_LOG=./logs/first-run.csv \
SKIP_ABUSE_CASES=true \
npm run start:production
```

Documentação completa: [`README.md`](./README.md) neste diretório.

---

## Limitações que o red team precisa conhecer

Cinco pontos que o módulo `production-mode` NÃO resolve:

1. **Não valida `TARGET_URL`.** Se o `.env` apontar para o alvo errado,
   o agente ataca o alvo errado. Confira duas vezes.

2. **Read-only não impede vazamento de dados.** `GET` ainda retorna
   payloads que passam pelo LLM. Se o provedor for OpenRouter/Anthropic,
   os dados são enviados para servidores nos EUA. Considere `LLM_PROVIDER=ollama`
   se o alvo tem dados sensíveis sob LGPD.

3. **`RiskClassifier` é heurístico.** Regex de path cobre padrões
   comuns (`/messages`, `/webhooks`, `/billing`) mas pode ter falso
   negativo para convenções específicas do alvo. Ajustar
   `CRITICAL_PATH_PATTERNS` em [`RiskClassifier.ts`](./RiskClassifier.ts)
   conforme necessário.

4. **`Abuse Cases` (fase 3b) rodam via HttpClient direto**, sem passar
   pelo `SafeDispatcher`. **Sempre use `SKIP_ABUSE_CASES=true` em
   produção.** Se esquecer, 8 exploits específicos do Juice Shop
   vão tentar executar contra o alvo.

5. **`DOMExtractor` (fase 1) faz login automático e navegação inicial
   sem passar pelo `SafeDispatcher`.** Isso é considerado seguro para
   alvos que aceitam login normal, mas se o alvo tem lógica de negócio
   que dispara efeito colateral no login (webhook de "user logged in",
   por exemplo), avalie desativar essa fase manualmente.

---

## Configurações recomendadas por cenário

### Sanity check (validar setup, alvo público)

```bash
TARGET_URL=https://httpbin.org \
READ_ONLY=true INTERACTIVE=false SKIP_ABUSE_CASES=true \
MAX_REACT_ITERATIONS=3 npm run start:production
```

### Primeira rodada em alvo autorizado

```bash
READ_ONLY=true INTERACTIVE=true \
AUDIT_LOG=./logs/target-run-001.csv \
SKIP_ABUSE_CASES=true \
MAX_REACT_ITERATIONS=15 \
npm run start:production
```

### Rodada com aprovação humana em ações destrutivas

```bash
INTERACTIVE=true \
AUDIT_LOG=./logs/target-run-002.csv \
CIRCUIT_BREAKER=5 RATE_LIMIT_MS=1000 \
SKIP_ABUSE_CASES=true \
npm run start:production
```

---

## Alimentando o estudo científico da autora

Se o red team autorizar, os resultados das rodadas em ambiente
autorizado podem alimentar um estudo de generalização do framework
(o TCC foi validado só em Juice Shop; um alvo real é dado científico
valioso). Como colaborar:

1. **Antes da rodada:** preencher o arquivo
   [`ground-truth-target-template.json`](./ground-truth-target-template.json)
   listando as vulnerabilidades já conhecidas do alvo (categoria,
   endpoint, severidade). Não precisa ser exaustivo, só as principais.

2. **Após a rodada:** rodar o script de comparação:
   ```bash
   python3 scripts/compare-findings-vs-gt.py \
     reports/report-production-<timestamp>.json \
     src/production-mode/ground-truth-target-filled.json
   ```

   Ele imprime: quantas vulns do GT foram redescobertas, quais foram,
   quais foram missed, e quais findings do agente são potencialmente
   novos (não estavam no GT).

3. **Enviar o output** (não os dados sensíveis) por email para a
   autora. Formato mínimo:
   - Tipo genérico da aplicação (ex: "CRM comercial", sem nome)
   - Stack (linguagem, framework)
   - Métricas: TP, FP, FN, cobertura, F1
   - Findings anonimizados (categoria e endpoint genérico, sem
     payload real)

Esse dado, se autorizado, aparecerá anonimizado no artigo que a
autora pretende submeter após a defesa do TCC 2. O nome da empresa
ou do produto não será mencionado.

---

## Reporte de bugs / sugestões

- **Bug no framework:** issue no GitHub ou email direto
- **Comportamento inesperado do agente:** enviar o log da sessão
  (JSON do relatório + CSV de audit) por email. **Remover dados
  sensíveis antes.**
- **Sugestão de melhoria no `RiskClassifier`:** PR no repositório
  ou descrição por email

---

## O que a autora garante e o que não garante

**Garante:**
- Framework compila e roda sem erros contra Juice Shop
- Módulo `production-mode` foi testado unitariamente durante
  desenvolvimento (dry-runs contra endpoints locais)
- `SafeDispatcher` bloqueia efetivamente ações não-GET em modo
  `READ_ONLY=true`

**Não garante:**
- Comportamento correto em qualquer alvo real (nunca foi testado)
- Cobertura de vulnerabilidades comparável ao Juice Shop em outros alvos
- Detecção de todas as ações destrutivas via `RiskClassifier` (é
  heurístico)
- Isolamento absoluto do alvo (o red team é responsável pelo
  ambiente de execução, autorização e escopo)

---

## Checklist final antes de rodar em produção

- [ ] Autorização escrita do responsável pelo alvo (interno da empresa)
- [ ] Alvo confirmado no `.env` (`TARGET_URL` visto por 2 pessoas)
- [ ] Time de operação/SOC avisado do horário e IP de origem
- [ ] Snapshot do banco (se aplicável)
- [ ] Sanity check já executado (contra httpbin ou similar)
- [ ] Primeira rodada será `READ_ONLY=true`
- [ ] `SKIP_ABUSE_CASES=true` presente no comando
- [ ] `AUDIT_LOG` configurado
- [ ] Alguém do red team disponível no terminal para responder aprovações
- [ ] Plano de resposta se algo der errado (contato para reverter, DBA
      de plantão, etc.)
