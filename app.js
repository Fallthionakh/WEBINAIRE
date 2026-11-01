// WEBINAIRE – plateforme de gestion de webinaires.
// Site statique (GitHub Pages) + Supabase : comptes, base de données,
// temps réel et stockage des fichiers. Les droits de chaque rôle sont
// appliqués par la base (voir supabase/schema.sql), pas seulement ici.

const CONFIG = window.WEBINAIRE_CONFIG || {};
const configured = Boolean(CONFIG.supabaseUrl && CONFIG.supabaseKey && window.supabase);
const sb = configured ? window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey) : null;

const ROLE_LABELS = { admin: 'Administrateur', encadreur: 'Encadreur', apprenant: 'Apprenant' };
const STATUS_LABELS = { planifie: 'Planifié', en_direct: 'En direct', termine: 'Terminé', annule: 'Annulé' };
const ACCOUNT_STATUS = { en_attente: ['En attente', 'warn'], approuve: ['Approuvé', 'ok'], suspendu: ['Suspendu', 'cancel'] };
const MAX_FILE_BYTES = 50 * 1024 * 1024; // limite de l'offre gratuite Supabase
const HEARTBEAT_MS = 30000;
const SESSION_PING_MS = 60000;
const PDFJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const SITE_URL = location.origin + location.pathname;

let session = null;
let profile = null;
let renderToken = 0;

const app = document.getElementById('app');

// =====================================================================
// Utilitaires
// =====================================================================

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

const pad = n => String(n).padStart(2, '0');

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

function fmtShortDate(iso) {
  return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

function fmtDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h} h ${pad(m)} min`;
  if (m) return `${m} min ${pad(s)} s`;
  return `${s} s`;
}

function fmtRelative(iso) {
  if (!iso) return 'Jamais';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 2 * SESSION_PING_MS) return 'En ligne';
  if (diff < 3600 * 1000) return `Il y a ${Math.round(diff / 60000)} min`;
  if (diff < 24 * 3600 * 1000) return `Il y a ${Math.round(diff / 3600000)} h`;
  return `${fmtShortDate(iso)} à ${fmtTime(iso)}`;
}

function accountBadge(status) {
  const [label, cls] = ACCOUNT_STATUS[status] || ACCOUNT_STATUS.approuve;
  return `<span class="badge ${cls}">${label}</span>`;
}

function fmtMinutes(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${pad(m)}` : `${h} h`;
}

function fmtSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} Ko`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} Mo`;
}

function dateInput(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function timeInput(d) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function initials(name) {
  return (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0].toUpperCase()).join('');
}

function firstName(name) {
  return (name || '').split(/\s+/)[0] || '';
}

function isStale(token) {
  return token !== renderToken;
}

function canManage(w) {
  return profile && (profile.role === 'admin' || w.encadreur_id === profile.id);
}

function isStaff() {
  return profile && (profile.role === 'admin' || profile.role === 'encadreur');
}

function translateError(error) {
  const msg = (error && (error.message || error.error_description)) || String(error || '');
  const map = [
    [/Invalid login credentials/i, 'E-mail ou mot de passe incorrect.'],
    [/already registered|already been registered/i, 'Un compte existe déjà avec cet e-mail.'],
    [/Password should be at least/i, 'Le mot de passe doit contenir au moins 6 caractères.'],
    [/Email not confirmed/i, 'Confirmez votre adresse e-mail avant de vous connecter.'],
    [/rate limit/i, 'Trop de tentatives. Réessayez dans quelques minutes.'],
    [/duplicate key/i, 'Cet élément existe déjà.'],
    [/row-level security|permission denied/i, "Vous n'avez pas le droit de faire cette action."],
    [/Failed to fetch|NetworkError/i, 'Connexion internet indisponible.'],
    [/exceeded the maximum allowed size|Payload too large/i, 'Fichier trop volumineux (50 Mo maximum).']
  ];
  const found = map.find(([re]) => re.test(msg));
  return found ? found[1] : msg;
}

function toast(message, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), 4500);
}

function fail(error) {
  console.error(error);
  toast(translateError(error), 'error');
}

const modal = document.getElementById('modal');

function openModal(html, { wide = false } = {}) {
  modal.className = wide ? 'modal wide' : 'modal';
  modal.innerHTML = `<div class="modal-card">${html}</div>`;
  if (!modal.open) modal.showModal();
  return modal;
}

// Fonction appelée à la fermeture de la fenêtre (annulation, Échap, clic à côté).
// L'événement « close » du navigateur est asynchrone, on ne s'appuie donc pas dessus.
let onModalClose = null;

function closeModal() {
  if (modal.open) modal.close();
  modal.innerHTML = '';
  const callback = onModalClose;
  onModalClose = null;
  if (callback) callback();
}

modal.addEventListener('click', e => {
  if (e.target === modal || e.target.closest('[data-close]')) closeModal();
});
modal.addEventListener('cancel', e => {
  e.preventDefault();
  closeModal();
});

function confirmDialog(message, { confirmLabel = 'Confirmer', danger = false, input = null } = {}) {
  return new Promise(resolve => {
    openModal(`
      <h2>${esc(message)}</h2>
      ${input ? `<label>${esc(input)}<textarea id="dlg-input" rows="3" maxlength="500"></textarea></label>` : ''}
      <div class="actions">
        <button class="btn" data-close>Annuler</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" id="dlg-ok">${esc(confirmLabel)}</button>
      </div>`);
    onModalClose = () => resolve(false);
    document.getElementById('dlg-ok').addEventListener('click', () => {
      const field = document.getElementById('dlg-input');
      onModalClose = null;
      closeModal();
      resolve(field ? field.value.trim() || true : true);
    });
  });
}

function loading(text = 'Chargement…') {
  return `<div class="loading"><span class="spinner"></span>${esc(text)}</div>`;
}

function emptyState(icon, text, action = '') {
  return `<div class="empty"><div class="big">${icon}</div><p>${esc(text)}</p>${action ? `<div style="margin-top:16px">${action}</div>` : ''}</div>`;
}

