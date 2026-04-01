/**
 * executor/tasks/runner.ts
 * ---------------------------------------------------------------
 * Orquestrador dos Abuse Cases predefinidos.
 *
 * Os Abuse Cases são testes estruturados que complementam o loop
 * ReAct. Enquanto o ReAct descobre vulnerabilidades autonomamente
 * com raciocínio livre, os Abuse Cases garantem cobertura mínima
 * dos challenges documentados do Juice Shop em múltiplas categorias.
 *
 * Categorias cobertas:
 *   - Lógica de Negócio (BLV)
 *   - Broken Access Control (IDOR, rotas admin)
 *   - XSS Armazenado
 *   - JWT Attacks
 *   - Sensitive Data Exposure
 *   - SQL Injection
 *
 * Fluxo:
 *   1. Recebe o JWT coletado na fase de Percepção
 *   2. Executa cada task de forma sequencial (para não sobrecarregar)
 *   3. Filtra e retorna apenas os Findings confirmados (não-null)
 * ---------------------------------------------------------------
 */

import { Finding } from '../ActionDispatcher';
import { abuseNegativeQuantity }      from './AbuseNegativeQuantity';
import { abuseZeroStarReview }        from './AbuseZeroStarReview';
import { abuseIDOR }                  from './AbuseIDOR';
import { abuseAdminRoute }            from './AbuseAdminRoute';
import { abuseXSS }                   from './AbuseXSS';
import { abuseJWT }                   from './AbuseJWT';
import { abuseSensitiveDataExposure } from './AbuseSensitiveDataExposure';
import { abuseSQLInjection }          from './AbuseSQLInjection';

/** Assinatura comum de todas as tasks de abuso */
type TaskFn = (jwt: string, baseUrl: string) => Promise<Finding | null>;

interface AbuseTask {
  name:     string;
  category: string;
  fn:       TaskFn;
}

const ABUSE_TASKS: AbuseTask[] = [
  // ── Lógica de Negócio ──────────────────────────────────────
  { name: 'AbuseNegativeQuantity',      category: 'Business Logic',        fn: abuseNegativeQuantity      },
  { name: 'AbuseZeroStarReview',        category: 'Business Logic',        fn: abuseZeroStarReview        },

  // ── Broken Access Control ──────────────────────────────────
  { name: 'AbuseIDOR',                  category: 'Broken Access Control', fn: abuseIDOR                  },
  { name: 'AbuseAdminRoute',            category: 'Broken Access Control', fn: abuseAdminRoute            },

  // ── XSS ───────────────────────────────────────────────────
  { name: 'AbuseXSS',                   category: 'XSS',                   fn: abuseXSS                   },

  // ── JWT Attacks ───────────────────────────────────────────
  { name: 'AbuseJWT',                   category: 'JWT',                   fn: abuseJWT                   },

  // ── Sensitive Data Exposure ───────────────────────────────
  { name: 'AbuseSensitiveDataExposure', category: 'Sensitive Data',        fn: abuseSensitiveDataExposure },

  // ── Injection ─────────────────────────────────────────────
  { name: 'AbuseSQLInjection',          category: 'Injection',             fn: abuseSQLInjection          },
];

/**
 * Executa todos os Abuse Cases e retorna os Findings encontrados.
 *
 * @param jwt      Token JWT do usuário de teste (customer)
 * @param baseUrl  URL base do alvo (ex: http://localhost:3000)
 */
export async function runAbuseCases(
  jwt: string,
  baseUrl: string,
): Promise<Finding[]> {
  console.log(`\n[ ABUSE CASES ] Executando ${ABUSE_TASKS.length} testes predefinidos...\n`);

  // Agrupa por categoria para exibição organizada
  const categories = [...new Set(ABUSE_TASKS.map((t) => t.category))];

  const findings: Finding[] = [];

  for (const category of categories) {
    const tasksInCategory = ABUSE_TASKS.filter((t) => t.category === category);
    console.log(`  ── ${category} (${tasksInCategory.length} teste(s)) ──`);

    for (const task of tasksInCategory) {
      process.stdout.write(`     → ${task.name}... `);

      try {
        const finding = await task.fn(jwt, baseUrl);

        if (finding) {
          console.log(`VULNERÁVEL [${finding.severity}]`);
          findings.push(finding);
        } else {
          console.log('seguro');
        }
      } catch (err) {
        console.log(`ERRO: ${(err as Error).message}`);
      }
    }

    console.log('');
  }

  console.log(
    `[ ABUSE CASES ] Concluído: ${findings.length} vulnerabilidade(s) encontrada(s) ` +
    `em ${ABUSE_TASKS.length} testes.\n`
  );

  return findings;
}
