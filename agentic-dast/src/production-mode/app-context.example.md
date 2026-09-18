# Contexto da aplicação — exemplo

> Copie este arquivo, preencha com informações REAIS do seu alvo e
> aponte `APP_CONTEXT_FILE` para ele no `.env`. Objetivo: ajudar o LLM
> a distinguir uma vulnerabilidade real de um caso de uso legítimo —
> reduzindo falso-positivo. **Não** torna nada "seguro por decreto":
> o agente ainda exige evidência concreta para reportar qualquer finding
> (ver regra 3a do system prompt).

## O que é a aplicação

- Nome / propósito de negócio (ex.: "CRM de relacionamento com clientes,
  usado por atendentes e gestores de contas").
- Tipo de arquitetura (SPA React, multi-tenant, mobile-first, etc.).
- Ambiente testado (produção real, staging, sandbox com dados sintéticos).

## Papéis e permissões (RBAC)

Descreva os papéis existentes e o que CADA UM pode/deve acessar por
design. Isso evita que o agente marque como "Broken Access Control"
algo que é a regra de negócio esperada.

- **Admin**: acesso total a todos os tenants/contas — por design.
- **Gestor de conta**: vê apenas os dados dos clientes vinculados à sua
  carteira.
- **Atendente**: vê apenas tickets/conversas atribuídos a ele.
- **Cliente final**: vê apenas os próprios dados.

## Dados públicos por design

Liste endpoints/dados que são intencionalmente públicos ou
semi-públicos, para não virarem "exposição de dados" falso-positivo.

- Ex.: `/api/public/status-page` — status do serviço, sem autenticação,
  proposital.
- Ex.: nomes e cargos de contatos em pesquisas de satisfação
  respondidas publicamente (o link da pesquisa é o "segredo").

## Fluxos que parecem suspeitos mas são esperados

- Ex.: o endpoint `/api/leads/export` permite exportar todos os leads
  de uma campanha — isso é uma feature usada por gestores, não uma
  falha de "mass assignment".
- Ex.: tokens JWT de curta duração (5 min) sem refresh automático são
  intencionais para o fluxo de embed em iframe de terceiros.

## O que NÃO está fora de escopo (reforço)

- Confirme aqui limites de escopo já definidos no `TARGET_PROFILE`
  (hosts/paths excluídos), se relevante — evita que o LLM proponha
  ações fora do combinado.

## Observações de segurança já conhecidas (opcional)

Se já existem findings aceitos ("risco conhecido e aceito pela
empresa"), documente aqui para o agente não repetir o achado óbvio e
focar em coisas novas — mas ele ainda pode reportar se achar evidência
de que o risco é maior do que o assumido.
