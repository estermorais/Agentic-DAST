"use strict";
/**
 * executor/abilities/HttpClient.ts
 * ---------------------------------------------------------------
 * Ability do Screenplay Pattern responsável por requisições HTTP
 * diretas, sem passar pelo browser (útil para abusar APIs REST).
 *
 * Usa Axios para suporte a todos os métodos HTTP, headers e body
 * personalizados. Não lança exceção em respostas 4xx/5xx —
 * retorna o status como parte da Observation para o LLM.
 * ---------------------------------------------------------------
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.HttpClient = exports.TARGET_DOWN_MARKER = void 0;
const axios_1 = __importDefault(require("axios"));
const config_1 = require("../../config");
const sameSite_1 = require("../../util/sameSite");
/**
 * Resolve uma URL que pode vir relativa (ex: "/api/Users") contra a
 * URL-base do alvo. Necessário porque o LLM, ao gerar make_request,
 * tipicamente usa paths relativos — sem isso, o axios falha com
 * "Invalid URL".
 *
 * Usa browserBaseUrl (nao targetUrl) porque, com proxy ZAP ativo, o
 * axios envia essa URL literal ao proxy e quem resolve o hostname
 * destino e o ZAP, de dentro do seu container. 'localhost' la dentro
 * seria o proprio ZAP, entao usamos 'juice-shop:3000', que resolve
 * pela Docker network 'dast-net' (mesma logica do Chrome/Puppeteer).
 */
