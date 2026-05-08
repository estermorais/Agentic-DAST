"use strict";
/**
 * auditor/ZapClient.ts
 * ---------------------------------------------------------------
 * Módulo de Auditoria — cliente da API REST do OWASP ZAP.
 *
 * O ZAP opera em modo daemon (via Docker) e analisa passivamente
 * todo o tráfego que passa pelo seu proxy (porta 8888).
 * Este módulo:
 *   1. Consulta os alertas do scan passivo após a navegação
 *   2. Opcionalmente dispara um scan ativo em endpoints específicos
 *   3. Converte alertas ZAP no formato Finding usado pelo framework
 *
 * Referência: https://www.zaproxy.org/docs/api/
 * ---------------------------------------------------------------
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ZapClient = void 0;
const axios_1 = __importDefault(require("axios"));
const config_1 = require("../config");
class ZapClient {
    baseUrl;
    apiKey;
    constructor() {
        this.baseUrl = config_1.config.zapApiUrl;
        this.apiKey = config_1.config.zapApiKey;
    }
    // ===========================================================
    // Scan Passivo
    // ===========================================================
    /**
     * Recupera os alertas do scan passivo para a URL base fornecida.
     * O ZAP acumula esses alertas automaticamente enquanto o Puppeteer
     * navega pela aplicação com o proxy configurado.
     *
     * Filtra alertas de baixíssima confiança (False Positive provável).
     */
    /**
     * Diagnóstico: retorna quantas mensagens HTTP o ZAP capturou.
     * Útil para confirmar que o proxy está realmente recebendo tráfego.
     */
    async getMessageCount() {
        try {
            const response = await axios_1.default.get(`${this.baseUrl}/JSON/core/view/numberOfMessages/`, {
                params: { apikey: this.apiKey },
                timeout: 5_000,
                validateStatus: () => true,
            });
            return parseInt(response.data?.numberOfMessages ?? '0', 10);
        }
        catch {
            return 0;
        }
    }
    async getPassiveAlerts(targetBaseUrl) {
        console.log('[Auditoria] Consultando alertas passivos do ZAP...');
        // Diagnóstico: confirma que o ZAP viu tráfego
        const msgCount = await this.getMessageCount();
        console.log(`[Auditoria] ZAP capturou ${msgCount} mensagem(ns) HTTP.`);
        try {
            // Não filtramos por baseurl: o ZAP rodando em contêiner pode ter
            // registrado alertas com URLs internas (juice-shop:3000) que não
            // casam com a baseurl externa (localhost:3000). Sem filtro,
            // pegamos todos os alertas e o filtro fica a cargo da fase de
            // classificação (que casa por keyword no título).
            const response = await axios_1.default.get(`${this.baseUrl}/JSON/alert/view/alerts/`, {
                params: {
                    apikey: this.apiKey,
                    start: 0,
                    count: 500,
                },
                timeout: 60_000,
                validateStatus: () => true,
            });
            // Sinaliza ao caller qual URL foi solicitada (apenas para log)
            void targetBaseUrl;
            if (response.status !== 200) {
                console.warn(`[Auditoria] ZAP respondeu HTTP ${response.status}. Sem alertas.`);
                return [];
            }
            const alerts = response.data?.alerts ?? [];
            // Filtro removido: a triagem por relevância acontece na fase de
            // classificação (evaluation/classify.ts), que casa por keyword e
            // categoria. Cortar aqui por confidence = 0 estava descartando 100%
            // dos alertas em algumas configurações do ZAP.
            console.log(`[Auditoria] ${alerts.length} alerta(s) ZAP recebido(s).`);
            return alerts.map((a) => this.zapAlertToFinding(a));
        }
        catch (err) {
            console.warn(`[Auditoria] ZAP inacessível ou sem alertas passivos: ${err.message}`);
            return [];
        }
    }
    // ===========================================================
    // Scan Ativo
    // ===========================================================
    /**
     * Dispara um scan ativo do ZAP na URL especificada.
     * Retorna o ID do scan ou null em caso de falha.
     *
     * ATENÇÃO: O scan ativo envia payloads de ataque reais.
     * Usar apenas em ambientes de teste controlados.
     */
    async startActiveScan(url) {
        console.log(`[Auditoria] Iniciando scan ativo em: ${url}`);
        try {
            const response = await axios_1.default.get(`${this.baseUrl}/JSON/ascan/action/scan/`, {
                params: {
                    url,
                    apikey: this.apiKey,
                    recurse: true,
                    inScopeOnly: false,
                    scanPolicyName: '',
                    method: '',
                    postData: '',
                },
                timeout: 30_000,
                validateStatus: () => true,
            });
            const scanId = response.data?.scan;
            if (!scanId) {
                console.warn('[Auditoria] ZAP não retornou scan ID.');
                return null;
            }
            console.log(`[Auditoria] Scan ativo iniciado. ID: ${scanId}`);
            return scanId;
        }
        catch (err) {
            console.warn(`[Auditoria] Erro ao iniciar scan ativo: ${err.message}`);
            return null;
        }
    }
    // ===========================================================
    // Spider Tradicional
    // ===========================================================
    /**
     * Dispara o spider tradicional do ZAP na URL especificada.
     * Retorna o ID do scan ou null em caso de falha.
     * Usado pelo Cenário A do experimento comparativo.
     */
    async startSpider(url) {
        console.log(`[Auditoria] Iniciando spider em: ${url}`);
        try {
            const response = await axios_1.default.get(`${this.baseUrl}/JSON/spider/action/scan/`, {
                params: {
                    url,
                    apikey: this.apiKey,
                    maxChildren: 10,
                    recurse: true,
                    contextName: '',
                    subtreeOnly: false,
                },
                timeout: 30_000,
                validateStatus: () => true,
            });
            const scanId = response.data?.scan;
            if (!scanId) {
                console.warn('[Auditoria] ZAP spider não retornou scan ID.');
                return null;
            }
            console.log(`[Auditoria] Spider iniciado. ID: ${scanId}`);
            return scanId;
        }
        catch (err) {
            console.warn(`[Auditoria] Erro ao iniciar spider: ${err.message}`);
            return null;
        }
    }
    /**
     * Aguarda a conclusão do spider (polling a cada 5s).
     * Retorna true se concluiu dentro do timeout.
     */
    async waitForSpiderCompletion(scanId, timeoutMs = 300_000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            try {
                const response = await axios_1.default.get(`${this.baseUrl}/JSON/spider/view/status/`, {
                    params: { scanId, apikey: this.apiKey },
                    timeout: 5_000,
                    validateStatus: () => true,
                });
                const progress = parseInt(response.data?.status ?? '0', 10);
                process.stdout.write(`\r[Auditoria] Spider: ${progress}%   `);
                if (progress >= 100) {
                    console.log('\n[Auditoria] Spider concluído.');
                    return true;
                }
            }
            catch {
                // ZAP pode estar ocupado; tenta novamente
            }
            await this.sleep(5_000);
        }
        console.warn('\n[Auditoria] Timeout aguardando conclusão do spider.');
        return false;
    }
    /**
     * Aguarda a conclusão de um scan ativo (polling a cada 5s).
     * Retorna true se concluiu dentro do timeout, false caso contrário.
     */
    async waitForScanCompletion(scanId, timeoutMs = 180_000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            try {
                const response = await axios_1.default.get(`${this.baseUrl}/JSON/ascan/view/status/`, {
                    params: { scanId, apikey: this.apiKey },
                    timeout: 5_000,
                    validateStatus: () => true,
                });
                const progress = parseInt(response.data?.status ?? '0', 10);
                process.stdout.write(`\r[Auditoria] Scan ativo: ${progress}%   `);
                if (progress >= 100) {
                    console.log('\n[Auditoria] Scan ativo concluído.');
                    return true;
                }
            }
            catch {
                // ZAP pode estar ocupado; tenta novamente
            }
            await this.sleep(5_000);
        }
        console.warn('\n[Auditoria] Timeout aguardando conclusão do scan ativo.');
        return false;
    }
    /**
     * Busca os alertas de um scan ativo específico.
     * Chame após waitForScanCompletion retornar true.
     */
    async getActiveScanAlerts(targetBaseUrl) {
        // Os alertas do scan ativo são agregados junto com os passivos
        return this.getPassiveAlerts(targetBaseUrl);
    }
    // ===========================================================
    // Conversão
    // ===========================================================
    zapAlertToFinding(alert) {
        const severityMap = {
            '3': 'HIGH',
            '2': 'MEDIUM',
            '1': 'LOW',
            '0': 'INFO',
        };
        return {
            title: `[ZAP] ${alert.name || alert.alert}`,
            severity: severityMap[alert.riskcode] ?? 'INFO',
            category: `ZAP_PLUGIN_${alert.pluginId}`,
            description: [
                alert.description,
                alert.cweid ? `CWE-${alert.cweid}` : '',
                alert.wascid ? `WASC-${alert.wascid}` : '',
            ].filter(Boolean).join(' | '),
            steps: [
                `URL afetada: ${alert.url}`,
                `Confiança: ${alert.confidence}/3`,
                alert.solution ? `Solução: ${alert.solution.substring(0, 200)}` : '',
            ].filter(Boolean),
            evidence: alert.evidence || alert.url,
            discoveredAt: new Date(),
        };
    }
    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
exports.ZapClient = ZapClient;
//# sourceMappingURL=ZapClient.js.map