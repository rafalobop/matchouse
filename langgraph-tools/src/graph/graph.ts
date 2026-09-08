// Wiring del grafo LangGraph de equipo de desarrollo.
// DevTeamState (src/graph/state.ts) es el contrato de tipos que usan los nodos;
// acá lo traducimos a channels reales de LangGraph (Annotation.Root) para poder
// construir y compilar el StateGraph.

import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { DevTeamState } from './state';
import { poNode } from './nodes/po';
import { pmNode } from './nodes/pm';
import { emNode } from './nodes/em';
import { techLeadNode } from './nodes/techLead';
import { judgeNode } from './nodes/judge';
import { taskCreationNode } from './nodes/taskCreation';

// Todos los campos son "last value wins": cada nodo devuelve el delta de state
// que le corresponde y LangGraph lo mergea sobreescribiendo esa clave (sin
// reducers de concatenación, a diferencia de un array de mensajes de chat).
function overwrite<T>(_left: T, right: T): T {
  return right;
}

// roleInputs es la única excepción: pm/em/techLead corren en PARALELO (fan-out
// desde po) en el mismo superstep, y cada uno solo conoce/devuelve su propia
// clave. Con overwrite, el último nodo en aplicarse pisaría lo que escribieron
// los otros dos. Merge superficial en cambio es seguro sin importar el orden,
// porque las 3 claves (pm/em/techLead) son disjuntas.
function mergeRoleInputs(
  left: DevTeamState['roleInputs'],
  right: Partial<DevTeamState['roleInputs']>
): DevTeamState['roleInputs'] {
  return { ...left, ...right };
}

export const GraphState = Annotation.Root({
  jiraIssueKey: Annotation<DevTeamState['jiraIssueKey']>({ reducer: overwrite, default: () => null }),
  rawIdea: Annotation<DevTeamState['rawIdea']>({ reducer: overwrite, default: () => '' }),
  spec: Annotation<DevTeamState['spec']>({ reducer: overwrite, default: () => null }),
  roleInputs: Annotation<DevTeamState['roleInputs'], Partial<DevTeamState['roleInputs']>>({
    reducer: mergeRoleInputs,
    default: () => ({ pm: null, em: null, techLead: null })
  }),
  conflictsResolved: Annotation<DevTeamState['conflictsResolved']>({ reducer: overwrite, default: () => [] }),
  plan: Annotation<DevTeamState['plan']>({ reducer: overwrite, default: () => null }),
  tasks: Annotation<DevTeamState['tasks']>({ reducer: overwrite, default: () => [] }),
  qaResult: Annotation<DevTeamState['qaResult']>({ reducer: overwrite, default: () => null }),
  correctionFocus: Annotation<DevTeamState['correctionFocus']>({ reducer: overwrite, default: () => null }),
  retryCount: Annotation<DevTeamState['retryCount']>({ reducer: overwrite, default: () => 0 }),
  maxRetries: Annotation<DevTeamState['maxRetries']>({ reducer: overwrite, default: () => 3 })
});

export function buildDevTeamGraph() {
  const builder = new StateGraph(GraphState)
    .addNode('po', poNode)
    .addNode('pm', pmNode)
    .addNode('em', emNode)
    .addNode('techLead', techLeadNode)
    .addNode('judge', judgeNode)
    .addNode('taskCreation', taskCreationNode)
    .addEdge(START, 'po')
    // Fan-out real: los 3 corren en paralelo, sin verse entre sí (Paso 3 de la skill).
    .addEdge('po', 'pm')
    .addEdge('po', 'em')
    .addEdge('po', 'techLead')
    // Fan-in real: forma de array en addEdge = "esperar a que las 3 ramas terminen"
    // (waiting edge). Con 3 addEdge separados hacia el mismo destino, judge podría
    // dispararse una vez por cada rama en vez de una sola vez con las 3 completas.
    .addEdge(['pm', 'em', 'techLead'], 'judge')
    .addEdge('judge', 'taskCreation')
    // TODO: reemplazar por el edge real cuando exista devNode: .addEdge('taskCreation', 'developer')
    // Por ahora termina acá para que el grafo sea compilable e invocable de punta a punta.
    .addEdge('taskCreation', END);

  return builder.compile();
}
