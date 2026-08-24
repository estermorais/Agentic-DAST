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

## Escolha do LLM (decisão importante antes de rodar)

O framework é agnóstico ao provedor de LLM. Suporta três configurações,
escolhidas via variável de ambiente `LLM_PROVIDER`. **Antes de rodar
contra qualquer sistema da empresa, defina qual usar em conjunto com o
DPO/time de segurança**, porque a escolha afeta onde os dados do alvo
vão trafegar.

| Provider | `LLM_PROVIDER` | Modelo padrão | Custo | Onde os dados trafegam |
|---|---|---|---|---|
| **OpenRouter** (default) | `openrouter` | Claude Haiku 4.5 | ~US$ 0,82 por rodada | Sua máquina → OpenRouter (EUA) → Anthropic (EUA) |
| **Anthropic direto** | `anthropic` | Claude Haiku 4.5 | ~US$ 0,82 por rodada | Sua máquina → Anthropic (EUA) |
| **Claude Code CLI** | `claude-cli` | Configurável via `LLM_MODEL` | Zero (usa assinatura Claude Pro da empresa) | Sua máquina → Anthropic (EUA) |
| **Ollama local** | `ollama` | Llama 3.1 / Qwen 2.5 (a definir) | Zero (compute local) | Nada sai da sua máquina |

### Implicação de LGPD

O CRM da empresa provavelmente contém dados pessoais de clientes
brasileiros. Se rodar com `openrouter` ou `anthropic`, cada resposta
`GET /api/leads`, `GET /api/contacts`, etc. **é enviada para servidores
nos EUA** como parte do prompt do LLM. Isso configura transferência
internacional de dados pessoais (art. 33 da LGPD) e precisa estar
alinhado com o DPO da empresa.

**Se essa aprovação não for possível**, use `LLM_PROVIDER=ollama`.
Trade-off: modelos locais (Llama 3.1 8B, Qwen 2.5 14B) têm qualidade
menor que o Claude Haiku 4.5 no raciocínio ReAct estruturado. Vão errar
formato com mais frequência, entrar em loop com mais frequência e
detectar menos vulnerabilidades. Ainda vale a pena se a alternativa é
não rodar.

### Configuração via `.env`

**OpenRouter (default):**
```env
LLM_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-v1-...      # obter em openrouter.ai/keys
LLM_MODEL=claude-haiku-4-5-20251001
```

**Anthropic direto:**
```env
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...          # obter em console.anthropic.com
LLM_MODEL=claude-haiku-4-5-20251001
```

**Claude Code CLI (usa assinatura Pro da empresa, sem custo adicional):**
```env
LLM_PROVIDER=claude-cli
LLM_MODEL=claude-haiku-4-5-20251001   # ver aviso científico abaixo
```