function downloadCsv(filename, rows) {
  const csv = rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function slug(text) {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').slice(0, 80);
}

function statusBadge(w) {
  if (w.status === 'en_direct') return '<span class="badge live">En direct</span>';
  if (w.status === 'termine') return '<span class="badge done">Terminé</span>';
  if (w.status === 'annule') return '<span class="badge cancel">Annulé</span>';
  const badges = ['<span class="badge">Planifié</span>'];
  if (w.rescheduled_at) badges.push('<span class="badge warn">Reprogrammé</span>');
  return badges.join(' ');
}

function dateBox(iso) {
  const d = new Date(iso);
  return `<div class="datebox"><div class="d">${d.getDate()}</div>
    <div class="m">${d.toLocaleDateString('fr-FR', { month: 'short' }).replace('.', '')}</div></div>`;
}

// =====================================================================
// Routeur et coquille de l'application
// =====================================================================

async function route() {
  const token = ++renderToken;
  await leaveRoom();
  closeModal();
  let hash = location.hash || '#/';
  if (/access_token|error=/.test(hash)) hash = '#/';

  if (!configured) return renderSetup();

  if (!session) {
    if (hash === '#/inscription') return renderAuth('signup');
    if (hash === '#/mot-de-passe-oublie') return renderAuth('forgot');
    return renderAuth('login');
  }

  if (!profile) {
    const { data, error } = await sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
    if (isStale(token)) return;
    if (error || !data) {
      app.innerHTML = `<div class="auth-panel"><div class="card auth-card stack">
        <h2>Profil introuvable</h2>
        <p class="muted">Votre compte existe mais son profil n'a pas été créé. Vérifiez que le script
        <code>supabase/schema.sql</code> a bien été exécuté, puis reconnectez-vous.</p>
        <button class="btn primary" id="logout-now">Se déconnecter</button></div></div>`;
      document.getElementById('logout-now').addEventListener('click', logout);
      return;
    }
    profile = data;
  }

  startAppSession();
  if (profile.status && profile.status !== 'approuve') return renderBlocked();

  if (hash === '#/connexion' || hash === '#/inscription') hash = '#/';
  renderShell(hash);
  const view = document.getElementById('view');
  view.innerHTML = loading();
  let m;

  if (hash === '#/') return viewDashboard(view, token);
  if (hash === '#/webinaires') return viewWebinars(view, token);
  if (hash === '#/webinaires/nouveau' && isStaff()) return viewWebinarForm(view, token, null);
  if ((m = hash.match(/^#\/webinaires\/([\w-]+)\/reprogrammer$/))) return viewWebinarForm(view, token, m[1]);
  if ((m = hash.match(/^#\/webinaires\/([\w-]+)$/))) return viewWebinarDetail(view, token, m[1]);
  if ((m = hash.match(/^#\/salle\/([\w-]+)$/))) return viewRoom(view, token, m[1]);
  if (hash === '#/bibliotheque') return viewLibrary(view, token);
  if (hash === '#/utilisateurs' && profile.role === 'admin') return viewAdmin(view, token);
  if (hash === '#/profil') return viewProfile(view, token);
  location.hash = '#/';
}

function renderShell(hash) {
  const links = [
    ['#/', '🏠', 'Tableau de bord'],
    ['#/webinaires', '🎥', 'Webinaires'],
    ['#/bibliotheque', '📚', 'Bibliothèque']
  ];
  if (profile.role === 'admin') links.push(['#/utilisateurs', '👥', 'Utilisateurs']);
  links.push(['#/profil', '⚙️', 'Mon profil']);

  const active = href => (href === '#/' ? hash === '#/' : hash.startsWith(href)) ||
    (href === '#/webinaires' && hash.startsWith('#/salle/'));

  app.innerHTML = `
    <div class="layout">
      <aside class="sidebar" id="sidebar">
        <a class="brand" href="#/"><span class="logo">🎥</span>WEBINAIRE</a>
        <nav class="side-nav">
          ${links.map(([href, ico, label]) =>
            `<a href="${href}" class="${active(href) ? 'active' : ''}"><span class="ico">${ico}</span>${label}</a>`).join('')}
        </nav>
        <div class="side-user">
          <div class="avatar">${esc(initials(profile.full_name || profile.email))}</div>
          <div class="who">
            <div class="name">${esc(profile.full_name || profile.email)}</div>
            <div class="muted small">${ROLE_LABELS[profile.role]}</div>
          </div>
          <button class="btn ghost sm" id="logout" title="Déconnexion" aria-label="Déconnexion">⎋</button>
        </div>
      </aside>
      <div class="main">
        <header class="mobile-bar">
          <button class="btn sm" id="menu" aria-label="Menu">☰</button>
          <a class="brand" href="#/"><span class="logo">🎥</span>WEBINAIRE</a>
        </header>
        <main id="view" class="view"></main>
      </div>
    </div>`;

  document.getElementById('logout').addEventListener('click', logout);
  const sidebar = document.getElementById('sidebar');
  document.getElementById('menu').addEventListener('click', () => {
    sidebar.classList.add('open');
    const scrim = Object.assign(document.createElement('div'), { className: 'scrim' });
    scrim.addEventListener('click', () => { sidebar.classList.remove('open'); scrim.remove(); });
    document.body.append(scrim);
  });
  document.querySelectorAll('.scrim').forEach(s => s.remove());
}

// Compte en attente d'approbation ou suspendu : aucun accès à la plateforme.
function renderBlocked() {
  const pending = profile.status === 'en_attente';
  app.innerHTML = `<div class="auth-panel" style="min-height:100vh"><div class="card auth-card stack" style="text-align:center">
    <div style="font-size:2.6rem">${pending ? '⏳' : '⛔'}</div>
    <h2>${pending ? 'Inscription en attente de validation' : 'Compte suspendu'}</h2>
    <p class="muted">${pending
      ? `Merci ${esc(firstName(profile.full_name))} ! Votre compte doit être approuvé par l’administrateur avant
         que vous puissiez accéder aux webinaires. Revenez un peu plus tard.`
      : 'Votre accès à la plateforme a été suspendu. Contactez l’administrateur pour plus d’informations.'}</p>
    <div class="row" style="justify-content:center">
      <button class="btn" id="recheck">Vérifier à nouveau</button>
      <button class="btn primary" id="logout-now">Se déconnecter</button>
    </div></div></div>`;
  document.getElementById('recheck').addEventListener('click', () => { profile = null; route(); });
  document.getElementById('logout-now').addEventListener('click', logout);
}

// =====================================================================
// Connexions à la plateforme (date, heure et durée de chaque visite)
// =====================================================================

let appSession = { id: null, timer: null, pending: false };

async function startAppSession() {
  if (appSession.id || appSession.pending) return;
  appSession.pending = true;
  const { data, error } = await sb.rpc('session_start', { agent: navigator.userAgent.slice(0, 200) });
  appSession.pending = false;
  if (error) return console.error(error);
  appSession.id = data;
  appSession.timer = setInterval(async () => {
    const { data: active, error: err } = await sb.rpc('session_ping', { sid: appSession.id });
    if (err || !profile) return;
    // Compte approuvé ou suspendu pendant la visite : on recharge le profil.
    if ((active === true) !== (profile.status === 'approuve')) {
      profile = null;
      route();
    }
  }, SESSION_PING_MS);
}

async function endAppSession() {
  clearInterval(appSession.timer);
  if (appSession.id) await sb.rpc('session_end', { sid: appSession.id });
  appSession = { id: null, timer: null, pending: false };
}

async function logout() {
  await endAppSession();
  await sb.auth.signOut();
}

// Appel envoyé même si l'onglet se ferme (fetch keepalive).
function keepaliveRpc(name, body) {
  if (!session) return;
  fetch(`${CONFIG.supabaseUrl}/rest/v1/rpc/${name}`, {
    method: 'POST',
    keepalive: true,
    headers: {
      apikey: CONFIG.supabaseKey,
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
}

function renderSetup() {
  app.innerHTML = `<div class="auth-panel"><div class="card auth-card stack">
    <h2>Configuration requise</h2>
    <p class="muted">Renseignez l'URL et la clé publique de votre projet Supabase dans
    <code>config.js</code>, puis rechargez la page.</p></div></div>`;
}

// =====================================================================
// Connexion, inscription, mot de passe oublié
// =====================================================================

function renderAuth(mode) {
  const titles = {
    login: ['Bon retour 👋', 'Connectez-vous à votre espace.'],
    signup: ['Créer un compte', 'Les apprenants s’inscrivent ici ; leur compte est ensuite validé par l’administrateur. ' +
      'Les encadreurs utilisent l’e-mail invité par l’administrateur.'],
    forgot: ['Mot de passe oublié', 'Recevez un lien pour choisir un nouveau mot de passe.']
  };
  const [title, subtitle] = titles[mode];

  app.innerHTML = `
    <div class="auth">
      <section class="auth-hero">
        <a class="brand" href="#/"><span class="logo">🎥</span>WEBINAIRE</a>
        <div>
          <h1>Vos webinaires,<br>de la planification<br>au suivi des présences.</h1>
          <p>Une seule plateforme pour les encadreurs et les apprenants.</p>
          <ul>
            <li>📅 Planifiez, reprogrammez ou annulez en un clic</li>
            <li>🎬 Diffusez avec caméra, partage d'écran et présentation</li>
            <li>✅ Liste de présence automatique avec durée de connexion</li>
            <li>📚 Bibliothèque de ressources : PDF, vidéos, PowerPoint</li>
          </ul>
        </div>
        <p class="small" style="opacity:.8">© ${new Date().getFullYear()} WOMMAT</p>
      </section>
      <section class="auth-panel">
        <div class="auth-card">
          <h2>${title}</h2>
          <p class="muted" style="margin-bottom:24px">${subtitle}</p>
          <form id="auth-form" class="form">
            ${mode === 'signup' ? '<label>Nom complet<input name="full_name" required maxlength="80" autocomplete="name"></label>' : ''}
            <label>E-mail<input name="email" type="email" required autocomplete="email"></label>
            ${mode !== 'forgot' ? `<label>Mot de passe<input name="password" type="password" required minlength="6"
              autocomplete="${mode === 'signup' ? 'new-password' : 'current-password'}"></label>` : ''}
            <button class="btn primary block" type="submit">${
              mode === 'login' ? 'Se connecter' : mode === 'signup' ? 'Créer mon compte' : 'Envoyer le lien'}</button>
          </form>
          <div class="stack" style="margin-top:20px;text-align:center">
            ${mode === 'login' ? `
              <a href="#/mot-de-passe-oublie">Mot de passe oublié ?</a>
              <p class="muted">Pas encore de compte ? <a href="#/inscription">Créer un compte</a></p>` :
              '<p class="muted">Déjà un compte ? <a href="#/connexion">Se connecter</a></p>'}
          </div>
        </div>
      </section>
    </div>`;

  const form = document.getElementById('auth-form');
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = form.querySelector('button');
    const d = new FormData(form);
    const email = d.get('email').trim().toLowerCase();
    btn.disabled = true;
    try {
      if (mode === 'login') {
        const { error } = await sb.auth.signInWithPassword({ email, password: d.get('password') });
        if (error) throw error;
      } else if (mode === 'signup') {
        const { data, error } = await sb.auth.signUp({
          email,
          password: d.get('password'),
          options: { data: { full_name: d.get('full_name').trim() }, emailRedirectTo: SITE_URL }
        });
        if (error) throw error;
        if (!data.session) {
          toast('Compte créé. Ouvrez le lien reçu par e-mail pour l’activer.', 'success');
          location.hash = '#/connexion';
        }
      } else {
        const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: SITE_URL + '#/profil' });
        if (error) throw error;
        toast('Si un compte existe, un e-mail vient d’être envoyé.', 'success');
      }
    } catch (err) {
      fail(err);
    } finally {
      btn.disabled = false;
    }
  });
}

// =====================================================================
// Tableau de bord
// =====================================================================

async function count(query) {
  const { count: n, error } = await query;
  if (error) throw error;
  return n || 0;
}

function statCard(icon, label, value) {
  return `<div class="card stat"><div class="ico">${icon}</div>
    <div><div class="value">${esc(value)}</div><div class="muted small">${esc(label)}</div></div></div>`;
}

const WEBINAR_SELECT = '*, encadreur:profiles!encadreur_id(full_name)';

async function viewDashboard(view, token) {
  const now = new Date().toISOString();
  try {
    let stats = '';
    let upcoming = [];
    let extra = '';
    let alertHtml = '';

    if (profile.role === 'admin') {
      const head = { count: 'exact', head: true };
      const [enc, app_, waiting, web, live, res] = await Promise.all([
        count(sb.from('profiles').select('id', head).eq('role', 'encadreur')),
        count(sb.from('profiles').select('id', head).eq('role', 'apprenant')),
        count(sb.from('profiles').select('id', head).eq('status', 'en_attente')),
        count(sb.from('webinars').select('id', head).neq('status', 'annule')),
        count(sb.from('webinars').select('id', head).eq('status', 'en_direct')),
        count(sb.from('resources').select('id', head))
      ]);
      if (waiting) {
        alertHtml = `<a class="notice warn" href="#/utilisateurs" style="display:block;margin-bottom:24px">
          ⏳ ${waiting} inscription${waiting > 1 ? 's' : ''} en attente de validation → Voir</a>`;
      }
      stats = statCard('🧑‍🏫', 'Encadreurs', enc) + statCard('🎓', 'Apprenants', app_) +
        statCard('⏳', 'En attente', waiting) + statCard('🎥', 'Webinaires', web) +
        statCard('🔴', 'En direct', live) + statCard('📚', 'Ressources', res);
      const { data, error } = await sb.from('webinars').select(WEBINAR_SELECT)
        .in('status', ['planifie', 'en_direct']).gte('ends_at', now).order('starts_at').limit(6);
      if (error) throw error;
      upcoming = data;
    } else if (profile.role === 'encadreur') {
      const { data, error } = await sb.from('webinars').select(WEBINAR_SELECT + ', registrations(count)')
        .eq('encadreur_id', profile.id).order('starts_at');
      if (error) throw error;
      const res = await count(sb.from('resources').select('id', { count: 'exact', head: true }).eq('owner_id', profile.id));
      const next = data.filter(w => ['planifie', 'en_direct'].includes(w.status) && w.ends_at >= now);
      const inscrits = next.reduce((n, w) => n + (w.registrations[0]?.count || 0), 0);
      stats = statCard('📅', 'Webinaires à venir', next.length) + statCard('🎓', 'Inscriptions à venir', inscrits) +
        statCard('✅', 'Webinaires terminés', data.filter(w => w.status === 'termine').length) +
        statCard('📚', 'Ressources déposées', res);
      upcoming = next.slice(0, 6);
    } else {
      const [{ data: regs, error }, res] = await Promise.all([
        sb.from('registrations').select('excluded, webinar:webinars(' + WEBINAR_SELECT + ')').eq('apprenant_id', profile.id),
        count(sb.from('resources').select('id', { count: 'exact', head: true }))
      ]);
      if (error) throw error;
      const mine = regs.filter(r => r.webinar && !r.excluded).map(r => r.webinar);
      const next = mine.filter(w => ['planifie', 'en_direct'].includes(w.status) && w.ends_at >= now)
        .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
      const { data: attended } = await sb.from('attendance').select('webinar_id').eq('user_id', profile.id);
      stats = statCard('📅', 'Mes webinaires à venir', next.length) +
        statCard('✅', 'Webinaires suivis', new Set((attended || []).map(a => a.webinar_id)).size) +
        statCard('📚', 'Ressources disponibles', res);
      upcoming = next.slice(0, 6);

      const registered = new Set(mine.map(w => w.id));
      const { data: open } = await sb.from('webinars').select(WEBINAR_SELECT)
        .in('status', ['planifie', 'en_direct']).gte('ends_at', now).order('starts_at').limit(12);
      const discover = (open || []).filter(w => !registered.has(w.id)).slice(0, 3);
      if (discover.length) {
        extra = `<h2 style="margin-top:32px">À découvrir</h2><div class="grid">${discover.map(w => webinarCard(w)).join('')}</div>`;
      }
    }
    if (isStale(token)) return;

    const hour = new Date().getHours();
    view.innerHTML = `
      <div class="page-head">
        <div>
          <h1>${hour < 18 ? 'Bonjour' : 'Bonsoir'}, ${esc(firstName(profile.full_name) || ROLE_LABELS[profile.role])} 👋</h1>
          <p class="muted">${esc(fmtDate(new Date().toISOString()))}</p>
        </div>
        ${isStaff() ? '<a class="btn primary" href="#/webinaires/nouveau">＋ Nouveau webinaire</a>' :
          '<a class="btn primary" href="#/webinaires">Voir les webinaires</a>'}
      </div>
      ${alertHtml}
      <div class="stats">${stats}</div>
      <h2>${profile.role === 'apprenant' ? 'Mes prochains webinaires' : 'Prochains webinaires'}</h2>
      ${upcoming.length ? `<div class="grid">${upcoming.map(w => webinarCard(w, { registered: profile.role === 'apprenant' })).join('')}</div>` :
        `<div class="card">${emptyState('🗓️', profile.role === 'apprenant' ?
          'Vous n’êtes inscrit à aucun webinaire à venir.' : 'Aucun webinaire à venir.')}</div>`}
      ${extra}`;
  } catch (err) {
    if (!isStale(token)) view.innerHTML = `<div class="notice danger">${esc(translateError(err))}</div>`;
  }
}

// =====================================================================
// Webinaires : liste, création, reprogrammation, détail
// =====================================================================

function webinarCard(w, { registered = false, excluded = false, showActions = false } = {}) {
  const inscrits = w.registrations ? (w.registrations[0]?.count || 0) : null;
  let action = `<a class="btn sm" href="#/webinaires/${w.id}">Détails</a>`;
  if (w.status === 'en_direct' && (canManage(w) || (registered && !excluded))) {
    action = `<a class="btn live sm" href="#/salle/${w.id}">Rejoindre</a>`;
  } else if (showActions && profile.role === 'apprenant' && ['planifie', 'en_direct'].includes(w.status) && !excluded) {
    action = registered
      ? `<button class="btn sm" data-unregister="${w.id}">✓ Inscrit</button>`
      : `<button class="btn primary sm" data-register="${w.id}">S'inscrire</button>`;
  }
  return `
    <article class="card wcard">
      <div class="row spread">${statusBadge(w)}${excluded ? '<span class="badge cancel">Exclu</span>' : ''}</div>
      <div class="when">
        ${dateBox(w.starts_at)}
        <div>
          <h3><a href="#/webinaires/${w.id}">${esc(w.title)}</a></h3>
          <div class="muted small">${esc(fmtTime(w.starts_at))} – ${esc(fmtTime(w.ends_at))} · ${esc(fmtMinutes(w.duration_minutes))}</div>
        </div>
      </div>
      ${w.description ? `<p class="muted small clamp">${esc(w.description)}</p>` : ''}
      <div class="foot">
        <span class="muted small">🧑‍🏫 ${esc(w.encadreur?.full_name || '')}${inscrits !== null ? ` · 🎓 ${inscrits}` : ''}</span>
        ${action}
      </div>
    </article>`;
}

async function viewWebinars(view, token) {
  let query = sb.from('webinars').select(WEBINAR_SELECT + (isStaff() ? ', registrations(count)' : '')).order('starts_at');
  if (profile.role === 'encadreur') query = query.eq('encadreur_id', profile.id);
  const [{ data: webinars, error }, regs] = await Promise.all([
    query,
    profile.role === 'apprenant'
      ? sb.from('registrations').select('webinar_id, excluded').eq('apprenant_id', profile.id)
      : Promise.resolve({ data: [] })
  ]);
  if (isStale(token)) return;
  if (error) return (view.innerHTML = `<div class="notice danger">${esc(translateError(error))}</div>`);

  const regMap = new Map((regs.data || []).map(r => [r.webinar_id, r]));
  const filters = profile.role === 'apprenant'
    ? [['avenir', 'À venir'], ['mes', 'Mes inscriptions'], ['passes', 'Passés'], ['annules', 'Annulés']]
    : [['avenir', 'À venir'], ['passes', 'Passés'], ['annules', 'Annulés'], ['tous', 'Tous']];
  let filter = 'avenir';
  let search = '';

  view.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Webinaires</h1>
        <p class="muted">${profile.role === 'encadreur' ? 'Les webinaires que vous animez.' :
          profile.role === 'admin' ? 'Tous les webinaires de la plateforme.' : 'Inscrivez-vous à un ou plusieurs webinaires.'}</p>
      </div>
      ${isStaff() ? '<a class="btn primary" href="#/webinaires/nouveau">＋ Nouveau webinaire</a>' : ''}
    </div>
    <div class="toolbar">
      <div class="chips" id="filters">${filters.map(([k, l]) =>
        `<button class="chip ${k === filter ? 'active' : ''}" data-filter="${k}">${l}</button>`).join('')}</div>
      <input class="search" id="search" type="search" placeholder="Rechercher un webinaire…">
    </div>
    <div id="results"></div>`;

  const draw = () => {
    const now = new Date().toISOString();
    const list = webinars.filter(w => {
      const reg = regMap.get(w.id);
      if (search && !(`${w.title} ${w.description} ${w.encadreur?.full_name}`.toLowerCase().includes(search))) return false;
      if (filter === 'avenir') return ['planifie', 'en_direct'].includes(w.status) && w.ends_at >= now;
      if (filter === 'mes') return !!reg;
      if (filter === 'passes') return w.status === 'termine' || (w.status === 'planifie' && w.ends_at < now);
      if (filter === 'annules') return w.status === 'annule';
      return true;
    });
    if (filter === 'passes') list.reverse();
    document.getElementById('results').innerHTML = list.length
      ? `<div class="grid">${list.map(w => {
          const reg = regMap.get(w.id);
          return webinarCard(w, { registered: !!reg, excluded: reg?.excluded, showActions: true });
        }).join('')}</div>`
      : `<div class="card">${emptyState('🔍', 'Aucun webinaire dans cette catégorie.')}</div>`;
  };
  draw();

  view.querySelector('#filters').addEventListener('click', e => {
    const b = e.target.closest('[data-filter]');
    if (!b) return;
    filter = b.dataset.filter;
    view.querySelectorAll('[data-filter]').forEach(x => x.classList.toggle('active', x === b));
    draw();
  });
  view.querySelector('#search').addEventListener('input', e => { search = e.target.value.trim().toLowerCase(); draw(); });
  view.querySelector('#results').addEventListener('click', async e => {
    const reg = e.target.closest('[data-register]');
    const unreg = e.target.closest('[data-unregister]');
    if (!reg && !unreg) return;
    const id = (reg || unreg).dataset.register || (reg || unreg).dataset.unregister;
    const ok = reg ? await register(id) : await unregister(id);
    if (!ok) return;
    if (reg) regMap.set(id, { webinar_id: id, excluded: false });
    else regMap.delete(id);
    draw();
  });
}

async function register(id) {
  const { error } = await sb.from('registrations').insert({ webinar_id: id, apprenant_id: profile.id });
  if (error) { fail(error); return false; }
  toast('Inscription confirmée ✓', 'success');
  return true;
}

async function unregister(id) {
  if (!await confirmDialog('Se désinscrire de ce webinaire ?', { confirmLabel: 'Me désinscrire', danger: true })) return false;
  const { error } = await sb.from('registrations').delete().eq('webinar_id', id).eq('apprenant_id', profile.id);
  if (error) { fail(error); return false; }
  toast('Désinscription enregistrée.');
  return true;
}

async function viewWebinarForm(view, token, id) {
  let w = null;
  if (id) {
    const { data, error } = await sb.from('webinars').select('*').eq('id', id).maybeSingle();
    if (isStale(token)) return;
    if (error || !data || !canManage(data)) {
      view.innerHTML = `<div class="notice danger">Webinaire introuvable ou non modifiable.</div>`;
      return;
    }
    if (!['planifie', 'en_direct'].includes(data.status)) {
      view.innerHTML = `<div class="notice warn">Un webinaire ${STATUS_LABELS[data.status].toLowerCase()} ne peut plus être reprogrammé.</div>`;
      return;
    }
    w = data;
  }

  const start = w ? new Date(w.starts_at) : (() => {
    const d = new Date(Date.now() + 24 * 3600 * 1000);
    d.setMinutes(0, 0, 0);
    d.setHours(10);
    return d;
  })();

  view.innerHTML = `
    <div class="page-head">
      <div>
        <a class="back" href="${id ? `#/webinaires/${id}` : '#/webinaires'}">← Retour</a>
        <h1>${id ? 'Modifier / reprogrammer' : 'Nouveau webinaire'}</h1>
        ${id ? '<p class="muted">Les apprenants inscrits verront la nouvelle date et le badge « Reprogrammé ».</p>' : ''}
      </div>
    </div>
    <form id="wf" class="card form" style="max-width:760px">
      <label>Titre<input name="title" required maxlength="160" value="${esc(w?.title)}" placeholder="Ex. Introduction à l'échographie"></label>
      <label>Description<textarea name="description" rows="4" maxlength="2000" placeholder="Objectifs, programme, public visé…">${esc(w?.description)}</textarea></label>
      <div class="form-grid">
        <label>Date<input type="date" name="date" required value="${dateInput(start)}"></label>
        <label>Heure de début<input type="time" name="start" required value="${timeInput(start)}"></label>
        <label>Durée (minutes)<input type="number" name="duration" min="5" max="720" step="5" required value="${w ? w.duration_minutes : 60}"></label>
        <label>Heure de fin<input type="time" name="end" required></label>
      </div>
      <p class="notice" id="wf-summary"></p>
      <div class="actions">
        <a class="btn" href="${id ? `#/webinaires/${id}` : '#/webinaires'}">Annuler</a>
        <button class="btn primary" type="submit">${id ? 'Enregistrer' : 'Créer le webinaire'}</button>
      </div>
    </form>`;

  const form = document.getElementById('wf');
  const startDate = () => new Date(`${form.date.value}T${form.start.value}`);
  const summary = () => {
    const s = startDate();
    const dur = Number(form.duration.value);
    if (isNaN(s) || !dur) return;
    const e = new Date(s.getTime() + dur * 60000);
    const nextDay = e.getDate() !== s.getDate();
    document.getElementById('wf-summary').textContent =
      `📅 ${fmtDate(s.toISOString())}, de ${fmtTime(s.toISOString())} à ${fmtTime(e.toISOString())}` +
      `${nextDay ? ' (le lendemain)' : ''} · durée ${fmtMinutes(dur)}`;
  };
  const syncEnd = () => {
    const s = startDate();
    const dur = Number(form.duration.value);
    if (!isNaN(s) && dur) form.end.value = timeInput(new Date(s.getTime() + dur * 60000));
    summary();
  };
  const syncDuration = () => {
    const s = startDate();
    if (isNaN(s) || !form.end.value) return;
    const [h, m] = form.end.value.split(':').map(Number);
    let mins = (h * 60 + m) - (s.getHours() * 60 + s.getMinutes());
    if (mins <= 0) mins += 24 * 60;
    form.duration.value = mins;
    summary();
  };
  form.date.addEventListener('input', syncEnd);
  form.start.addEventListener('input', syncEnd);
  form.duration.addEventListener('input', syncEnd);
  form.end.addEventListener('change', syncDuration);
  syncEnd();

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const s = startDate();
    const duration = Number(form.duration.value);
    if (isNaN(s)) return toast('Date ou heure invalide.', 'error');
    if (duration < 5 || duration > 720) return toast('La durée doit être comprise entre 5 minutes et 12 heures.', 'error');
    if ((!w || s.getTime() !== new Date(w.starts_at).getTime()) && s < new Date()) {
      return toast('Cette date est déjà passée.', 'error');
    }
    const payload = {
      title: form.title.value.trim(),
      description: form.description.value.trim(),
      starts_at: s.toISOString(),
      duration_minutes: duration
    };
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    const { data, error } = w
      ? await sb.from('webinars').update(payload).eq('id', w.id).select().single()
      : await sb.from('webinars').insert({ ...payload, encadreur_id: profile.id }).select().single();
    btn.disabled = false;
    if (error) return fail(error);
    toast(w ? 'Webinaire mis à jour ✓' : 'Webinaire créé ✓', 'success');
    location.hash = `#/webinaires/${data.id}`;
  });
}

async function viewWebinarDetail(view, token, id) {
  const { data: w, error } = await sb.from('webinars').select(WEBINAR_SELECT).eq('id', id).maybeSingle();
  if (isStale(token)) return;
  if (error || !w) {
    view.innerHTML = `<div class="notice danger">Webinaire introuvable. <a href="#/webinaires">Retour</a></div>`;
    return;
  }
  const manage = canManage(w);
  let reg = null;
  if (profile.role === 'apprenant') {
    const { data } = await sb.from('registrations').select('*').eq('webinar_id', id).eq('apprenant_id', profile.id).maybeSingle();
    reg = data;
  }
  const { data: resources } = await sb.from('resources').select('*').eq('webinar_id', id).order('created_at');
  if (isStale(token)) return;

  const open = ['planifie', 'en_direct'].includes(w.status);
  let actions = '';
  if (manage) {
    if (w.status === 'planifie') {
      actions = `
        <a class="btn live" href="#/salle/${id}">🎬 Ouvrir la salle</a>
        <a class="btn" href="#/webinaires/${id}/reprogrammer">🗓️ Reprogrammer</a>
        <button class="btn danger" id="cancel-w">Annuler le webinaire</button>`;
    } else if (w.status === 'en_direct') {
      actions = `<a class="btn live" href="#/salle/${id}">Rejoindre la salle</a>`;
    } else if (w.status === 'annule') {
      actions = '<button class="btn danger" id="delete-w">Supprimer</button>';
    }
  } else if (profile.role === 'apprenant') {
    if (reg?.excluded) {
      actions = '<span class="badge cancel">Vous avez été exclu de ce webinaire</span>';
    } else if (w.status === 'en_direct' && reg) {
      actions = `<a class="btn live" href="#/salle/${id}">Rejoindre le direct</a>`;
    } else if (open && reg) {
      actions = '<span class="badge ok">✓ Inscrit</span><button class="btn sm" id="unreg">Se désinscrire</button>';
    } else if (open) {
      actions = '<button class="btn primary" id="reg">S’inscrire</button>';
    }
  }

  view.innerHTML = `
    <div class="page-head">
      <div>
        <a class="back" href="#/webinaires">← Webinaires</a>
        <div class="row" style="margin-bottom:8px">${statusBadge(w)}</div>
        <h1>${esc(w.title)}</h1>
      </div>
      <div class="row">${actions}</div>
    </div>
    ${w.status === 'annule' ? `<div class="notice danger" style="margin-bottom:16px">Ce webinaire a été annulé${
      w.cancel_reason ? ` : ${esc(w.cancel_reason)}` : '.'}</div>` : ''}
    ${w.rescheduled_at && w.status === 'planifie' ? `<div class="notice warn" style="margin-bottom:16px">
      Reprogrammé le ${esc(fmtShortDate(w.rescheduled_at))}. Nouvelle date ci-dessous.</div>` : ''}
    <div class="card">
      <div class="info-grid">
        <div><div class="k">Date</div><div class="v">${esc(fmtDate(w.starts_at))}</div></div>
        <div><div class="k">Horaire</div><div class="v">${esc(fmtTime(w.starts_at))} – ${esc(fmtTime(w.ends_at))}</div></div>
        <div><div class="k">Durée</div><div class="v">${esc(fmtMinutes(w.duration_minutes))}</div></div>
        <div><div class="k">Encadreur</div><div class="v">${esc(w.encadreur?.full_name)}</div></div>
      </div>
      ${w.description ? `<p style="margin-top:16px;white-space:pre-line">${esc(w.description)}</p>` : ''}
    </div>
    ${resources?.length ? `<div class="card"><h2>📚 Ressources du webinaire</h2>
      <div class="list">${resources.map(r => resourceRow(r)).join('')}</div></div>` : ''}
    ${manage ? '<div class="card" id="manage">' + loading() + '</div>' : ''}`;

  bindResourceButtons(view);

  const on = (sel, fn) => { const el = view.querySelector(sel); if (el) el.addEventListener('click', fn); };
  on('#reg', async () => { if (await register(id)) route(); });
  on('#unreg', async () => { if (await unregister(id)) route(); });
  on('#cancel-w', async () => {
    const reason = await confirmDialog('Annuler ce webinaire ?', {
      confirmLabel: 'Annuler le webinaire', danger: true, input: 'Motif (visible par les apprenants, facultatif)'
    });
    if (!reason) return;
    const { error: err } = await sb.from('webinars')
      .update({ status: 'annule', cancel_reason: reason === true ? null : reason }).eq('id', id);
    if (err) return fail(err);
    toast('Webinaire annulé.');
    route();
  });
  on('#delete-w', async () => {
    if (!await confirmDialog('Supprimer définitivement ce webinaire ?', { confirmLabel: 'Supprimer', danger: true })) return;
    const { error: err } = await sb.from('webinars').delete().eq('id', id);
    if (err) return fail(err);
    toast('Webinaire supprimé.');
    location.hash = '#/webinaires';
  });

  if (manage) renderManagement(document.getElementById('manage'), w, token);
}

// Inscrits et liste de présence (encadreur / admin).
async function renderManagement(box, w, token, tab = 'inscrits') {
  const [{ data: regs, error: e1 }, { data: att, error: e2 }] = await Promise.all([
    sb.from('registrations').select('*, apprenant:profiles!apprenant_id(full_name, email)')
      .eq('webinar_id', w.id).order('registered_at'),
    sb.from('attendance').select('*, user:profiles!user_id(full_name, email)')
      .eq('webinar_id', w.id).order('joined_at')
  ]);
  if (isStale(token)) return;
  if (e1 || e2) return (box.innerHTML = `<div class="notice danger">${esc(translateError(e1 || e2))}</div>`);

  const sessions = att.filter(a => a.user_id !== w.encadreur_id);
  const report = presenceReport(w, regs, sessions);
  const present = report.filter(r => r.sessions.length).length;

  box.innerHTML = `
    <div class="tabs">
      <button data-tab="inscrits" class="${tab === 'inscrits' ? 'active' : ''}">🎓 Inscrits (${regs.length})</button>
      <button data-tab="presences" class="${tab === 'presences' ? 'active' : ''}">✅ Liste de présence (${present})</button>
    </div>
    <div id="tab-body"></div>`;

  const body = box.querySelector('#tab-body');
  if (tab === 'inscrits') {
    body.innerHTML = regs.length ? `
      <div class="table-wrap"><table>
        <thead><tr><th>Apprenant</th><th>E-mail</th><th>Inscrit le</th><th>Statut</th><th></th></tr></thead>
        <tbody>${regs.map(r => `<tr>
          <td><div class="row"><div class="avatar sm">${esc(initials(r.apprenant?.full_name))}</div>${esc(r.apprenant?.full_name)}</div></td>
          <td class="muted">${esc(r.apprenant?.email)}</td>
          <td>${esc(fmtShortDate(r.registered_at))}</td>
          <td>${r.excluded ? '<span class="badge cancel">Exclu</span>' : '<span class="badge ok">Inscrit</span>'}</td>
          <td style="text-align:right">${r.excluded
            ? `<button class="btn sm" data-readmit="${r.apprenant_id}">Réintégrer</button>`
            : `<button class="btn danger sm" data-exclude="${r.apprenant_id}">Exclure</button>`}</td>
        </tr>`).join('')}</tbody>
      </table></div>` : emptyState('🎓', 'Aucun apprenant inscrit pour le moment.');
  } else {
    body.innerHTML = `
      <div class="row spread" style="margin-bottom:12px">
        <p class="muted small">Dressée automatiquement : heure de connexion, de déconnexion et durée de chaque connexion.</p>
        <button class="btn sm" id="export">⬇️ Exporter (Excel / CSV)</button>
      </div>
      ${report.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Apprenant</th><th>Date</th><th>Connexion</th><th>Déconnexion</th><th>Durée</th><th>Total</th></tr></thead>
        <tbody>${report.map(r => r.sessions.length ? r.sessions.map((s, i) => `<tr>
            ${i === 0 ? `<td rowspan="${r.sessions.length}"><div class="row"><div class="avatar sm">${esc(initials(r.name))}</div>
              <div>${esc(r.name)}<div class="muted small">${esc(r.email)}</div></div></div></td>` : ''}
            <td>${esc(fmtShortDate(s.joined_at))}</td>
            <td>${esc(fmtTime(s.joined_at))}</td>
            <td>${s.online ? '<span class="badge live">En ligne</span>' : esc(fmtTime(s.end))}</td>
            <td>${esc(fmtDuration(s.duration))}</td>
            ${i === 0 ? `<td rowspan="${r.sessions.length}"><strong>${esc(fmtDuration(r.total))}</strong></td>` : ''}
          </tr>`).join('') : `<tr>
            <td><div class="row"><div class="avatar sm">${esc(initials(r.name))}</div>
              <div>${esc(r.name)}<div class="muted small">${esc(r.email)}</div></div></div></td>
            <td colspan="5"><span class="badge cancel">Absent</span></td></tr>`).join('')}
        </tbody></table></div>` : emptyState('✅', 'La liste se remplira automatiquement pendant le direct.')}`;
  }

  box.querySelectorAll('[data-tab]').forEach(b =>
    b.addEventListener('click', () => renderManagement(box, w, token, b.dataset.tab)));
  box.querySelectorAll('[data-exclude], [data-readmit]').forEach(b => b.addEventListener('click', async () => {
    const userId = b.dataset.exclude || b.dataset.readmit;
    const ok = await setExcluded(w.id, userId, !!b.dataset.exclude);
    if (ok) renderManagement(box, w, token, tab);
  }));
  const exp = box.querySelector('#export');
  if (exp) exp.addEventListener('click', () => exportPresence(w, report));
}

function presenceReport(w, regs, sessions) {
  const now = Date.now();
  const people = new Map();
  regs.forEach(r => people.set(r.apprenant_id, {
    name: r.apprenant?.full_name || '', email: r.apprenant?.email || '', excluded: r.excluded, sessions: [], total: 0
  }));
  sessions.forEach(a => {
    if (!people.has(a.user_id)) {
      people.set(a.user_id, { name: a.user?.full_name || '', email: a.user?.email || '', sessions: [], total: 0 });
    }
    const online = !a.left_at && w.status === 'en_direct' && now - new Date(a.last_seen_at).getTime() < 2 * HEARTBEAT_MS;
    const end = a.left_at || a.last_seen_at;
    const duration = (online ? now : new Date(end).getTime()) - new Date(a.joined_at).getTime();
    const p = people.get(a.user_id);
    p.sessions.push({ joined_at: a.joined_at, end, online, duration });
    p.total += duration;
  });
  return [...people.values()].sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

function exportPresence(w, report) {
  const rows = [['Webinaire', 'Apprenant', 'E-mail', 'Date', 'Heure de connexion', 'Heure de déconnexion',
    'Durée de connexion', 'Durée totale', 'Statut']];
  report.forEach(r => {
    if (!r.sessions.length) {
      rows.push([w.title, r.name, r.email, '', '', '', '', '', r.excluded ? 'Exclu' : 'Absent']);
    }
    r.sessions.forEach(s => rows.push([
      w.title, r.name, r.email, fmtShortDate(s.joined_at), fmtTime(s.joined_at),
      s.online ? 'en ligne' : fmtTime(s.end), fmtDuration(s.duration), fmtDuration(r.total),
      r.excluded ? 'Exclu' : 'Présent'
    ]));
  });
  downloadCsv(`presence-${slug(w.title)}-${dateInput(new Date(w.starts_at))}.csv`, rows);
}

async function setExcluded(webinarId, userId, excluded) {
  if (excluded && !await confirmDialog('Exclure cet apprenant du webinaire ?', {
    confirmLabel: 'Exclure', danger: true
  })) return false;
  const { error } = await sb.from('registrations').update({ excluded })
    .eq('webinar_id', webinarId).eq('apprenant_id', userId);
  if (error) { fail(error); return false; }
  toast(excluded ? 'Apprenant exclu.' : 'Apprenant réintégré.', 'success');
  return true;
}

// =====================================================================
// Salle en direct
// =====================================================================

function emptyRoom() {
  return {
    id: null, webinar: null, isHost: false, channel: null, sessionId: null, heartbeat: null,
    tab: 'chat', messages: [], polls: [], votes: [], presence: {}
  };
}

let room = emptyRoom();

// Scène de l'organisateur : caméra, partage d'écran ou présentation.
let cameraStream = null;
let cameraPending = false;
let cameraError = false;
let screenStream = null;
let stageMode = 'camera'; // 'camera' | 'screen' | 'slides'
let slides = null;        // { name, kind: 'pdf' | 'images', doc, urls, page, count }
let pdfjsPromise = null;
let stageToken = 0;

async function viewRoom(view, token, id) {
  const { data: w, error } = await sb.from('webinars').select(WEBINAR_SELECT).eq('id', id).maybeSingle();
  if (isStale(token)) return;
  if (error || !w) return (view.innerHTML = '<div class="notice danger">Webinaire introuvable.</div>');

  const isHost = canManage(w);
  if (!isHost) {
    const { data: reg } = await sb.from('registrations').select('excluded')
      .eq('webinar_id', id).eq('apprenant_id', profile.id).maybeSingle();
    if (isStale(token)) return;
    if (!reg || reg.excluded) {
      view.innerHTML = `<div class="card">${emptyState('🔒', reg ? 'Vous avez été exclu de ce webinaire.' :
        'Inscrivez-vous à ce webinaire pour accéder à la salle.', `<a class="btn primary" href="#/webinaires/${id}">Voir le webinaire</a>`)}</div>`;
      return;
    }
  }

  room = { ...emptyRoom(), id, webinar: w, isHost };

  const [msgs, polls] = await Promise.all([
    sb.from('messages').select('*').eq('webinar_id', id).order('created_at').limit(500),
    sb.from('polls').select('*').eq('webinar_id', id).order('created_at')
  ]);
  room.messages = msgs.data || [];
  room.polls = polls.data || [];
  if (room.polls.length) {
    const { data } = await sb.from('poll_votes').select('*').in('poll_id', room.polls.map(p => p.id));
    room.votes = data || [];
  }
  if (isStale(token) || room.id !== id) return;

  const channel = sb.channel(`salle:${id}`, { config: { presence: { key: profile.id } } });
  room.channel = channel;
  channel
    .on('presence', { event: 'sync' }, () => {
      room.presence = channel.presenceState();
      renderRoomMeta();
      if (room.tab === 'participants') renderPanel();
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `webinar_id=eq.${id}` }, p => {
      if (!room.messages.some(m => m.id === p.new.id)) room.messages.push(p.new);
      if (room.tab === 'chat' || room.tab === 'questions') renderPanel();
    })
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'messages' }, p => {
      room.messages = room.messages.filter(m => m.id !== p.old.id);
      if (room.tab === 'chat' || room.tab === 'questions') renderPanel();
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'polls', filter: `webinar_id=eq.${id}` }, p => {
      if (!room.polls.some(x => x.id === p.new.id)) room.polls.push(p.new);
      if (room.tab === 'sondages') renderPanel();
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'poll_votes' }, p => {
      if (!room.polls.some(x => x.id === p.new.poll_id)) return;
      if (!room.votes.some(v => v.poll_id === p.new.poll_id && v.user_id === p.new.user_id)) room.votes.push(p.new);
      if (room.tab === 'sondages') renderPanel();
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'webinars', filter: `id=eq.${id}` }, p => {
      onWebinarUpdate(p.new);
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'registrations',
      filter: `apprenant_id=eq.${profile.id}` }, p => {
      if (p.new.webinar_id === id && p.new.excluded) kickOut("L'encadreur vous a retiré de ce webinaire.");
    })
    .subscribe(status => {
      if (status === 'SUBSCRIBED') {
        channel.track({ user_id: profile.id, name: profile.full_name, role: profile.role, joined_at: new Date().toISOString() });
      }
    });

  if (w.status === 'en_direct' && !isHost) await startAttendance();
  if (isStale(token) || room.id !== id) return;
  renderRoomView();
}

async function startAttendance() {
  if (room.sessionId || room.isHost) return;
  const id = room.id;
  const { data, error } = await sb.rpc('attendance_join', { w: id });
  if (room.id !== id) {
    if (data) sb.rpc('attendance_leave', { session_id: data });
    return;
  }
  if (error) return fail(error);
  room.sessionId = data;
  room.heartbeat = setInterval(async () => {
    const { data: ok, error: err } = await sb.rpc('attendance_ping', { session_id: room.sessionId });
    if (!err && ok === false) kickOut('Vous ne pouvez plus participer à ce webinaire.');
  }, HEARTBEAT_MS);
}

function stopAttendance() {
  clearInterval(room.heartbeat);
  room.heartbeat = null;
  if (room.sessionId) sb.rpc('attendance_leave', { session_id: room.sessionId });
  room.sessionId = null;
}

async function leaveRoom() {
  if (!room.id) return;
  stopAttendance();
  if (room.channel) await sb.removeChannel(room.channel);
  stopMedia();
  room = emptyRoom();
}

function kickOut(message) {
  leaveRoom();
  toast(message, 'error');
  location.hash = '#/webinaires';
}

// Fermeture de l'onglet : on enregistre l'heure de départ sans attendre la réponse.
window.addEventListener('pagehide', () => {
  if (room.sessionId) keepaliveRpc('attendance_leave', { session_id: room.sessionId });
  if (appSession.id) keepaliveRpc('session_end', { sid: appSession.id });
});

function onWebinarUpdate(next) {
  const prev = room.webinar;
  room.webinar = { ...prev, ...next };
  if (prev.status !== next.status) {
    if (next.status === 'en_direct') startAttendance();
    if (next.status === 'termine' || next.status === 'annule') {
      stopAttendance();
      stopMedia();
    }
    renderRoomView();
  } else if (!room.isHost) {
    const info = document.getElementById('stage-info');
    if (info) info.innerHTML = stageInfo(room.webinar);
  }
}

function onlineList() {
  return Object.values(room.presence).map(list => list[0]).filter(Boolean)
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'fr'));
}

function renderRoomMeta() {
  const el = document.getElementById('online-count');
  if (el) el.textContent = `👥 ${onlineList().length} en ligne`;
  const tabBtn = document.querySelector('[data-rtab="participants"]');
  if (tabBtn) tabBtn.textContent = `👥 ${onlineList().length}`;
}

function renderRoomView() {
  const view = document.getElementById('view');
  const w = room.webinar;
  if (!view || !w) return;
  const host = room.isHost;

  let stage;
  if (w.status === 'en_direct' && host) {
    stage = '<div id="stage-host" class="stage-host"></div>';
  } else if (w.status === 'en_direct') {
    stage = `<div class="stage-msg"><span class="badge live">En direct</span>
      <h2 style="margin:0">${esc(w.encadreur?.full_name)} présente</h2>
      <div id="stage-info">${stageInfo(w)}</div>
      <p class="small" style="opacity:.7">La transmission vidéo vers les participants arrivera avec le serveur WebRTC.<br>
      Votre présence est enregistrée automatiquement.</p></div>`;
  } else if (w.status === 'termine') {
    stage = '<div class="stage-msg"><h2 style="margin:0">Ce webinaire est terminé</h2><p style="opacity:.7">Merci pour votre participation.</p></div>';
  } else if (w.status === 'annule') {
    stage = '<div class="stage-msg"><h2 style="margin:0">Ce webinaire a été annulé</h2></div>';
  } else {
    stage = `<div class="stage-msg"><span class="badge">Bientôt</span>
      <h2 style="margin:0">Début prévu à ${esc(fmtTime(w.starts_at))}</h2>
      <p style="opacity:.7">${esc(fmtDate(w.starts_at))}</p>
      ${host ? '' : '<p class="small" style="opacity:.7">La salle s’ouvrira automatiquement dès que l’encadreur lancera le direct.</p>'}</div>`;
  }

  const tabs = [['chat', '💬 Chat'], ['questions', '❓ Questions'], ['sondages', '📊 Sondages']];
  if (host) tabs.push(['participants', `👥 ${onlineList().length}`]);

  view.innerHTML = `
    <div class="page-head">
      <div>
        <a class="back" href="#/webinaires/${w.id}">← Quitter la salle</a>
        <div class="row" style="margin-bottom:6px">${statusBadge(w)}<span class="muted small" id="online-count"></span></div>
        <h1>${esc(w.title)}</h1>
      </div>
    </div>
    <div class="room">
      <section>
        <div class="stage">${stage}</div>
        ${host ? stageToolbar(w) : ''}
      </section>
      <aside class="card side-panel">
        <div class="tabs">${tabs.map(([k, l]) =>
          `<button data-rtab="${k}" class="${room.tab === k ? 'active' : ''}">${l}</button>`).join('')}</div>
        <div class="panel-body" id="panel"></div>
      </aside>
    </div>`;

  renderRoomMeta();
  view.querySelectorAll('[data-rtab]').forEach(b => b.addEventListener('click', () => {
    room.tab = b.dataset.rtab;
    view.querySelectorAll('[data-rtab]').forEach(x => x.classList.toggle('active', x === b));
    renderPanel();
  }));
  if (host) bindStageToolbar(w);
  renderPanel();
}

function stageToolbar(w) {
  if (w.status === 'planifie') {
    return `<div class="stage-tools"><button class="btn live" id="go-live">🎬 Démarrer le direct</button>
      <span class="muted small" style="align-self:center">Les apprenants inscrits pourront entrer dès le démarrage.</span></div>`;
  }
  if (w.status !== 'en_direct') return '';
  return `
    <div class="stage-tools">
      <button class="btn ${stageMode === 'camera' ? 'active' : ''}" data-mode="camera">📷 Caméra</button>
      ${canShareScreen() ? `<button class="btn ${stageMode === 'screen' ? 'active' : ''}" data-mode="screen">🖥️ Partager l'écran</button>` : ''}
      <label class="btn ${stageMode === 'slides' ? 'active' : ''}">📑 Présentation
        <input type="file" id="slides-input" accept="application/pdf,image/*" multiple hidden>
      </label>
      <button class="btn" id="slides-library">📚 Depuis la bibliothèque</button>
      <button class="btn" id="fullscreen">⛶ Plein écran</button>
      <button class="btn danger" id="end-live">Terminer le direct</button>
    </div>
    ${slides ? `
      <div class="stage-tools">
        <button class="btn sm" data-slide="-1" aria-label="Diapositive précédente">◀</button>
        <strong id="slide-pos">${slides.page} / ${slides.count}</strong>
        <button class="btn sm" data-slide="1" aria-label="Diapositive suivante">▶</button>
        <span class="muted small" style="align-self:center">${esc(slides.name)}</span>
        ${stageMode !== 'slides' ? '<button class="btn ghost sm" data-mode="slides">Afficher</button>' : ''}
        <button class="btn ghost sm" id="close-slides">Fermer</button>
      </div>` : ''}`;
}

function bindStageToolbar(w) {
  const view = document.getElementById('view');
  const on = (sel, fn) => { const el = view.querySelector(sel); if (el) el.addEventListener('click', fn); };

  on('#go-live', async () => {
    const { error } = await sb.from('webinars').update({ status: 'en_direct' }).eq('id', w.id);
    if (error) return fail(error);
    onWebinarUpdate({ status: 'en_direct' });
  });
  on('#end-live', async () => {
    if (!await confirmDialog('Terminer le direct pour tout le monde ?', { confirmLabel: 'Terminer', danger: true })) return;
    const { error } = await sb.from('webinars').update({ status: 'termine', stage: null }).eq('id', w.id);
    if (error) return fail(error);
    toast('Direct terminé. La liste de présence est prête.', 'success');
    location.hash = `#/webinaires/${w.id}`;
  });
  on('#fullscreen', () => {
    const el = view.querySelector('.stage');
    if (el.requestFullscreen) el.requestFullscreen();
  });
  on('#close-slides', () => {
    clearSlides();
    if (stageMode === 'slides') stageMode = 'camera';
    publishStage();
    renderRoomView();
  });
  on('#slides-library', () => pickSlidesFromLibrary());
  view.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => setStageMode(b.dataset.mode)));
  view.querySelectorAll('[data-slide]').forEach(b => b.addEventListener('click', () => changeSlide(Number(b.dataset.slide))));
  const input = view.querySelector('#slides-input');
  if (input) input.addEventListener('change', () => loadSlides([...input.files]));

  if (w.status === 'en_direct') {
    ensureCamera();
    renderStage();
  }
}

function renderPanel() {
  const panel = document.getElementById('panel');
  if (!panel) return;
  const w = room.webinar;
  const canPost = w.status === 'en_direct' || (room.isHost && w.status === 'planifie');

  if (room.tab === 'participants') {
    const people = onlineList();
    panel.innerHTML = people.length ? `<div class="list">${people.map(p => `
      <div class="list-item">
        <div class="avatar sm">${esc(initials(p.name))}</div>
        <div class="grow"><div>${esc(p.name)}</div>
          <div class="muted small">${ROLE_LABELS[p.role] || ''} · depuis ${esc(fmtTime(p.joined_at))}</div></div>
        ${p.role === 'apprenant' ? `<button class="btn danger sm" data-kick="${p.user_id}">Exclure</button>` : ''}
      </div>`).join('')}</div>` : emptyState('👥', 'Personne en ligne pour le moment.');
    panel.querySelectorAll('[data-kick]').forEach(b => b.addEventListener('click', () =>
      setExcluded(w.id, b.dataset.kick, true)));
    return;
  }

  if (room.tab === 'sondages') {
    panel.innerHTML = `<div class="messages">${room.polls.map(p => {
      const votes = room.votes.filter(v => v.poll_id === p.id);
      const mine = votes.find(v => v.user_id === profile.id);
      return `<div class="poll"><strong>${esc(p.question)}</strong>
        ${p.options.map((o, i) => {
          const n = votes.filter(v => v.option_index === i).length;
          const pct = votes.length ? Math.round(n * 100 / votes.length) : 0;
          const show = mine || room.isHost;
          return `<button class="poll-opt ${mine?.option_index === i ? 'mine' : ''}" data-vote="${p.id}:${i}"
            ${mine || room.isHost || !canPost ? 'disabled' : ''}>
            ${show ? `<span class="fill" style="width:${pct}%"></span>` : ''}
            <span>${esc(o)}${show ? ` — ${pct} % (${n})` : ''}</span></button>`;
        }).join('')}</div>`;
    }).join('') || emptyState('📊', 'Aucun sondage pour le moment.')}</div>
    ${room.isHost && canPost ? `
      <form id="poll-form" class="form" style="margin-top:12px;gap:8px">
        <input name="question" placeholder="Question du sondage" required maxlength="200">
        <input name="options" placeholder="Choix séparés par des virgules" required maxlength="400">
        <button class="btn primary" type="submit">Lancer le sondage</button>
      </form>` : ''}`;

    panel.querySelectorAll('[data-vote]').forEach(b => b.addEventListener('click', async () => {
      const [pollId, idx] = b.dataset.vote.split(':');
      const vote = { poll_id: pollId, user_id: profile.id, option_index: Number(idx) };
      const { error } = await sb.from('poll_votes').insert(vote);
      if (error) return fail(error);
      room.votes.push(vote);
      renderPanel();
    }));
    const form = panel.querySelector('#poll-form');
    if (form) form.addEventListener('submit', async e => {
      e.preventDefault();
      const options = form.options.value.split(',').map(s => s.trim()).filter(Boolean);
      if (options.length < 2) return toast('Il faut au moins deux choix.', 'error');
      const { data, error } = await sb.from('polls')
        .insert({ webinar_id: w.id, question: form.question.value.trim(), options }).select().single();
      if (error) return fail(error);
      if (!room.polls.some(p => p.id === data.id)) room.polls.push(data);
      renderPanel();
    });
    return;
  }

  const kind = room.tab === 'questions' ? 'question' : 'chat';
  const items = room.messages.filter(m => m.kind === kind);
  panel.innerHTML = `
    <div class="messages" id="messages">
      ${items.map(m => `
        <div class="msg ${m.user_id === profile.id ? 'mine' : ''}">
          <div class="avatar sm">${esc(initials(m.author_name))}</div>
          <div class="bubble">
            <div class="meta">${esc(m.author_name)} · ${esc(fmtTime(m.created_at))}
              ${room.isHost ? `<button class="btn ghost sm" data-del="${m.id}" title="Supprimer" style="padding:0 4px">✕</button>` : ''}</div>
            <div>${esc(m.body)}</div>
          </div>
        </div>`).join('') || emptyState(kind === 'question' ? '❓' : '💬',
          kind === 'question' ? 'Aucune question pour le moment.' : 'Aucun message pour le moment.')}
    </div>
    ${canPost ? `<form class="composer" id="composer">
      <input name="body" required maxlength="1000" autocomplete="off"
        placeholder="${kind === 'question' ? 'Posez votre question…' : 'Écrire un message…'}">
      <button class="btn primary" type="submit" aria-label="Envoyer">➤</button>
    </form>` : ''}`;

  const box = panel.querySelector('#messages');
  box.scrollTop = box.scrollHeight;

  panel.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
    const { error } = await sb.from('messages').delete().eq('id', Number(b.dataset.del));
    if (error) return fail(error);
    room.messages = room.messages.filter(m => m.id !== Number(b.dataset.del));
    renderPanel();
  }));

  const form = panel.querySelector('#composer');
  if (form) form.addEventListener('submit', async e => {
    e.preventDefault();
    const body = form.body.value.trim();
    if (!body) return;
    form.body.value = '';
    const { data, error } = await sb.from('messages').insert({ webinar_id: w.id, kind, body }).select().single();
    if (error) return fail(error);
    if (!room.messages.some(m => m.id === data.id)) room.messages.push(data);
    renderPanel();
    const input = document.querySelector('#composer input');
    if (input) input.focus();
  });
}

