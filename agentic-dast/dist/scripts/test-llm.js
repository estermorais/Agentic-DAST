"use strict";
/**
 * scripts/test-llm.ts
 * ---------------------------------------------------------------
 * Faz UMA única chamada ao provedor de LLM configurado no .env
 * para confirmar que a chave e o modelo estão funcionando antes
 * de rodar qualquer cenário completo.
 *
 * Uso:
 *   npm run test:llm
 *
 * Custo (via OpenRouter com Claude Haiku 4.5):
 *   ~US$ 0,0001 por execução (praticamente zero)
 * ---------------------------------------------------------------
 */
Object.defineProperty(exports, "__esModule", { value: true });
const LLMClient_1 = require("../cognitive/LLMClient");
async function main() {
    const divider = '='.repeat(60);
    console.log(divider);
    console.log('TESTE DE CONFIGURAÇÃO DO LLM');
    console.log(divider);
    const client = (0, LLMClient_1.createLLMClient)();
    console.log(`Provedor: ${client.name}\n`);
    const systemPrompt = 'Você é um assistente de teste. Responda EXATAMENTE com a palavra "OK" e nada mais.';
    const history = [
        { role: 'user', content: 'Você está funcionando?' },
    ];
    console.log('Enviando chamada de teste ao modelo...');
    const start = Date.now();
    try {
        const response = await client.chat(systemPrompt, history);
        const elapsed = ((Date.now() - start) / 1000).toFixed(2);
        console.log(`\n${divider}`);
        console.log(`SUCESSO — resposta em ${elapsed}s`);
        console.log(divider);
        console.log(`Resposta do modelo: "${response.trim()}"`);
        console.log(divider);
        console.log('\nA chave está funcionando. Você pode rodar os cenários agora:');
        console.log('  npm run scenario:c   (Agentic DAST, cenário experimental)');
        console.log('  npm run scenario:a   (OWASP ZAP puro, baseline)');
        console.log('  npm run scenario:b   (ZAP + navegação E2E, baseline)');
        console.log('  npm run scenario:d   (PentestGPT, controle tecnológico)');
        process.exit(0);
    }
    catch (err) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(2);
        console.error(`\n${divider}`);
        console.error(`ERRO — falha após ${elapsed}s`);
        console.error(divider);
        console.error(err.message);
        console.error(divider);
        console.error('\nDiagnóstico rápido:');
        console.error('  • Chave inválida ou expirada: cheque o .env');
        console.error('  • Sem crédito: adicione créditos no dashboard do provedor');
        console.error('  • Modelo inexistente: cheque o nome do modelo no .env');
        console.error('  • Sem conexão: cheque sua internet e/ou proxy');
        process.exit(1);
    }
}
main();
//# sourceMappingURL=test-llm.js.map