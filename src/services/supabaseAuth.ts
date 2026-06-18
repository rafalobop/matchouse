import { AuthenticationCreds, AuthenticationState, SignalDataTypeMap, initAuthCreds, BufferJSON } from '@whiskeysockets/baileys';
import { supabase } from './supabase';

export async function useSupabaseAuthState(tenantId: string): Promise<{ state: AuthenticationState, saveCreds: () => Promise<void> }> {
  
  // 1. Cargar o inicializar credenciales principales
  let creds: AuthenticationCreds;
  const { data: credsRow, error: credsError } = await supabase
    .from('WhatsappSession')
    .select('value')
    .eq('tenant_id', tenantId)
    .eq('key', 'creds')
    .maybeSingle();

  if (credsError) {
    console.error(`[SUPABASE-AUTH] Error al cargar credenciales para tenant ${tenantId}:`, credsError);
  }

  if (credsRow && credsRow.value) {
    creds = JSON.parse(JSON.stringify(credsRow.value), BufferJSON.reviver);
  } else {
    creds = initAuthCreds();
  }

  const saveCreds = async () => {
    const { error } = await supabase
      .from('WhatsappSession')
      .upsert({
        tenant_id: tenantId,
        key: 'creds',
        value: JSON.parse(JSON.stringify(creds, BufferJSON.replacer))
      });
    
    if (error) {
      if (error.code === '23503') {
        // Ignorar silenciosamente si el tenant ya fue eliminado (carrera al desvincular/mapear)
        return;
      }
      console.error(`[SUPABASE-AUTH] Error al guardar credenciales para tenant ${tenantId}:`, error);
    }
  };

  return {
    state: {
      creds,
      keys: {
        get: async (type: keyof SignalDataTypeMap, ids: string[]) => {
          const data: { [id: string]: any } = {};
          
          if (ids.length === 0) return data;
          
          // Dividir la lista de IDs en lotes de 50 para evitar sobrepasar límites de longitud de URL (PostgREST HTTP Header Overflow)
          const chunkSize = 50;
          const chunks: string[][] = [];
          for (let i = 0; i < ids.length; i += chunkSize) {
            chunks.push(ids.slice(i, i + chunkSize));
          }

          const results = await Promise.all(chunks.map(async (chunk) => {
            const dbKeys = chunk.map(id => `${type}-${id}`);
            const { data: rows, error } = await supabase
              .from('WhatsappSession')
              .select('key, value')
              .eq('tenant_id', tenantId)
              .in('key', dbKeys);

            if (error) {
              console.error(`[SUPABASE-AUTH] Error al obtener keys (${type}) para tenant ${tenantId}:`, error);
              return [];
            }
            return rows || [];
          }));

          const allRows = results.flat();
          for (const row of allRows) {
            const originalId = row.key.substring(type.length + 1); // Extraer 'id' de 'type-id'
            data[originalId] = JSON.parse(JSON.stringify(row.value), BufferJSON.reviver);
          }
          return data;
        },
        set: async (data: any) => {
          const upserts: any[] = [];
          const deletes: string[] = [];

          for (const type in data) {
            for (const id in data[type]) {
              const value = data[type][id];
              const dbKey = `${type}-${id}`;

              if (value) {
                upserts.push({
                  tenant_id: tenantId,
                  key: dbKey,
                  value: JSON.parse(JSON.stringify(value, BufferJSON.replacer))
                });
              } else {
                deletes.push(dbKey);
              }
            }
          }

          // 1. Guardar las actualizaciones en lotes si son demasiadas (upsert via POST en JSON body es seguro, pero se hace directo)
          if (upserts.length > 0) {
            const { error } = await supabase.from('WhatsappSession').upsert(upserts);
            if (error) {
              if (error.code === '23503') {
                // Ignorar silenciosamente si el tenant ya fue eliminado
                return;
              }
              console.error(`[SUPABASE-AUTH] Error al guardar keys para tenant ${tenantId}:`, error);
            }
          }

          // 2. Eliminar las claves en lotes de 50 para evitar sobrepasar el límite de URL en la petición DELETE
          if (deletes.length > 0) {
            const chunkSize = 50;
            const chunks: string[][] = [];
            for (let i = 0; i < deletes.length; i += chunkSize) {
              chunks.push(deletes.slice(i, i + chunkSize));
            }

            await Promise.all(chunks.map(async (chunk) => {
              const { error } = await supabase
                .from('WhatsappSession')
                .delete()
                .eq('tenant_id', tenantId)
                .in('key', chunk);
              if (error) {
                console.error(`[SUPABASE-AUTH] Error al eliminar keys para tenant ${tenantId}:`, error);
              }
            }));
          }
        }
      }
    },
    saveCreds
  };
}

export async function clearSupabaseSession(tenantId: string): Promise<void> {
  const { error } = await supabase
    .from('WhatsappSession')
    .delete()
    .eq('tenant_id', tenantId);

  if (error) {
    console.error(`[SUPABASE-AUTH] Error al limpiar sesión del tenant ${tenantId}:`, error);
  } else {
    console.log(`[SUPABASE-AUTH] Sesión en base de datos eliminada para tenant ${tenantId}.`);
  }
}
