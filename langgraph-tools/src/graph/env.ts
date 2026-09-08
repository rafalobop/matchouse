// Config standalone del workspace langgraph-tools — deliberadamente independiente de
// src/config/env.ts del producto (KAN-320: el andamiaje de LangGraph no debe depender
// de código fuente de Brokaza). Solo lee las variables que este grafo necesita.

import * as dotenv from 'dotenv';

dotenv.config();

function cleanEnvVar(val: string | undefined): string | undefined {
  if (!val) return val;
  return val.replace(/^["']|["']$/g, '').trim();
}

export interface GraphConfig {
  geminiApiKey: string;
  openaiApiKey?: string;
  jiraDomain?: string;
  jiraEmail?: string;
  jiraProjectKey?: string;
  atlassianApiKey?: string;
}

export const config: GraphConfig = {
  geminiApiKey: cleanEnvVar(process.env.GEMINI_API_KEY) || '',
  openaiApiKey: cleanEnvVar(process.env.OPENAI_API_KEY),
  jiraDomain: cleanEnvVar(process.env.JIRA_DOMAIN),
  jiraEmail: cleanEnvVar(process.env.JIRA_EMAIL),
  jiraProjectKey: cleanEnvVar(process.env.JIRA_PROJECT_KEY),
  atlassianApiKey: cleanEnvVar(process.env.ATLASSIAN_API_KEY)
};
