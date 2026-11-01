// WEBINAIRE – fonction « admin-reset-password » (Supabase Edge Function).
//
// Permet à l'administrateur de donner un mot de passe provisoire à un
// utilisateur qui a oublié le sien, sans passer par l'e-mail. L'utilisateur
// devra choisir un nouveau mot de passe à sa prochaine connexion.
// La clé secrète du projet (droits complets) reste sur le serveur.

import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

// Première valeur d'une variable « dictionnaire de clés » (nouvelles clés Supabase),
// sinon l'ancienne variable.
function key(dictVar: string, legacyVar: string): string {
  try {
    const keys = JSON.parse(Deno.env.get(dictVar) ?? '{}');
    const first = Object.values(keys)[0];
    if (typeof first === 'string' && first) return first;
  } catch (_) { /* variable absente ou mal formée */ }
  return Deno.env.get(legacyVar) ?? '';
}

// Mot de passe provisoire lisible, sans caractères ambigus (0/O, 1/l…).
function temporaryPassword(): string {
  const letters = 'abcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const pick = (set: string, n: number) =>
    Array.from(crypto.getRandomValues(new Uint32Array(n)), v => set[v % set.length]).join('');
  return `${pick(letters, 4)}-${pick(digits, 4)}-${pick(letters, 4)}`;
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const authHeader = req.headers.get('Authorization') ?? '';
    const jwt = authHeader.replace(/^Bearer\s+/i, '');

    // Qui appelle ? Il doit être administrateur (règles de la base).
    const asCaller = createClient(url, key('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY'), {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const { data: { user } } = await asCaller.auth.getUser(jwt);
    if (!user) return json({ error: 'Non connecté.' }, 401);
    const { data: role } = await asCaller.rpc('my_role');
    if (role !== 'admin') return json({ error: "Réservé à l'administrateur." }, 403);

    const { user_id } = await req.json();
    if (!user_id) return json({ error: 'Utilisateur manquant.' }, 400);
    if (user_id === user.id) return json({ error: 'Changez votre propre mot de passe dans « Mon profil ».' }, 400);

    const admin = createClient(url, key('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const password = temporaryPassword();
    const { error } = await admin.auth.admin.updateUserById(user_id, {
      password,
      user_metadata: { must_change_password: true }
    });
    if (error) return json({ error: error.message }, 400);

    // Les demandes en attente de cet utilisateur sont traitées.
    await admin.from('password_requests')
      .update({ status: 'traitee', handled_at: new Date().toISOString(), handled_by: user.id })
      .eq('user_id', user_id).eq('status', 'en_attente');

    return json({ password });
  } catch (err) {
    return json({ error: String((err as Error)?.message ?? err) }, 500);
  }
});
