# Pseudocódigo — Agentic DAST

```
PROGRAMA AgenticDAST:

  // ── Fase 1: Percepção ──────────────────────────────
  browser ← iniciar Chrome (proxy → ZAP:8888)

  appMap ← {
    rotas: [],
    endpoints: [],
    auth: {}
  }

  PARA CADA rota EM ["/", "/#/login", "/#/basket", ...]:
    navegar(rota)
    aguardar SPA renderizar
    appMap.rotas += extrair formulários e botões do DOM
    appMap.endpoints += interceptar chamadas /api/ e /rest/

  navegar("/#/login")
  preencher(email="customer@juice-sh.op", senha="customer")
  clicar("Log in")
  appMap.auth.jwt ← capturar JWT do localStorage

  fechar browser


  // ── Fase 2: Inicialização do Executor ──────────────
  browser2 ← iniciar Chrome (proxy → ZAP:8888)
  actor ← Actor("SecurityAgent")
            .comBrowser(browser2)
            .comHttpClient(Axios)


  // ── Fase 3: Loop ReAct (Agente LLM) ────────────────
  histórico ← []
  histórico.adicionar( serializar(appMap) )

  REPETIR até MAX_ITERAÇÕES:

    resposta ← Claude(
      system: SYSTEM_PROMPT,   // cacheado → barato
      messages: histórico
    )

    thought ← extrair "Thought:" da resposta
    action  ← extrair "Action:" + "Action Input:" da resposta

    SE action == "finish":
      PARAR loop

    observação ← DESPACHAR(action):

      SE action == "navigate":
        browser2.goto(url)
        RETORNAR título + URL atual

      SE action == "fill_field":
        browser2.type(selector, value)
        RETORNAR confirmação

      SE action == "click_element":
        browser2.click(selector)
        RETORNAR URL após clique

      SE action == "read_page":
        RETORNAR primeiros 2000 chars do body

      SE action == "extract_tokens":
        jwt ← browser2.localStorage["token"]
        httpClient.setHeader("Authorization", "Bearer " + jwt)
        RETORNAR { jwt, cookies }

      SE action == "make_request":
        resposta ← httpClient.request(method, url, headers, body)
        RETORNAR "HTTP {status}\nBody: {resposta}"

      SE action == "report_finding":
        findings.adicionar({
          título, severidade, categoria,
          descrição, passos, evidência
        })
        RETORNAR "Finding registrado. Total: " + findings.tamanho

    histórico.adicionar("Observation: " + observação)


  // ── Fase 3b: Abuse Cases Predefinidos ──────────────
  // Categorias cobertas:
  //   [BLV]            AbuseNegativeQuantity, AbuseZeroStarReview
  //   [Access Control] AbuseIDOR, AbuseAdminRoute
  //   [XSS]            AbuseXSS
  //   [JWT]            AbuseJWT
  //   [Data Exposure]  AbuseSensitiveDataExposure
  //   [Injection]      AbuseSQLInjection

  PARA CADA task EM [NegativeQty, ZeroStar, IDOR, AdminRoute,
                     XSS, JWT, SensitiveData, SQLi]:

    resultado ← task(jwt=appMap.auth.jwt, baseUrl)

    SE resultado != null:
      abuseFindings.adicionar(resultado)


  // ── Fase 3c: Alertas do ZAP ────────────────────────
  zapFindings ← ZAP_API.getAlerts(baseUrl)
                        .filtrar(confiança > 0)
                        .converter para Finding[]


  // ── Fase 4: Relatório ──────────────────────────────
  todosFindings ← deduplificar(
    findings +        // descobertos pelo LLM
    abuseFindings +   // confirmados pelos Abuse Cases
    zapFindings       // detectados passivamente pelo ZAP
  )

  salvar "reports/report-{timestamp}.json" com {
    resumo, iterações, todosFindings, histórico de passos
  }

  fechar browser2
```

---

O ponto central é o **loop ReAct** na Fase 3: o LLM nunca recebe comandos diretos —
ele raciocina livremente (`Thought`), decide qual ferramenta usar (`Action`),
e a Observation do mundo real alimenta o próximo ciclo.