// Ce que les participants voient décrit (la vidéo arrivera avec le serveur WebRTC).
function stageInfo(w) {
  const s = w.stage;
  if (!s || s.mode === 'camera') return '<p>📷 Caméra</p>';
  if (s.mode === 'screen') return "<p>🖥️ Partage d'écran en cours</p>";
  return `<p>📑 Présentation : ${esc(s.name)} – diapositive ${esc(s.page)} / ${esc(s.count)}</p>`;
}

function publishStage() {
  if (!room.id || !room.isHost) return;
  const stage = { mode: stageMode };
  if (stageMode === 'slides' && slides) Object.assign(stage, { name: slides.name, page: slides.page, count: slides.count });
  room.webinar.stage = stage;
  sb.from('webinars').update({ stage }).eq('id', room.id).then(({ error }) => { if (error) console.error(error); });
}

function canShareScreen() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
}

async function ensureCamera() {
  if (cameraStream || cameraPending || cameraError) return;
  cameraPending = true;
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    // L'encadreur a quitté la salle pendant la demande d'autorisation.
    if (!document.getElementById('stage-host')) stopMedia();
  } catch (e) {
    cameraError = true;
  }
  cameraPending = false;
  renderStage();
}

async function setStageMode(mode) {
  if (mode === 'screen') {
    if (!screenStream) {
      try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      } catch (e) {
        return; // partage annulé
      }
      // Bouton « Arrêter le partage » du navigateur.
      screenStream.getVideoTracks()[0].addEventListener('ended', () => {
        screenStream = null;
        if (stageMode === 'screen') setStageMode('camera');
      });
    }
  } else if (screenStream) {
    screenStream.getTracks().forEach(t => t.stop());
    screenStream = null;
  }
  stageMode = mode;
  publishStage();
  renderRoomView();
}

function loadPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = PDFJS_URL;
      script.onload = () => {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_URL.replace('pdf.min.js', 'pdf.worker.min.js');
        resolve(window.pdfjsLib);
      };
      script.onerror = () => {
        pdfjsPromise = null;
        reject(new Error('pdf.js indisponible'));
      };
      document.head.append(script);
    });
  }
  return pdfjsPromise;
}

// 📑 Présentation : un PDF, ou plusieurs images (une par diapositive).
async function loadSlides(files) {
  if (!files.length) return;
  let next;
  try {
    if (files[0].type === 'application/pdf') {
      const pdfjs = await loadPdfJs();
      const doc = await pdfjs.getDocument({ data: await files[0].arrayBuffer() }).promise;
      next = { name: files[0].name, kind: 'pdf', doc, page: 1, count: doc.numPages };
    } else {
      const images = files
        .filter(f => f.type.startsWith('image/'))
        .sort((a, b) => a.name.localeCompare(b.name, 'fr', { numeric: true }));
      if (!images.length) throw new Error('format non pris en charge');
      next = {
        name: images.length > 1 ? `${images.length} images` : images[0].name,
        kind: 'images',
        urls: images.map(f => URL.createObjectURL(f)),
        page: 1,
        count: images.length
      };
    }
  } catch (e) {
    toast("Impossible d'ouvrir ce fichier. Utilisez un PDF ou des images (PowerPoint : Fichier → Exporter → PDF).", 'error');
    return;
  }
  clearSlides();
  slides = next;
  stageMode = 'slides';
  if (screenStream) {
    screenStream.getTracks().forEach(t => t.stop());
    screenStream = null;
  }
  publishStage();
  renderRoomView();
}

