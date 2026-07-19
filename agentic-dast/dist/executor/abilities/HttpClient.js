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
exports.HttpClient = void 0;
const axios_1 = __importDefault(require("axios"));
const config_1 = require("../../config");
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
class HttpClient {
    defaultHeaders = {
        'Content-Type': 'application/json',
    };
    /**
     * Define um header padrão que será enviado em todas as requisições.
     * Útil para configurar o Authorization: Bearer após login.
     */
    setDefaultHeader(key, value) {
        this.defaultHeaders[key] = value;
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
        const mergedHeaders = { ...this.defaultHeaders, ...headers };
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
        try {
            const response = await (0, axios_1.default)(axiosConfig);
            // Serializa o body de resposta de forma legível mas limitada
            const bodyStr = typeof response.data === 'object'
                ? JSON.stringify(response.data, null, 2).substring(0, 1500)
                : String(response.data).substring(0, 1500);
            const truncationNote = JSON.stringify(response.data).length > 1500
                ? '\n[... resposta truncada]'
                : '';
            return (`HTTP ${response.status} ${method.toUpperCase()} ${fullUrl}\n` +
                `Headers de resposta: ${JSON.stringify(response.headers)}\n` +
                `Body:\n${bodyStr}${truncationNote}`);
        }
        catch (err) {
            // Erros de rede (timeout, DNS, conexão recusada)
            return `ERRO de rede em ${method.toUpperCase()} ${fullUrl}: ${err.message}`;
        }
    }
}
exports.HttpClient = HttpClient;
//# sourceMappingURL=HttpClient.js.map