function resolveUrl(url) {
    if (/^https?:\/\//i.test(url))
        return url;
    try {
        return new URL(url, config_1.config.browserBaseUrl).toString();
    }
    catch {
        return url;
    }
}
// Marker string returned quando o alvo cai (circuit breaker aberto). O
// ReActAgent detecta este prefixo e para o loop com finish, evitando
// gastar tokens em iteracoes repetidas contra um servidor morto.
exports.TARGET_DOWN_MARKER = 'ERRO_ALVO_INDISPONIVEL';
// Numero de falhas de conexao consecutivas antes de abrir o breaker.
const CIRCUIT_BREAKER_THRESHOLD = 3;
// Padroes que indicam que o alvo caiu (nao um erro de payload, mas
// indisponibilidade). Nao inclui erros HTTP 5xx do proprio alvo, so os
// que vem de conexao recusada / proxy sem destino.
const CONNECTION_FAILURE_PATTERNS = [
    /ECONNREFUSED/i,
    /Connection refused/i,
    /ZAP Error.*HttpHostConnectException/i,
    /HTTP 502 .* ZAP Error/,
];
function looksLikeConnectionFailure(observation) {
    return CONNECTION_FAILURE_PATTERNS.some((p) => p.test(observation));
}
class HttpClient {
    defaultHeaders = {
        'Content-Type': 'application/json',
    };
    // Headers de AUTENTICAÇÃO do alvo (Authorization/Cookie). Separados dos
    // defaultHeaders porque só podem ser enviados a hosts do PRÓPRIO alvo —
    // enviá-los a terceiros (Auth0, Freshchat, analytics que o agente
    // resolva chamar) vazaria o token de sessão do alvo. Escopo = mesmo
    // domínio registrável do alvo.
    authHeaders = {};
    authScopeHost = (0, sameSite_1.hostOf)(config_1.config.browserBaseUrl);
    // Circuit breaker: se as ultimas N requests seguidas indicam servidor
    // fora do ar, todas as chamadas subsequentes retornam TARGET_DOWN_MARKER
    // sem tocar na rede. O LLM viu duas vezes hoje o juice-shop cair
    // no meio de um run e continuar emitindo make_request contra
    // localhost:3000 com 502 em loop, gastando tokens em iteracoes vazias.
    consecutiveFailures = 0;
    breakerOpen = false;
    /**
     * Define um header padrão que será enviado em todas as requisições.
     * Útil para configurar o Authorization: Bearer após login.
     */
    setDefaultHeader(key, value) {
        this.defaultHeaders[key] = value;
    }
    /**
     * Define um header de AUTENTICAÇÃO do alvo (Authorization/Cookie).
     * Diferente de setDefaultHeader: só é enviado a requisições cujo host
     * seja do mesmo domínio registrável do alvo — nunca a terceiros.
     */
    setAuthHeader(key, value) {
        this.authHeaders[key] = value;
    }
    /**
     * Faz uma requisição HTTP e retorna uma Observation formatada.
     *
     * @param method  - Método HTTP (GET, POST, PUT, DELETE, PATCH)
     * @param url     - URL completa do endpoint
     * @param headers - Headers adicionais (merged com os defaults)
     * @param body    - Body da requisição (serializado como JSON)
     */
    async request(method, url, headers, body) {
        const fullUrl = resolveUrl(url);
        // Só anexa os headers de auth do alvo se o host de destino for
        // same-site (mesmo domínio registrável). Para terceiros, o token do
        // alvo é omitido — evita exfiltração cross-host do Bearer/Cookie.
        const destHost = (0, sameSite_1.hostOf)(fullUrl);
        const includeAuth = (0, sameSite_1.sameSite)(destHost, this.authScopeHost);
        const authToSend = Object.keys(this.authHeaders).length > 0;
        const mergedHeaders = {
            ...this.defaultHeaders,
            ...(includeAuth ? this.authHeaders : {}),
            ...headers,
        };
        if (authToSend && !includeAuth) {
            console.log(`[Executor] Auth do alvo OMITIDA para host de terceiro (${destHost}) — não vaza o token.`);
        }
        const axiosConfig = {
            method: method.toUpperCase(),
            url: fullUrl,
            headers: mergedHeaders,
            data: body !== null && body !== undefined ? body : undefined,
            // Não lança exceção em 4xx/5xx para que o LLM possa analisar
            validateStatus: () => true,
            timeout: 10_000,
        };
        // Roteia pelo ZAP quando o proxy esta ativo, para que as chamadas
        // que o LLM emite via 'make_request' tambem alimentem a auditoria
        // passiva. Sem isso, so o trafego do Chrome era gravado e o scan
        // passivo perdia toda a superficie de API testada pelo agente.
        if (config_1.config.useZapProxy) {
            axiosConfig.proxy = {
                host: config_1.config.zapProxyHost,
                port: config_1.config.zapProxyPort,
                protocol: 'http',
            };
        }
        // Se o circuit breaker ja abriu, nao tenta mais. Retorna o marker
        // que o ReActAgent vai detectar para encerrar o loop cedo.
        if (this.breakerOpen) {
            return `${exports.TARGET_DOWN_MARKER}: alvo indisponivel apos ${CIRCUIT_BREAKER_THRESHOLD} ` +
                `falhas de conexao consecutivas. Nao ha mais tentativas nesta sessao. ` +
                `Encerre com Action: finish e sumario indicando servidor caiu mid-run.`;
        }
        try {
            const response = await (0, axios_1.default)(axiosConfig);
            const bodyCap = config_1.config.httpMaxBodyChars;
            const bodyStr = typeof response.data === 'object'
                ? JSON.stringify(response.data, null, 2).substring(0, bodyCap)
                : String(response.data).substring(0, bodyCap);
            const truncationNote = JSON.stringify(response.data).length > bodyCap
                ? '\n[... resposta truncada]'
                : '';
            const observation = (`HTTP ${response.status} ${method.toUpperCase()} ${fullUrl}\n` +
                `Headers de resposta: ${JSON.stringify(response.headers)}\n` +
                `Body:\n${bodyStr}${truncationNote}`);
            // Circuit breaker: uma 502 do ZAP com HttpHostConnectException
            // significa que o ZAP nao conseguiu se conectar ao alvo (juice-shop
            // caiu). Nao e um 502 legitimo da aplicacao — e um sinal de servidor
            // fora. HTTP 200/4xx/5xx do proprio alvo reseta o contador.
            if (response.status === 502 && looksLikeConnectionFailure(observation)) {
                this.consecutiveFailures += 1;
            }
            else {
                this.consecutiveFailures = 0;
            }
            if (this.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
                this.breakerOpen = true;
                console.warn(`[HttpClient] Circuit breaker ABERTO apos ${CIRCUIT_BREAKER_THRESHOLD} ` +
                    `falhas consecutivas. Chamadas subsequentes retornarao TARGET_DOWN_MARKER.`);
            }
            return observation;
        }
        catch (err) {
            const msg = err.message;
            if (looksLikeConnectionFailure(msg)) {
                this.consecutiveFailures += 1;
                if (this.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
                    this.breakerOpen = true;
                    console.warn(`[HttpClient] Circuit breaker ABERTO (${CIRCUIT_BREAKER_THRESHOLD} erros ` +
                        `de rede consecutivos). Chamadas subsequentes retornarao TARGET_DOWN_MARKER.`);
                }
            }
            return `ERRO de rede em ${method.toUpperCase()} ${fullUrl}: ${msg}`;
        }
    }
}
exports.HttpClient = HttpClient;
//# sourceMappingURL=HttpClient.js.map