async function pickSlidesFromLibrary() {
  const { data, error } = await sb.from('resources').select('*').eq('mime_type', 'application/pdf').order('created_at', { ascending: false });
  if (error) return fail(error);
  openModal(`
    <h2>Choisir un PDF de la bibliothèque</h2>
    ${data.length ? `<div class="list">${data.map(r => `
      <div class="list-item"><div class="ftype pdf">📕</div>
        <div class="grow"><strong>${esc(r.title)}</strong><div class="muted small">${esc(r.file_name)}</div></div>
        <button class="btn primary sm" data-pick="${r.id}">Présenter</button></div>`).join('')}</div>` :
      emptyState('📚', 'Aucun PDF dans la bibliothèque.')}
    <div class="actions"><button class="btn" data-close>Fermer</button></div>`);
  modal.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', async () => {
    const r = data.find(x => x.id === b.dataset.pick);
    b.disabled = true;
    const { data: blob, error: err } = await sb.storage.from('bibliotheque').download(r.file_path);
    if (err) { b.disabled = false; return fail(err); }
    closeModal();
    loadSlides([new File([blob], r.file_name, { type: 'application/pdf' })]);
  }));
}

function changeSlide(delta) {
  if (!slides) return;
  const page = Math.min(slides.count, Math.max(1, slides.page + delta));
  if (page === slides.page) return;
  slides.page = page;
  publishStage();
  const pos = document.getElementById('slide-pos');
  if (pos) pos.textContent = `${slides.page} / ${slides.count}`;
  if (stageMode === 'slides') renderStage();
}

