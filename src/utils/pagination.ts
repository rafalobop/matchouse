import * as express from 'express';

export const PAGINATION_DEFAULT_LIMIT = 50;
export const PAGINATION_MAX_LIMIT = 200;

export interface ParsedPagination {
  limit: number;
  offset: number;
  error?: string;
}

/** Parsea y valida `limit`/`offset` de query params — devuelve `{ error }` si son inválidos. */
export function parsePagination(
  query: express.Request['query'],
  defaultLimit = PAGINATION_DEFAULT_LIMIT,
  maxLimit = PAGINATION_MAX_LIMIT
): ParsedPagination {
  let limit = defaultLimit;
  if (query.limit !== undefined) {
    const n = parseInt(String(query.limit), 10);
    if (isNaN(n) || n <= 0 || n > maxLimit) {
      return { limit, offset: 0, error: `El parámetro "limit" debe ser un número entre 1 y ${maxLimit}.` };
    }
    limit = n;
  }

  let offset = 0;
  if (query.offset !== undefined) {
    const n = parseInt(String(query.offset), 10);
    if (isNaN(n) || n < 0) {
      return { limit, offset, error: 'El parámetro "offset" debe ser un número mayor o igual a 0.' };
    }
    offset = n;
  }

  return { limit, offset };
}
