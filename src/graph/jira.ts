// Cliente de Jira para el grafo de equipo de desarrollo: lectura (fetchJiraIssue,
// usado por poNode) y escritura (createJiraIssue/updateJiraIssue, usado por
// taskCreationNode — ver Paso 2 de la skill langgraph-dev-team-scaffolder).

import { config } from '../config/env';

function requireJiraAuthConfig(): { domain: string; email: string; apiKey: string } {
  if (!config.jiraDomain || !config.jiraEmail || !config.atlassianApiKey) {
    throw new Error('Falta configuración de Jira (JIRA_DOMAIN/JIRA_EMAIL/ATLASSIAN_API_KEY en .env).');
  }

  return {
    // JIRA_DOMAIN a veces se carga ya con el esquema incluido (ej. "https://foo.atlassian.net")
    // — normalizamos para no terminar con "https://https://..." en la URL final.
    domain: config.jiraDomain.replace(/^https?:\/\//, ''),
    email: config.jiraEmail,
    apiKey: config.atlassianApiKey
  };
}

function buildAuthHeader(email: string, apiKey: string): string {
  return `Basic ${Buffer.from(`${email}:${apiKey}`).toString('base64')}`;
}

export interface JiraIssueContent {
  key: string;
  issueType: string; // ej. "Task", "Story", "Bug" — tal cual lo devuelve Jira
  summary: string;
  descriptionText: string;
}

// fields.description en Jira Cloud API v3 viene en Atlassian Document Format
// (JSON anidado), no texto plano. Walker simple: concatena los nodos de texto
// y separa bloques con salto de línea. Sin soporte de formato rico (negrita,
// links, etc.) — alcanza para darle contexto en texto plano al LLM.
export function adfToPlainText(doc: any): string {
  if (!doc || typeof doc !== 'object') return '';

  const lines: string[] = [];

  function walk(node: any, currentLine: string[]): void {
    if (!node || typeof node !== 'object') return;

    if (node.type === 'text' && typeof node.text === 'string') {
      currentLine.push(node.text);
      return;
    }

    if (Array.isArray(node.content)) {
      const isBlock = node.type === 'paragraph' || node.type === 'heading' || node.type === 'listItem';
      const line: string[] = [];
      for (const child of node.content) {
        walk(child, isBlock ? line : currentLine);
      }
      if (isBlock) {
        lines.push(line.join(''));
      }
    }
  }

  walk(doc, []);
  return lines.join('\n').trim();
}

export function parseJiraIssueResponse(raw: any): JiraIssueContent {
  return {
    key: typeof raw?.key === 'string' ? raw.key : '',
    issueType: typeof raw?.fields?.issuetype?.name === 'string' ? raw.fields.issuetype.name : 'Task',
    summary: typeof raw?.fields?.summary === 'string' ? raw.fields.summary : '',
    descriptionText: adfToPlainText(raw?.fields?.description)
  };
}

export async function fetchJiraIssue(issueKey: string): Promise<JiraIssueContent> {
  const { domain, email, apiKey } = requireJiraAuthConfig();

  const res = await fetch(`https://${domain}/rest/api/3/issue/${issueKey}`, {
    method: 'GET',
    headers: {
      Authorization: buildAuthHeader(email, apiKey),
      Accept: 'application/json'
    }
  });

  if (!res.ok) {
    throw new Error(`Jira fetch issue falló (${issueKey}): ${res.status} ${await res.text()}`);
  }

  return parseJiraIssueResponse(await res.json());
}

// --- Escritura (Task Creation) ---

export interface TaskDefinition {
  title: string;
  definitionOfDone: string;
  acceptanceCriteria: string[];
}

// Dirección inversa de adfToPlainText: arma el ADF a partir de texto plano.
// Un párrafo con el DoD + una bulletList con los criterios de aceptación.
export function buildTaskDescriptionAdf(definitionOfDone: string, acceptanceCriteria: string[]): object {
  const content: any[] = [
    {
      type: 'paragraph',
      content: [{ type: 'text', text: definitionOfDone }]
    }
  ];

  if (acceptanceCriteria.length > 0) {
    content.push({
      type: 'bulletList',
      content: acceptanceCriteria.map((criterion) => ({
        type: 'listItem',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: criterion }] }]
      }))
    });
  }

  return { type: 'doc', version: 1, content };
}

// Solo actualiza description — nunca summary/título, ver decisión en el plan
// de la sesión: el ticket original no se redefine, solo se enriquece.
export async function updateJiraIssue(issueKey: string, descriptionAdf: object): Promise<void> {
  const { domain, email, apiKey } = requireJiraAuthConfig();

  const res = await fetch(`https://${domain}/rest/api/3/issue/${issueKey}`, {
    method: 'PUT',
    headers: {
      Authorization: buildAuthHeader(email, apiKey),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ fields: { description: descriptionAdf } })
  });

  if (!res.ok) {
    throw new Error(`Jira update issue falló (${issueKey}): ${res.status} ${await res.text()}`);
  }
}

export async function createJiraIssue(task: TaskDefinition): Promise<{ key: string }> {
  const { domain, email, apiKey } = requireJiraAuthConfig();

  if (!config.jiraProjectKey) {
    throw new Error('Falta la variable de entorno JIRA_PROJECT_KEY en .env para crear una issue nueva.');
  }

  const res = await fetch(`https://${domain}/rest/api/3/issue`, {
    method: 'POST',
    headers: {
      Authorization: buildAuthHeader(email, apiKey),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      fields: {
        project: { key: config.jiraProjectKey },
        summary: task.title,
        issuetype: { name: 'Task' },
        description: buildTaskDescriptionAdf(task.definitionOfDone, task.acceptanceCriteria)
      }
    })
  });

  if (!res.ok) {
    throw new Error(`Jira create issue falló: ${res.status} ${await res.text()}`);
  }

  const created = await res.json();
  return { key: created.key };
}