function clearSlides() {
  if (!slides) return;
  if (slides.kind === 'images') slides.urls.forEach(u => URL.revokeObjectURL(u));
  if (slides.doc) slides.doc.destroy();
  slides = null;
}

function mediaElement(stream) {
  const video = document.createElement('video');
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  return video;
}

async function renderStage() {
  const host = document.getElementById('stage-host');
  if (!host) return;
  const token = ++stageToken;

  let main;
  if (stageMode === 'screen' && screenStream) {
    main = mediaElement(screenStream);
  } else if (stageMode === 'slides' && slides) {
    if (slides.kind === 'images') {
      main = document.createElement('img');
      main.src = slides.urls[slides.page - 1];
      main.alt = `Diapositive ${slides.page}`;
    } else {
      const page = await slides.doc.getPage(slides.page);
      if (token !== stageToken) return;
      const viewport = page.getViewport({ scale: 2 });
      main = document.createElement('canvas');
      main.width = viewport.width;
      main.height = viewport.height;
      await page.render({ canvasContext: main.getContext('2d'), viewport }).promise;
      if (token !== stageToken) return;
    }
  } else if (cameraStream) {
    main = mediaElement(cameraStream);
  } else {
    main = document.createElement('p');
    main.className = 'stage-msg';
    main.textContent = cameraError
      ? "Caméra indisponible : autorisez l'accès à la caméra et au micro."
      : 'Démarrage de la caméra…';
  }

  host.replaceChildren(main);
  // Petite vignette de la caméra pendant le partage d'écran ou la présentation.
  if (stageMode !== 'camera' && cameraStream && main.tagName !== 'P') {
    const pip = mediaElement(cameraStream);
    pip.className = 'pip';
    host.append(pip);
  }
}

function stopMedia() {
  [cameraStream, screenStream].forEach(s => s && s.getTracks().forEach(t => t.stop()));
  cameraStream = null;
  screenStream = null;
  cameraError = false;
  stageMode = 'camera';
  clearSlides();
}

// Flèches du clavier pour changer de diapositive.
document.addEventListener('keydown', e => {
  if (!slides || stageMode !== 'slides') return;
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (e.key === 'ArrowRight' || e.key === 'PageDown') changeSlide(1);
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') changeSlide(-1);
});

// =====================================================================
// Bibliothèque
// =====================================================================

const FILE_TYPES = {
  pdf: ['📕', 'PDF'],
  video: ['🎬', 'Vidéo'],
  presentation: ['📊', 'Présentation'],
  document: ['📝', 'Document'],
  image: ['🖼️', 'Image'],
  autre: ['📦', 'Autre']
};

function fileType(r) {
  const name = (r.file_name || '').toLowerCase();
  const mime = r.mime_type || '';
  if (mime === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (mime.startsWith('video/') || /\.(mp4|webm|mov|mkv|avi)$/.test(name)) return 'video';
  if (/\.(pptx?|odp|key)$/.test(name) || mime.includes('presentation') || mime.includes('powerpoint')) return 'presentation';
  if (/\.(docx?|odt|rtf|txt|xlsx?|ods|csv)$/.test(name) || mime.includes('word') || mime.includes('sheet')) return 'document';
  if (mime.startsWith('image/')) return 'image';
  return 'autre';
}

function resourceRow(r) {
  const t = fileType(r);
  return `<div class="list-item">
    <div class="ftype ${t}">${FILE_TYPES[t][0]}</div>
    <div class="grow"><strong>${esc(r.title)}</strong>
      <div class="muted small">${FILE_TYPES[t][1]} · ${esc(fmtSize(r.size_bytes))}</div></div>
    <button class="btn sm" data-open="${r.id}" data-path="${esc(r.file_path)}" data-name="${esc(r.file_name)}"
      data-type="${t}">${t === 'video' ? '▶ Regarder' : 'Ouvrir'}</button>
  </div>`;
}

function bindResourceButtons(container) {
  container.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () =>
    openResource({ file_path: b.dataset.path, file_name: b.dataset.name }, b.dataset.type)));
}

async function openResource(r, type) {
  // Fenêtre ouverte tout de suite pour ne pas être bloquée par le navigateur.
  const win = type === 'video' ? null : window.open('', '_blank');
  const { data, error } = await sb.storage.from('bibliotheque')
    .createSignedUrl(r.file_path, 3600, type === 'pdf' || type === 'image' ? undefined : { download: r.file_name });
  if (error) {
    if (win) win.close();
    return fail(error);
  }
  if (type === 'video') {
    openModal(`<h2>${esc(r.title || r.file_name)}</h2>
      <video controls autoplay src="${esc(data.signedUrl)}"></video>
      <div class="actions"><button class="btn" data-close>Fermer</button></div>`, { wide: true });
  } else if (win) {
    win.location = data.signedUrl;
  } else {
    location.href = data.signedUrl;
  }
}

