// Entry point real para arrancar el grafo dev-team desde la terminal, fuera de
// cualquier sesión de Claude Code. Uso:
//   pnpm graph:run KAN-12                                  (key de Jira)
//   pnpm graph:run Necesito que revisemos y refactoricemos X cosa   (idea manual)
//
// Detecta automáticamente cuál de los dos es: si el primer argumento matchea
// el patrón de una key de Jira (PROYECTO-NUMERO, ej. KAN-12, HOUSE-42), se
// interpreta como jiraIssueKey; si no, se toma TODO lo que se pasó (sin
// necesidad de comillas) como rawIdea manual.

import { buildDevTeamGraph } from './graph';

const JIRA_ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9]*-\d+$/;

function resolveInput(args: string[]): { jiraIssueKey: string } | { rawIdea: string } {
  const firstArg = args[0];

  if (firstArg && JIRA_ISSUE_KEY_PATTERN.test(firstArg)) {
    return { jiraIssueKey: firstArg };
  }

  return { rawIdea: args.join(' ') };
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('Uso: pnpm graph:run <JIRA_ISSUE_KEY | idea en texto libre>');
    console.error('Ejemplos:');
    console.error('  pnpm graph:run KAN-12');
    console.error('  pnpm graph:run Necesito que revisemos y refactoricemos X cosa');
    process.exit(1);
  }

  const input = resolveInput(args);
  const graph = buildDevTeamGraph();
  const stream = await graph.stream(input);

  for await (const chunk of stream) {
    // Modo "updates" (default de .stream()): cada chunk es { [nombreDelNodo]: delta }
    for (const [nodeName, update] of Object.entries(chunk)) {
      console.log(`\n--- ${nodeName} ---`);
      console.log(JSON.stringify(update, null, 2));
    }
  }

  console.log('\n=== Grafo finalizado ===');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
