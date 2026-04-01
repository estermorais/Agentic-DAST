/**
 * executor/tasks/AbuseAdminRoute.ts
 * ---------------------------------------------------------------
 * Abuse Case: Acesso Não-Autorizado a Endpoints Administrativos
 *
 * Testa se um usuário comum (sem role=admin) consegue acessar
 * endpoints restritos a administradores via chamada direta à API,
 * mesmo que o menu de administração esteja oculto no frontend.
 *
 * Testa dois endpoints:
 *   1. GET /api/Users       — listagem de todos os usuários
 *   2. GET /api/Complaints  — listagem de reclamações internas
 *
 * Juice Shop Challenge: "Access the administration section"
 * Categoria OWASP: A01:2021 – Broken Access Control
 * ---------------------------------------------------------------
 */

import axios from 'axios';
import { Finding } from '../ActionDispatcher';

export async function abuseAdminRoute(
  jwt: string,
  baseUrl: string,
): Promise<Finding | null> {
  const headers = {
    'Authorization': `Bearer ${jwt}`,
    'Content-Type':  'application/json',
  };

  const adminEndpoints = [
    { url: `${baseUrl}/api/Users`,      description: 'listagem de todos os usuários' },
    { url: `${baseUrl}/api/Complaints`, description: 'listagem de reclamações internas' },
  ];

  const exposedEndpoints: string[] = [];

  for (const ep of adminEndpoints) {
    try {
      const response = await axios.get(ep.url, {
        headers,
        validateStatus: () => true,
        timeout: 10_000,
      });

      // Considera vulnerável se retornou dados (200) em vez de 401/403
      if (response.status === 200 && response.data?.data) {
        const count = Array.isArray(response.data.data)
          ? response.data.data.length
          : 1;
        exposedEndpoints.push(`${ep.url} → HTTP 200, ${count} registro(s) exposto(s) (${ep.description})`);
      }
    } catch {
      // ignora erros de rede individuais
    }
  }

  if (exposedEndpoints.length === 0) return null;

  return {
    title:       'Acesso Não-Autorizado a Endpoints Administrativos',
    severity:    'CRITICAL',
    category:    'BLV_BROKEN_ACCESS_CONTROL',
    description:
      'Usuário comum (sem privilégios de admin) conseguiu acessar endpoints ' +
      'restritos à administração via chamada direta à API, sem qualquer ' +
      'verificação de role no servidor.',
    steps: [
      'Autenticação realizada com conta customer@juice-sh.op',
      ...exposedEndpoints.map((e) => `Acessou: ${e}`),
    ],
    evidence:     exposedEndpoints.join('\n'),
    discoveredAt: new Date(),
  };
}
