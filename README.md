# Agentic DAST

Framework de testes de segurança dinâmicos (DAST) baseado em agente autônomo LLM para detecção de vulnerabilidades em Single Page Applications (SPAs).

Desenvolvido como Trabalho de Conclusão de Curso em Engenharia de Computação — CEFET-MG.

---

## O que é

O Agentic DAST integra o raciocínio semântico de Grandes Modelos de Linguagem (LLMs) com automação de navegadores via Puppeteer e o padrão Screenplay, operando em um loop ReAct autônomo para detectar vulnerabilidades que ferramentas tradicionais não conseguem identificar.

### Categorias de vulnerabilidades cobertas

| Categoria | Exemplos |
|---|---|
| Lógica de Negócio (BLV) | Preço negativo, cupom duplo, rating inválido |
| Broken Access Control | IDOR no carrinho, rotas administrativas |
| XSS | Stored XSS via feedback e perfil de usuário |
| JWT Attacks | Algoritmo `none`, payload adulterado |
| Sensitive Data Exposure | Diretório FTP, endpoints sem autenticação |
| SQL Injection | Bypass de autenticação via login |

---

## Arquitetura

```
Percepção → Cognitivo → Executor → Abuse Cases → Auditoria → Relatório
```

| Módulo | Tecnologia | Responsabilidade |
|---|---|---|
| Percepção | Puppeteer + CDP | Navega a SPA e extrai o AppMap (DOM, endpoints, tokens) |
| Cognitivo | Claude API + ReAct | Raciocina sobre o AppMap e decide as próximas ações |
| Executor | Screenplay + Puppeteer + Axios | Executa as ações no browser e via HTTP |
| Abuse Cases | TypeScript | Testes estruturados por categoria de vulnerabilidade |
| Auditoria | OWASP ZAP daemon | Scan passivo e ativo do tráfego interceptado |

---

## Estrutura do repositório

```
.
├── README.md
│
├── agentic-dast/                  ← Código do framework
│   ├── src/                       ← TypeScript (fonte autoritativo)
│   │   ├── index.ts               ← Orquestrador principal (Cenário C)
│   │   ├── perception/            ← Extrator DOM e AppMap
│   │   ├── cognitive/             ← Agente LLM (ReAct loop)
│   │   ├── executor/              ← Screenplay + Abuse Cases
│   │   ├── auditor/               ← Cliente OWASP ZAP
│   │   ├── scenarios/             ← Cenários A e B (baselines)
│   │   └── evaluation/            ← Pipeline de Precision/Recall/F1
│   ├── dist/                      ← JavaScript compilado (npm run build)
│   ├── docs/                      ← Documentação técnica do framework
│   │   ├── DOCUMENTACAO.md
│   │   └── PSEUDOCODIGO.md
│   ├── docker-compose.yml         ← Juice Shop + ZAP
│   ├── package.json
│   └── tsconfig.json
│
└── docs/                          ← Documentação acadêmica
    ├── artigo/                    ← Artigo TCC + pré-projeto + bib
    │   ├── artigo_agentic_dast.tex
    │   ├── pre_projeto_agentic_dast.tex
    │   └── referencias.bib
    ├── metodologia/               ← Atividades da disciplina Met. de Pesquisa
    │   ├── metodologia_aa1.tex
    │   └── metodologia_aa2.tex
    └── apresentacao/              ← Materiais para reunião com orientador
        ├── APRESENTACAO_ORIENTADOR.md
        └── MAPA_DO_PROJETO.md
```

---

## Como executar

### Pré-requisitos

- Node.js 20+
- Docker e Docker Compose
- Chave de API da Anthropic

### Configuração

```bash
cd agentic-dast
cp .env.example .env
# edite .env com sua ANTHROPIC_API_KEY
npm install
```

### Executar

```bash
# Sobe o ambiente (Juice Shop + ZAP)
docker-compose up -d

# Roda o agente
npm start
```

O relatório JSON é salvo em `agentic-dast/reports/`.

---

## Alvo de validação

[OWASP Juice Shop](https://owasp.org/www-project-juice-shop/) — aplicação Angular intencionalmente vulnerável, usada como *Ground Truth* para o experimento comparativo.

---

## Experimento

O framework é avaliado em três cenários comparativos:

- **Cenário A** — OWASP ZAP com spider tradicional (baseline)
- **Cenário B** — ZAP guiado por script E2E de navegação humana (baseline)
- **Cenário C** — Agentic DAST autônomo em modo black-box (experimental)

Métricas: Precision, Recall, F1-Score por categoria de vulnerabilidade.