async function viewLibrary(view, token) {
  const { data: resources, error } = await sb.from('resources')
    .select('*, owner:profiles!owner_id(full_name), webinar:webinars(id, title)')
    .order('created_at', { ascending: false });
  if (isStale(token)) return;
  if (error) return (view.innerHTML = `<div class="notice danger">${esc(translateError(error))}</div>`);

  let filter = 'tous';
  let search = '';

  view.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Bibliothèque</h1>
        <p class="muted">Ressources didactiques déposées par les encadreurs : PDF, vidéos, présentations, documents.</p>
      </div>
      ${isStaff() ? '<button class="btn primary" id="upload">＋ Déposer une ressource</button>' : ''}
    </div>
    <div class="toolbar">
      <div class="chips" id="filters">
        <button class="chip active" data-filter="tous">Tout</button>
        ${Object.entries(FILE_TYPES).map(([k, [ico, l]]) => `<button class="chip" data-filter="${k}">${ico} ${l}</button>`).join('')}
      </div>
      <input class="search" id="search" type="search" placeholder="Rechercher une ressource…">
    </div>
    <div id="results"></div>`;

  const draw = () => {
    const list = resources.filter(r =>
      (filter === 'tous' || fileType(r) === filter) &&
      (!search || `${r.title} ${r.description} ${r.file_name} ${r.owner?.full_name}`.toLowerCase().includes(search)));
    const results = document.getElementById('results');
    results.innerHTML = list.length ? `<div class="grid">${list.map(r => {
      const t = fileType(r);
      const mine = r.owner_id === profile.id || profile.role === 'admin';
      return `<article class="card rcard">
        <div class="row" style="flex-wrap:nowrap">
          <div class="ftype ${t}">${FILE_TYPES[t][0]}</div>
          <div style="min-width:0"><h3>${esc(r.title)}</h3>
            <div class="muted small">${FILE_TYPES[t][1]} · ${esc(fmtSize(r.size_bytes))} · ${esc(fmtShortDate(r.created_at))}</div></div>
        </div>
        ${r.description ? `<p class="muted small clamp">${esc(r.description)}</p>` : ''}
        <div class="muted small">🧑‍🏫 ${esc(r.owner?.full_name)}${r.webinar ? ` · 🎥 <a href="#/webinaires/${r.webinar.id}">${esc(r.webinar.title)}</a>` : ''}</div>
        <div class="row" style="margin-top:auto">
          <button class="btn primary sm" data-open="${r.id}" data-path="${esc(r.file_path)}" data-name="${esc(r.file_name)}"
            data-type="${t}">${t === 'video' ? '▶ Regarder' : t === 'pdf' || t === 'image' ? 'Ouvrir' : '⬇ Télécharger'}</button>
          ${mine ? `<button class="btn ghost sm" data-delete="${r.id}">Supprimer</button>` : ''}
        </div>
      </article>`;
    }).join('')}</div>` : `<div class="card">${emptyState('📚', resources.length ?
      'Aucune ressource ne correspond.' : 'La bibliothèque est vide pour le moment.')}</div>`;
    bindResourceButtons(results);
    results.querySelectorAll('[data-delete]').forEach(b => b.addEventListener('click', async () => {
      const r = resources.find(x => x.id === b.dataset.delete);
      if (!await confirmDialog(`Supprimer « ${r.title} » ?`, { confirmLabel: 'Supprimer', danger: true })) return;
      const { error: e1 } = await sb.storage.from('bibliotheque').remove([r.file_path]);
      if (e1) return fail(e1);
      const { error: e2 } = await sb.from('resources').delete().eq('id', r.id);
      if (e2) return fail(e2);
      resources.splice(resources.indexOf(r), 1);
      toast('Ressource supprimée.');
      draw();
    }));
  };
  draw();

  view.querySelector('#filters').addEventListener('click', e => {
    const b = e.target.closest('[data-filter]');
    if (!b) return;
    filter = b.dataset.filter;
    view.querySelectorAll('[data-filter]').forEach(x => x.classList.toggle('active', x === b));
    draw();
  });
  view.querySelector('#search').addEventListener('input', e => { search = e.target.value.trim().toLowerCase(); draw(); });
  const up = view.querySelector('#upload');
  if (up) up.addEventListener('click', () => uploadDialog(created => { resources.unshift(created); draw(); }));
}

async function uploadDialog(onDone) {
  let query = sb.from('webinars').select('id, title, starts_at').neq('status', 'annule').order('starts_at', { ascending: false });
  if (profile.role === 'encadreur') query = query.eq('encadreur_id', profile.id);
  const { data: webinars } = await query;

  openModal(`
    <h2>Déposer une ressource</h2>
    <form id="up-form" class="form">
      <div class="dropzone" id="drop">
        <div style="font-size:1.8rem">📤</div>
        <strong id="drop-label">Glissez un fichier ici ou cliquez pour choisir</strong>
        <div class="small">PDF, vidéo, PowerPoint, Word, Excel, images · 50 Mo maximum</div>
        <input type="file" name="file" hidden
          accept=".pdf,.ppt,.pptx,.odp,.doc,.docx,.odt,.xls,.xlsx,.ods,.csv,.txt,video/*,audio/*,image/*">
      </div>
      <label>Titre<input name="title" required maxlength="160"></label>
      <label>Description<textarea name="description" rows="2" maxlength="1000"></textarea></label>
      <label>Webinaire associé (facultatif)
        <select name="webinar_id"><option value="">— Aucun —</option>
          ${(webinars || []).map(w => `<option value="${w.id}">${esc(w.title)} (${esc(fmtShortDate(w.starts_at))})</option>`).join('')}
        </select></label>
      <div class="actions">
        <button class="btn" type="button" data-close>Annuler</button>
        <button class="btn primary" type="submit">Déposer</button>
      </div>
    </form>`);

  const form = modal.querySelector('#up-form');
  const drop = modal.querySelector('#drop');
  const input = form.file;
  let file = null;
  const pick = f => {
    if (!f) return;
    if (f.size > MAX_FILE_BYTES) return toast(`Fichier trop volumineux (${fmtSize(f.size)}). Maximum : 50 Mo.`, 'error');
    file = f;
    modal.querySelector('#drop-label').textContent = `${f.name} · ${fmtSize(f.size)}`;
    if (!form.title.value) form.title.value = f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
  };
  drop.addEventListener('click', () => input.click());
  input.addEventListener('change', () => pick(input.files[0]));
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); pick(e.dataTransfer.files[0]); });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (!file) return toast('Choisissez un fichier.', 'error');
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Envoi…';
    const path = `${profile.id}/${Date.now()}-${slug(file.name)}`;
    const { error: e1 } = await sb.storage.from('bibliotheque').upload(path, file, {
      contentType: file.type || 'application/octet-stream', upsert: false
    });
    if (e1) { btn.disabled = false; btn.textContent = 'Déposer'; return fail(e1); }
    const { data, error: e2 } = await sb.from('resources').insert({
      owner_id: profile.id,
      title: form.title.value.trim(),
      description: form.description.value.trim(),
      file_path: path,
      file_name: file.name,
      mime_type: file.type || '',
      size_bytes: file.size,
      webinar_id: form.webinar_id.value || null
    }).select('*, owner:profiles!owner_id(full_name), webinar:webinars(id, title)').single();
    if (e2) {
      await sb.storage.from('bibliotheque').remove([path]);
      btn.disabled = false;
      btn.textContent = 'Déposer';
      return fail(e2);
    }
    closeModal();
    toast('Ressource déposée ✓', 'success');
    onDone(data);
  });
}

// =====================================================================
// Administration : encadreurs et utilisateurs
// =====================================================================

async function viewAdmin(view, token) {
  const [{ data: users, error: e1 }, { data: invites, error: e2 }] = await Promise.all([
    sb.from('profiles').select('*').order('created_at', { ascending: false }),
    sb.from('invitations').select('*').order('created_at', { ascending: false })
  ]);
  if (isStale(token)) return;
  if (e1 || e2) return (view.innerHTML = `<div class="notice danger">${esc(translateError(e1 || e2))}</div>`);

  const known = new Set(users.map(u => u.email));
  const pending = invites.filter(i => !known.has(i.email));
  const waiting = users.filter(u => u.status === 'en_attente').length;
  let filter = waiting ? 'en_attente' : 'tous';
  let search = '';
  const filters = [
    ['en_attente', 'En attente', u => u.status === 'en_attente'],
    ['encadreur', 'Encadreurs', u => u.role === 'encadreur'],
    ['apprenant', 'Apprenants', u => u.role === 'apprenant'],
    ['admin', 'Administrateurs', u => u.role === 'admin'],
    ['suspendu', 'Suspendus', u => u.status === 'suspendu'],
    ['tous', 'Tous', () => true]
  ];

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Utilisateurs</h1><p class="muted">Créez les encadreurs et gérez les accès.</p></div>
    </div>
    <div class="two-cols">
      <div class="card">
        <h2>🧑‍🏫 Ajouter un encadreur</h2>
        <form id="invite" class="form">
          <label>Nom complet<input name="full_name" required maxlength="80"></label>
          <label>E-mail<input name="email" type="email" required></label>
          <button class="btn primary" type="submit">Donner l’accès encadreur</button>
        </form>
        <p class="hint" style="margin-top:12px">L’encadreur crée ensuite son compte sur la plateforme avec cet e-mail et choisit
          son mot de passe. S’il a déjà un compte, il devient encadreur immédiatement.</p>
      </div>
      <div class="card">
        <h2>⏳ Invitations en attente (${pending.length})</h2>
        ${pending.length ? `<div class="list">${pending.map(i => `
          <div class="list-item">
            <div class="avatar sm">${esc(initials(i.full_name || i.email))}</div>
            <div class="grow"><div>${esc(i.full_name || i.email)}</div>
              <div class="muted small">${esc(i.email)} · ${ROLE_LABELS[i.role]}</div></div>
            <button class="btn sm" data-share="${esc(i.email)}" data-name="${esc(i.full_name)}">Message</button>
            <button class="btn ghost sm" data-revoke="${esc(i.email)}">Retirer</button>
          </div>`).join('')}</div>` : emptyState('✅', 'Aucune invitation en attente.')}
      </div>
    </div>
    <div class="card">
      <div class="toolbar" style="margin-bottom:12px">
        <div class="chips" id="filters">${filters.map(([k, l, fn]) =>
          `<button class="chip ${k === filter ? 'active' : ''}" data-filter="${k}">${l} (${users.filter(fn).length})</button>`).join('')}</div>
        <input class="search" id="search" type="search" placeholder="Rechercher…">
      </div>
      <div id="users"></div>
    </div>`;

  const refreshCounts = () => view.querySelectorAll('#filters [data-filter]').forEach(b => {
    const [, l, fn] = filters.find(f => f[0] === b.dataset.filter);
    b.textContent = `${l} (${users.filter(fn).length})`;
  });

  const draw = () => {
    const match = filters.find(f => f[0] === filter)[2];
    const list = users.filter(u => match(u) &&
      (!search || `${u.full_name} ${u.email}`.toLowerCase().includes(search)));
    view.querySelector('#users').innerHTML = list.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Nom</th><th>Statut</th><th>Inscrit le</th><th>Dernière connexion</th><th>Rôle</th><th></th></tr></thead>
      <tbody>${list.map(u => `<tr>
        <td><button class="btn ghost" data-view="${u.id}" style="padding:0;text-align:left;color:inherit">
          <div class="row" style="flex-wrap:nowrap"><div class="avatar sm">${esc(initials(u.full_name || u.email))}</div>
          <div><div style="font-weight:600">${esc(u.full_name || '—')}</div><div class="muted small">${esc(u.email)}</div></div></div>
        </button></td>
        <td>${accountBadge(u.status)}</td>
        <td>${esc(fmtShortDate(u.created_at))}</td>
        <td>${fmtRelative(u.last_seen_at) === 'En ligne' ? '<span class="badge ok">● En ligne</span>' : esc(fmtRelative(u.last_seen_at))}</td>
        <td>${u.id === profile.id ? `<span class="badge">${ROLE_LABELS[u.role]} (vous)</span>` :
          `<select data-role="${u.id}" style="margin:0;max-width:160px">${Object.entries(ROLE_LABELS).map(([k, l]) =>
            `<option value="${k}" ${u.role === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`}</td>
        <td><div class="row" style="flex-wrap:nowrap;justify-content:flex-end">
          ${u.id === profile.id ? '' : statusButton(u)}
          <button class="btn sm" data-view="${u.id}">Voir</button>
        </div></td>
      </tr>`).join('')}</tbody></table></div>` : emptyState('👥', 'Aucun utilisateur dans cette catégorie.');

    view.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () =>
      showUserProfile(users.find(x => x.id === b.dataset.view), () => { refreshCounts(); draw(); })));
    view.querySelectorAll('[data-status]').forEach(b => b.addEventListener('click', async () => {
      const u = users.find(x => x.id === b.dataset.id);
      if (await setUserStatus(u, b.dataset.status)) { refreshCounts(); draw(); }
    }));
    view.querySelectorAll('[data-role]').forEach(s => s.addEventListener('change', async () => {
      const u = users.find(x => x.id === s.dataset.role);
      const ok = await confirmDialog(`Passer ${u.full_name || u.email} en « ${ROLE_LABELS[s.value]} » ?`);
      if (!ok) { s.value = u.role; return; }
      const { error } = await sb.rpc('set_user_role', { target: u.id, new_role: s.value });
      if (error) { s.value = u.role; return fail(error); }
      u.role = s.value;
      toast('Rôle mis à jour ✓', 'success');
      draw();
    }));
  };
  draw();

  view.querySelector('#filters').addEventListener('click', e => {
    const b = e.target.closest('[data-filter]');
    if (!b) return;
    filter = b.dataset.filter;
    view.querySelectorAll('#filters [data-filter]').forEach(x => x.classList.toggle('active', x === b));
    draw();
  });
  view.querySelector('#search').addEventListener('input', e => { search = e.target.value.trim().toLowerCase(); draw(); });

  view.querySelector('#invite').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    const email = f.email.value.trim().toLowerCase();
    const fullName = f.full_name.value.trim();
    const { error } = await sb.from('invitations').upsert({ email, role: 'encadreur', full_name: fullName });
    if (error) return fail(error);
    if (known.has(email)) {
      toast(`${fullName} est maintenant encadreur ✓`, 'success');
      return route();
    }
    shareInvite(email, fullName, () => route());
  });

  view.querySelectorAll('[data-share]').forEach(b => b.addEventListener('click', () =>
    shareInvite(b.dataset.share, b.dataset.name)));
  view.querySelectorAll('[data-revoke]').forEach(b => b.addEventListener('click', async () => {
    if (!await confirmDialog(`Retirer l’invitation de ${b.dataset.revoke} ?`, { confirmLabel: 'Retirer', danger: true })) return;
    const { error } = await sb.from('invitations').delete().eq('email', b.dataset.revoke);
    if (error) return fail(error);
    route();
  }));
}

