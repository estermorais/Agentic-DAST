/**
 * executor/tasks/AbuseSensitiveDataExposure.ts
 * ---------------------------------------------------------------
 * Abuse Case: Exposição de Dados Sensíveis
 *
 * Testa endpoints e recursos que expõem dados confidenciais
 * sem autenticação adequada ou por configuração incorreta:
 *
 * 1. Diretório FTP exposto — /ftp/ lista e serve arquivos
 *    internos como backups, contratos e configurações.
 *
 * 2. Endpoint de configuração administrativo sem auth —
 *    /rest/admin/application-configuration retorna configurações
 *    internas da aplicação sem exigir token.
 *
 * 3. API de usuários sem autenticação — /api/Users acessível
 *    sem Bearer token, expondo emails e hashes de senha.
 *
 * 4. Arquivo de backup via FTP — /ftp/package.json.bak expõe
 *    dependências e potencialmente metadados do projeto.
 *
 * Juice Shop Challenges: "Access a confidential document",
 *   "Retrieve the language file that contains authenticity tokens"
 * Categoria OWASP: A02:2021 – Cryptographic Failures /
 *                  A05:2021 – Security Misconfiguration
 * CWE-200: Exposure of Sensitive Information to an Unauthorized Actor
 * ---------------------------------------------------------------
 */

import axios from 'axios';
import { Finding } from '../ActionDispatcher';

interface ExposedResource {
  url:         string;
  description: string;
  evidence:    string;
  severity:    Finding['severity'];
}

export async function abuseSensitiveDataExposure(
  _jwt: string,
  baseUrl: string,
): Promise<Finding | null> {
  const exposed: ExposedResource[] = [];

  // ── Lista de recursos a testar ───────────────────────────────
  const targets: { url: string; description: string; severity: Finding['severity'] }[] = [
    {
      url:         `${baseUrl}/ftp/`,
      description: 'Diretório FTP interno acessível sem autenticação',
      severity:    'HIGH',
    },
    {
      url:         `${baseUrl}/ftp/acquisitions.md`,
      description: 'Documento confidencial de aquisições exposto via FTP',
      severity:    'HIGH',
    },
    {
      url:         `${baseUrl}/ftp/package.json.bak`,
      description: 'Arquivo de backup do package.json com metadados do projeto',
      severity:    'MEDIUM',
    },
    {
      url:         `${baseUrl}/rest/admin/application-configuration`,
      description: 'Endpoint de configuração administrativa sem autenticação',
      severity:    'HIGH',
    },
    {
      url:         `${baseUrl}/api/Users`,
      description: 'Listagem de usuários acessível sem autenticação',
      severity:    'CRITICAL',
    },
  ];

  for (const target of targets) {
    try {
      // Testa sem autenticação (sem JWT)
      const res = await axios.get(target.url, {
        validateStatus: () => true,
        timeout: 10_000,
        maxRedirects: 3,
      });

      // Considera exposto se respondeu com conteúdo (200) sem exigir auth
      if (res.status === 200) {
        const body = typeof res.data === 'string'
          ? res.data.substring(0, 300)
          : JSON.stringify(res.data).substring(0, 300);

        exposed.push({
          url:         target.url,
          description: target.description,
          severity:    target.severity,
          evidence:    `HTTP 200 — ${body}`,
        });
      }
    } catch {
      // recurso inacessível, ignora
    }
  }

  if (exposed.length === 0) return null;

  // Determina severidade máxima encontrada
  const severityOrder: Finding['severity'][] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];
  const maxSeverity = severityOrder.find((s) => exposed.some((e) => e.severity === s)) ?? 'MEDIUM';

  return {
    title:       'Exposição de Dados Sensíveis — Recursos Acessíveis Sem Autenticação',
    severity:    maxSeverity,
    category:    'SENSITIVE_DATA_EXPOSURE',
    description:
      `${exposed.length} recurso(s) confidencial(is) acessível(is) sem autenticação. ` +
      'A aplicação não protege adequadamente endpoints e arquivos internos, ' +
      'expondo configurações, documentos e dados de usuários.',
    steps: exposed.map((e) => `${e.url} → ${e.description}`),
    evidence:     exposed.map((e) => `[${e.severity}] ${e.url}\n${e.evidence}`).join('\n\n'),
    discoveredAt: new Date(),
  };
}
