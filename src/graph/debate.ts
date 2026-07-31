// Runner compartido del patrón "debate interno" (Paso 2 de la skill
// langgraph-dev-team-scaffolder): 3 llamadas secuenciales dentro de un mismo
// rol — Proposer (postura inicial) → Opposer (la ataca activamente) →
// Reconcile (postura final + selfCritique). Los 3 nodos de debate (pm/em/
// techLead) comparten esta secuenciación; solo cambian la skill, los prompts
// específicos del rol y el schema de salida del Reconcile.

import { generateText, generateStructuredJSON, GenerateStructuredJSONParams, LLMProvider } from './llm';
import { DevTeamState } from './state';

// Formato común en el que los 3 nodos de debate le pasan state.spec al modelo.
export function formatSpecSummary(spec: NonNullable<DevTeamState['spec']>): string {
  return `Título: ${spec.title}
Problema: ${spec.problem}
Solución propuesta: ${spec.proposedSolution}
Preguntas abiertas: ${spec.openQuestions.length > 0 ? spec.openQuestions.join(' | ') : '(ninguna)'}
Estado: ${spec.status}`;
}

export interface DebateStepContext {
  roleName: string;    // ej. "Project Manager (PM)", para prosa del prompt
  roleHandle: string;  // ej. "@pm", el handle usado dentro del SKILL.md
  skillContent: string; // contenido completo del SKILL.md del rol
  specSummary: string;  // state.spec ya formateado en texto para inyectar en los prompts
  primaryProvider?: LLMProvider; // default 'gemini' (ver src/graph/llm.ts)
}

function buildStepInstruction(context: DebateStepContext, step: 'Proposer' | 'Opposer'): string {
  const attitude = step === 'Proposer'
    ? 'Armá tu postura inicial siguiendo estrictamente la sección "Si actuás como Proposer" de la skill.'
    : 'Tu trabajo es atacar activamente la postura del Proposer: buscá puntos débiles, casos borde no contemplados y supuestos frágiles. Seguí la sección "Si actuás como Opposer" de la skill. No seas complaciente — si la postura del Proposer es sólida igual encontrá su punto más débil.';

  return `Encarnás el rol "${context.roleName}" (persona ${context.roleHandle}) dentro de un grafo LangGraph que simula un equipo de desarrollo de software para el proyecto HouseMatch. Estás en el paso "${step}" de un debate interno proposer/opposer/reconcile de tu propio rol.

Tu comportamiento y criterio están definidos por la siguiente skill. Seguila al pie de la letra:

<ROLE_SKILL>
${context.skillContent}
</ROLE_SKILL>

${attitude}

Respondé en prosa clara y concreta, en español, sin JSON ni formato especial. No es una conversación con el usuario humano — no repreguntes, trabajá con la información que tenés.`;
}

function buildProposerUserPrompt(context: DebateStepContext): string {
  return `Esta es la especificación funcional aprobada por Product Owner, dentro de las etiquetas <SPEC>:
<SPEC>
${context.specSummary}
</SPEC>

Armá tu postura inicial como ${context.roleName}.`;
}

function buildOpposerUserPrompt(context: DebateStepContext, proposerText: string): string {
  return `Esta es la especificación funcional, dentro de <SPEC>:
<SPEC>
${context.specSummary}
</SPEC>

Esta es la postura inicial del Proposer de tu mismo rol (${context.roleName}), dentro de <PROPOSER_POSITION>:
<PROPOSER_POSITION>
${proposerText}
</PROPOSER_POSITION>

Atacá esa postura activamente.`;
}

function buildReconcileInstruction(context: DebateStepContext): string {
  return `Encarnás el rol "${context.roleName}" (persona ${context.roleHandle}) dentro de un grafo LangGraph que simula un equipo de desarrollo de software para el proyecto HouseMatch. Estás en el paso "Reconcile", el último de tu debate interno.

Tu comportamiento y criterio están definidos por la siguiente skill:

<ROLE_SKILL>
${context.skillContent}
</ROLE_SKILL>

Tomá la postura inicial del Proposer y la crítica del Opposer (ambas de tu mismo rol) y producí tu postura FINAL, incorporando lo que la crítica reveló — no la ignores, pero tampoco la aceptes automáticamente si no es válida.

Reglas de salida:
- Respondé ÚNICAMENTE con el JSON estructurado pedido, sin texto adicional.
- El campo de autocrítica ("selfCritique") debe reflejar el punto más fuerte que encontró el Opposer, aunque no haya cambiado tu conclusión final.`;
}

function buildReconcileUserPrompt(context: DebateStepContext, proposerText: string, opposerText: string): string {
  return `Especificación funcional, dentro de <SPEC>:
<SPEC>
${context.specSummary}
</SPEC>

Postura inicial del Proposer, dentro de <PROPOSER_POSITION>:
<PROPOSER_POSITION>
${proposerText}
</PROPOSER_POSITION>

Crítica del Opposer, dentro de <OPPOSER_CRITIQUE>:
<OPPOSER_CRITIQUE>
${opposerText}
</OPPOSER_CRITIQUE>

Producí tu postura final como ${context.roleName}.`;
}

export interface RunDebateParams<T> {
  context: DebateStepContext;
  reconcileSchemas: {
    geminiSchema: GenerateStructuredJSONParams['geminiSchema'];
    openaiSchema: GenerateStructuredJSONParams['openaiSchema'];
  };
  normalizeReconcile: (raw: any) => T;
}

export async function runProposerOpposerReconcile<T>(params: RunDebateParams<T>): Promise<T> {
  const { context, reconcileSchemas, normalizeReconcile } = params;
  const llmOptions = { primaryProvider: context.primaryProvider };

  const proposerText = await generateText({
    systemInstruction: buildStepInstruction(context, 'Proposer'),
    userPrompt: buildProposerUserPrompt(context)
  }, llmOptions);

  const opposerText = await generateText({
    systemInstruction: buildStepInstruction(context, 'Opposer'),
    userPrompt: buildOpposerUserPrompt(context, proposerText)
  }, llmOptions);

  const rawReconcile = await generateStructuredJSON({
    systemInstruction: buildReconcileInstruction(context),
    userPrompt: buildReconcileUserPrompt(context, proposerText, opposerText),
    geminiSchema: reconcileSchemas.geminiSchema,
    openaiSchema: reconcileSchemas.openaiSchema
  }, llmOptions);

  return normalizeReconcile(rawReconcile);
}
