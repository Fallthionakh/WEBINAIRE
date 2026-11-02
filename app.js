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
const NEXT_KEY = 'webinaire.next';

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
  const msg = (error && (error.message || error.error_description || error.errorMsg || error.error?.msg)) ||
    (typeof error === 'string' ? error : 'Erreur inattendue.');
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
  // Visio en cours : naviguer ailleurs ne coupe pas l'appel, il passe en mini-fenêtre.
  // Seuls « Terminer le direct » (encadreur) ou « Quitter la salle » (apprenant) le ferment.
  if (room.id && session && callActive()) room.background = true;
  else await leaveRoom();
  destroyAgenda();
  closeModal();
  let hash = location.hash || '#/';
  if (/access_token|error=/.test(hash)) hash = '#/';

  if (!configured) return renderSetup();

  if (!session) {
    // Lien d'invitation (salle ou webinaire) : on y reviendra après la connexion.
    if (/^#\/(salle|webinaires)\/[\w-]+$/.test(hash)) {
      try { sessionStorage.setItem(NEXT_KEY, hash); } catch (e) { /* stockage indisponible */ }
    }
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

  let next = null;
  try {
    next = sessionStorage.getItem(NEXT_KEY);
    sessionStorage.removeItem(NEXT_KEY);
  } catch (e) { /* stockage indisponible */ }
  if (next && next !== location.hash) {
    location.hash = next;
    return;
  }

  startAppSession();
  // Mot de passe provisoire donné par l'administrateur : il faut en choisir un nouveau.
  if (session.user?.user_metadata?.must_change_password) return renderForcePassword();
  if (profile.status === 'en_attente') {
    // Compte pas encore validé : il peut quand même demander à entrer dans une salle par un lien.
    const room = hash.match(/^#\/salle\/([\w-]+)$/);
    if (room) {
      renderBareShell();
      return viewRoom(document.getElementById('view'), token, room[1]);
    }
  }
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
  if (hash === '#/mes-inscriptions' && profile.role === 'apprenant') return viewMyRegistrations(view, token);
  location.hash = '#/';
}

// Mise en page réduite (sans menu) pour un compte en attente arrivé par un lien de salle.
function renderBareShell() {
  app.innerHTML = `
    <div class="main">
      <header class="mobile-bar" style="display:flex">
        <a class="brand" href="#/"><span class="logo">🎥</span>WEBINAIRE</a>
        <span style="flex:1"></span>
        <button class="btn ghost sm" id="logout">Déconnexion</button>
      </header>
      <main id="view" class="view"></main>
    </div>`;
  document.getElementById('logout').addEventListener('click', logout);
}

function roomLink(id) {
  return `${SITE_URL}#/salle/${id}`;
}

async function copyRoomLink(id) {
  try {
    await navigator.clipboard.writeText(roomLink(id));
    toast('Lien de la salle copié ✓ Envoyez-le aux participants.', 'success');
  } catch (e) {
    openModal(`<h2>Lien de la salle</h2><input readonly value="${esc(roomLink(id))}" onclick="this.select()">
      <div class="actions"><button class="btn" data-close>Fermer</button></div>`);
  }
}

function renderShell(hash) {
  const links = [
    ['#/', '🏠', 'Tableau de bord'],
    ['#/webinaires', '🎥', 'Webinaires'],
    ['#/bibliotheque', '📚', 'Bibliothèque']
  ];
  if (profile.role === 'apprenant') links.splice(2, 0, ['#/mes-inscriptions', '📝', 'Mes inscriptions']);
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

function renderForcePassword() {
  app.innerHTML = `<div class="auth-panel" style="min-height:100vh"><div class="card auth-card stack">
    <div style="font-size:2.4rem;text-align:center">🔑</div>
    <h2 style="text-align:center">Choisissez votre nouveau mot de passe</h2>
    <p class="muted" style="text-align:center">Vous vous êtes connecté avec un mot de passe provisoire.
      Choisissez maintenant votre propre mot de passe (8 caractères minimum).</p>
    <form id="force-pwd" class="form">
      <label>Nouveau mot de passe<input name="password" type="password" minlength="8" required autocomplete="new-password"></label>
      <label>Confirmer<input name="confirm" type="password" minlength="8" required autocomplete="new-password"></label>
      <button class="btn primary block" type="submit">Enregistrer et continuer</button>
    </form>
    <button class="btn ghost" id="logout-now">Se déconnecter</button>
  </div></div>`;
  document.getElementById('logout-now').addEventListener('click', logout);
  const form = document.getElementById('force-pwd');
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (form.password.value !== form.confirm.value) return toast('Les deux mots de passe ne correspondent pas.', 'error');
    const btn = form.querySelector('button');
    btn.disabled = true;
    const { data, error } = await sb.auth.updateUser({
      password: form.password.value,
      data: { must_change_password: false }
    });
    btn.disabled = false;
    if (error) return fail(error);
    if (data?.user) session.user = data.user;
    toast('Mot de passe enregistré ✓', 'success');
    route();
  });
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
    forgot: ['Mot de passe oublié ?', 'Pas de panique : indiquez l’e-mail de votre compte, nous prévenons l’administrateur.']
  };
  const [title, subtitle] = titles[mode];
  let invited = false;
  try { invited = !!sessionStorage.getItem(NEXT_KEY); } catch (e) { /* stockage indisponible */ }

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
          ${invited ? `<div class="notice" style="margin-bottom:20px">🎥 Vous avez reçu un lien vers un webinaire.
            ${mode === 'signup' ? 'Créez votre compte' : 'Connectez-vous (ou créez un compte)'} : vous arriverez ensuite
            dans la salle d’attente, et l’organisateur vous admettra.</div>` : ''}
          <form id="auth-form" class="form">
            ${mode === 'signup' ? '<label>Nom complet<input name="full_name" required maxlength="80" autocomplete="name"></label>' : ''}
            <label>E-mail<input name="email" type="email" required autocomplete="email"></label>
            ${mode !== 'forgot' ? `<label>Mot de passe
              <div class="pwd-field"><input name="password" type="password" required minlength="6"
                autocomplete="${mode === 'signup' ? 'new-password' : 'current-password'}">
                <button type="button" class="btn ghost sm" id="toggle-pwd" aria-label="Afficher le mot de passe">👁</button></div>
              </label>` : ''}
            <button class="btn primary block" type="submit">${
              mode === 'login' ? 'Se connecter' : mode === 'signup' ? 'Créer mon compte' : 'Demander un nouveau mot de passe'}</button>
          </form>
          <div id="auth-help"></div>
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
  const help = document.getElementById('auth-help');
  const toggle = document.getElementById('toggle-pwd');
  if (toggle) toggle.addEventListener('click', () => {
    const input = form.password;
    input.type = input.type === 'password' ? 'text' : 'password';
    toggle.textContent = input.type === 'password' ? '👁' : '🙈';
  });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = form.querySelector('[type=submit]');
    const d = new FormData(form);
    const email = d.get('email').trim().toLowerCase();
    btn.disabled = true;
    try {
      if (mode === 'login') {
        const { error } = await sb.auth.signInWithPassword({ email, password: d.get('password') });
        if (error && /Invalid login credentials/i.test(error.message)) {
          // Même message que l'e-mail existe ou non (on ne révèle pas les comptes) : on aide à trouver la cause.
          help.innerHTML = `
            <div class="notice warn" style="margin-top:16px">
              <strong>E-mail ou mot de passe incorrect.</strong>
              <ul style="margin:8px 0 0;padding-left:18px">
                <li>Vérifiez l’e-mail et les majuscules du mot de passe (bouton 👁 pour l’afficher).</li>
                <li>Vous avez été invité comme encadreur ? Votre compte n’existe qu’après
                  <a href="#/inscription">la création de votre compte</a> avec cet e-mail.</li>
                <li>Mot de passe oublié ? <a href="#/mot-de-passe-oublie">Demandez-en un nouveau</a>.</li>
              </ul>
            </div>`;
          return;
        }
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
        // 1) l'administrateur est prévenu ; 2) un e-mail de réinitialisation est tenté
        // (l'envoi d'e-mails de Supabase est limité : il peut ne pas arriver).
        const { error } = await sb.rpc('request_password_help', { p_email: email });
        if (error) throw error;
        sb.auth.resetPasswordForEmail(email, { redirectTo: SITE_URL + '#/profil' }).catch(() => {});
        form.hidden = true;
        help.innerHTML = `
          <div class="notice" style="margin-top:8px">
            <strong>✓ Demande envoyée</strong>
            <p style="margin:8px 0">Si un compte existe avec <strong>${esc(email)}</strong> :</p>
            <ol style="margin:0;padding-left:18px">
              <li>l’administrateur a été prévenu et va vous transmettre un <strong>mot de passe provisoire</strong>
                (par WhatsApp, SMS ou e-mail) ;</li>
              <li>vous pourriez aussi recevoir un e-mail avec un lien (pensez aux spams) ;</li>
              <li>à votre prochaine connexion, vous choisirez un nouveau mot de passe.</li>
            </ol>
          </div>
          <a class="btn primary block" href="#/connexion" style="margin-top:16px">Retour à la connexion</a>`;
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
    let pendingMap = new Map();
    const regMap = new Map();

    if (profile.role === 'admin') {
      const head = { count: 'exact', head: true };
      const [enc, app_, waiting, web, live, res, pwd] = await Promise.all([
        count(sb.from('profiles').select('id', head).eq('role', 'encadreur')),
        count(sb.from('profiles').select('id', head).eq('role', 'apprenant')),
        count(sb.from('profiles').select('id', head).eq('status', 'en_attente')),
        count(sb.from('webinars').select('id', head).neq('status', 'annule')),
        count(sb.from('webinars').select('id', head).eq('status', 'en_direct')),
        count(sb.from('resources').select('id', head)),
        count(sb.from('password_requests').select('id', head).eq('status', 'en_attente')).catch(() => 0)
      ]);
      if (waiting) {
        alertHtml = `<a class="notice warn" href="#/utilisateurs" style="display:block;margin-bottom:12px">
          ⏳ ${waiting} inscription${waiting > 1 ? 's' : ''} en attente de validation → Voir</a>`;
      }
      if (pwd) {
        alertHtml += `<a class="notice warn" href="#/utilisateurs" style="display:block;margin-bottom:12px">
          🔑 ${pwd} demande${pwd > 1 ? 's' : ''} de mot de passe oublié → Voir</a>`;
      }
      if (alertHtml) alertHtml += '<div style="height:12px"></div>';
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
      const [res, pending] = await Promise.all([
        count(sb.from('resources').select('id', { count: 'exact', head: true }).eq('owner_id', profile.id)),
        pendingRegistrations()
      ]);
      pendingMap = pending;
      const next = data.filter(w => ['planifie', 'en_direct'].includes(w.status) && w.ends_at >= now);
      const inscrits = next.reduce((n, w) => n + (w.registrations[0]?.count || 0), 0);
      const waiting = [...pending.values()].reduce((a, b) => a + b, 0);
      if (waiting) {
        alertHtml = `<a class="notice warn" href="#/webinaires" style="display:block;margin-bottom:24px">
          ⏳ ${waiting} demande${waiting > 1 ? 's' : ''} d’inscription à valider → ouvrez le webinaire concerné</a>`;
      }
      stats = statCard('📅', 'Webinaires à venir', next.length) + statCard('🎓', 'Inscriptions à venir', inscrits) +
        statCard('⏳', 'Demandes à valider', waiting) +
        statCard('✅', 'Webinaires terminés', data.filter(w => w.status === 'termine').length) +
        statCard('📚', 'Ressources déposées', res);
      upcoming = next.slice(0, 6);
    } else {
      const [{ data: regs, error }, res] = await Promise.all([
        sb.from('registrations').select('status, webinar:webinars(' + WEBINAR_SELECT + ')').eq('apprenant_id', profile.id),
        count(sb.from('resources').select('id', { count: 'exact', head: true }))
      ]);
      if (error) throw error;
      regs.forEach(r => r.webinar && regMap.set(r.webinar.id, r));
      const mine = regs.filter(r => r.webinar && r.status !== 'suspendu').map(r => r.webinar);
      const next = mine.filter(w => ['planifie', 'en_direct'].includes(w.status) && w.ends_at >= now)
        .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
      const { data: attended } = await sb.from('attendance').select('webinar_id').eq('user_id', profile.id);
      const waiting = regs.filter(r => r.webinar && r.status === 'en_attente').length;
      if (waiting) {
        alertHtml = `<a class="notice warn" href="#/mes-inscriptions" style="display:block;margin-bottom:24px">
          ⏳ ${waiting} inscription${waiting > 1 ? 's' : ''} en attente de validation par l’encadreur → Mes inscriptions</a>`;
      }
      stats = statCard('📅', 'Mes webinaires à venir', next.length) +
        statCard('✅', 'Webinaires suivis', new Set((attended || []).map(a => a.webinar_id)).size) +
        statCard('📚', 'Ressources disponibles', res);
      upcoming = next.slice(0, 6);

      const registered = new Set(regs.filter(r => r.webinar).map(r => r.webinar.id));
      const { data: open } = await sb.from('webinars').select(WEBINAR_SELECT)
        .in('status', ['planifie', 'en_direct']).gte('ends_at', now).order('starts_at').limit(12);
      const discover = (open || []).filter(w => !registered.has(w.id)).slice(0, 3);
      if (discover.length) {
        extra = `<h2 style="margin-top:32px">À découvrir</h2><div class="grid">${discover.map(w =>
          webinarCard(w, { showActions: true })).join('')}</div>`;
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
      ${upcoming.length ? `<div class="grid">${upcoming.map(w => webinarCard(w, {
          reg: regMap.get(w.id), pending: pendingMap.get(w.id) || 0 })).join('')}</div>` :
        `<div class="card">${emptyState('🗓️', profile.role === 'apprenant' ?
          'Vous n’êtes inscrit à aucun webinaire à venir.' : 'Aucun webinaire à venir.')}</div>`}
      ${extra}`;
    bindRegisterButtons(view, regMap, () => route());
  } catch (err) {
    if (!isStale(token)) view.innerHTML = `<div class="notice danger">${esc(translateError(err))}</div>`;
  }
}

// =====================================================================
// Webinaires : liste, création, reprogrammation, détail
// =====================================================================

// Statut d'une inscription à un webinaire.
const REG_STATUS = { en_attente: ['⏳ En attente', 'warn'], approuve: ['✓ Inscrit', 'ok'], suspendu: ['Suspendu', 'cancel'] };

function regBadge(status) {
  const [label, cls] = REG_STATUS[status] || REG_STATUS.en_attente;
  return `<span class="badge ${cls}">${label}</span>`;
}

// Demandes d'inscription en attente par webinaire (limitées par la base aux webinaires gérés).
async function pendingRegistrations() {
  const { data } = await sb.from('registrations').select('webinar_id').eq('status', 'en_attente');
  const map = new Map();
  (data || []).forEach(r => map.set(r.webinar_id, (map.get(r.webinar_id) || 0) + 1));
  return map;
}

function webinarCard(w, { reg = null, pending = 0, showActions = false } = {}) {
  const inscrits = w.registrations ? (w.registrations[0]?.count || 0) : null;
  const open = ['planifie', 'en_direct'].includes(w.status);
  let action = `<a class="btn sm" href="#/webinaires/${w.id}">Détails</a>`;
  if (w.status === 'en_direct' && (canManage(w) || reg?.status !== 'suspendu')) {
    action = `<a class="btn live sm" href="#/salle/${w.id}">Rejoindre</a>`;
  } else if (showActions && profile.role === 'apprenant' && open && reg?.status !== 'suspendu') {
    action = reg
      ? `<button class="btn sm" data-unregister="${w.id}" title="Annuler mon inscription">Se désinscrire</button>`
      : `<button class="btn primary sm" data-register="${w.id}">S'inscrire</button>`;
  }
  return `
    <article class="card wcard">
      <div class="row spread"><div class="row">${statusBadge(w)}</div>
        ${reg ? regBadge(reg.status) : ''}</div>
      <div class="when">
        ${dateBox(w.starts_at)}
        <div>
          <h3><a href="#/webinaires/${w.id}">${esc(w.title)}</a></h3>
          <div class="muted small">${esc(fmtTime(w.starts_at))} – ${esc(fmtTime(w.ends_at))} · ${esc(fmtMinutes(w.duration_minutes))}</div>
        </div>
      </div>
      ${w.description ? `<p class="muted small clamp">${esc(w.description)}</p>` : ''}
      ${pending ? `<button class="notice warn" data-pending="${w.id}" style="border:0;font:inherit;text-align:left;cursor:pointer">
        ⏳ <strong>${pending} apprenant${pending > 1 ? 's' : ''}</strong> attend${pending > 1 ? 'ent' : ''} votre validation → Voir</button>` : ''}
      <div class="foot">
        <span class="muted small">🧑‍🏫 ${esc(w.encadreur?.full_name || '')}${inscrits !== null ? ` · 🎓 ${inscrits}` : ''}</span>
        ${action}
      </div>
    </article>`;
}

async function viewWebinars(view, token) {
  let query = sb.from('webinars').select(WEBINAR_SELECT + (isStaff() ? ', registrations(count)' : '')).order('starts_at');
  if (profile.role === 'encadreur') query = query.eq('encadreur_id', profile.id);
  const [{ data: webinars, error }, regs, pendingMap] = await Promise.all([
    query,
    profile.role === 'apprenant'
      ? sb.from('registrations').select('webinar_id, status').eq('apprenant_id', profile.id)
      : Promise.resolve({ data: [] }),
    isStaff() ? pendingRegistrations() : Promise.resolve(new Map())
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
    <div id="results"></div>
    <div id="agenda-card"></div>`;

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
          return webinarCard(w, { reg, pending: pendingMap.get(w.id) || 0, showActions: true });
        }).join('')}</div>`
      : `<div class="card">${emptyState('🔍', 'Aucun webinaire dans cette catégorie.')}</div>`;
  };
  draw();
  bindRegisterButtons(view.querySelector('#results'), regMap, draw);

  view.querySelector('#filters').addEventListener('click', e => {
    const b = e.target.closest('[data-filter]');
    if (!b) return;
    filter = b.dataset.filter;
    view.querySelectorAll('[data-filter]').forEach(x => x.classList.toggle('active', x === b));
    draw();
  });
  view.querySelector('#search').addEventListener('input', e => { search = e.target.value.trim().toLowerCase(); draw(); });

  // Agenda : l'encadreur voit ses webinaires, l'admin tous ; l'apprenant ne voit que
  // les webinaires auxquels son inscription est approuvée (pas d'agenda s'il n'en a aucun).
  const agendaItems = profile.role === 'apprenant'
    ? webinars.filter(w => regMap.get(w.id)?.status === 'approuve')
    : webinars;
  if (agendaItems.length || isStaff()) renderAgenda(view.querySelector('#agenda-card'), agendaItems, token);
}

// =====================================================================
// Agenda (FullCalendar) : jour, semaine, mois, liste ; glisser pour reprogrammer
// =====================================================================

const FULLCALENDAR_URL = 'https://cdn.jsdelivr.net/npm/fullcalendar@6.1.15/index.global.min.js';
const FULLCALENDAR_FR_URL = 'https://cdn.jsdelivr.net/npm/@fullcalendar/core@6.1.15/locales/fr.global.min.js';
let fullCalendarPromise = null;
let agendaCalendar = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Impossible de charger ${src}`));
    document.head.append(script);
  });
}

function loadFullCalendar() {
  if (!fullCalendarPromise) {
    fullCalendarPromise = loadScript(FULLCALENDAR_URL)
      .then(() => loadScript(FULLCALENDAR_FR_URL))
      .then(() => window.FullCalendar)
      .catch(err => { fullCalendarPromise = null; throw err; });
  }
  return fullCalendarPromise;
}

function destroyAgenda() {
  if (agendaCalendar) {
    agendaCalendar.destroy();
    agendaCalendar = null;
  }
}

const AGENDA_COLORS = { planifie: '#4f46e5', en_direct: '#e11d48', termine: '#6b7280', annule: '#9ca3af' };

function agendaEvent(w) {
  return {
    id: w.id,
    title: w.title,
    start: w.starts_at,
    end: w.ends_at,
    color: AGENDA_COLORS[w.status],
    classNames: w.status === 'annule' ? ['ev-cancelled'] : [],
    // Seul l'organisateur peut déplacer un webinaire encore planifié.
    editable: canManage(w) && w.status === 'planifie',
    durationEditable: false,
    extendedProps: { webinar: w }
  };
}

async function renderAgenda(box, items, token) {
  box.innerHTML = `
    <div class="card" style="margin-top:24px">
      <div class="row spread" style="margin-bottom:12px">
        <h2 style="margin:0">📅 Agenda</h2>
        ${isStaff() ? '<span class="muted small">Glissez un webinaire planifié pour le reprogrammer.</span>' : ''}
      </div>
      <div id="agenda">${loading('Chargement de l’agenda…')}</div>
    </div>`;
  let FC;
  try {
    FC = await loadFullCalendar();
  } catch (err) {
    if (!isStale(token)) box.querySelector('#agenda').innerHTML = `<div class="notice danger">${esc(err.message)}</div>`;
    return;
  }
  if (isStale(token)) return;
  const el = box.querySelector('#agenda');
  el.innerHTML = '';
  destroyAgenda();
  const narrow = window.matchMedia('(max-width: 700px)').matches;
  agendaCalendar = new FC.Calendar(el, {
    locale: 'fr',
    initialView: narrow ? 'listWeek' : 'dayGridMonth',
    headerToolbar: narrow
      ? { left: 'prev,next', center: 'title', right: 'today' }
      : { left: 'prev,next today', center: 'title', right: 'timeGridDay,timeGridWeek,dayGridMonth,listMonth' },
    footerToolbar: narrow ? { center: 'timeGridDay,listWeek,dayGridMonth' } : false,
    buttonText: { listMonth: 'Liste', listWeek: 'Semaine' },
    height: 'auto',
    nowIndicator: true,
    slotMinTime: '06:00:00',
    slotMaxTime: '23:00:00',
    allDaySlot: false,
    eventTimeFormat: { hour: '2-digit', minute: '2-digit' },
    noEventsText: 'Aucun webinaire sur cette période.',
    events: items.map(agendaEvent),
    // Ouvrir une date : la liste des webinaires de ce jour.
    dateClick: info => agendaCalendar.changeView('listDay', info.dateStr),
    navLinks: true,
    navLinkDayClick: date => agendaCalendar.changeView('listDay', date),
    eventClick: info => {
      info.jsEvent.preventDefault();
      agendaDetails(info.event.extendedProps.webinar);
    },
    eventDrop: info => agendaReschedule(info)
  });
  agendaCalendar.render();
}

// Détails d'un webinaire depuis l'agenda.
function agendaDetails(w) {
  const live = w.status === 'en_direct';
  openModal(`
    <div class="row spread"><div class="row">${statusBadge(w)}</div><button class="btn ghost" data-close aria-label="Fermer">✕</button></div>
    <h2 style="margin:0">${esc(w.title)}</h2>
    <div class="info-grid">
      <div><div class="k">Date</div><div class="v">${esc(fmtDate(w.starts_at))}</div></div>
      <div><div class="k">Horaire</div><div class="v">${esc(fmtTime(w.starts_at))} – ${esc(fmtTime(w.ends_at))}</div></div>
      <div><div class="k">Durée</div><div class="v">${esc(fmtMinutes(w.duration_minutes))}</div></div>
      <div><div class="k">Encadreur</div><div class="v">${esc(w.encadreur?.full_name || '')}</div></div>
    </div>
    ${w.description ? `<p class="muted" style="white-space:pre-line">${esc(w.description)}</p>` : ''}
    ${w.status === 'annule' && w.cancel_reason ? `<div class="notice danger">Annulé : ${esc(w.cancel_reason)}</div>` : ''}
    <div class="actions">
      ${canManage(w) && w.status === 'planifie' ? `<a class="btn" href="#/webinaires/${w.id}/reprogrammer" data-close>🗓️ Reprogrammer</a>` : ''}
      <a class="btn ${live ? '' : 'primary'}" href="#/webinaires/${w.id}" data-close>Voir le webinaire</a>
      ${live ? `<a class="btn live" href="#/salle/${w.id}" data-close>Rejoindre</a>` : ''}
    </div>`);
}

// Glisser-déposer : reprogrammer en gardant la même durée.
async function agendaReschedule(info) {
  const w = info.event.extendedProps.webinar;
  const start = info.event.start;
  if (start < new Date()) {
    info.revert();
    return toast('Impossible de reprogrammer dans le passé.', 'error');
  }
  const ok = await confirmDialog(`Reprogrammer « ${w.title} » au ${fmtDate(start.toISOString())} à ${fmtTime(start.toISOString())} ?`, {
    confirmLabel: 'Reprogrammer'
  });
  if (!ok) return info.revert();
  const { data, error } = await sb.from('webinars').update({ starts_at: start.toISOString() })
    .eq('id', w.id).select().single();
  if (error) {
    info.revert();
    return fail(error);
  }
  Object.assign(w, data);
  info.event.setExtendedProp('webinar', w);
  info.event.setEnd(data.ends_at);
  toast('Webinaire reprogrammé ✓ Les inscrits verront la nouvelle date.', 'success');
}

// Boutons des cartes : « S'inscrire », « Se désinscrire » et demandes à valider.
function bindRegisterButtons(container, regMap, redraw) {
  container.addEventListener('click', async e => {
    const pending = e.target.closest('[data-pending]');
    if (pending) return pendingDialog(pending.dataset.pending);
    const reg = e.target.closest('[data-register]');
    const unreg = e.target.closest('[data-unregister]');
    if (!reg && !unreg) return;
    const id = reg ? reg.dataset.register : unreg.dataset.unregister;
    const ok = reg ? await register(id) : await unregister(id);
    if (!ok) return;
    if (reg) regMap.set(id, { webinar_id: id, status: 'en_attente' });
    else regMap.delete(id);
    redraw();
  });
}

// Encadreur : valider les demandes d'inscription d'un webinaire sans quitter la liste.
async function pendingDialog(webinarId) {
  const { data, error } = await sb.from('registrations')
    .select('apprenant_id, registered_at, apprenant:profiles!apprenant_id(full_name, email)')
    .eq('webinar_id', webinarId).eq('status', 'en_attente').order('registered_at');
  if (error) return fail(error);
  let changed = false;
  openModal(`
    <h2>⏳ Demandes d’inscription à valider</h2>
    <div class="list" id="pending-list" style="max-height:380px;overflow-y:auto"></div>
    <div class="actions">
      <button class="btn" data-close>Fermer</button>
      <button class="btn primary" id="approve-all-dlg">✓ Tout approuver</button>
    </div>`);
  onModalClose = () => { if (changed) route(); };

  const draw = () => {
    modal.querySelector('#pending-list').innerHTML = data.length ? data.map(r => `
      <div class="list-item">
        <div class="avatar sm">${esc(initials(r.apprenant?.full_name))}</div>
        <div class="grow"><strong>${esc(r.apprenant?.full_name)}</strong>
          <div class="muted small">${esc(r.apprenant?.email)} · demande du ${esc(fmtShortDate(r.registered_at))} à ${esc(fmtTime(r.registered_at))}</div></div>
        <button class="btn primary sm" data-decide="approuve" data-user="${r.apprenant_id}">✓ Approuver</button>
        <button class="btn ghost sm" data-decide="suspendu" data-user="${r.apprenant_id}">Refuser</button>
      </div>`).join('') : emptyState('✅', 'Toutes les demandes ont été traitées.');
    modal.querySelector('#approve-all-dlg').hidden = !data.length;
    modal.querySelectorAll('[data-decide]').forEach(b => b.addEventListener('click', async () => {
      b.disabled = true;
      const { error: err } = await sb.from('registrations').update({ status: b.dataset.decide })
        .eq('webinar_id', webinarId).eq('apprenant_id', b.dataset.user);
      if (err) { b.disabled = false; return fail(err); }
      data.splice(data.findIndex(r => r.apprenant_id === b.dataset.user), 1);
      changed = true;
      toast(b.dataset.decide === 'approuve' ? 'Inscription approuvée ✓' : 'Demande refusée.', 'success');
      draw();
    }));
  };
  draw();
  modal.querySelector('#approve-all-dlg').addEventListener('click', async () => {
    const { error: err } = await sb.from('registrations').update({ status: 'approuve' })
      .eq('webinar_id', webinarId).eq('status', 'en_attente');
    if (err) return fail(err);
    toast(`${data.length} inscription${data.length > 1 ? 's' : ''} approuvée${data.length > 1 ? 's' : ''} ✓`, 'success');
    data.length = 0;
    changed = true;
    draw();
  });
}

// Apprenant : toutes ses inscriptions, leur statut, sa présence, et les webinaires ouverts.
async function viewMyRegistrations(view, token) {
  const now = new Date().toISOString();
  const [regsRes, openRes, attRes] = await Promise.all([
    sb.from('registrations').select('status, registered_at, status_changed_at, webinar:webinars(' + WEBINAR_SELECT + ')')
      .eq('apprenant_id', profile.id),
    sb.from('webinars').select(WEBINAR_SELECT).in('status', ['planifie', 'en_direct']).gte('ends_at', now).order('starts_at'),
    sb.from('attendance').select('webinar_id, joined_at, last_seen_at, left_at').eq('user_id', profile.id)
  ]);
  if (isStale(token)) return;
  const error = regsRes.error || openRes.error || attRes.error;
  if (error) return (view.innerHTML = `<div class="notice danger">${esc(translateError(error))}</div>`);

  const regs = regsRes.data.filter(r => r.webinar)
    .sort((a, b) => b.webinar.starts_at.localeCompare(a.webinar.starts_at));
  const regMap = new Map(regs.map(r => [r.webinar.id, r]));
  const presence = new Map();
  attRes.data.forEach(a => {
    const d = new Date(a.left_at || a.last_seen_at).getTime() - new Date(a.joined_at).getTime();
    presence.set(a.webinar_id, (presence.get(a.webinar_id) || 0) + Math.max(0, d));
  });
  const available = openRes.data.filter(w => !regMap.has(w.id));
  const filters = [
    ['toutes', 'Toutes', () => true],
    ['en_attente', 'En attente', r => r.status === 'en_attente'],
    ['approuve', 'Approuvées', r => r.status === 'approuve'],
    ['suspendu', 'Suspendues', r => r.status === 'suspendu']
  ];
  let filter = 'toutes';

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Mes inscriptions</h1>
        <p class="muted">Suivez vos demandes d’inscription et inscrivez-vous à d’autres webinaires.</p></div>
    </div>
    <div class="card">
      <div class="chips" id="filters" style="margin-bottom:12px">${filters.map(([k, l, fn]) =>
        `<button class="chip ${k === filter ? 'active' : ''}" data-filter="${k}">${l} (${regs.filter(fn).length})</button>`).join('')}</div>
      <div id="my-regs"></div>
    </div>
    <h2 style="margin-top:32px">S’inscrire à un webinaire</h2>
    <div id="available">${available.length
      ? `<div class="grid">${available.map(w => webinarCard(w, { showActions: true })).join('')}</div>`
      : `<div class="card">${emptyState('🎉', 'Vous êtes déjà inscrit à tous les webinaires à venir.')}</div>`}</div>`;

  const draw = () => {
    const match = filters.find(f => f[0] === filter)[2];
    const list = regs.filter(match);
    view.querySelector('#my-regs').innerHTML = list.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Webinaire</th><th>Date</th><th>Inscription</th><th>Ma présence</th><th></th></tr></thead>
      <tbody>${list.map(r => {
        const w = r.webinar;
        const open = ['planifie', 'en_direct'].includes(w.status) && w.ends_at >= now;
        let action = '';
        if (w.status === 'en_direct' && r.status === 'approuve') action = `<a class="btn live sm" href="#/salle/${w.id}">Rejoindre</a>`;
        else if (open && r.status !== 'suspendu') action = `<button class="btn ghost sm" data-unregister="${w.id}">Se désinscrire</button>`;
        return `<tr>
          <td><a href="#/webinaires/${w.id}"><strong>${esc(w.title)}</strong></a>
            <div class="muted small">🧑‍🏫 ${esc(w.encadreur?.full_name || '')} · ${statusBadge(w)}</div></td>
          <td>${esc(fmtShortDate(w.starts_at))}<div class="muted small">${esc(fmtTime(w.starts_at))} – ${esc(fmtTime(w.ends_at))}</div></td>
          <td>${regBadge(r.status)}<div class="muted small">demandée le ${esc(fmtShortDate(r.registered_at))}</div></td>
          <td>${presence.has(w.id) ? esc(fmtDuration(presence.get(w.id))) :
            w.status === 'termine' && r.status === 'approuve' ? '<span class="badge cancel">Absent</span>' : '—'}</td>
          <td style="text-align:right">${action}</td>
        </tr>`;
      }).join('')}</tbody></table></div>` : emptyState('📝', regs.length ? 'Aucune inscription dans cette catégorie.' :
        'Vous n’êtes inscrit à aucun webinaire. Choisissez-en un ci-dessous.');
  };
  draw();

  view.querySelector('#filters').addEventListener('click', e => {
    const b = e.target.closest('[data-filter]');
    if (!b) return;
    filter = b.dataset.filter;
    view.querySelectorAll('#filters [data-filter]').forEach(x => x.classList.toggle('active', x === b));
    draw();
  });
  // Toute inscription ou désinscription recharge la page pour mettre les deux listes à jour.
  bindRegisterButtons(view, regMap, () => route());
}

async function register(id) {
  const { error } = await sb.from('registrations').insert({ webinar_id: id, apprenant_id: profile.id });
  if (error) { fail(error); return false; }
  toast('Demande d’inscription envoyée. L’encadreur doit la valider.', 'success');
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
  const { data: links } = await sb.from('webinar_resources').select('resource:resources(*)')
    .eq('webinar_id', id).order('created_at');
  const resources = (links || []).map(l => l.resource).filter(Boolean);
  if (isStale(token)) return;

  const open = ['planifie', 'en_direct'].includes(w.status);
  let actions = '';
  if (manage) {
    if (w.status === 'planifie') {
      actions = `
        <a class="btn live" href="#/salle/${id}">🎬 Ouvrir la salle</a>
        <button class="btn" id="copy-link-w">🔗 Copier le lien</button>
        <a class="btn" href="#/webinaires/${id}/reprogrammer">🗓️ Reprogrammer</a>
        <button class="btn danger" id="cancel-w">Annuler le webinaire</button>`;
    } else if (w.status === 'en_direct') {
      actions = `<a class="btn live" href="#/salle/${id}">Rejoindre la salle</a>
        <button class="btn" id="copy-link-w">🔗 Copier le lien</button>`;
    } else if (w.status === 'termine') {
      actions = `<button class="btn live" id="reopen-w">🔓 Rouvrir le direct</button>
        <a class="btn" href="#/webinaires/${id}/reprogrammer">🗓️ Reprogrammer</a>`;
    } else if (w.status === 'annule') {
      actions = `<button class="btn primary" id="restore-w">↩ Rétablir le webinaire</button>
        <button class="btn danger" id="delete-w">Supprimer</button>`;
    }
  } else if (profile.role === 'apprenant') {
    if (reg?.status === 'suspendu') {
      actions = '<span class="badge cancel">Votre inscription est suspendue</span>';
    } else if (w.status === 'en_direct') {
      actions = `<a class="btn live" href="#/salle/${id}">Rejoindre le direct</a>`;
    } else if (open && reg) {
      actions = `${regBadge(reg.status)}<button class="btn sm" id="unreg">Se désinscrire</button>`;
    } else if (open) {
      actions = '<button class="btn primary" id="reg">S’inscrire</button>';
    }
  }
  const regNotice = reg?.status === 'en_attente' && open
    ? `<div class="notice warn" style="margin-bottom:16px">⏳ Votre demande d’inscription est en attente de validation par l’encadreur.
       Vous pourrez rejoindre le direct dès qu’elle sera approuvée.</div>` : '';

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
    ${regNotice}
    <div class="card">
      <div class="info-grid">
        <div><div class="k">Date</div><div class="v">${esc(fmtDate(w.starts_at))}</div></div>
        <div><div class="k">Horaire</div><div class="v">${esc(fmtTime(w.starts_at))} – ${esc(fmtTime(w.ends_at))}</div></div>
        <div><div class="k">Durée</div><div class="v">${esc(fmtMinutes(w.duration_minutes))}</div></div>
        <div><div class="k">Encadreur</div><div class="v">${esc(w.encadreur?.full_name)}</div></div>
      </div>
      ${w.description ? `<p style="margin-top:16px;white-space:pre-line">${esc(w.description)}</p>` : ''}
    </div>
    ${resources.length || manage ? `<div class="card">
      <div class="row spread" style="margin-bottom:8px">
        <h2 style="margin:0">📚 Ressources du webinaire (${resources.length})</h2>
        ${manage ? `<div class="row">
          <button class="btn sm" id="link-res">＋ Depuis la bibliothèque</button>
          <button class="btn primary sm" id="upload-res">⬆ Déposer un fichier</button></div>` : ''}
      </div>
      ${resources.length ? `<div class="list">${resources.map(r => resourceRow(r, manage)).join('')}</div>` :
        '<p class="muted">Aucune ressource associée. Ajoutez des supports de cours pour les apprenants.</p>'}
    </div>` : ''}
    ${manage ? '<div class="card" id="manage">' + loading() + '</div>' : ''}`;

  bindResourceButtons(view);
  view.querySelectorAll('[data-unlink]').forEach(b => b.addEventListener('click', async () => {
    const { error: err } = await sb.from('webinar_resources').delete().eq('webinar_id', id).eq('resource_id', b.dataset.unlink);
    if (err) return fail(err);
    toast('Ressource retirée du webinaire.');
    route();
  }));

  const on = (sel, fn) => { const el = view.querySelector(sel); if (el) el.addEventListener('click', fn); };
  on('#link-res', () => linkResourcesDialog(w, resources.map(r => r.id)));
  on('#upload-res', () => uploadDialog(() => route(), w.id));
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
  on('#reopen-w', () => reopenWebinar(w));
  on('#copy-link-w', () => copyRoomLink(id));
  on('#restore-w', async () => {
    const { error: err } = await sb.from('webinars').update({ status: 'planifie', cancel_reason: null }).eq('id', id);
    if (err) return fail(err);
    toast('Webinaire rétabli ✓ Pensez à vérifier sa date.', 'success');
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

// Rouvrir un webinaire terminé : le direct reprend, la présence continue de s'enregistrer.
async function reopenWebinar(w) {
  if (!await confirmDialog('Rouvrir le direct ? Les apprenants approuvés pourront revenir dans la salle.', {
    confirmLabel: 'Rouvrir le direct'
  })) return false;
  const { error } = await sb.from('webinars').update({ status: 'en_direct' }).eq('id', w.id);
  if (error) { fail(error); return false; }
  toast('Direct rouvert ✓', 'success');
  if (location.hash === `#/salle/${w.id}`) onWebinarUpdate({ status: 'en_direct' });
  else location.hash = `#/salle/${w.id}`;
  return true;
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
  const waiting = regs.filter(r => r.status === 'en_attente');
  // Les demandes en attente d'abord, puis les approuvées, puis les suspendues.
  const order = { en_attente: 0, approuve: 1, suspendu: 2 };
  regs.sort((a, b) => order[a.status] - order[b.status]);

  box.innerHTML = `
    <div class="tabs">
      <button data-tab="inscrits" class="${tab === 'inscrits' ? 'active' : ''}">🎓 Inscriptions (${regs.length})${
        waiting.length ? ` · ⏳ ${waiting.length}` : ''}</button>
      <button data-tab="presences" class="${tab === 'presences' ? 'active' : ''}">✅ Liste de présence (${present})</button>
    </div>
    <div id="tab-body"></div>`;

  const body = box.querySelector('#tab-body');
  if (tab === 'inscrits') {
    body.innerHTML = regs.length ? `
      ${waiting.length ? `<div class="notice warn row spread" style="margin-bottom:12px">
        <span>⏳ ${waiting.length} demande${waiting.length > 1 ? 's' : ''} d’inscription à valider</span>
        <button class="btn primary sm" id="approve-all">✓ Tout approuver</button></div>` : ''}
      <div class="table-wrap"><table>
        <thead><tr><th>Apprenant</th><th>Demande le</th><th>Statut</th><th></th></tr></thead>
        <tbody>${regs.map(r => `<tr>
          <td><div class="row" style="flex-wrap:nowrap"><div class="avatar sm">${esc(initials(r.apprenant?.full_name))}</div>
            <div><div>${esc(r.apprenant?.full_name)}</div><div class="muted small">${esc(r.apprenant?.email)}</div></div></div></td>
          <td>${esc(fmtShortDate(r.registered_at))} à ${esc(fmtTime(r.registered_at))}</td>
          <td>${regBadge(r.status)}</td>
          <td><div class="row" style="justify-content:flex-end">${regActions(r)}</div></td>
        </tr>`).join('')}</tbody>
      </table></div>` : emptyState('🎓', 'Aucune demande d’inscription pour le moment.');
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
  box.querySelectorAll('[data-reg-status]').forEach(b => b.addEventListener('click', async () => {
    const ok = await setRegistrationStatus(w.id, b.dataset.user, b.dataset.regStatus);
    if (ok) renderManagement(box, w, token, tab);
  }));
  const all = box.querySelector('#approve-all');
  if (all) all.addEventListener('click', async () => {
    all.disabled = true;
    const { error } = await sb.from('registrations').update({ status: 'approuve' })
      .eq('webinar_id', w.id).eq('status', 'en_attente');
    if (error) { all.disabled = false; return fail(error); }
    toast(`${waiting.length} inscription${waiting.length > 1 ? 's' : ''} approuvée${waiting.length > 1 ? 's' : ''} ✓`, 'success');
    renderManagement(box, w, token, tab);
  });
  const exp = box.querySelector('#export');
  if (exp) exp.addEventListener('click', () => exportPresence(w, report));
}

function presenceReport(w, regs, sessions) {
  const now = Date.now();
  const people = new Map();
  // Seuls les apprenants approuvés (ou venus au direct) figurent dans la liste de présence.
  regs.filter(r => r.status !== 'en_attente').forEach(r => people.set(r.apprenant_id, {
    name: r.apprenant?.full_name || '', email: r.apprenant?.email || '', excluded: r.status === 'suspendu',
    sessions: [], total: 0
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

function regActions(r) {
  const btn = (status, label, cls) =>
    `<button class="btn ${cls} sm" data-reg-status="${status}" data-user="${r.apprenant_id}">${label}</button>`;
  if (r.status === 'en_attente') return btn('approuve', '✓ Approuver', 'primary') + btn('suspendu', 'Refuser', 'ghost');
  if (r.status === 'suspendu') return btn('approuve', 'Réactiver', '');
  return btn('suspendu', 'Suspendre', 'danger');
}

// Approuver, suspendre (exclure) ou réactiver l'inscription d'un apprenant.
async function setRegistrationStatus(webinarId, userId, status) {
  if (status === 'suspendu' && !await confirmDialog('Suspendre l’inscription de cet apprenant ?', {
    confirmLabel: 'Suspendre', danger: true
  })) return false;
  const { data, error } = await sb.from('registrations').update({ status })
    .eq('webinar_id', webinarId).eq('apprenant_id', userId).select('status');
  if (error) { fail(error); return false; }
  if (!data.length) { toast("Vous n'avez pas le droit de modifier cette inscription.", 'error'); return false; }
  toast(status === 'approuve' ? 'Inscription approuvée ✓' : 'Inscription suspendue.', 'success');
  return true;
}

// =====================================================================
// Salle en direct
// =====================================================================

function emptyRoom() {
  return {
    id: null, webinar: null, isHost: false, channel: null, sessionId: null, heartbeat: null,
    tab: 'chat', messages: [], polls: [], votes: [], presence: {},
    joinedAt: null, hand: false, handAt: null, handsSeen: new Set(),
    lobby: 'admis', lobbyList: [], lobbySeen: new Set(), lobbyError: '', wide: false,
    departed: new Map(), // personnes vues dans la salle puis parties : user_id → { ...présence, left_at }
    video: null, call: null, videoError: '',
    background: false, // visio en cours pendant la navigation sur d'autres pages
    sharing: false,    // partage d'écran local en cours
    myShare: null,     // document que je montre à la salle : { url, kind, name, page, count, at, path }
    shareBusy: false,  // envoi du document en cours
    sharesSeen: new Set(),
    projectionHidden: null // projection masquée par moi (valeur « at » de la projection)
  };
}

// =====================================================================
// Visio Daily : caméra, micro et partage d'écran pour tous les participants
// =====================================================================

const DAILY_JS_URL = 'https://unpkg.com/@daily-co/daily-js@0.93.0/dist/daily.js';
let dailyPromise = null;

function loadDaily() {
  if (!dailyPromise) {
    dailyPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = DAILY_JS_URL;
      script.crossOrigin = 'anonymous';
      script.onload = () => resolve(window.Daily);
      script.onerror = () => { dailyPromise = null; reject(new Error('Daily indisponible')); };
      document.head.append(script);
    });
  }
  return dailyPromise;
}

// Demande un jeton à la fonction serveur « daily-token », puis rejoint la visio.
// Si la visio n'est pas configurée, la salle revient au mode local (caméra de l'encadreur).
async function startVideo() {
  if (room.call || room.video === 'pending' || room.webinar?.status !== 'en_direct') return;
  if (!room.isHost && room.lobby !== 'admis') return;
  const id = room.id;
  room.video = 'pending';
  let auth;
  try {
    const { data, error } = await sb.functions.invoke('daily-token', { body: { webinar_id: id } });
    if (error) {
      let detail = error.message;
      try { detail = (await error.context.json()).error || detail; } catch (e) { /* réponse non JSON */ }
      throw new Error(detail);
    }
    auth = data;
    await loadDaily();
  } catch (err) {
    if (room.id !== id) return;
    console.warn('Visio indisponible :', err);
    room.video = 'off';
    room.videoError = err.message || String(err);
    renderRoomView();
    return;
  }
  // Daily n'accepte qu'une visio à la fois : on attend la fermeture complète de la
  // précédente (sinon un retour dans la salle restait bloqué sur « Connexion… »).
  if (dailyClosing) await dailyClosing;
  const leftover = window.Daily.getCallInstance && window.Daily.getCallInstance();
  if (leftover) {
    try { await leftover.destroy(); } catch (e) { /* déjà détruite */ }
  }
  const box = document.getElementById('video-stage');
  if (room.id !== id || (!box && !room.background)) { room.video = null; return; }
  if (box) box.innerHTML = '';
  // L'iframe Daily vit dans le dock, hors de la page : elle n'est jamais déplacée
  // (déplacer une iframe la recharge), seule sa position change.
  const frame = dockFrame();
  frame.innerHTML = '';
  try {
    room.call = window.Daily.createFrame(frame, {
      iframeStyle: { width: '100%', height: '100%', border: '0' },
      showLeaveButton: false,
      showFullscreenButton: true,
      lang: 'fr'
    });
  } catch (err) {
    room.video = null;
    return videoFailed(id, err?.message);
  }
  room.video = 'on';
  updateDock();
  room.call.on('error', e => videoFailed(id, e?.errorMsg || e?.error?.type));
  room.call.on('local-screen-share-started', () => { room.sharing = true; renderHandBar(); });
  room.call.on('local-screen-share-stopped', () => { room.sharing = false; renderHandBar(); });
  room.call.on('local-screen-share-canceled', () => { room.sharing = false; renderHandBar(); });
  try {
    await room.call.join({ url: auth.url, token: auth.token });
  } catch (err) {
    videoFailed(id, err?.errorMsg || err?.error?.type || err?.message);
    return;
  }
  renderHandBar();
}

// Erreur Daily (compte, réseau…) : on ferme la visio et on revient au mode local,
// sans laisser l'écran d'erreur de Daily (dont le lien mène à son espace d'administration).
function videoFailed(id, code) {
  if (room.id !== id || room.video === 'off') return;
  console.warn('Erreur Daily :', code);
  if (room.background) toast('La visio a été interrompue. Revenez dans la salle pour la relancer.', 'error');
  stopVideo();
  room.video = 'off';
  room.videoError = /payment/i.test(code || '')
    ? 'le compte Daily doit avoir un moyen de paiement enregistré : Daily → Billing'
    : (code || 'erreur inconnue');
  renderRoomView();
}

// Fermeture en cours de la visio précédente (la destruction Daily est asynchrone).
let dailyClosing = null;

function stopVideo() {
  if (room.call) {
    const call = room.call;
    dailyClosing = Promise.resolve()
      .then(() => call.destroy())
      .catch(() => { /* déjà détruite */ })
      .finally(() => { dailyClosing = null; });
  }
  room.call = null;
  room.sharing = false;
  if (room.video !== 'off') room.video = null;
  updateDock();
}

function callActive() {
  return !!room.call && room.video === 'on';
}

// =====================================================================
// Visio persistante : le « dock » contient l'iframe Daily.
// Dans la salle, il se superpose exactement à la scène ; sur les autres pages,
// il devient une mini-fenêtre et l'appel continue.
// =====================================================================

let dock = null;
let dockRaf = 0;
let dockRect = '';

function ensureDock() {
  if (dock) return dock;
  dock = document.createElement('div');
  dock.id = 'call-dock';
  dock.className = 'call-dock';
  dock.hidden = true;
  dock.innerHTML = `
    <div class="call-dock-bar">
      <span class="live-dot" aria-hidden="true"></span>
      <div class="grow"><strong class="call-dock-title"></strong><div class="small call-dock-info"></div></div>
    </div>
    <div class="call-dock-frame"></div>
    <div class="call-dock-actions">
      <button class="btn sm primary" data-dock="back">↩ Revenir à la salle</button>
      <button class="btn sm danger" data-dock="end"></button>
    </div>`;
  dock.addEventListener('click', e => {
    const b = e.target.closest('[data-dock]');
    if (!b) return;
    if (b.dataset.dock === 'back') location.hash = `#/salle/${room.id}`;
    else if (room.isHost) endLive(room.webinar);
    else quitRoom();
  });
  document.body.append(dock);
  return dock;
}

function dockFrame() {
  return ensureDock().querySelector('.call-dock-frame');
}

// Place le dock : sur la scène si la salle est affichée, sinon en mini-fenêtre.
function updateDock() {
  if (!dock) return;
  const active = callActive();
  dock.hidden = !active;
  if (!active) { renderProjection(); return stopDockSync(); }
  const placeholder = !room.background && document.getElementById('video-stage');
  dock.classList.toggle('mini', !placeholder);
  renderProjection();
  if (placeholder) return startDockSync();
  stopDockSync();
  dock.removeAttribute('style');
  const w = room.webinar;
  dock.querySelector('.call-dock-title').textContent = w?.title || 'Visio en cours';
  const waiting = room.isHost ? room.lobbyList.length : 0;
  const proj = currentProjection();
  dock.querySelector('.call-dock-info').textContent = waiting
    ? `🔔 ${waiting} personne${waiting > 1 ? 's' : ''} en salle d’attente`
    : proj ? `📱 ${proj.user_id === profile.id ? 'Vous montrez' : `${proj.name} montre`} un document`
    : `En direct · 👥 ${onlineList().length} en ligne`;
  dock.querySelector('[data-dock="end"]').textContent = room.isHost ? 'Terminer le direct' : 'Quitter';
}

// Suit la position de la scène (défilement, « Agrandir », bandeaux qui apparaissent…).
function syncDock() {
  const ph = document.getElementById('video-stage');
  if (!ph || room.background || !dock || dock.hidden) {
    dockRaf = 0;
    updateDock();
    return;
  }
  const r = ph.getBoundingClientRect();
  const key = `${r.left + scrollX},${r.top + scrollY},${r.width},${r.height}`;
  if (key !== dockRect) {
    dockRect = key;
    Object.assign(dock.style, {
      left: `${r.left + scrollX}px`, top: `${r.top + scrollY}px`,
      width: `${r.width}px`, height: `${r.height}px`
    });
  }
  dockRaf = requestAnimationFrame(syncDock);
}

function startDockSync() {
  if (!dockRaf) { dockRect = ''; dockRaf = requestAnimationFrame(syncDock); }
}

function stopDockSync() {
  cancelAnimationFrame(dockRaf);
  dockRaf = 0;
  dockRect = '';
}

// Encadreur : fin du direct pour tout le monde (seule façon pour lui de quitter la visio).
async function endLive(w) {
  if (!w) return;
  if (!await confirmDialog('Terminer le direct pour tout le monde ?', { confirmLabel: 'Terminer', danger: true })) return;
  const { error } = await sb.from('webinars').update({ status: 'termine', stage: null }).eq('id', w.id);
  if (error) return fail(error);
  await leaveRoom();
  toast('Direct terminé. La liste de présence est prête.', 'success');
  location.hash = `#/webinaires/${w.id}`;
}

// Apprenant : quitter volontairement la salle (il pourra y revenir).
async function quitRoom() {
  const w = room.webinar;
  if (!w) return;
  if (callActive() && !await confirmDialog('Quitter la salle ? Vous pourrez y revenir tant que le direct continue.',
    { confirmLabel: 'Quitter' })) return;
  await leaveRoom();
  location.hash = `#/webinaires/${w.id}`;
}

// Partage d'écran (bouton dans la page, en plus de celui de la visio).
function toggleScreenShare() {
  if (!room.call) return;
  if (room.sharing) return room.call.stopScreenShare();
  const support = window.Daily?.supportedBrowser ? window.Daily.supportedBrowser() : null;
  if (support && support.supportsScreenShare === false) {
    return toast('Le partage d’écran n’est pas possible depuis un téléphone ou une tablette. Utilisez « 📱 Montrer une capture ou un document ».', 'error');
  }
  room.call.startScreenShare();
}

// =====================================================================
// Projection depuis le téléphone : capture d'écran, photo ou PDF montré en grand
// à toute la salle (les navigateurs mobiles ne permettent pas le partage d'écran).
// Le document est déposé dans le dossier privé « salle » et annoncé par la
// présence temps réel : les retardataires le voient aussi, et il disparaît
// automatiquement quand son auteur quitte la salle.
// =====================================================================

const SHARE_MAX_BYTES = 20 * 1024 * 1024;
let projDoc = null; // PDF projeté déjà chargé : { url, doc }

function screenShareSupported() {
  const support = window.Daily?.supportedBrowser ? window.Daily.supportedBrowser() : null;
  if (support) return support.supportsScreenShare !== false;
  return !!navigator.mediaDevices?.getDisplayMedia && !/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

function pickShareFile() {
  const input = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*,application/pdf' });
  input.addEventListener('change', () => { if (input.files[0]) startMyShare(input.files[0]); });
  input.click();
}

// Photos de téléphone (souvent 4 à 8 Mo) : réduites à 1920 px pour un envoi rapide.
async function shrinkImage(file) {
  if (file.size < 1.5e6 || file.type === 'image/gif') return file;
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, 1920 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    return blob && blob.size < file.size ? blob : file;
  } catch (e) {
    return file;
  }
}

async function startMyShare(file) {
  const id = room.id;
  const isPdf = file.type === 'application/pdf';
  if (!isPdf && !/^image\/(jpeg|png|webp|gif)$/.test(file.type)) {
    return toast('Choisissez une capture d’écran, une photo (JPG, PNG) ou un PDF.', 'error');
  }
  room.shareBusy = true;
  renderHandBar();
  try {
    const blob = isPdf ? file : await shrinkImage(file);
    if (blob.size > SHARE_MAX_BYTES) throw new Error('Fichier trop lourd : 20 Mo maximum.');
    const type = blob.type || file.type;
    const ext = isPdf ? 'pdf' : type.split('/')[1].replace('jpeg', 'jpg');
    const path = `${id}/${profile.id}/${Date.now()}.${ext}`;
    const { error } = await sb.storage.from('salle').upload(path, blob, { contentType: type });
    if (error) throw error;
    const { data, error: err } = await sb.storage.from('salle').createSignedUrl(path, 6 * 3600);
    if (err) throw err;
    if (room.id !== id) return sb.storage.from('salle').remove([path]);
    const previous = room.myShare;
    room.myShare = {
      url: data.signedUrl, kind: isPdf ? 'pdf' : 'image', name: file.name || 'Capture',
      page: 1, count: 1, at: new Date().toISOString(), path
    };
    room.projectionHidden = null;
    trackMe();
    renderProjection();
    if (previous?.path) sb.storage.from('salle').remove([previous.path]);
    toast('Votre document est affiché pour toute la salle.', 'success');
  } catch (e) {
    fail(e);
  } finally {
    room.shareBusy = false;
    renderHandBar();
  }
}

function stopMyShare(message) {
  const share = room.myShare;
  if (!share) return;
  room.myShare = null;
  trackMe();
  renderProjection();
  renderHandBar();
  if (share.path) sb.storage.from('salle').remove([share.path]);
  if (message) toast(message);
}

// Projection affichée : la plus récente parmi les personnes présentes.
function currentProjection() {
  if (!room.id) return null;
  const list = onlineList()
    .map(p => (p.user_id === profile.id ? { ...p, share: room.myShare } : p))
    .filter(p => p.share && p.share.url);
  if (room.myShare && !list.some(p => p.user_id === profile.id)) {
    list.push({ user_id: profile.id, name: profile.full_name, share: room.myShare });
  }
  list.sort((a, b) => (b.share.at || '').localeCompare(a.share.at || ''));
  return list[0] || null;
}

// La projection recouvre la visio (dans le dock) ou, sans visio, la scène de la page.
function projectionHolder() {
  if (room.background) return null;
  if (callActive()) return dock && !dock.hidden && !dock.classList.contains('mini') ? dock : null;
  return document.querySelector('#view .stage');
}

function renderProjection() {
  const p = currentProjection();
  let layer = document.getElementById('projection');
  const holder = projectionHolder();
  renderProjectionChip(p);
  if (!p || !holder || room.projectionHidden === p.share.at) {
    if (layer) layer.remove();
    return;
  }
  if (!layer || layer.parentElement !== holder) {
    if (layer) layer.remove();
    layer = document.createElement('div');
    layer.id = 'projection';
    layer.className = 'projection';
    holder.append(layer);
  }
  const s = p.share;
  const mine = p.user_id === profile.id;
  const key = `${s.url}|${s.page}|${s.count}|${room.isHost}`;
  if (layer.dataset.key === key) return;
  layer.dataset.key = key;
  const pages = s.kind === 'pdf' && s.count > 1
    ? (mine
      ? `<button class="btn sm" data-proj="prev" aria-label="Page précédente">◀</button><span class="small">${s.page} / ${s.count}</span>
         <button class="btn sm" data-proj="next" aria-label="Page suivante">▶</button>`
      : `<span class="small">${s.page} / ${s.count}</span>`)
    : '';
  layer.innerHTML = `
    <div class="projection-bar">
      <span class="grow">📱 <strong>${mine ? 'Vous montrez' : `${esc(p.name)} montre`}</strong> · ${esc(s.name)}</span>
      ${pages}
      <button class="btn sm" data-proj="hide">${callActive() ? '🎥 Voir la visio' : 'Masquer'}</button>
      ${mine || room.isHost ? `<button class="btn sm danger" data-proj="stop">${mine ? 'Arrêter' : 'Fermer'}</button>` : ''}
    </div>
    <div class="projection-body">${s.kind === 'image' ? `<img src="${esc(s.url)}" alt="${esc(s.name)}">` : '<canvas></canvas>'}</div>`;
  layer.querySelectorAll('[data-proj]').forEach(b => b.addEventListener('click', () => projectionAction(b.dataset.proj, p)));
  if (s.kind === 'pdf') renderProjectionPdf(layer, s, mine);
}

function renderProjectionChip(p) {
  const chip = document.getElementById('projection-chip');
  if (!chip) return;
  chip.innerHTML = p && room.projectionHidden === p.share.at
    ? `<div class="stage-tools"><button class="btn" id="proj-show">📱 ${p.user_id === profile.id ? 'Afficher mon document' : `Afficher le document de ${esc(p.name)}`}</button></div>`
    : '';
  const show = chip.querySelector('#proj-show');
  if (show) show.addEventListener('click', () => { room.projectionHidden = null; renderProjection(); });
}

function projectionAction(action, p) {
  if (action === 'hide') {
    room.projectionHidden = p.share.at;
    return renderProjection();
  }
  if ((action === 'prev' || action === 'next') && room.myShare) {
    const page = Math.min(room.myShare.count, Math.max(1, room.myShare.page + (action === 'next' ? 1 : -1)));
    if (page === room.myShare.page) return;
    room.myShare.page = page;
    trackMe();
    return renderProjection();
  }
  if (action === 'stop') {
    if (p.user_id === profile.id) return stopMyShare();
    room.channel?.send({ type: 'broadcast', event: 'stop-share', payload: { user_id: p.user_id } });
    room.projectionHidden = p.share.at;
    renderProjection();
    toast('Projection fermée.');
  }
}

async function renderProjectionPdf(layer, s, mine) {
  const key = layer.dataset.key;
  try {
    const pdfjs = await loadPdfJs();
    if (!projDoc || projDoc.url !== s.url) {
      if (projDoc) projDoc.doc.destroy();
      projDoc = { url: s.url, doc: await pdfjs.getDocument({ url: s.url }).promise };
    }
    const doc = projDoc.doc;
    if (mine && room.myShare && room.myShare.url === s.url && room.myShare.count !== doc.numPages) {
      room.myShare.count = doc.numPages; // nombre de pages connu une fois le PDF ouvert
      trackMe();
      return renderProjection();
    }
    const page = await doc.getPage(Math.min(s.page, doc.numPages));
    const body = layer.querySelector('.projection-body');
    const canvas = layer.querySelector('canvas');
    if (!body || !canvas || layer.dataset.key !== key) return;
    const base = page.getViewport({ scale: 1 });
    const fit = Math.min(body.clientWidth / base.width, body.clientHeight / base.height) || 1;
    const viewport = page.getViewport({ scale: fit * (window.devicePixelRatio || 1) });
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  } catch (e) {
    const body = layer.querySelector('.projection-body');
    if (body) body.innerHTML = '<p style="color:#fff">Impossible d’afficher ce PDF.</p>';
  }
}

// =====================================================================
// Supports du cours : liste visible dans la salle (organisateur et apprenants)
// =====================================================================

async function loadSupports() {
  const id = room.id;
  const { data } = await sb.from('webinar_resources').select('resource:resources(*)')
    .eq('webinar_id', id).order('created_at');
  if (room.id !== id) return;
  room.supports = (data || []).map(l => l.resource).filter(Boolean);
  renderSupports();
}

function renderSupports() {
  const box = document.getElementById('supports');
  if (!box) return;
  const host = room.isHost;
  const list = room.supports || [];
  if (!host && !list.length) { box.innerHTML = ''; return; }
  box.innerHTML = `
    <div class="card supports">
      <div class="row spread" style="margin-bottom:8px">
        <h3>📚 Supports du cours (${list.length})</h3>
        ${host ? `<div class="row">
          <button class="btn sm" id="sup-add">＋ Depuis la bibliothèque</button>
          <button class="btn sm" id="sup-upload">⬆ Déposer un fichier</button></div>` : ''}
      </div>
      ${list.length ? `<div class="list">${list.map(r => {
        const t = fileType(r);
        return `<div class="list-item">
          <div class="ftype ${t}">${FILE_TYPES[t][0]}</div>
          <div class="grow"><strong>${esc(r.title)}</strong>
            <div class="muted small">${FILE_TYPES[t][1]} · ${esc(fmtSize(r.size_bytes))}</div></div>
          <div class="row" style="justify-content:flex-end">${resourceButtons(r)}
            ${host ? `<button class="btn ghost sm" data-unlink-sup="${r.id}" title="Retirer de ce cours">✕</button>` : ''}</div>
        </div>`;
      }).join('')}</div>` : '<p class="muted small">Aucun support pour ce cours. Ajoutez vos PDF, présentations ou vidéos.</p>'}
      ${host && list.length ? `<p class="hint" style="margin-top:8px">Pour montrer un support : <strong>👁 Voir</strong>
        l’ouvre dans un onglet, puis dans la visio <strong>Partager l’écran</strong> → choisissez cet onglet.</p>` : ''}
    </div>`;
  bindResourceButtons(box);
  const add = box.querySelector('#sup-add');
  if (add) add.addEventListener('click', () => linkResourcesDialog(room.webinar, list.map(r => r.id), loadSupports));
  const upload = box.querySelector('#sup-upload');
  if (upload) upload.addEventListener('click', () => uploadDialog(() => loadSupports(), room.id));
  box.querySelectorAll('[data-unlink-sup]').forEach(b => b.addEventListener('click', async () => {
    const { error } = await sb.from('webinar_resources').delete()
      .eq('webinar_id', room.id).eq('resource_id', b.dataset.unlinkSup);
    if (error) return fail(error);
    toast('Support retiré du cours.');
    loadSupports();
  }));
}

// Ma présence dans la salle (nom, rôle, main levée), visible des autres en temps réel.
function trackMe() {
  // Seules les personnes admises apparaissent dans la liste des participants.
  if (!room.channel || (!room.isHost && room.lobby !== 'admis')) return;
  const sh = room.myShare;
  room.channel.track({
    user_id: profile.id, name: profile.full_name, role: profile.role,
    joined_at: room.joinedAt, hand: room.hand, hand_at: room.handAt,
    share: sh ? { url: sh.url, kind: sh.kind, name: sh.name, page: sh.page, count: sh.count, at: sh.at } : null
  });
}

function setHand(raised) {
  room.hand = raised;
  room.handAt = raised ? new Date().toISOString() : null;
  trackMe();
  renderHandBar();
}

function renderHandBar() {
  const bar = document.getElementById('hand-bar');
  if (!bar) return;
  // Partage d'écran sur ordinateur ; sur téléphone/tablette (non pris en charge), projection d'un document.
  const screenOk = screenShareSupported();
  const share = (callActive() && screenOk
    ? `<button class="btn${room.sharing ? ' active' : ''}" id="share-toggle">${room.sharing ? '⏹ Arrêter le partage' : '🖥️ Partager mon écran'}</button>`
    : '') + (room.myShare
    ? '<button class="btn active" id="doc-stop">⏹ Arrêter de montrer</button><button class="btn" id="doc-pick">🔄 Changer</button>'
    : `<button class="btn" id="doc-pick"${room.shareBusy ? ' disabled' : ''}>${room.shareBusy ? '⏳ Envoi…'
      : screenOk ? '📎 Montrer un document' : '📱 Montrer une capture ou un document'}</button>`);
  bar.innerHTML = room.hand
    ? `<div class="notice warn row spread" style="flex-basis:100%"><span>✋ <strong>Vous avez levé la main.</strong> L’encadreur est prévenu et vous donnera la parole.</span>
        <button class="btn sm" id="hand-toggle">Baisser la main</button></div>${share}`
    : `<button class="btn" id="hand-toggle">✋ Lever la main</button>${share}`;
  bar.querySelector('#hand-toggle').addEventListener('click', () => setHand(!room.hand));
  const shareBtn = bar.querySelector('#share-toggle');
  if (shareBtn) shareBtn.addEventListener('click', toggleScreenShare);
  const pick = bar.querySelector('#doc-pick');
  if (pick) pick.addEventListener('click', pickShareFile);
  const stop = bar.querySelector('#doc-stop');
  if (stop) stop.addEventListener('click', () => stopMyShare());
}

// =====================================================================
// Salle d'attente : chaque entrée doit être admise par l'organisateur
// =====================================================================

// Organisateur : personnes qui attendent d'entrer.
async function loadLobby() {
  if (!room.isHost) return;
  const id = room.id;
  const { data } = await sb.from('lobby')
    .select('user_id, requested_at, user:profiles!user_id(full_name, email, status)')
    .eq('webinar_id', id).eq('status', 'en_attente').order('requested_at');
  if (room.id !== id) return;
  room.lobbyList = data || [];
  // Signal sonore et notification pour chaque nouvelle arrivée.
  const fresh = room.lobbyList.filter(r => !room.lobbySeen.has(r.user_id));
  if (fresh.length) {
    fresh.forEach(r => toast(`🔔 ${r.user?.full_name || r.user?.email} attend dans la salle d’attente`));
    beep();
  }
  room.lobbySeen = new Set(room.lobbyList.map(r => r.user_id));
  renderRoomMeta();
  if (room.background) updateDock();
  renderLobbyBar();
  if (room.tab === 'participants') renderPanel();
}

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
  } catch (e) { /* son indisponible */ }
}

async function lobbyDecide(userId, decision) {
  const { error } = await sb.rpc('lobby_decide', { w: room.id, target: userId, decision });
  if (error) { fail(error); return false; }
  return true;
}

// Bandeau de la salle d'attente, toujours visible pour l'organisateur pendant le cours.
function renderLobbyBar() {
  const bar = document.getElementById('lobby-bar');
  if (!bar) return;
  const list = room.lobbyList;
  if (!list.length) { bar.innerHTML = ''; return; }
  bar.innerHTML = `
    <div class="notice warn">
      <div class="row spread" style="margin-bottom:8px">
        <strong>🔔 Salle d’attente : ${list.length} personne${list.length > 1 ? 's' : ''}</strong>
        ${list.length > 1 ? '<button class="btn primary sm" id="admit-all">✓ Tout admettre</button>' : ''}
      </div>
      <div class="list">${list.map(r => `
        <div class="list-item" style="color:var(--text)">
          <div class="avatar sm">${esc(initials(r.user?.full_name || r.user?.email))}</div>
          <div class="grow"><strong>${esc(r.user?.full_name || '—')}</strong>
            <div class="muted small">${esc(r.user?.email || '')} · depuis ${esc(fmtTime(r.requested_at))}${
              r.user?.status === 'en_attente' ? ' · compte non validé' : ''}</div></div>
          <button class="btn primary sm" data-lobby="admis" data-user="${r.user_id}">Admettre</button>
          <button class="btn ghost sm" data-lobby="refuse" data-user="${r.user_id}">Refuser</button>
        </div>`).join('')}</div>
    </div>`;
  bar.querySelectorAll('[data-lobby]').forEach(b => b.addEventListener('click', async () => {
    b.disabled = true;
    if (await lobbyDecide(b.dataset.user, b.dataset.lobby)) {
      toast(b.dataset.lobby === 'admis' ? 'Participant admis ✓' : 'Demande refusée.', 'success');
      loadLobby();
    } else {
      b.disabled = false;
    }
  }));
  const all = bar.querySelector('#admit-all');
  if (all) all.addEventListener('click', async () => {
    all.disabled = true;
    for (const r of list) await lobbyDecide(r.user_id, 'admis');
    toast(`${list.length} participants admis ✓`, 'success');
    loadLobby();
  });
}

// Participant : écran de la salle d'attente (en attente, refusé, retiré).
function renderLobbyWait() {
  const view = document.getElementById('view');
  const w = room.webinar;
  const state = room.lobby;
  const screens = {
    en_attente: ['⏳', 'Vous êtes dans la salle d’attente',
      'L’organisateur a été prévenu et va vous admettre. Restez sur cette page.', ''],
    refuse: ['🚫', 'Votre demande n’a pas été acceptée',
      'L’organisateur n’a pas admis votre demande pour le moment.', 'Redemander à entrer'],
    exclu: ['🚪', 'Vous avez été retiré de la salle',
      'L’organisateur vous a retiré du cours. Vous pouvez demander à revenir.', 'Demander à revenir']
  };
  const [icon, title, text, retry] = screens[state] || screens.en_attente;
  view.innerHTML = `
    <div class="card" style="max-width:560px;margin:24px auto;text-align:center">
      <div style="font-size:2.6rem">${icon}</div>
      <h2>${title}</h2>
      <p class="muted">${text}</p>
      <div class="notice" style="margin:16px 0;text-align:left">
        <strong>${esc(w.title)}</strong><br>
        <span class="small">🧑‍🏫 ${esc(w.encadreur?.full_name || '')} · ${esc(fmtDate(w.starts_at))}, ${esc(fmtTime(w.starts_at))}</span>
      </div>
      ${state === 'en_attente' ? `<div class="loading" style="padding:8px"><span class="spinner"></span>En attente de l’organisateur…</div>` : ''}
      <div class="row" style="justify-content:center;margin-top:8px">
        ${retry ? `<button class="btn primary" id="knock-again">${retry}</button>` : ''}
        <a class="btn" href="#/">Quitter</a>
      </div>
    </div>`;
  const again = document.getElementById('knock-again');
  if (again) again.addEventListener('click', async () => {
    again.disabled = true;
    const { data, error } = await sb.rpc('lobby_knock', { w: room.id });
    if (error) { again.disabled = false; return fail(error); }
    room.lobby = data;
    renderRoomView();
  });
}

// Participant admis : chargement du chat et des sondages, présence, visio.
async function onAdmitted() {
  const id = room.id;
  room.lobby = 'admis';
  const [msgs, polls] = await Promise.all([
    sb.from('messages').select('*').eq('webinar_id', id).order('created_at').limit(500),
    sb.from('polls').select('*').eq('webinar_id', id).order('created_at')
  ]);
  if (room.id !== id) return;
  room.messages = msgs.data || [];
  room.polls = polls.data || [];
  if (room.polls.length) {
    const { data } = await sb.from('poll_votes').select('*').in('poll_id', room.polls.map(p => p.id));
    room.votes = data || [];
  }
  if (room.id !== id) return;
  room.joinedAt = new Date().toISOString();
  trackMe();
  renderRoomView();
  loadSupports();
  if (room.webinar.status === 'en_direct') {
    startAttendance();
    startVideo();
  }
}

// Participant retiré (exclusion, refus) : on coupe tout et on revient à l'écran d'attente.
function removedFromRoom(state, message) {
  if (room.isHost || room.lobby === state) return;
  stopAttendance();
  stopVideo();
  if (room.channel) room.channel.untrack();
  room.lobby = state;
  room.hand = false;
  if (message) toast(message, 'error');
  if (room.background) return leaveRoom();
  renderRoomView();
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
  // Retour dans la salle dont la visio tourne en arrière-plan : on réaffiche sans rien couper.
  if (room.id === id && room.background) {
    room.background = false;
    renderRoomView();
    return;
  }
  if (room.id) await leaveRoom(); // visio d'un autre webinaire encore ouverte
  // Chaque entrée passe par la salle d'attente (l'organisateur, lui, est admis d'office).
  const { data: knock, error: knockError } = await sb.rpc('lobby_knock', { w: id });
  if (isStale(token)) return;
  if (knockError) {
    view.innerHTML = `<div class="card">${emptyState('🔒', translateError(knockError),
      '<a class="btn primary" href="#/">Retour à l’accueil</a>')}</div>`;
    return;
  }
  const { data: w, error } = await sb.from('webinars').select(WEBINAR_SELECT).eq('id', id).maybeSingle();
  if (isStale(token)) return;
  if (error || !w) return (view.innerHTML = '<div class="notice danger">Webinaire introuvable.</div>');

  const isHost = canManage(w);
  room = { ...emptyRoom(), id, webinar: w, isHost, joinedAt: new Date().toISOString(), lobby: isHost ? 'admis' : knock };

  const channel = sb.channel(`salle:${id}`, { config: { presence: { key: profile.id } } });
  room.channel = channel;
  channel
    .on('presence', { event: 'sync' }, () => {
      // Copie de la liste précédente (Supabase peut modifier l'objet de présence sur place).
      const before = room.lastOnline || [];
      room.presence = channel.presenceState();
      room.lastOnline = onlineList().map(p => ({ ...p }));
      // Qui vient de partir (ou de revenir) : affiché « A quitté la réunion » chez l'organisateur.
      const online = new Set(room.lastOnline.map(p => p.user_id));
      before.filter(p => !online.has(p.user_id) && p.user_id !== profile.id).forEach(p => {
        room.departed.set(p.user_id, { ...p, hand: false, left_at: new Date().toISOString() });
        if (room.isHost) toast(`🚪 ${p.name} a quitté la réunion`);
      });
      online.forEach(uid => room.departed.delete(uid));
      // L'encadreur est prévenu de chaque nouvelle main levée.
      const hands = onlineList().filter(p => p.hand);
      if (room.isHost) {
        hands.filter(p => !room.handsSeen.has(p.user_id)).forEach(p => toast(`✋ ${p.name} lève la main`));
      }
      room.handsSeen = new Set(hands.map(p => p.user_id));
      // Nouvelle projection (capture, photo, PDF) montrée par un participant.
      const shares = onlineList().filter(p => p.share && p.user_id !== profile.id);
      shares.filter(p => !room.sharesSeen.has(p.share.at)).forEach(p => toast(`📱 ${p.name} montre un document`));
      room.sharesSeen = new Set(shares.map(p => p.share.at));
      renderRoomMeta();
      renderProjection();
      if (room.background) updateDock();
      if (room.tab === 'participants') renderPanel();
    })
    .on('broadcast', { event: 'stop-share' }, ({ payload }) => {
      if (payload.user_id === profile.id) stopMyShare('L’encadreur a fermé votre projection.');
    })
    .on('broadcast', { event: 'lower-hand' }, ({ payload }) => {
      if (payload.user_id === profile.id && room.hand) {
        setHand(false);
        toast('L’encadreur a baissé votre main.');
      }
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
      if (p.new.webinar_id === id && p.new.status === 'suspendu') {
        removedFromRoom('exclu', "L'organisateur a suspendu votre inscription à ce webinaire.");
      }
    });
  if (isHost) {
    // Arrivées dans la salle d'attente, en temps réel.
    channel.on('postgres_changes', { event: '*', schema: 'public', table: 'lobby',
      filter: `webinar_id=eq.${id}` }, () => loadLobby());
  } else {
    // Décision de l'organisateur sur ma demande.
    channel.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'lobby',
      filter: `user_id=eq.${profile.id}` }, p => {
      if (p.new.webinar_id !== id) return;
      if (p.new.status === 'admis' && room.lobby !== 'admis') {
        toast('Vous avez été admis dans la salle ✓', 'success');
        onAdmitted();
      } else if (p.new.status === 'refuse') {
        removedFromRoom('refuse');
      } else if (p.new.status === 'exclu') {
        removedFromRoom('exclu', 'L’organisateur vous a retiré de la salle.');
      }
    });
  }
  channel.subscribe(status => {
    if (status === 'SUBSCRIBED') trackMe();
  });

  if (isStale(token) || room.id !== id) return;
  if (isHost) {
    await onAdmitted();
    await loadLobby();
  } else if (room.lobby === 'admis') {
    // Déjà admis pendant ce cours (retour après un départ ou un rechargement) : entrée directe.
    await onAdmitted();
  } else {
    renderRoomView();
  }
}

async function startAttendance() {
  if (room.sessionId || room.isHost || room.lobby !== 'admis') return;
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
    if (!err && ok === false) removedFromRoom('exclu', 'Vous ne pouvez plus participer à ce webinaire.');
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
  if (room.myShare?.path) sb.storage.from('salle').remove([room.myShare.path]);
  document.getElementById('projection')?.remove();
  clearInterval(room.clock);
  // Un participant admis qui quitte pourra revenir directement ; s'il attendait encore, sa demande est retirée.
  if (!room.isHost) sb.rpc('lobby_leave', { w: room.id });
  stopAttendance();
  stopVideo();
  if (room.channel) {
    // Départ annoncé tout de suite aux autres (sinon il faut attendre la coupure de connexion).
    try { await room.channel.untrack(); } catch (e) { /* déjà déconnecté */ }
    await sb.removeChannel(room.channel);
  }
  stopMedia();
  room = emptyRoom();
  updateDock();
}

function kickOut(message) {
  const background = room.background;
  leaveRoom();
  toast(message, 'error');
  if (!background) location.hash = '#/webinaires';
}

// Fermeture de l'onglet : on enregistre l'heure de départ sans attendre la réponse.
window.addEventListener('pagehide', () => {
  if (room.sessionId) keepaliveRpc('attendance_leave', { session_id: room.sessionId });
  if (room.id && !room.isHost) keepaliveRpc('lobby_leave', { w: room.id });
  if (room.channel) room.channel.untrack();
  if (appSession.id) keepaliveRpc('session_end', { sid: appSession.id });
});

function onWebinarUpdate(next) {
  const prev = room.webinar;
  room.webinar = { ...prev, ...next };
  if (prev.status !== next.status) {
    if (next.status === 'en_direct') startAttendance();
    if (next.status === 'termine' || next.status === 'annule') {
      stopAttendance();
      stopVideo();
      stopMedia();
      if (room.background) {
        toast(next.status === 'termine' ? 'Le direct est terminé. Merci pour votre participation.' : 'Le webinaire a été annulé.');
        leaveRoom();
        return;
      }
    }
    renderRoomView();
    if (next.status === 'en_direct') startVideo();
  } else if (!room.isHost) {
    const info = document.getElementById('stage-info');
    if (info) info.innerHTML = stageInfo(room.webinar);
  }
}

function onlineList() {
  // Une personne connectée deux fois (deux onglets, reconnexion) a plusieurs états :
  // on garde celui qui montre un document, sinon le plus récent.
  const pick = list => (list || []).filter(m => m && m.share && m.share.url)
    .sort((a, b) => (b.share.at || '').localeCompare(a.share.at || ''))[0] || (list || [])[list.length - 1];
  return Object.values(room.presence).map(pick).filter(Boolean)
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'fr'));
}

function participantsLabel() {
  const hands = onlineList().filter(p => p.hand).length;
  if (!room.isHost) return `👥 ${onlineList().length}`;
  return `👥 ${onlineList().length}${hands ? ` · ✋ ${hands}` : ''}${room.lobbyList.length ? ` · 🔔 ${room.lobbyList.length}` : ''}`;
}

function teacherOnline() {
  return onlineList().some(p => p.user_id === room.webinar?.encadreur_id);
}

function renderRoomMeta() {
  const hands = onlineList().filter(p => p.hand).length;
  const w = room.webinar;
  const el = document.getElementById('online-count');
  if (el) {
    el.textContent = `👥 ${onlineList().length} en ligne${hands ? ` · ✋ ${hands} main${hands > 1 ? 's' : ''} levée${hands > 1 ? 's' : ''}` : ''}`;
  }
  const teacher = document.getElementById('teacher-status');
  if (teacher && w) {
    teacher.innerHTML = teacherOnline()
      ? `<span class="badge ok">🧑‍🏫 ${esc(w.encadreur?.full_name || 'L’encadreur')} est en salle</span>`
      : `<span class="badge warn">🧑‍🏫 ${esc(w.encadreur?.full_name || 'L’encadreur')} n’est pas en salle</span>`;
  }
  const tabBtn = document.querySelector('[data-rtab="participants"]');
  if (tabBtn) tabBtn.textContent = participantsLabel();
}

// Heure de début du direct et temps écoulé, mis à jour chaque seconde.
function startClock() {
  clearInterval(room.clock);
  const tick = () => {
    const el = document.getElementById('live-clock');
    const w = room.webinar;
    if (!el || !w) return;
    if (w.status === 'en_direct') {
      const start = w.live_started_at || room.liveSeenAt || (room.liveSeenAt = new Date().toISOString());
      const s = Math.max(0, Math.floor((Date.now() - new Date(start).getTime()) / 1000));
      el.textContent = `▶ Début du cours : ${fmtTime(start)} · ⏱ ${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
    } else if (w.status === 'planifie') {
      el.textContent = `Début prévu à ${fmtTime(w.starts_at)}`;
    } else {
      el.textContent = '';
    }
  };
  tick();
  room.clock = setInterval(tick, 1000);
}

function renderRoomView() {
  // Salle en arrière-plan (navigation ailleurs) : on ne touche pas à la page affichée.
  if (room.background) return updateDock();
  const view = document.getElementById('view');
  const w = room.webinar;
  if (!view || !w) return;
  const host = room.isHost;

  // Participant pas (encore) admis : écran de la salle d'attente.
  if (!host && room.lobby !== 'admis') return renderLobbyWait();

  // Visio en cours : on ne reconstruit pas la page, sinon la visio serait coupée.
  if (room.call && w.status === 'en_direct' && document.getElementById('video-stage')) {
    renderRoomMeta();
    renderHandBar();
    renderLobbyBar();
    renderSupports();
    renderPanel();
    updateDock();
    return;
  }

  const videoMode = w.status === 'en_direct' && room.video !== 'off';
  let stage;
  if (videoMode) {
    // Emplacement de la visio : le dock (iframe Daily) vient s'y superposer.
    stage = `<div id="video-stage" class="video-stage">${room.call ? '' : loading('Connexion à la visio…')}</div>`;
  } else if (w.status === 'en_direct' && host) {
    stage = '<div id="stage-host" class="stage-host"></div>';
  } else if (w.status === 'en_direct') {
    stage = `<div class="stage-msg"><span class="badge live">En direct</span>
      <h2 style="margin:0">${esc(w.encadreur?.full_name)} présente</h2>
      <div id="stage-info">${stageInfo(w)}</div>
      <p class="small" style="opacity:.7">La visio n’est pas disponible pour le moment.<br>
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
  tabs.push(['participants', participantsLabel()]);

  view.innerHTML = `
    <div class="page-head">
      <div>
        ${host
          ? `<a class="back" href="#/webinaires/${w.id}">← Détails du webinaire</a>`
          : '<a class="back" href="#" id="quit-room">← Quitter la salle</a>'}
        <div class="row" style="margin-bottom:6px">${statusBadge(w)}<span class="muted small" id="online-count"></span></div>
        <div class="row" style="margin-bottom:6px"><span id="teacher-status"></span><strong class="small" id="live-clock"></strong></div>
        <h1>${esc(w.title)}</h1>
      </div>
    </div>
    ${host ? '<div id="lobby-bar" style="margin-bottom:12px"></div>' : ''}
    <div class="room${room.wide ? ' wide' : ''}">
      <section>
        <div class="stage${videoMode ? ' video' : ''}">${stage}</div>
        <div class="stage-tools">
          <button class="btn sm" id="zoom-wide">${room.wide ? '↙ Réduire' : '↗ Agrandir'}</button>
          <button class="btn sm" id="zoom-full">⛶ Plein écran</button>
          ${host ? '<button class="btn sm" id="copy-link">🔗 Copier le lien de la salle</button>' : ''}
        </div>
        ${host ? stageToolbar(w) : ''}
        <div id="projection-chip"></div>
        ${!host && w.status === 'en_direct' ? '<div class="stage-tools" id="hand-bar"></div>' : ''}
        <div id="supports" style="margin-top:16px"></div>
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
  bindZoomButtons(view, w);
  renderHandBar();
  renderLobbyBar();
  renderSupports();
  renderPanel();
  startClock();
  const quit = view.querySelector('#quit-room');
  if (quit) quit.addEventListener('click', e => { e.preventDefault(); quitRoom(); });
  updateDock();
  renderProjection();
}

// Agrandir la vidéo (masque le panneau latéral) ou la passer en plein écran.
// On modifie les classes sans reconstruire la page, pour ne pas couper la visio.
function bindZoomButtons(view, w) {
  const wide = view.querySelector('#zoom-wide');
  wide.addEventListener('click', () => {
    room.wide = !room.wide;
    view.querySelector('.room').classList.toggle('wide', room.wide);
    wide.textContent = room.wide ? '↙ Réduire' : '↗ Agrandir';
  });
  view.querySelector('#zoom-full').addEventListener('click', () => {
    const stage = callActive() && dock && !dock.hidden ? dock : view.querySelector('.stage');
    const request = stage.requestFullscreen || stage.webkitRequestFullscreen;
    if (request) request.call(stage);
    else toast('Le plein écran n’est pas disponible sur cet appareil : utilisez « Agrandir ».');
  });
  const copy = view.querySelector('#copy-link');
  if (copy) copy.addEventListener('click', () => copyRoomLink(w.id));
}

function stageToolbar(w) {
  if (w.status === 'planifie') {
    return `<div class="stage-tools"><button class="btn live" id="go-live">🎬 Démarrer le direct</button>
      <span class="muted small" style="align-self:center">Les apprenants inscrits pourront entrer dès le démarrage.</span></div>`;
  }
  if (w.status === 'termine') {
    return '<div class="stage-tools"><button class="btn live" id="reopen-live">🔓 Rouvrir le direct</button></div>';
  }
  if (w.status !== 'en_direct') return '';
  if (room.video !== 'off') {
    return `
      <div class="stage-tools">
        <button class="btn danger" id="end-live">Terminer le direct</button>
      </div>
      <p class="hint" style="margin-top:8px">Dans la visio : caméra, micro, <strong>Partager l’écran</strong>,
        et dans la liste <strong>People</strong> / <strong>Participants</strong>, couper le micro ou retirer un participant.
        Vous pouvez ouvrir les autres rubriques : la visio continue dans une mini-fenêtre.</p>`;
  }
  return `
    ${room.videoError ? `<div class="notice warn" style="margin-top:12px">Visio indisponible (${esc(room.videoError)}).
      Mode local : seule votre caméra s’affiche, elle n’est pas transmise aux apprenants.</div>` : ''}
    <div class="stage-tools">
      <button class="btn ${stageMode === 'camera' ? 'active' : ''}" data-mode="camera">📷 Caméra</button>
      ${canShareScreen() ? `<button class="btn ${stageMode === 'screen' ? 'active' : ''}" data-mode="screen">🖥️ Partager l'écran</button>` : ''}
      <label class="btn ${stageMode === 'slides' ? 'active' : ''}">📑 Présentation
        <input type="file" id="slides-input" accept="application/pdf,image/*" multiple hidden>
      </label>
      <button class="btn" id="slides-library">📚 Depuis la bibliothèque</button>
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

  on('#reopen-live', () => reopenWebinar(w));
  on('#go-live', async () => {
    const { error } = await sb.from('webinars').update({ status: 'en_direct' }).eq('id', w.id);
    if (error) return fail(error);
    onWebinarUpdate({ status: 'en_direct' });
  });
  on('#end-live', () => endLive(w));
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

  if (w.status === 'en_direct' && room.video === 'off') {
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
    // Mains levées d'abord (dans l'ordre où elles ont été levées), puis les autres.
    const people = onlineList().sort((a, b) =>
      (b.hand ? 1 : 0) - (a.hand ? 1 : 0) || (a.hand_at || '').localeCompare(b.hand_at || ''));
    const hands = people.filter(p => p.hand).length;
    const host = room.isHost;
    if (!host) {
      // Apprenant : liste en lecture seule, l'encadreur en tête.
      const sorted = people.sort((a, b) => (b.user_id === w.encadreur_id ? 1 : 0) - (a.user_id === w.encadreur_id ? 1 : 0));
      panel.innerHTML = `<div class="messages">
        <div class="muted small">En ligne : ${people.length}</div>
        <div class="list">${sorted.map(p => `
          <div class="list-item">
            <div class="avatar sm">${esc(initials(p.name))}</div>
            <div class="grow"><div>${p.hand ? '✋ ' : ''}${esc(p.name)}${p.user_id === profile.id ? ' (vous)' : ''}</div>
              <div class="muted small">${p.user_id === w.encadreur_id ? '🧑‍🏫 Encadreur · organisateur' : ROLE_LABELS[p.role] || ''}
                · depuis ${esc(fmtTime(p.joined_at))}</div></div>
          </div>`).join('')}</div>
        ${teacherOnline() ? '' : '<div class="notice warn">L’encadreur n’est pas encore (ou plus) dans la salle.</div>'}
      </div>`;
      return;
    }
    panel.innerHTML = `<div class="messages">
      ${room.lobbyList.length ? `<div class="notice warn">🔔 ${room.lobbyList.length} personne${room.lobbyList.length > 1 ? 's' : ''}
        dans la salle d’attente : admettez-les dans le bandeau au-dessus de la vidéo.</div>` : ''}
      <div class="muted small">En ligne : ${people.length}${hands ? ` · ✋ ${hands} main${hands > 1 ? 's' : ''} levée${hands > 1 ? 's' : ''}` : ''}</div>
      ${people.length ? `<div class="list">${people.map(p => `
        <div class="list-item">
          <div class="avatar sm">${esc(initials(p.name))}</div>
          <div class="grow"><div>${p.hand ? '✋ ' : ''}${esc(p.name)}</div>
            <div class="muted small">${ROLE_LABELS[p.role] || ''} · ${p.hand
              ? `main levée à ${esc(fmtTime(p.hand_at))}` : `depuis ${esc(fmtTime(p.joined_at))}`}</div></div>
          ${p.hand ? `<button class="btn sm" data-lower="${p.user_id}" title="Baisser la main">👇</button>` : ''}
          ${p.role === 'apprenant' ? `<button class="btn danger sm" data-kick="${p.user_id}">Exclure</button>` : ''}
        </div>`).join('')}</div>` : emptyState('👥', 'Personne en ligne pour le moment.')}
      ${room.departed.size ? `
        <div class="muted small" style="margin-top:8px">Ont quitté la réunion : ${room.departed.size}</div>
        <div class="list">${[...room.departed.values()].sort((a, b) => b.left_at.localeCompare(a.left_at)).map(p => `
          <div class="list-item" style="opacity:.7">
            <div class="avatar sm" style="filter:grayscale(1)">${esc(initials(p.name))}</div>
            <div class="grow"><div>${esc(p.name)}</div>
              <div class="muted small">${ROLE_LABELS[p.role] || ''} · présent depuis ${esc(fmtTime(p.joined_at))}</div></div>
            <span class="badge done">🚪 A quitté la réunion à ${esc(fmtTime(p.left_at))}</span>
          </div>`).join('')}</div>` : ''}
    </div>`;
    panel.querySelectorAll('[data-kick]').forEach(b => b.addEventListener('click', async () => {
      const person = people.find(p => p.user_id === b.dataset.kick);
      if (!await confirmDialog(`Retirer ${person?.name || 'ce participant'} de la salle ?`, {
        confirmLabel: 'Retirer', danger: true
      })) return;
      if (await lobbyDecide(b.dataset.kick, 'exclu')) {
        toast('Participant retiré. S’il revient, il passera par la salle d’attente.', 'success');
      }
    }));
    panel.querySelectorAll('[data-lower]').forEach(b => b.addEventListener('click', () =>
      room.channel.send({ type: 'broadcast', event: 'lower-hand', payload: { user_id: b.dataset.lower } })));
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

// Les types lisibles directement dans le navigateur ; les autres (PowerPoint, Word…) se téléchargent.
const VIEWABLE = new Set(['pdf', 'image', 'video']);

// Attributs communs aux boutons « Voir » et « Télécharger ».
function resourceData(r) {
  return `data-path="${esc(r.file_path)}" data-name="${esc(r.file_name)}" data-title="${esc(r.title)}" data-type="${fileType(r)}"`;
}

function resourceButtons(r, { small = true } = {}) {
  const t = fileType(r);
  const sm = small ? ' sm' : '';
  return `${VIEWABLE.has(t) ? `<button class="btn primary${sm}" data-open="${r.id}" ${resourceData(r)}>${
    t === 'video' ? '▶ Regarder' : '👁 Voir'}</button>` : ''}
    <button class="btn${VIEWABLE.has(t) ? '' : ' primary'}${sm}" data-download="${r.id}" ${resourceData(r)}
      title="Télécharger ${esc(r.file_name)}">⬇ Télécharger</button>`;
}

function resourceRow(r, removable = false) {
  const t = fileType(r);
  return `<div class="list-item">
    <div class="ftype ${t}">${FILE_TYPES[t][0]}</div>
    <div class="grow"><strong>${esc(r.title)}</strong>
      <div class="muted small">${FILE_TYPES[t][1]} · ${esc(fmtSize(r.size_bytes))}</div></div>
    <div class="row" style="justify-content:flex-end">${resourceButtons(r)}
    ${removable ? `<button class="btn ghost sm" data-unlink="${r.id}" title="Retirer du webinaire">Retirer</button>` : ''}</div>
  </div>`;
}

// Carte de la bibliothèque : vignette colorée par type, infos, actions.
function resourceCard(r) {
  const t = fileType(r);
  const mine = r.owner_id === profile.id || profile.role === 'admin';
  const links = (r.links || []).filter(l => l.webinar);
  const thumbAttrs = VIEWABLE.has(t) ? `data-open="${r.id}"` : `data-download="${r.id}"`;
  return `<article class="rcard2">
    <button class="rthumb ${t}" ${thumbAttrs} ${resourceData(r)} title="${VIEWABLE.has(t) ? 'Voir' : 'Télécharger'}">
      <span class="ricon">${FILE_TYPES[t][0]}</span>
      <span class="rtype">${FILE_TYPES[t][1]}</span>
      ${t === 'video' ? '<span class="rplay">▶</span>' : ''}
    </button>
    <div class="rbody">
      <h3 class="clamp" title="${esc(r.title)}">${esc(r.title)}</h3>
      ${r.description ? `<p class="muted small clamp">${esc(r.description)}</p>` : ''}
      <div class="muted small">${esc(fmtSize(r.size_bytes))} · ${esc(fmtShortDate(r.created_at))}${
        r.owner?.full_name ? ` · ${esc(r.owner.full_name)}` : ''}</div>
      ${links.length ? `<div class="row">${links.map(l =>
        `<a class="badge" href="#/webinaires/${l.webinar.id}">🎥 ${esc(l.webinar.title)}</a>`).join('')}</div>` : ''}
    </div>
    <div class="ractions">
      ${resourceButtons(r)}
      <span style="flex:1"></span>
      ${isStaff() ? `<button class="btn ghost sm" data-link="${r.id}" title="Lier à un webinaire" aria-label="Lier à un webinaire">🔗</button>` : ''}
      ${mine ? `<button class="btn ghost sm" data-delete="${r.id}" title="Supprimer" aria-label="Supprimer">🗑</button>` : ''}
    </div>
  </article>`;
}

// Ligne de la bibliothèque en affichage « liste ».
function resourceListRow(r) {
  const t = fileType(r);
  const mine = r.owner_id === profile.id || profile.role === 'admin';
  const links = (r.links || []).filter(l => l.webinar);
  return `<div class="list-item">
    <div class="ftype ${t}">${FILE_TYPES[t][0]}</div>
    <div class="grow"><strong>${esc(r.title)}</strong>
      <div class="muted small">${FILE_TYPES[t][1]} · ${esc(fmtSize(r.size_bytes))} · ${esc(fmtShortDate(r.created_at))}${
        links.length ? ` · 🎥 ${links.map(l => esc(l.webinar.title)).join(', ')}` : ''}</div></div>
    <div class="row" style="justify-content:flex-end">
      ${resourceButtons(r)}
      ${isStaff() ? `<button class="btn ghost sm" data-link="${r.id}" title="Lier à un webinaire">🔗</button>` : ''}
      ${mine ? `<button class="btn ghost sm" data-delete="${r.id}" title="Supprimer">🗑</button>` : ''}
    </div>
  </div>`;
}

// Webinaires que l'utilisateur peut gérer (les siens, ou tous pour l'admin).
async function manageableWebinars() {
  let query = sb.from('webinars').select('id, title, starts_at, status').neq('status', 'annule')
    .order('starts_at', { ascending: false });
  if (profile.role !== 'admin') query = query.eq('encadreur_id', profile.id);
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

// Depuis la bibliothèque : choisir les webinaires auxquels associer une ressource.
async function linkWebinarsDialog(r, onDone) {
  let webinars;
  try { webinars = await manageableWebinars(); } catch (err) { return fail(err); }
  const linked = new Set((r.links || []).map(l => l.webinar?.id));
  openModal(`
    <h2>🔗 Associer « ${esc(r.title)} »</h2>
    <p class="muted">Cochez les webinaires dans lesquels cette ressource doit apparaître.</p>
    ${webinars.length ? `<div class="list" style="max-height:360px;overflow-y:auto">${webinars.map(w => `
      <label class="list-item" style="font-weight:400;cursor:pointer">
        <input type="checkbox" value="${w.id}" ${linked.has(w.id) ? 'checked' : ''} style="width:auto;margin:0">
        <div class="grow"><strong>${esc(w.title)}</strong>
          <div class="muted small">${esc(fmtShortDate(w.starts_at))} · ${esc(STATUS_LABELS[w.status])}</div></div>
      </label>`).join('')}</div>` : emptyState('🎥', 'Vous n’avez encore aucun webinaire.')}
    <div class="actions">
      <button class="btn" data-close>Annuler</button>
      ${webinars.length ? '<button class="btn primary" id="save-links">Enregistrer</button>' : ''}
    </div>`);
  const save = modal.querySelector('#save-links');
  if (!save) return;
  save.addEventListener('click', async () => {
    const checked = new Set([...modal.querySelectorAll('input[type=checkbox]:checked')].map(c => c.value));
    const toAdd = webinars.filter(w => checked.has(w.id) && !linked.has(w.id));
    const toRemove = webinars.filter(w => !checked.has(w.id) && linked.has(w.id));
    save.disabled = true;
    if (toAdd.length) {
      const { error } = await sb.from('webinar_resources').insert(toAdd.map(w => ({ webinar_id: w.id, resource_id: r.id })));
      if (error) { save.disabled = false; return fail(error); }
    }
    for (const w of toRemove) {
      const { error } = await sb.from('webinar_resources').delete().eq('webinar_id', w.id).eq('resource_id', r.id);
      if (error) { save.disabled = false; return fail(error); }
    }
    // Les liens vers des webinaires d'autres encadreurs ne sont pas modifiés.
    const kept = (r.links || []).filter(l => !webinars.some(w => w.id === l.webinar?.id));
    r.links = [...kept, ...webinars.filter(w => checked.has(w.id)).map(w => ({ webinar: { id: w.id, title: w.title } }))];
    closeModal();
    toast('Associations enregistrées ✓', 'success');
    onDone();
  });
}

// Depuis un webinaire : associer des ressources déjà présentes dans la bibliothèque.
async function linkResourcesDialog(w, linkedIds, onChange = () => route()) {
  const { data: resources, error } = await sb.from('resources').select('*').order('created_at', { ascending: false });
  if (error) return fail(error);
  const linked = new Set(linkedIds);
  let changed = false;
  openModal(`
    <h2>📚 Ajouter des ressources au webinaire</h2>
    <input type="search" id="res-search" placeholder="Rechercher dans la bibliothèque…" style="margin:0">
    <div class="list" id="res-list" style="max-height:380px;overflow-y:auto"></div>
    <div class="actions"><button class="btn primary" data-close>Terminé</button></div>`);
  onModalClose = () => { if (changed) onChange(); };

  const draw = (search = '') => {
    const list = resources.filter(r => !search || `${r.title} ${r.file_name}`.toLowerCase().includes(search));
    modal.querySelector('#res-list').innerHTML = list.length ? list.map(r => {
      const t = fileType(r);
      return `<div class="list-item">
        <div class="ftype ${t}">${FILE_TYPES[t][0]}</div>
        <div class="grow"><strong>${esc(r.title)}</strong><div class="muted small">${FILE_TYPES[t][1]} · ${esc(fmtSize(r.size_bytes))}</div></div>
        ${linked.has(r.id) ? '<span class="badge ok">✓ Associée</span>' :
          `<button class="btn primary sm" data-attach="${r.id}">Associer</button>`}
      </div>`;
    }).join('') : emptyState('📚', resources.length ? 'Aucune ressource ne correspond.' :
      'La bibliothèque est vide. Utilisez « Déposer un fichier ».');
    modal.querySelectorAll('[data-attach]').forEach(b => b.addEventListener('click', async () => {
      b.disabled = true;
      const { error: err } = await sb.from('webinar_resources').insert({ webinar_id: w.id, resource_id: b.dataset.attach });
      if (err) { b.disabled = false; return fail(err); }
      linked.add(b.dataset.attach);
      changed = true;
      draw(modal.querySelector('#res-search').value.trim().toLowerCase());
    }));
  };
  draw();
  modal.querySelector('#res-search').addEventListener('input', e => draw(e.target.value.trim().toLowerCase()));
}

function bindResourceButtons(container) {
  const meta = b => ({ file_path: b.dataset.path, file_name: b.dataset.name, title: b.dataset.title });
  container.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () =>
    openResource(meta(b), b.dataset.type, 'view')));
  container.querySelectorAll('[data-download]').forEach(b => b.addEventListener('click', () =>
    openResource(meta(b), b.dataset.type, 'download')));
}

// « Voir » : PDF et images dans un nouvel onglet, vidéos dans le lecteur intégré.
// « Télécharger » : enregistre le fichier sur l'appareil, avec son nom d'origine.
async function openResource(r, type, mode = 'view') {
  if (mode === 'download' || !VIEWABLE.has(type)) {
    const { data, error } = await sb.storage.from('bibliotheque')
      .createSignedUrl(r.file_path, 600, { download: r.file_name });
    if (error) return fail(error);
    const a = document.createElement('a');
    a.href = data.signedUrl;
    a.download = r.file_name;
    document.body.append(a);
    a.click();
    a.remove();
    return toast(`Téléchargement de « ${r.title || r.file_name} »…`);
  }
  // Fenêtre ouverte tout de suite pour ne pas être bloquée par le navigateur.
  const win = type === 'video' ? null : window.open('', '_blank');
  const { data, error } = await sb.storage.from('bibliotheque').createSignedUrl(r.file_path, 3600);
  if (error) {
    if (win) win.close();
    return fail(error);
  }
  if (type === 'video') {
    openModal(`<div class="row spread"><h2 style="margin:0">${esc(r.title || r.file_name)}</h2>
        <button class="btn ghost" data-close aria-label="Fermer">✕</button></div>
      <video controls autoplay playsinline src="${esc(data.signedUrl)}"></video>
      <div class="actions"><button class="btn" id="video-download">⬇ Télécharger</button>
        <button class="btn primary" data-close>Fermer</button></div>`, { wide: true });
    modal.querySelector('#video-download').addEventListener('click', () => openResource(r, type, 'download'));
  } else if (win) {
    win.location = data.signedUrl;
  } else {
    location.href = data.signedUrl;
  }
}

const RESOURCE_SELECT = '*, owner:profiles!owner_id(full_name), links:webinar_resources(webinar:webinars(id, title))';

async function viewLibrary(view, token) {
  const { data: resources, error } = await sb.from('resources')
    .select(RESOURCE_SELECT)
    .order('created_at', { ascending: false });
  if (isStale(token)) return;
  if (error) return (view.innerHTML = `<div class="notice danger">${esc(translateError(error))}</div>`);

  const learner = profile.role === 'apprenant';
  let filter = 'tous';
  let search = '';
  let sort = 'recent';
  let layout = 'grid';
  try { layout = localStorage.getItem('webinaire.libLayout') || 'grid'; } catch (e) { /* stockage indisponible */ }

  view.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Bibliothèque</h1>
        <p class="muted">${learner
          ? 'Les supports des webinaires auxquels vous êtes inscrit : à consulter en ligne ou à télécharger.'
          : 'Ressources didactiques : PDF, vidéos, présentations, documents.'}</p>
      </div>
      ${isStaff() ? '<button class="btn primary" id="upload">＋ Déposer une ressource</button>' : ''}
    </div>
    <div class="toolbar">
      <div class="chips" id="filters"></div>
      <div class="row">
        <input class="search" id="search" type="search" placeholder="Rechercher une ressource…">
        <select id="sort" style="width:auto;margin:0" aria-label="Trier">
          <option value="recent">Plus récents</option>
          <option value="title">De A à Z</option>
          <option value="type">Par type</option>
        </select>
        <div class="seg" role="group" aria-label="Affichage">
          <button class="btn sm" data-layout="grid" title="Vignettes">▦</button>
          <button class="btn sm" data-layout="list" title="Liste">☰</button>
        </div>
      </div>
    </div>
    <div id="results"></div>`;

  const matches = r => !search ||
    `${r.title} ${r.description} ${r.file_name} ${r.owner?.full_name}`.toLowerCase().includes(search);
  const sorters = {
    recent: (a, b) => b.created_at.localeCompare(a.created_at),
    title: (a, b) => a.title.localeCompare(b.title, 'fr', { numeric: true }),
    type: (a, b) => fileType(a).localeCompare(fileType(b)) || a.title.localeCompare(b.title, 'fr', { numeric: true })
  };
  const renderList = list => layout === 'list'
    ? `<div class="card list">${list.map(resourceListRow).join('')}</div>`
    : `<div class="rgrid">${list.map(resourceCard).join('')}</div>`;

  const draw = () => {
    const searched = resources.filter(matches);
    view.querySelector('#filters').innerHTML = [['tous', '', 'Tout'], ...Object.entries(FILE_TYPES).map(([k, [ico, l]]) => [k, ico, l])]
      .map(([k, ico, l]) => {
        const n = k === 'tous' ? searched.length : searched.filter(r => fileType(r) === k).length;
        return n || k === 'tous' || k === filter
          ? `<button class="chip ${k === filter ? 'active' : ''}" data-filter="${k}">${ico} ${l} (${n})</button>` : '';
      }).join('');
    view.querySelectorAll('[data-layout]').forEach(b => b.classList.toggle('active', b.dataset.layout === layout));

    const list = searched.filter(r => filter === 'tous' || fileType(r) === filter).sort(sorters[sort]);
    const results = document.getElementById('results');
    if (!list.length) {
      results.innerHTML = `<div class="card">${emptyState('📚', resources.length ? 'Aucune ressource ne correspond.'
        : learner ? 'Aucune ressource pour le moment. Les supports apparaissent ici dès que vous êtes inscrit à un webinaire qui en propose.'
        : 'La bibliothèque est vide pour le moment.')}</div>`;
    } else if (learner) {
      // Apprenant : ressources regroupées par webinaire.
      const groups = new Map();
      list.forEach(r => (r.links || []).filter(l => l.webinar).forEach(l => {
        if (!groups.has(l.webinar.id)) groups.set(l.webinar.id, { title: l.webinar.title, items: [] });
        groups.get(l.webinar.id).items.push(r);
      }));
      results.innerHTML = [...groups.entries()].map(([id, g]) => `
        <section style="margin-bottom:24px">
          <div class="row spread" style="margin-bottom:12px">
            <h2 style="margin:0">🎥 ${esc(g.title)}</h2>
            <a class="small" href="#/webinaires/${id}">Voir le webinaire →</a>
          </div>
          ${renderList(g.items)}
        </section>`).join('');
    } else {
      results.innerHTML = renderList(list);
    }
    bindResourceButtons(results);
    results.querySelectorAll('[data-link]').forEach(b => b.addEventListener('click', () =>
      linkWebinarsDialog(resources.find(x => x.id === b.dataset.link), draw)));
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
  view.querySelector('#sort').addEventListener('change', e => { sort = e.target.value; draw(); });
  view.querySelectorAll('[data-layout]').forEach(b => b.addEventListener('click', () => {
    layout = b.dataset.layout;
    try { localStorage.setItem('webinaire.libLayout', layout); } catch (e) { /* stockage indisponible */ }
    draw();
  }));
  const up = view.querySelector('#upload');
  if (up) up.addEventListener('click', () => uploadDialog(created => { resources.unshift(created); draw(); }));
}

async function uploadDialog(onDone, presetWebinarId = '') {
  let webinars = [];
  try { webinars = await manageableWebinars(); } catch (err) { console.error(err); }

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
          ${webinars.map(w => `<option value="${w.id}" ${w.id === presetWebinarId ? 'selected' : ''}>${
            esc(w.title)} (${esc(fmtShortDate(w.starts_at))})</option>`).join('')}
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
      size_bytes: file.size
    }).select(RESOURCE_SELECT).single();
    if (e2) {
      await sb.storage.from('bibliotheque').remove([path]);
      btn.disabled = false;
      btn.textContent = 'Déposer';
      return fail(e2);
    }
    const webinarId = form.webinar_id.value;
    if (webinarId) {
      const { error: e3 } = await sb.from('webinar_resources').insert({ webinar_id: webinarId, resource_id: data.id });
      if (e3) fail(e3);
      else data.links = [{ webinar: { id: webinarId, title: webinars.find(w => w.id === webinarId)?.title || '' } }];
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
  const [{ data: users, error: e1 }, { data: invites, error: e2 }, { data: pwdRequests }] = await Promise.all([
    sb.from('profiles').select('*').order('created_at', { ascending: false }),
    sb.from('invitations').select('*').order('created_at', { ascending: false }),
    sb.from('password_requests').select('id, email, user_id, created_at, user:profiles!user_id(full_name)')
      .eq('status', 'en_attente').order('created_at')
  ]);
  if (isStale(token)) return;
  if (e1 || e2) return (view.innerHTML = `<div class="notice danger">${esc(translateError(e1 || e2))}</div>`);
  // Une seule ligne par personne, même si elle a fait plusieurs demandes.
  const pwdList = [...new Map((pwdRequests || []).map(r => [r.user_id, r])).values()];

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
    ${pwdList.length ? `<div class="card" style="margin-bottom:16px">
      <h2>🔑 Mots de passe oubliés (${pwdList.length})</h2>
      <div class="list">${pwdList.map(r => `
        <div class="list-item">
          <div class="avatar sm">${esc(initials(r.user?.full_name || r.email))}</div>
          <div class="grow"><strong>${esc(r.user?.full_name || r.email)}</strong>
            <div class="muted small">${esc(r.email)} · demande du ${esc(fmtShortDate(r.created_at))} à ${esc(fmtTime(r.created_at))}</div></div>
          <button class="btn primary sm" data-reset="${r.user_id}">Générer un mot de passe provisoire</button>
          <button class="btn ghost sm" data-ignore="${r.user_id}">Ignorer</button>
        </div>`).join('')}</div>
    </div>` : ''}
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
  view.querySelectorAll('[data-reset]').forEach(b => b.addEventListener('click', () =>
    resetUserPassword(users.find(u => u.id === b.dataset.reset) || { id: b.dataset.reset }, () => route())));
  view.querySelectorAll('[data-ignore]').forEach(b => b.addEventListener('click', async () => {
    const { error } = await sb.from('password_requests').update({ status: 'annulee', handled_at: new Date().toISOString() })
      .eq('user_id', b.dataset.ignore).eq('status', 'en_attente');
    if (error) return fail(error);
    route();
  }));
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
    sb.from('registrations').select('registered_at, status, webinar:webinars(id, title, starts_at, status)').eq('apprenant_id', u.id),
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
            <td>${regBadge(r.status)}</td>
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
      ${u.id === profile.id ? '' : '<button class="btn" id="reset-pwd">🔑 Mot de passe provisoire</button>'}
      ${u.id === profile.id ? '' : statusButton(u)}
    </div>`, { wide: true });
  const resetBtn = modal.querySelector('#reset-pwd');
  if (resetBtn) resetBtn.addEventListener('click', () => resetUserPassword(u));

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

// Admin : génère un mot de passe provisoire (fonction serveur) et prépare le message à envoyer.
async function resetUserPassword(u, onDone) {
  const name = u.full_name || u.email || 'cet utilisateur';
  if (!await confirmDialog(`Générer un mot de passe provisoire pour ${name} ?`, {
    confirmLabel: 'Générer'
  })) return;
  openModal(loading('Génération du mot de passe…'));
  let password;
  try {
    const { data, error } = await sb.functions.invoke('admin-reset-password', { body: { user_id: u.id } });
    if (error) {
      let detail = error.message;
      try { detail = (await error.context.json()).error || detail; } catch (e) { /* réponse non JSON */ }
      if (/Failed to send|non-2xx|404/i.test(detail) && !/Réservé|connecté/i.test(detail)) {
        detail = 'la fonction « admin-reset-password » n’est pas encore déployée dans Supabase.';
      }
      throw new Error(detail);
    }
    password = data.password;
  } catch (err) {
    closeModal();
    return toast(`Impossible de générer le mot de passe : ${err.message}`, 'error');
  }
  const text = `Bonjour ${u.full_name || ''},\n\nVoici votre mot de passe provisoire pour la plateforme WEBINAIRE : ${password}\n` +
    `Connectez-vous ici : ${SITE_URL}\nAdresse e-mail : ${u.email || ''}\n` +
    `Vous devrez choisir un nouveau mot de passe dès votre connexion.`;
  openModal(`
    <h2>🔑 Mot de passe provisoire</h2>
    <p class="muted">Transmettez-le à ${esc(name)} par un moyen sûr (WhatsApp, SMS, appel). Il ne sera plus affiché ensuite.</p>
    <div class="notice" style="font:600 1.4rem/1.4 Consolas, monospace;text-align:center;letter-spacing:.05em">${esc(password)}</div>
    <textarea rows="6" readonly>${esc(text)}</textarea>
    <div class="actions">
      ${u.email ? `<a class="btn" href="mailto:${esc(u.email)}?subject=${encodeURIComponent('Votre mot de passe provisoire WEBINAIRE')}&body=${encodeURIComponent(text)}">✉️ E-mail</a>` : ''}
      <a class="btn" href="https://wa.me/?text=${encodeURIComponent(text)}" target="_blank" rel="noopener">💬 WhatsApp</a>
      <button class="btn primary" id="copy-pwd">📋 Copier le message</button>
    </div>`);
  modal.querySelector('#copy-pwd').addEventListener('click', async () => {
    await navigator.clipboard.writeText(text);
    toast('Message copié ✓', 'success');
  });
  if (onDone) onModalClose = onDone;
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
    </div>
    ${profile.role === 'apprenant' ? `<div class="card row spread" style="margin-top:16px">
      <div><h2 style="margin:0 0 4px">📝 Mes inscriptions aux webinaires</h2>
        <p class="muted">Suivez vos demandes (en attente, approuvées, suspendues) et inscrivez-vous à de nouveaux webinaires.</p></div>
      <a class="btn primary" href="#/mes-inscriptions">Gérer mes inscriptions</a>
    </div>` : ''}`;

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
