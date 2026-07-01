import { AuthenticationCreds, AuthenticationState, SignalDataTypeMap, initAuthCreds, BufferJSON } from '@whiskeysockets/baileys';
import { supabase } from './supabase';

export async function useSupabaseAuthState(tenantId: string): Promise<{ state: AuthenticationState, saveCreds: () => Promise<void> }> {

  // Cargar auth state completo desde whatsapp_sessions.auth_creds (una sola fila por tenant)
  const { data, error: loadError } = await supabase
    .from('whatsapp_sessions')
    .select('auth_creds')
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (loadError) {
    console.error(`[SUPABASE-AUTH] Error al cargar credenciales para tenant ${tenantId}:`, loadError);
  }

  // auth_creds almacena: { creds: {...}, keys: { "type-id": value, ... } }
  const rawState = (data?.auth_creds as Record<string, any> | null) || {};

  let creds: AuthenticationCreds;
  if (rawState.creds) {
    creds = JSON.parse(JSON.stringify(rawState.creds), BufferJSON.reviver);
  } else {
    creds = initAuthCreds();
  }

  // Mapa en memoria de las signal keys (cargadas desde DB al inicio, sincronizadas en cada escritura)
  const keysStore: Record<string, any> = rawState.keys
    ? JSON.parse(JSON.stringify(rawState.keys), BufferJSON.reviver)
    : {};

  const persistState = async () => {
    const updatedState = {
      creds: JSON.parse(JSON.stringify(creds, BufferJSON.replacer)),
      keys: JSON.parse(JSON.stringify(keysStore, BufferJSON.replacer))
    };

    const { error } = await supabase
      .from('whatsapp_sessions')
      .upsert({
        tenant_id: tenantId,
        auth_creds: updatedState,
        updated_at: new Date().toISOString()
      }, { onConflict: 'tenant_id' });

    if (error) {
      if (error.code === '23503') {
        // Ignorar silenciosamente si el tenant ya fue eliminado (carrera al desvincular/mapear)
        return;
      }
      console.error(`[SUPABASE-AUTH] Error al guardar credenciales para tenant ${tenantId}:`, error);
    }
  };

  const saveCreds = persistState;

  return {
    state: {
      creds,
      keys: {
        get: async (type: keyof SignalDataTypeMap, ids: string[]) => {
          const result: { [id: string]: any } = {};
          for (const id of ids) {
            const dbKey = `${type}-${id}`;
            if (keysStore[dbKey] !== undefined) {
              result[id] = keysStore[dbKey];
            }
          }
          return result;
        },
        set: async (data: any) => {
          for (const type in data) {
            for (const id in data[type]) {
              const value = data[type][id];
              const dbKey = `${type}-${id}`;
              if (value) {
                keysStore[dbKey] = value;
              } else {
                delete keysStore[dbKey];
              }
            }
          }
          await persistState();
        }
      }
    },
    saveCreds
  };
}

export async function clearSupabaseSession(tenantId: string): Promise<void> {
  const { error } = await supabase
    .from('whatsapp_sessions')
    .update({ auth_creds: null, status: 'disconnected' })
    .eq('tenant_id', tenantId);

  if (error) {
    console.error(`[SUPABASE-AUTH] Error al limpiar sesión del tenant ${tenantId}:`, error);
  } else {
    console.log(`[SUPABASE-AUTH] Sesión en base de datos eliminada para tenant ${tenantId}.`);
  }
}
