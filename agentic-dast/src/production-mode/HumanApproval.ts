/**
 * production-mode/HumanApproval.ts
 * ---------------------------------------------------------------
 * Interacao no terminal via readline. Formata a acao proposta e
 * pergunta ao operador se pode prosseguir. Mantem um flag interno
 * de auto-approve para o resto da sessao caso o operador libere.
 * ---------------------------------------------------------------
 */

import * as readline from 'readline';

import { ParsedAction } from '../executor/ActionDispatcher';
import { RiskLevel, ClassificationResult } from './RiskClassifier';

export type ApprovalDecision =
  | { type: 'approve' }
  | { type: 'skip'; feedback: string }
  | { type: 'quit' };

export class HumanApproval {
  private autoApproveMedium = false;

  async prompt(
    action: ParsedAction,
    classification: ClassificationResult,
    iteration: number,
    thought: string,
  ): Promise<ApprovalDecision> {
    // Se ja liberou auto-approve para MEDIUM, executa direto
    if (classification.level === 'medium' && this.autoApproveMedium) {
      console.log(
        `[Approval] Auto-approve MEDIUM ativo. Executando sem confirmar.`,
      );
      return { type: 'approve' };
    }

    this.printPrompt(action, classification, iteration, thought);

    const options = classification.level === 'critical'
      ? '[y]es / [n]o / [q]uit'
      : classification.level === 'high'
      ? '[y]es / [n]o / [q]uit'
      : '[y]es / [n]o / [a]uto-approve MEDIUM / [q]uit';

    while (true) {
      const answer = (await this.readLine(`  Autorizar? ${options}\n  > `))
        .trim()
        .toLowerCase();

      if (classification.level === 'critical' && answer === 'y') {
        const confirm = (
          await this.readLine(
            '  Ação classificada como CRITICAL. Digite CONFIRMO para prosseguir: ',
          )
        ).trim();
        if (confirm !== 'CONFIRMO') {
          console.log('  Confirmação não recebida. Ação pulada.');
          return {
            type: 'skip',
            feedback: 'Operador humano recusou confirmação dupla em ação CRITICAL.',
          };
        }
        return { type: 'approve' };
      }

      if (answer === 'y' || answer === 'yes' || answer === 's' || answer === 'sim') {
        return { type: 'approve' };
      }
      if (answer === 'n' || answer === 'no' || answer === 'nao' || answer === 'não') {
        const reason = (
          await this.readLine('  Motivo (opcional, enviado ao LLM): ')
        ).trim();
        return {
          type: 'skip',
          feedback: reason
            ? `Ação pulada pelo operador humano. Motivo: ${reason}`
            : 'Ação pulada pelo operador humano. Considere alternativa.',
        };
      }
      if (
        answer === 'a' &&
        classification.level === 'medium' &&
        !this.autoApproveMedium
      ) {
        this.autoApproveMedium = true;
        console.log(
          '  Auto-approve MEDIUM ativado para o resto da sessão. HIGH e CRITICAL ainda pedem confirmação.',
        );
        return { type: 'approve' };
      }
      if (answer === 'q' || answer === 'quit' || answer === 'sair') {
        return { type: 'quit' };
      }

      console.log(`  Resposta "${answer}" inválida. Tente novamente.`);
    }
  }

  private printPrompt(
    action: ParsedAction,
    classification: ClassificationResult,
    iteration: number,
    thought: string,
  ): void {
    const banner = this.levelBanner(classification.level);
    const bar = '─'.repeat(72);

    console.log(`\n${bar}`);
    console.log(`  ${banner}  Iteração ${iteration}`);
    console.log(bar);

    if (thought) {
      console.log('  [Thought]');
      thought.split('\n').slice(0, 4).forEach((line) => {
        console.log(`    ${line.substring(0, 100)}`);
      });
    }

    console.log('  [Action]');
    console.log(`    ${this.formatAction(action)}`);

    console.log('  [Motivo da classificação]');
    console.log(`    ${classification.reason}`);
    console.log('');
  }

  private levelBanner(level: RiskLevel): string {
    switch (level) {
      case 'critical': return '🚨 CRITICAL — confirmação dupla obrigatória';
      case 'high':     return '⚠️  HIGH — ação destrutiva ou sensível';
      case 'medium':   return '⚡ MEDIUM — pode alterar estado no servidor';
      case 'safe':     return '✓  SAFE';
    }
  }

  private formatAction(action: ParsedAction): string {
    switch (action.action) {
      case 'make_request': {
        const method = (action.method || 'GET').toUpperCase();
        const headersStr = action.headers
          ? '\n    Headers: ' + JSON.stringify(action.headers).substring(0, 200)
          : '';
        const bodyStr = action.body
          ? '\n    Body: ' + JSON.stringify(action.body).substring(0, 300)
          : '';
        return `${method} ${action.url}${headersStr}${bodyStr}`;
      }
      case 'click_element':
        return `click "${action.selector}"`;
      case 'fill_field':
        return `fill "${action.selector}" = "${String(action.value).substring(0, 80)}"`;
      case 'navigate':
        return `navigate ${action.url}`;
      default:
        return JSON.stringify(action).substring(0, 200);
    }
  }

  private readLine(question: string): Promise<string> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    return new Promise((resolve) => {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
    });
  }
}