function statusButton(u) {
  if (u.status === 'en_attente') return `<button class="btn primary sm" data-status="approuve" data-id="${u.id}">✓ Approuver</button>`;
  if (u.status === 'suspendu') return `<button class="btn sm" data-status="approuve" data-id="${u.id}">Réactiver</button>`;
  return `<button class="btn danger sm" data-status="suspendu" data-id="${u.id}">Suspendre</button>`;
}

async function setUserStatus(u, status) {
  const name = u.full_name || u.email;
  if (status === 'suspendu' && !await confirmDialog(`Suspendre le compte de ${name} ?`, {
    confirmLabel: 'Suspendre', danger: true
  })) return false;
  const { error } = await sb.rpc('set_user_status', { target: u.id, new_status: status });
  if (error) { fail(error); return false; }
  const message = status === 'suspendu' ? `Compte de ${name} suspendu.`
    : u.status === 'suspendu' ? `Compte de ${name} réactivé ✓` : `Inscription de ${name} approuvée ✓`;
  u.status = status;
  toast(message, 'success');
  return true;
}

// Fiche d'un utilisateur : informations, connexions à la plateforme, webinaires.
async function showUserProfile(u, onChange) {
  openModal(loading(), { wide: true });
  const [sess, regs, att, owned] = await Promise.all([
    sb.from('app_sessions').select('*').eq('user_id', u.id).order('started_at', { ascending: false }).limit(300),
    sb.from('registrations').select('registered_at, excluded, webinar:webinars(id, title, starts_at, status)').eq('apprenant_id', u.id),
    sb.from('attendance').select('webinar_id, joined_at, last_seen_at, left_at').eq('user_id', u.id),
    sb.from('webinars').select('id, title, starts_at, status').eq('encadreur_id', u.id).order('starts_at', { ascending: false })
  ]);
  const error = sess.error || regs.error || att.error || owned.error;
  if (error) { closeModal(); return fail(error); }
  if (!modal.open) return;

  const now = Date.now();
  const sessions = sess.data.map(s => {
    const online = !s.ended_at && now - new Date(s.last_seen_at).getTime() < 2 * SESSION_PING_MS;
    const end = s.ended_at || s.last_seen_at;
    return { ...s, online, end, duration: (online ? now : new Date(end).getTime()) - new Date(s.started_at).getTime() };
  });
  const total = sessions.reduce((n, s) => n + s.duration, 0);
  const presence = new Map();
  att.data.forEach(a => {
    const d = new Date(a.left_at || a.last_seen_at).getTime() - new Date(a.joined_at).getTime();
    presence.set(a.webinar_id, (presence.get(a.webinar_id) || 0) + Math.max(0, d));
  });
  const regRows = regs.data.filter(r => r.webinar).sort((a, b) => b.webinar.starts_at.localeCompare(a.webinar.starts_at));

  openModal(`
    <div class="row spread">
      <div class="row" style="flex-wrap:nowrap">
        <div class="avatar" style="width:56px;height:56px;font-size:1.1rem">${esc(initials(u.full_name || u.email))}</div>
        <div><h2 style="margin:0">${esc(u.full_name || '—')}</h2>
          <div class="muted">${esc(u.email)}</div>
          <div class="row" style="margin-top:6px">${accountBadge(u.status)}<span class="badge">${ROLE_LABELS[u.role]}</span></div></div>
      </div>
      <button class="btn ghost" data-close aria-label="Fermer">✕</button>
    </div>
    <div class="info-grid">
      <div><div class="k">Inscrit le</div><div class="v">${esc(fmtShortDate(u.created_at))} à ${esc(fmtTime(u.created_at))}</div></div>
      <div><div class="k">Dernière connexion</div><div class="v">${esc(fmtRelative(u.last_seen_at))}</div></div>
      <div><div class="k">Connexions</div><div class="v">${sessions.length}</div></div>
      <div><div class="k">Temps total connecté</div><div class="v">${esc(fmtDuration(total))}</div></div>
    </div>
    <div>
      <div class="tabs">
        <button class="active" data-ptab="sessions">🕒 Connexions (${sessions.length})</button>
        <button data-ptab="webinars">🎥 Webinaires (${u.role === 'apprenant' ? regRows.length : owned.data.length})</button>
      </div>
      <div id="ptab-sessions" class="table-wrap" style="max-height:320px;overflow-y:auto">
        ${sessions.length ? `<table>
          <thead><tr><th>Date</th><th>Connexion</th><th>Déconnexion</th><th>Durée</th></tr></thead>
          <tbody>${sessions.map(s => `<tr>
            <td>${esc(fmtShortDate(s.started_at))}</td>
            <td>${esc(fmtTime(s.started_at))}</td>
            <td>${s.online ? '<span class="badge ok">● En ligne</span>' : esc(fmtTime(s.end))}</td>
            <td>${esc(fmtDuration(s.duration))}</td>
          </tr>`).join('')}</tbody></table>` : emptyState('🕒', 'Aucune connexion enregistrée.')}
      </div>
      <div id="ptab-webinars" class="table-wrap" hidden style="max-height:320px;overflow-y:auto">
        ${u.role === 'apprenant' ? (regRows.length ? `<table>
          <thead><tr><th>Webinaire</th><th>Date</th><th>Inscription</th><th>Présence</th></tr></thead>
          <tbody>${regRows.map(r => `<tr>
            <td><a href="#/webinaires/${r.webinar.id}" data-close>${esc(r.webinar.title)}</a></td>
            <td>${esc(fmtShortDate(r.webinar.starts_at))}</td>
            <td>${r.excluded ? '<span class="badge cancel">Exclu</span>' : '<span class="badge ok">Inscrit</span>'}</td>
            <td>${presence.has(r.webinar.id) ? esc(fmtDuration(presence.get(r.webinar.id))) :
              r.webinar.status === 'termine' ? '<span class="badge cancel">Absent</span>' : '—'}</td>
          </tr>`).join('')}</tbody></table>` : emptyState('🎥', 'Aucune inscription.'))
        : (owned.data.length ? `<table>
          <thead><tr><th>Webinaire animé</th><th>Date</th><th>Statut</th></tr></thead>
          <tbody>${owned.data.map(w => `<tr>
            <td><a href="#/webinaires/${w.id}" data-close>${esc(w.title)}</a></td>
            <td>${esc(fmtShortDate(w.starts_at))}</td>
            <td>${esc(STATUS_LABELS[w.status])}</td>
          </tr>`).join('')}</tbody></table>` : emptyState('🎥', 'Aucun webinaire animé.'))}
      </div>
    </div>
    <div class="actions">
      ${sessions.length ? '<button class="btn" id="export-sessions">⬇️ Exporter les connexions</button>' : ''}
      ${u.id === profile.id ? '' : statusButton(u)}
    </div>`, { wide: true });

  modal.querySelectorAll('[data-ptab]').forEach(b => b.addEventListener('click', () => {
    modal.querySelectorAll('[data-ptab]').forEach(x => x.classList.toggle('active', x === b));
    modal.querySelector('#ptab-sessions').hidden = b.dataset.ptab !== 'sessions';
    modal.querySelector('#ptab-webinars').hidden = b.dataset.ptab !== 'webinars';
  }));
  const exp = modal.querySelector('#export-sessions');
  if (exp) exp.addEventListener('click', () => downloadCsv(`connexions-${slug(u.full_name || u.email)}.csv`, [
    ['Nom', 'E-mail', 'Date', 'Heure de connexion', 'Heure de déconnexion', 'Durée'],
    ...sessions.map(s => [u.full_name, u.email, fmtShortDate(s.started_at), fmtTime(s.started_at),
      s.online ? 'en ligne' : fmtTime(s.end), fmtDuration(s.duration)])
  ]));
  const statusBtn = modal.querySelector('[data-status]');
  if (statusBtn) statusBtn.addEventListener('click', async () => {
    if (!await setUserStatus(u, statusBtn.dataset.status)) return;
    if (onChange) onChange();
    showUserProfile(u, onChange);
  });
}

function shareInvite(email, name, onClose) {
  const text = `Bonjour ${name || ''},\n\nVous avez désormais un accès encadreur à la plateforme WEBINAIRE.\n` +
    `Créez votre compte ici : ${SITE_URL}#/inscription\nUtilisez impérativement l'adresse : ${email}\n\nÀ bientôt !`;
  openModal(`
    <h2>✅ Accès encadreur créé</h2>
    <p class="muted">Envoyez ce message à ${esc(name || email)} (e-mail, WhatsApp…) :</p>
    <textarea rows="8" readonly id="invite-text">${esc(text)}</textarea>
    <div class="actions">
      <a class="btn" href="mailto:${esc(email)}?subject=${encodeURIComponent('Votre accès à WEBINAIRE')}&body=${encodeURIComponent(text)}">✉️ Ouvrir l’e-mail</a>
      <button class="btn primary" id="copy-invite">📋 Copier</button>
    </div>`);
  modal.querySelector('#copy-invite').addEventListener('click', async () => {
    await navigator.clipboard.writeText(text);
    toast('Message copié ✓', 'success');
  });
  if (onClose) onModalClose = onClose;
}

// =====================================================================
// Profil
// =====================================================================

function viewProfile(view) {
  view.innerHTML = `
    <div class="page-head"><div><h1>Mon profil</h1><p class="muted">${esc(profile.email)} · ${ROLE_LABELS[profile.role]}</p></div></div>
    <div class="two-cols">
      <form class="card form" id="name-form">
        <h2>Informations</h2>
        <label>Nom complet<input name="full_name" required maxlength="80" value="${esc(profile.full_name)}"></label>
        <div class="actions"><button class="btn primary" type="submit">Enregistrer</button></div>
      </form>
      <form class="card form" id="pwd-form">
        <h2>Mot de passe</h2>
        <label>Nouveau mot de passe<input name="password" type="password" minlength="8" required autocomplete="new-password"></label>
        <label>Confirmer<input name="confirm" type="password" minlength="8" required autocomplete="new-password"></label>
        <div class="actions"><button class="btn primary" type="submit">Changer le mot de passe</button></div>
      </form>
    </div>`;

  view.querySelector('#name-form').addEventListener('submit', async e => {
    e.preventDefault();
    const full_name = e.target.full_name.value.trim();
    const { error } = await sb.from('profiles').update({ full_name }).eq('id', profile.id);
    if (error) return fail(error);
    profile.full_name = full_name;
    toast('Profil mis à jour ✓', 'success');
    route();
  });
  view.querySelector('#pwd-form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    if (f.password.value !== f.confirm.value) return toast('Les deux mots de passe ne correspondent pas.', 'error');
    const { error } = await sb.auth.updateUser({ password: f.password.value });
    if (error) return fail(error);
    f.reset();
    toast('Mot de passe modifié ✓', 'success');
  });
}

// =====================================================================
// Démarrage
// =====================================================================

window.addEventListener('hashchange', route);

if (configured) {
  sb.auth.onAuthStateChange((event, s) => {
    // Pas d'appel Supabase directement ici (recommandation de supabase-js).
    if (event === 'SIGNED_OUT') {
      clearInterval(appSession.timer);
      appSession = { id: null, timer: null, pending: false };
      session = null;
      profile = null;
      setTimeout(route, 0);
    } else if (event === 'SIGNED_IN' && !session) {
      session = s;
      setTimeout(route, 0);
    } else if (event === 'PASSWORD_RECOVERY') {
      session = s;
      location.hash = '#/profil';
      setTimeout(() => toast('Choisissez votre nouveau mot de passe.', 'success'), 300);
    } else if (s) {
      session = s;
    }
  });
  sb.auth.getSession().then(({ data }) => {
    session = data.session;
    route();
  });
} else {
  route();
}
