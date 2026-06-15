import { createClient } from '@supabase/supabase-js';
import { config } from '../config/env';

if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
  console.warn('[SUPABASE] Las credenciales SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY no están configuradas.');
}

export const supabase = createClient(
  config.supabaseUrl || '',
  config.supabaseServiceRoleKey || ''
);