Pré-requisitos:
- `claude` CLI instalado e disponível no PATH
  ([code.claude.com/docs/en/install-claude-code](https://code.claude.com/docs/en/install-claude-code))
- Login OAuth previamente feito com `claude login` usando a conta
  Pro da empresa

Trade-offs em relação ao OpenRouter/Anthropic:

- **Rate limit do plano Pro** vai bater durante rodadas longas. Aconteceu
  no Cenário D do TCC 2 e exigiu pausas e retomadas. O framework detecta
  e reporta, mas o red team precisa estar pronto para esperar.
- **Overhead de ~1s por iteração** (cada Action do agente vira um
  `subprocess spawn`).
- **Prompt caching Anthropic-style não funciona** por este canal, o que
  em rodadas longas pode consumir mais quota do Pro do que o esperado.
- **Cada invocação aparece nos logs de uso** da conta Pro.

> ⚠️ **Aviso científico**: para que rodadas do red team possam alimentar
> o estudo de generalização do artigo, o `LLM_MODEL` **deve ser
> exatamente** `claude-haiku-4-5-20251001` (o mesmo do TCC 2). Se usarem
> outro modelo (Sonnet, Opus), os dados servem como pentest interno mas
> **não** como replicação científica direta — o desempenho medido
> refletiria o modelo escolhido, não o mesmo LLM que gerou os resultados
> publicados. A ideia do estudo é testar o **agente**, não o LLM
> substituído. Deixe isto claro no CSV de audit para não confundir
> análises futuras.

**Ollama local (nada sai da máquina):**
```env
LLM_PROVIDER=ollama
OLLAMA_MODEL=qwen2.5:14b
OLLAMA_HOST=http://localhost:11434
```

Requer Ollama instalado localmente (`ollama pull qwen2.5:14b`) e uma
GPU decente (RTX 3060+) para performance razoável.

### Custo estimado para o red team

Se optarem por OpenRouter ou Anthropic, o consumo esperado por rodada
`READ_ONLY=true` é **inferior a US$ 0,82** (menos ações executadas =
menos tokens processados). Para 10 rodadas de avaliação inicial no
CRM, orçar **US$ 10 em créditos** já cobre com folga. Custo pode ser
compartilhado como despesa de projeto de segurança.

---

## Autenticação em alvos com MFA / SSO / CAPTCHA

O `DOMExtractor` (Fase 1) tentaria fazer login automatizado usando
credenciais e rotas hardcoded do OWASP Juice Shop. Em qualquer alvo
real com MFA ou SSO, isso **não funciona** — Puppeteer não consegue
passar o segundo fator sozinho.

**Solução**: forneça o JWT manualmente via variável de ambiente
`MANUAL_JWT`. O framework detecta a presença dessa variável, pula
todo o fluxo de login automático e usa o JWT fornecido como identidade
autenticada para o resto da rodada.

### Como obter o JWT do CRM

1. Faça login no CRM pelo seu Chrome normalmente (senha + MFA)
2. Depois de autenticada, abra **DevTools → aba Network**
3. Faça qualquer ação que gere uma request autenticada (recarregar
   uma tela, clicar em um menu)
4. Clique numa das requests → aba **Headers** → procure o header
   `Authorization: Bearer <token>`
5. Copie **só a parte do token** (o texto depois de `Bearer `)

### Como passar pro framework

Adicione ao `.env` ou passe como env var da sessão:

```env
MANUAL_JWT=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

Ou em PowerShell antes de rodar:

```powershell
$env:MANUAL_JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

### Ressalvas importantes

- **Expiração**: JWTs corporativos duram tipicamente de 15 minutos a
  algumas horas. Se a rodada for longa, o token pode expirar no meio
  e todas as requests seguintes retornarão `401`. Se acontecer, o
  framework não relogado sozinho; encerra a sessão sem detectar as
  vulnerabilidades autenticadas. **Mitigação**: obter novo token
  imediatamente antes de iniciar cada rodada e usar
  `MAX_REACT_ITERATIONS` reduzido (10-15) pra caber dentro da janela.
- **Escopo do token**: o agente vai operar com as **permissões do
  usuário que gerou o token**. Se você quer testar vulnerabilidades
  de administrador, precisa gerar o JWT com uma conta admin. Se quer
  testar como usuário comum, use uma conta comum.
- **Dados do JWT vão pro LLM**: o token e as respostas autenticadas
  passam pelo prompt do LLM (Anthropic, EUA se estiver usando
  `openrouter`/`anthropic`/`claude-cli`). Considere isso na análise
  de LGPD/confidencialidade.
- **JWT no `.env`**: se colocar no arquivo, adicione o `.env` ao
  `.gitignore` (já está por padrão neste projeto) e apague depois
  da rodada. **Nunca comite JWT.**

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
- [ ] **Provedor de LLM escolhido em alinhamento com DPO** (OpenRouter/
      Anthropic exigem aprovação para transferência internacional de
      dados; Ollama local não exige)
- [ ] **Chave de API do provedor obtida e configurada no `.env`** (ou
      Ollama servindo modelo local)
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
