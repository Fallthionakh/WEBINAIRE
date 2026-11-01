// WEBINAIRE – prototype front-end de gestion de webinaires.
// Toutes les données sont stockées dans le localStorage du navigateur.
// Les onglets d'un même navigateur se synchronisent via l'événement "storage".

const STORAGE_KEY = 'webinaire.v1';
const SESSION_KEY = 'webinaire.session';

let state = loadState();
let roomTab = 'chat';

// Scène de l'organisateur : caméra, partage d'écran ou présentation.
const PDFJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
let cameraStream = null;
let cameraPending = false;
let cameraError = false;
let screenStream = null;
let stageMode = 'camera'; // 'camera' | 'screen' | 'slides'
let slides = null;        // { webinarId, name, kind: 'pdf' | 'images', doc, urls, page, count }
let pdfjsPromise = null;
let stageToken = 0;

// ---------- Données ----------

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* stockage indisponible : on repart de zéro */ }
  return { users: [], webinars: [] };
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) { /* stockage indisponible */ }
}

function currentUser() {
  let id = null;
  try { id = localStorage.getItem(SESSION_KEY); } catch (e) { /* ignore */ }
  return state.users.find(u => u.id === id) || null;
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function getWebinar(id) {
  return state.webinars.find(w => w.id === id);
}

function isOrganizer(user) {
  return user && user.role === 'organisateur';
}

// ---------- Utilitaires ----------

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function formatDate(w) {
  const d = new Date(`${w.date}T${w.time || '00:00'}`);
  return d.toLocaleString('fr-FR', { dateStyle: 'full', timeStyle: 'short' });
}

function formatPrice(price) {
  return price > 0 ? `${price.toLocaleString('fr-FR')} FCFA` : 'Gratuit';
}

function statusBadge(w) {
  if (w.status === 'live') return '<span class="badge live">● En direct</span>';
  if (w.status === 'done') return '<span class="badge done">Terminé</span>';
  return '<span class="badge">Planifié</span>';
}

function userName(id) {
  const u = state.users.find(x => x.id === id);
  return u ? u.name : 'Inconnu';
}

// ---------- Rendu ----------

const app = document.getElementById('app');

function render() {
  const user = currentUser();
  document.getElementById('nav').hidden = !user;
  if (user) {
    document.getElementById('current-user').textContent =
      `${user.name} (${user.role})`;
  }

  if (!user) return renderLogin();

  const hash = location.hash || '#/';
  const roomMatch = hash.match(/^#\/webinaire\/(.+)$/);
  if (roomMatch) return renderRoom(roomMatch[1], user);
  if (hash === '#/analytics') return renderAnalytics();
  if (hash === '#/nouveau' && isOrganizer(user)) return renderNewForm();
  renderList(user);
}

// 👥 Gestion des utilisateurs
function renderLogin() {
  stopMedia();
  app.innerHTML = `
    <div class="card stack" style="max-width:420px;margin:40px auto">
      <h1>Bienvenue</h1>
      <p class="muted">Entrez votre nom et votre rôle pour accéder à la plateforme.</p>
      <form id="login-form" class="stack">
        <label>Nom complet
          <input name="name" required maxlength="60" autocomplete="name">
        </label>
        <label>E-mail
          <input name="email" type="email" required maxlength="100" autocomplete="email">
        </label>
        <label>Rôle
          <select name="role">
            <option value="participant">Participant</option>
            <option value="organisateur">Organisateur</option>
          </select>
        </label>
        <button class="btn" type="submit">Entrer</button>
      </form>
    </div>`;

  document.getElementById('login-form').addEventListener('submit', e => {
    e.preventDefault();
    const data = new FormData(e.target);
    const email = data.get('email').trim().toLowerCase();
    let user = state.users.find(u => u.email === email);
    if (!user) {
      user = { id: uid(), email, name: '', role: 'participant' };
      state.users.push(user);
    }
    user.name = data.get('name').trim();
    user.role = data.get('role');
    saveState();
    try { localStorage.setItem(SESSION_KEY, user.id); } catch (err) { /* ignore */ }
    location.hash = '#/';
    render();
  });
}

// 📅 Planification des webinaires
function renderList(user) {
  stopMedia();
  const sorted = [...state.webinars].sort((a, b) =>
    `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));

  const cards = sorted.map(w => {
    const registered = w.registrations.includes(user.id);
    const full = w.capacity > 0 && w.registrations.length >= w.capacity;
    return `
      <article class="card stack">
        <div class="row spread">${statusBadge(w)}<strong>${esc(formatPrice(w.price))}</strong></div>
        <h2>${esc(w.title)}</h2>
        <div class="muted">${esc(formatDate(w))} · ${esc(w.duration)} min</div>
        <div>🎤 ${esc(w.speaker)}</div>
        <div class="muted">${w.registrations.length}${w.capacity ? ' / ' + w.capacity : ''} inscrit(s)</div>
        <div class="row">
          <a class="btn secondary" href="#/webinaire/${w.id}">Ouvrir</a>
          ${w.status !== 'done' ? `
            <button class="btn" data-register="${w.id}" ${!registered && full ? 'disabled' : ''}>
              ${registered ? 'Se désinscrire' : full ? 'Complet' : "S'inscrire"}
            </button>` : ''}
        </div>
      </article>`;
  }).join('');

  app.innerHTML = `
    <div class="row spread" style="margin-bottom:16px">
      <h1 style="margin:0">Webinaires</h1>
      ${isOrganizer(user) ? '<a class="btn" href="#/nouveau">+ Nouveau webinaire</a>' : ''}
    </div>
    ${cards ? `<div class="grid">${cards}</div>` :
      `<div class="card muted">Aucun webinaire pour l'instant.${isOrganizer(user) ? ' Créez le premier !' : ''}</div>`}`;

  app.querySelectorAll('[data-register]').forEach(btn => {
    btn.addEventListener('click', () => toggleRegistration(btn.dataset.register, user));
  });
}

function toggleRegistration(id, user) {
  const w = getWebinar(id);
  const i = w.registrations.indexOf(user.id);
  if (i >= 0) w.registrations.splice(i, 1);
  else w.registrations.push(user.id);
  saveState();
  render();
}

function renderNewForm() {
  stopMedia();
  const today = new Date().toISOString().slice(0, 10);
  app.innerHTML = `
    <div class="card stack">
      <h1>Nouveau webinaire</h1>
      <form id="new-form" class="stack">
        <label>Titre <input name="title" required maxlength="120"></label>
        <label>Description <textarea name="description" rows="3" maxlength="1000"></textarea></label>
        <div class="form-grid">
          <label>Intervenant <input name="speaker" required maxlength="80"></label>
          <label>Date <input name="date" type="date" required min="${today}" value="${today}"></label>
          <label>Heure <input name="time" type="time" required value="10:00"></label>
          <label>Durée (min) <input name="duration" type="number" min="15" step="15" value="60" required></label>
          <label>Places (0 = illimité) <input name="capacity" type="number" min="0" value="100"></label>
          <label>💰 Prix en FCFA (0 = gratuit) <input name="price" type="number" min="0" step="500" value="0"></label>
        </div>
        <div class="row">
          <button class="btn" type="submit">Planifier</button>
          <a class="btn secondary" href="#/">Annuler</a>
        </div>
      </form>
    </div>`;

  document.getElementById('new-form').addEventListener('submit', e => {
    e.preventDefault();
    const d = new FormData(e.target);
    const w = {
      id: uid(),
      ownerId: currentUser().id,
      title: d.get('title').trim(),
      description: d.get('description').trim(),
      speaker: d.get('speaker').trim(),
      date: d.get('date'),
      time: d.get('time'),
      duration: Number(d.get('duration')),
      capacity: Number(d.get('capacity')) || 0,
      price: Number(d.get('price')) || 0,
      status: 'scheduled',
      registrations: [],
      attendees: [],
      messages: [],
      polls: []
    };
    state.webinars.push(w);
    saveState();
    location.hash = `#/webinaire/${w.id}`;
  });
}

// 🎬 Diffusion en direct + 💬 Interaction en temps réel
function renderRoom(id, user) {
  const w = getWebinar(id);
  if (!w) {
    app.innerHTML = '<div class="card">Webinaire introuvable. <a href="#/">Retour</a></div>';
    return;
  }
  const isHost = w.ownerId === user.id;
  if (slides && slides.webinarId !== id) clearSlides();

  if (w.status === 'live' && !w.attendees.includes(user.id)) {
    w.attendees.push(user.id);
    saveState();
  }

  let stage;
  if (w.status === 'live' && isHost) {
    stage = '<div id="stage-host" class="stage-host"></div>';
  } else if (w.status === 'live') {
    stage = `<div><div class="badge live">● En direct</div><p>${esc(w.speaker)} présente en ce moment.</p>
      ${stageInfo(w)}
      <p class="muted">La vidéo des participants sera reliée au serveur WebRTC dans une prochaine version.</p></div>`;
  } else if (w.status === 'done') {
    stage = '<div>Ce webinaire est terminé.</div>';
  } else {
    stage = `<div>Début prévu : ${esc(formatDate(w))}</div>`;
  }

  app.innerHTML = `
    <p><a href="#/">← Tous les webinaires</a></p>
    <div class="row spread" style="margin-bottom:12px">
      <h1 style="margin:0">${esc(w.title)}</h1>
      ${statusBadge(w)}
    </div>
    <div class="room">
      <section class="stack">
        <div class="stage">${stage}</div>
        ${isHost ? `
          <div class="row">
            ${w.status === 'scheduled' ? '<button class="btn danger" id="go-live">🎬 Démarrer le direct</button>' : ''}
            ${w.status === 'live' ? `
              <button class="btn secondary ${stageMode === 'camera' ? 'active' : ''}" data-mode="camera">📷 Caméra</button>
              ${canShareScreen() ? `<button class="btn secondary ${stageMode === 'screen' ? 'active' : ''}" data-mode="screen">🖥️ Partager l'écran</button>` : ''}
              <label class="btn secondary ${stageMode === 'slides' ? 'active' : ''}">📑 Présentation
                <input type="file" id="slides-input" accept="application/pdf,image/*" multiple hidden>
              </label>
              <button class="btn secondary" id="fullscreen">⛶ Plein écran</button>
              <button class="btn secondary" id="end-live">Terminer le direct</button>` : ''}
          </div>
          ${w.status === 'live' && slides ? `
            <div class="row">
              <button class="btn secondary" data-slide="-1" aria-label="Diapositive précédente">◀</button>
              <span id="slide-pos">${slides.page} / ${slides.count}</span>
              <button class="btn secondary" data-slide="1" aria-label="Diapositive suivante">▶</button>
              <span class="muted">${esc(slides.name)}</span>
              ${stageMode !== 'slides' ? '<button class="btn-link" data-mode="slides">Afficher</button>' : ''}
              <button class="btn-link" id="close-slides">Fermer</button>
            </div>` : ''}` : ''}
        <div class="card stack">
          <div>🎤 <strong>${esc(w.speaker)}</strong> · ${esc(w.duration)} min · ${esc(formatPrice(w.price))}</div>
          ${w.description ? `<p style="margin:0">${esc(w.description)}</p>` : ''}
          <div class="muted">${w.registrations.length} inscrit(s) · ${w.attendees.length} participant(s) au direct</div>
        </div>
      </section>
      <aside class="card">
        <div class="tabs">
          <button data-tab="chat" class="${roomTab === 'chat' ? 'active' : ''}">💬 Chat</button>
          <button data-tab="qa" class="${roomTab === 'qa' ? 'active' : ''}">❓ Q&amp;R</button>
          <button data-tab="polls" class="${roomTab === 'polls' ? 'active' : ''}">📊 Sondages</button>
        </div>
        <div id="panel"></div>
      </aside>
    </div>`;

  app.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => {
    roomTab = b.dataset.tab;
    renderRoom(id, user);
  }));

  const goLive = document.getElementById('go-live');
  if (goLive) goLive.addEventListener('click', () => {
    w.status = 'live';
    saveState();
    renderRoom(id, user);
  });
  const endLive = document.getElementById('end-live');
  if (endLive) endLive.addEventListener('click', () => {
    w.status = 'done';
    w.stage = null;
    saveState();
    stopMedia();
    renderRoom(id, user);
  });

  app.querySelectorAll('[data-mode]').forEach(b =>
    b.addEventListener('click', () => setStageMode(b.dataset.mode, id)));
  app.querySelectorAll('[data-slide]').forEach(b =>
    b.addEventListener('click', () => changeSlide(Number(b.dataset.slide))));

  const slidesInput = document.getElementById('slides-input');
  if (slidesInput) slidesInput.addEventListener('change', () => loadSlides([...slidesInput.files], id));

  const closeSlides = document.getElementById('close-slides');
  if (closeSlides) closeSlides.addEventListener('click', () => {
    clearSlides();
    if (stageMode === 'slides') stageMode = 'camera';
    publishStage(id);
    render();
  });

  const fullscreen = document.getElementById('fullscreen');
  if (fullscreen) fullscreen.addEventListener('click', () => {
    const el = document.querySelector('.stage');
    if (el.requestFullscreen) el.requestFullscreen();
  });

  if (w.status === 'live' && isHost) {
    ensureCamera();
    renderStage();
  } else {
    stopMedia();
  }

  renderPanel(w, user, isHost);
}

function renderPanel(w, user, isHost) {
  const panel = document.getElementById('panel');
  const canPost = w.status !== 'done';

  if (roomTab === 'polls') {
    const polls = w.polls.map(p => {
      const total = p.options.reduce((n, o) => n + o.votes.length, 0);
      const voted = p.options.some(o => o.votes.includes(user.id));
      return `<div class="stack" style="margin-bottom:16px">
        <strong>${esc(p.question)}</strong>
        ${p.options.map((o, i) => {
          const pct = total ? Math.round(o.votes.length * 100 / total) : 0;
          return `<div>
            <div class="row spread">
              ${voted || !canPost ? `<span>${esc(o.label)}</span>` :
                `<button class="btn-link" data-vote="${p.id}:${i}">${esc(o.label)}</button>`}
              <span class="muted">${pct}%</span>
            </div>
            <div class="bar-track"><div class="bar" style="width:${pct}%"></div></div>
          </div>`;
        }).join('')}
      </div>`;
    }).join('') || '<p class="muted">Aucun sondage.</p>';

    panel.innerHTML = polls + (isHost && canPost ? `
      <form id="poll-form" class="stack">
        <input name="question" placeholder="Question du sondage" required maxlength="140">
        <input name="options" placeholder="Choix séparés par des virgules" required maxlength="300">
        <button class="btn" type="submit">Lancer le sondage</button>
      </form>` : '');

    panel.querySelectorAll('[data-vote]').forEach(b => b.addEventListener('click', () => {
      const [pollId, idx] = b.dataset.vote.split(':');
      w.polls.find(p => p.id === pollId).options[Number(idx)].votes.push(user.id);
      saveState();
      renderPanel(w, user, isHost);
    }));

    const form = document.getElementById('poll-form');
    if (form) form.addEventListener('submit', e => {
      e.preventDefault();
      const d = new FormData(form);
      const options = d.get('options').split(',').map(s => s.trim()).filter(Boolean);
      if (options.length < 2) return alert('Il faut au moins deux choix.');
      w.polls.push({
        id: uid(),
        question: d.get('question').trim(),
        options: options.map(label => ({ label, votes: [] }))
      });
      saveState();
      renderPanel(w, user, isHost);
    });
    return;
  }

  const type = roomTab === 'qa' ? 'question' : 'chat';
  let items = w.messages.filter(m => m.type === type);
  if (type === 'question') items = [...items].sort((a, b) => b.votes.length - a.votes.length);

  panel.innerHTML = `
    <div class="messages" id="messages">
      ${items.map(m => `<div class="msg">
        <strong>${esc(m.name)}</strong>${esc(m.text)}
        ${type === 'question' ? `<button class="btn-link" data-upvote="${m.id}">▲ ${m.votes.length}</button>` : ''}
      </div>`).join('') || `<p class="muted">${type === 'question' ? 'Aucune question.' : 'Aucun message.'}</p>`}
    </div>
    ${canPost ? `<form id="msg-form" class="row" style="margin-top:8px">
      <input name="text" required maxlength="500" style="flex:1;margin:0"
        placeholder="${type === 'question' ? 'Posez une question…' : 'Votre message…'}">
      <button class="btn" type="submit">Envoyer</button>
    </form>` : ''}`;

  const box = document.getElementById('messages');
  box.scrollTop = type === 'chat' ? box.scrollHeight : 0;

  panel.querySelectorAll('[data-upvote]').forEach(b => b.addEventListener('click', () => {
    const m = w.messages.find(x => x.id === b.dataset.upvote);
    if (!m.votes.includes(user.id)) m.votes.push(user.id);
    saveState();
    renderPanel(w, user, isHost);
  }));

  const form = document.getElementById('msg-form');
  if (form) form.addEventListener('submit', e => {
    e.preventDefault();
    const text = new FormData(form).get('text').trim();
    if (!text) return;
    w.messages.push({ id: uid(), type, userId: user.id, name: user.name, text, ts: Date.now(), votes: [] });
    saveState();
    renderPanel(w, user, isHost);
    document.querySelector('#msg-form input').focus();
  });
}

// Ce que les participants voient décrit (la vidéo arrivera avec le serveur WebRTC).
function stageInfo(w) {
  const s = w.stage;
  if (!s || s.mode === 'camera') return '';
  if (s.mode === 'screen') return "<p>🖥️ Partage d'écran en cours</p>";
  return `<p>📑 Présentation : ${esc(s.name)} – diapositive ${esc(s.page)} / ${esc(s.count)}</p>`;
}

function publishStage(id) {
  const w = getWebinar(id);
  if (!w) return;
  w.stage = { mode: stageMode };
  if (stageMode === 'slides' && slides) {
    Object.assign(w.stage, { name: slides.name, page: slides.page, count: slides.count });
  }
  saveState();
}

function canShareScreen() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
}

async function ensureCamera() {
  if (cameraStream || cameraPending || cameraError) return;
  cameraPending = true;
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    // L'organisateur a quitté la salle pendant la demande d'autorisation.
    if (!document.getElementById('stage-host')) stopMedia();
  } catch (e) {
    cameraError = true;
  }
  cameraPending = false;
  renderStage();
}

async function setStageMode(mode, id) {
  if (mode === 'screen') {
    if (!screenStream) {
      try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      } catch (e) {
        return; // partage annulé par l'utilisateur
      }
      // Bouton « Arrêter le partage » du navigateur.
      screenStream.getVideoTracks()[0].addEventListener('ended', () => {
        screenStream = null;
        if (stageMode === 'screen') setStageMode('camera', id);
      });
    }
  } else if (screenStream) {
    screenStream.getTracks().forEach(t => t.stop());
    screenStream = null;
  }
  stageMode = mode;
  publishStage(id);
  render();
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
async function loadSlides(files, id) {
  if (!files.length) return;
  let next;
  try {
    if (files[0].type === 'application/pdf') {
      const pdfjs = await loadPdfJs();
      const doc = await pdfjs.getDocument({ data: await files[0].arrayBuffer() }).promise;
      next = { webinarId: id, name: files[0].name, kind: 'pdf', doc, page: 1, count: doc.numPages };
    } else {
      const images = files
        .filter(f => f.type.startsWith('image/'))
        .sort((a, b) => a.name.localeCompare(b.name, 'fr', { numeric: true }));
      if (!images.length) throw new Error('format non pris en charge');
      next = {
        webinarId: id,
        name: images.length > 1 ? `${images.length} images` : images[0].name,
        kind: 'images',
        urls: images.map(f => URL.createObjectURL(f)),
        page: 1,
        count: images.length
      };
    }
  } catch (e) {
    alert("Impossible d'ouvrir ce fichier. Utilisez un PDF ou des images.\n" +
      'Depuis PowerPoint : Fichier → Exporter → PDF.');
    return;
  }
  clearSlides();
  slides = next;
  stageMode = 'slides';
  if (screenStream) {
    screenStream.getTracks().forEach(t => t.stop());
    screenStream = null;
  }
  publishStage(id);
  render();
}

function changeSlide(delta) {
  if (!slides) return;
  const page = Math.min(slides.count, Math.max(1, slides.page + delta));
  if (page === slides.page) return;
  slides.page = page;
  publishStage(slides.webinarId);
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

// 📊 Analytics & Reporting
function renderAnalytics() {
  stopMedia();
  const ws = state.webinars;
  const registrations = ws.reduce((n, w) => n + w.registrations.length, 0);
  const attendees = ws.reduce((n, w) => n + w.attendees.length, 0);
  const messages = ws.reduce((n, w) => n + w.messages.length, 0);
  const revenue = ws.reduce((n, w) => n + w.price * w.registrations.length, 0);
  const rate = registrations ? Math.round(attendees * 100 / registrations) : 0;

  const stat = (label, value) =>
    `<div class="card"><div class="muted">${label}</div><div class="stat">${value}</div></div>`;

  app.innerHTML = `
    <h1>Analytics</h1>
    <div class="grid" style="margin-bottom:16px">
      ${stat('Webinaires', ws.length)}
      ${stat('Inscriptions', registrations)}
      ${stat('Taux de présence', rate + ' %')}
      ${stat('Messages et questions', messages)}
      ${stat('💰 Revenus estimés', formatPrice(revenue).replace('Gratuit', '0 FCFA'))}
    </div>
    <div class="card table-wrap">
      <table>
        <thead><tr><th>Webinaire</th><th>Statut</th><th>Inscrits</th><th>Présents</th><th>Messages</th><th>Revenus</th></tr></thead>
        <tbody>
          ${ws.map(w => `<tr>
            <td><a href="#/webinaire/${w.id}">${esc(w.title)}</a><div class="muted">${esc(userName(w.ownerId))}</div></td>
            <td>${statusBadge(w)}</td>
            <td>${w.registrations.length}</td>
            <td>${w.attendees.length}</td>
            <td>${w.messages.length}</td>
            <td>${esc(formatPrice(w.price * w.registrations.length).replace('Gratuit', '0 FCFA'))}</td>
          </tr>`).join('') || '<tr><td colspan="6" class="muted">Aucune donnée.</td></tr>'}
        </tbody>
      </table>
    </div>`;
}

// ---------- Démarrage ----------

document.getElementById('logout').addEventListener('click', () => {
  try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
  location.hash = '#/';
  render();
});

window.addEventListener('hashchange', render);

// Flèches du clavier pour changer de diapositive.
document.addEventListener('keydown', e => {
  if (!slides || stageMode !== 'slides') return;
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (e.key === 'ArrowRight' || e.key === 'PageDown') changeSlide(1);
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') changeSlide(-1);
});

// Synchronisation temps réel entre onglets du même navigateur.
window.addEventListener('storage', e => {
  if (e.key !== STORAGE_KEY && e.key !== SESSION_KEY) return;
  state = loadState();
  const active = document.activeElement;
  if (active && active.tagName === 'INPUT' && active.value) return; // ne pas effacer une saisie en cours
  render();
});

render();
