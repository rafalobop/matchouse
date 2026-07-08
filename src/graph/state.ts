// Estado compartido del grafo LangGraph de equipo de desarrollo.
// Es sobre el PROCESO de desarrollo (specs, roles, tareas, QA), no sobre
// entidades de dominio de HouseMatch (esas viven en src/services, src/utils).

export interface DevTeamState {
  // Entrada: key de Jira de la tarea/historia a atacar (ej. "HOUSE-42"), elegida
  // manualmente corrida a corrida. Si está presente, tiene prioridad sobre rawIdea.
  jiraIssueKey: string | null;

  // Entrada alternativa/manual: idea cruda tipeada a mano (sin pasar por Jira),
  // útil para test/smoke. poNode también la usa como campo de trazabilidad,
  // volcando ahí el contenido derivado de Jira cuando esa es la fuente usada.
  rawIdea: string;

  // Producto de Product Owner
  spec: {
    title: string;
    problem: string;
    proposedSolution: string;
    openQuestions: string[];
    status: 'draft' | 'reviewed' | 'approved';
  } | null;

  // Aportes de cada rol, generados en paralelo (fan-out) sin verse entre sí.
  // Cada uno es resultado de un debate interno proposer/opposer del propio rol.
  roleInputs: {
    pm: { concerns: string[]; priorities: string[]; selfCritique: string } | null;
    em: { feasibility: string; risks: string[]; resourcing: string; selfCritique: string } | null;
    techLead: { approach: string; tradeoffs: string[]; risks: string[]; selfCritique: string } | null;
  };

  // Conflictos que el judge detectó entre roles y cómo los resolvió
  conflictsResolved: Array<{ issue: string; resolution: string }>;

  // Síntesis final, generada por judgeNode a partir de roleInputs
  plan: {
    approach: string;
    risks: string[];
    tradeoffs: string[];
    approvedBy: string[]; // qué roles dieron el ok
  } | null;

  // Tareas generadas (Task Creation, sincronizadas con Jira)
  tasks: Array<{
    id: string;
    title: string;
    definitionOfDone: string;
    acceptanceCriteria: string[];
    assignee: 'dev' | 'qa';
    status: 'todo' | 'in_progress' | 'in_review' | 'done' | 'blocked';
  }>;

  // Resultado de QA sobre la última corrida
  qaResult: {
    passed: boolean;
    failedCriteria: string[];
    evidence: string; // output real de test, no un resumen inventado
  } | null;

  // Qué tiene que corregir el dev en un retry — SOLO esto, nada más del resto del código
  correctionFocus: string[] | null;

  // Control de loop QA <-> Dev
  retryCount: number;
  maxRetries: number;
}
