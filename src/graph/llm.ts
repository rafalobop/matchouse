// Helper de LLM genérico para los nodos del grafo de equipo de desarrollo.
// Generaliza el patrón Strategy de src/services/ai.ts (que ahí está fijado a
// 3 métodos de negocio puntuales) para que cualquier nodo pida output JSON
// estructurado con el mismo fallback Gemini -> OpenAI ya probado en producción.

import { GoogleGenAI } from '@google/genai';
import { OpenAI } from 'openai';
import { config } from '../config/env';
import { logFallbackWarning } from '../services/ai';

const genAI = new GoogleGenAI({ apiKey: config.geminiApiKey });
const openai = config.openaiApiKey ? new OpenAI({ apiKey: config.openaiApiKey }) : null;

export type LLMProvider = 'gemini' | 'openai';

export interface LLMCallOptions {
  // Cuál proveedor probar primero. Default 'gemini' (comportamiento histórico).
  // Los nodos que necesiten gpt-4o-mini como primario (ej. po/pm/em/techLead)
  // pasan 'openai' acá — el otro proveedor sigue actuando como fallback.
  primaryProvider?: LLMProvider;
}

async function runWithFallback<T>(
  primaryProvider: LLMProvider,
  geminiFn: () => Promise<T>,
  openaiFn: () => Promise<T>
): Promise<T> {
  const primaryIsOpenAI = primaryProvider === 'openai';
  const first = primaryIsOpenAI ? openaiFn : geminiFn;
  const firstName = primaryIsOpenAI ? 'OpenAI (gpt-4o-mini)' : 'Google Gemini (gemini-2.5-flash-lite)';
  const second = primaryIsOpenAI ? geminiFn : openaiFn;

  try {
    return await first();
  } catch (error) {
    logFallbackWarning(firstName, error);
  }

  return await second();
}

export interface GenerateStructuredJSONParams {
  systemInstruction: string;
  userPrompt: string;
  geminiSchema: Record<string, unknown>; // formato responseSchema de @google/genai
  openaiSchema: {                        // formato json_schema.schema de openai (json_schema.name se define acá)
    name: string;
    schema: Record<string, unknown>;
  };
}

async function generateWithGemini(params: GenerateStructuredJSONParams): Promise<any> {
  const response = await genAI.models.generateContent({
    model: 'gemini-2.5-flash-lite',
    contents: params.userPrompt,
    config: {
      systemInstruction: params.systemInstruction,
      responseMimeType: 'application/json',
      responseSchema: params.geminiSchema
    }
  });

  const responseText = response.text;
  if (!responseText) throw new Error('Respuesta de Gemini vacía');
  return JSON.parse(responseText.trim());
}

async function generateWithOpenAI(params: GenerateStructuredJSONParams): Promise<any> {
  if (!openai) throw new Error('OpenAI API key no está configurada.');

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: params.systemInstruction },
      { role: 'user', content: params.userPrompt }
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: params.openaiSchema.name,
        strict: true,
        schema: params.openaiSchema.schema
      }
    }
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error('Respuesta de OpenAI vacía');
  return JSON.parse(content.trim());
}

// Default Gemini primero (costo/velocidad), fallback automático al otro proveedor
// ante error o cuota agotada. Ver src/services/ai.ts para el mismo patrón aplicado
// a los sub-agentes cognitivos del producto.
export async function generateStructuredJSON(
  params: GenerateStructuredJSONParams,
  options: LLMCallOptions = {}
): Promise<any> {
  return runWithFallback(
    options.primaryProvider ?? 'gemini',
    () => generateWithGemini(params),
    () => generateWithOpenAI(params)
  );
}

export interface GenerateTextParams {
  systemInstruction: string;
  userPrompt: string;
}

async function generateTextWithGemini(params: GenerateTextParams): Promise<string> {
  const response = await genAI.models.generateContent({
    model: 'gemini-2.5-flash-lite',
    contents: params.userPrompt,
    config: {
      systemInstruction: params.systemInstruction
    }
  });

  const responseText = response.text;
  if (!responseText) throw new Error('Respuesta de Gemini vacía');
  return responseText.trim();
}

async function generateTextWithOpenAI(params: GenerateTextParams): Promise<string> {
  if (!openai) throw new Error('OpenAI API key no está configurada.');

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: params.systemInstruction },
      { role: 'user', content: params.userPrompt }
    ]
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error('Respuesta de OpenAI vacía');
  return content.trim();
}

// Igual que generateStructuredJSON pero para texto libre (sin schema) — pensado
// para los pasos Proposer/Opposer del debate interno de cada rol, donde queremos
// razonamiento en prosa, no JSON forzado.
export async function generateText(
  params: GenerateTextParams,
  options: LLMCallOptions = {}
): Promise<string> {
  return runWithFallback(
    options.primaryProvider ?? 'gemini',
    () => generateTextWithGemini(params),
    () => generateTextWithOpenAI(params)
  );
}
