// WEBINAIRE – fonction « daily-token » (Supabase Edge Function).
//
// Donne l'accès à la visio Daily d'un webinaire, uniquement aux personnes
// autorisées par la base : l'encadreur du webinaire (ou l'admin) entre comme
// « propriétaire » (il peut couper les micros, exclure, gérer le partage
// d'écran) ; un apprenant n'entre que si son inscription est approuvée et que
// le direct est lancé. La clé secrète Daily (DAILY_API_KEY) reste sur le
// serveur et n'est jamais envoyée au navigateur.

import { createClient } from 'npm:@supabase/supabase-js@2';

const DAILY_API = 'https://api.daily.co/v1';
const TOKEN_HOURS = 6;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

// Clé publique du projet : la nouvelle clé « publishable » si elle existe,
// sinon l'ancienne clé « anon ».
function publicKey(): string {
  try {
    const keys = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') ?? '{}');
    const first = Object.values(keys)[0];
    if (typeof first === 'string' && first) return first;
  } catch (_) { /* variable absente ou mal formée */ }
  return Deno.env.get('SUPABASE_ANON_KEY') ?? '';
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const dailyKey = Deno.env.get('DAILY_API_KEY');
    if (!dailyKey) return json({ error: 'Visio non configurée (DAILY_API_KEY manquante).', code: 'not_configured' }, 503);

    const { webinar_id } = await req.json();
    if (!webinar_id) return json({ error: 'Webinaire manquant.' }, 400);

    // Client Supabase au nom de la personne connectée : les règles RLS s'appliquent.
    const authHeader = req.headers.get('Authorization') ?? '';
    const jwt = authHeader.replace(/^Bearer\s+/i, '');
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, publicKey(), {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false }
    });
    // Sur le serveur il n'y a pas de session enregistrée : on vérifie le jeton reçu.
    const { data: { user } } = await sb.auth.getUser(jwt);
    if (!user) return json({ error: 'Non connecté.' }, 401);

    const [canJoin, isOwner, webinar, profile] = await Promise.all([
      sb.rpc('can_join', { w: webinar_id }),
      sb.rpc('owns_webinar', { w: webinar_id }),
      sb.from('webinars').select('id, status').eq('id', webinar_id).maybeSingle(),
      sb.from('profiles').select('full_name').eq('id', user.id).maybeSingle()
    ]);
    if (!canJoin.data || !webinar.data) return json({ error: 'Accès refusé.' }, 403);
    const owner = isOwner.data === true;
    if (webinar.data.status !== 'en_direct' && !owner) return json({ error: "Le direct n'a pas commencé." }, 403);

    const headers = { Authorization: `Bearer ${dailyKey}`, 'Content-Type': 'application/json' };
    const name = `webinaire-${webinar_id}`;

    // Salle privée : on ne peut y entrer qu'avec un jeton délivré ici.
    let room = await fetch(`${DAILY_API}/rooms/${name}`, { headers });
    if (room.status === 404) {
      room = await fetch(`${DAILY_API}/rooms`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name,
          privacy: 'private',
          properties: {
            enable_screenshare: true,
            enable_chat: false,
            enable_prejoin_ui: true,
            start_audio_off: true,
            start_video_off: true,
            lang: 'fr'
          }
        })
      });
    }
    if (!room.ok) return json({ error: `Daily (salle) : ${await room.text()}` }, 502);
    const { url } = await room.json();

    const tokenRes = await fetch(`${DAILY_API}/meeting-tokens`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        properties: {
          room_name: name,
          user_name: profile.data?.full_name || user.email,
          user_id: user.id,
          is_owner: owner,
          enable_screenshare: true,
          start_audio_off: !owner,
          start_video_off: !owner,
          exp: Math.floor(Date.now() / 1000) + TOKEN_HOURS * 3600
        }
      })
    });
    if (!tokenRes.ok) return json({ error: `Daily (jeton) : ${await tokenRes.text()}` }, 502);
    const { token } = await tokenRes.json();

    return json({ url, token, owner });
  } catch (err) {
    return json({ error: String((err as Error)?.message ?? err) }, 500);
  }
});
