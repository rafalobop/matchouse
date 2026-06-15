import { createClient } from '@supabase/supabase-js';
import { config } from '../config/env';
import ws from 'ws';

if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
  console.warn('[SUPABASE] Las credenciales SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY no están configuradas.');
}

export const supabase = createClient(
  config.supabaseUrl || '',
  config.supabaseServiceRoleKey || '',
  {
    auth: {
      persistSession: false
    },
    realtime: {
      transport: ws as any
    }
  }
);
