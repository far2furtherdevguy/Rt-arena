// RT Arena client: Babylon.js renderer + WebSocket networking + touch/keyboard controls.
import {
  Engine,
  Scene,
  ArcRotateCamera,
  Vector3,
  Matrix,
  HemisphericLight,
  DirectionalLight,
  MeshBuilder,
  StandardMaterial,
  Color3,
  Color4,
  DynamicTexture,
  TransformNode,
} from '@babylonjs/core';

// ───────────────────────── helpers ─────────────────────────
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

const LS = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v === null ? d : v;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* storage unavailable */
    }
  },
};

const COLORS = ['#ef4444', '#3b82f6', '#22c55e', '#f59e0b', '#a855f7', '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#84cc16'];

// defaults; replaced by the server's values on join
let CFG = { r0: 14, rmin: 5.5, pr: 0.65, dashCd: 1.5, grace: 8, acc: 22, friction: 3, dashSpeed: 15, dashTime: 0.28 };

function normalizeServerUrl(v) {
  let s = String(v || '').trim();
  if (!s) return '';
  if (/^https:\/\//i.test(s)) s = 'wss://' + s.slice(8);
  else if (/^http:\/\//i.test(s)) s = 'ws://' + s.slice(7);
  else if (!/^wss?:\/\//i.test(s)) s = 'wss://' + s;
  return s.replace(/\/+$/, '');
}

function serverUrl() {
  const q = new URLSearchParams(location.search).get('server');
  if (q) return normalizeServerUrl(q);
  const saved = LS.get('rt_server', '');
  if (saved) return normalizeServerUrl(saved);
  const env = import.meta.env && import.meta.env.VITE_SERVER_URL;
  if (env) return normalizeServerUrl(env);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.hostname || 'localhost'}:2567`;
}

// ───────────────────────── sound (tiny synth, no files) ─────────────────────────
let actx = null;
let soundOn = LS.get('rt_sound', '1') === '1';
function audioInit() {
  try {
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
  } catch {
    actx = null;
  }
}
function tone(freq, dur, type = 'sine', vol = 0.12, slide = 0) {
  if (!actx || !soundOn) return;
  try {
    const t = actx.currentTime;
    const o = actx.createOscillator();
    const g = actx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(actx.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  } catch {
    /* ignore audio errors */
  }
}
const sfx = {
  dash: () => tone(260, 0.16, 'sawtooth', 0.08, 380),
  hit: (f) => tone(110 + Math.min(f, 14) * 8, 0.12, 'square', 0.1, -50),
  fall: () => tone(520, 0.55, 'triangle', 0.12, -440),
  win: () => {
    tone(523, 0.14, 'triangle', 0.12);
    setTimeout(() => tone(659, 0.14, 'triangle', 0.12), 120);
    setTimeout(() => tone(784, 0.3, 'triangle', 0.12), 240);
  },
  go: () => tone(660, 0.25, 'square', 0.08),
  tick: () => tone(440, 0.08, 'sine', 0.08),
};
function buzz(ms) {
  try {
    if (navigator.vibrate) navigator.vibrate(ms);
  } catch {
    /* ignore */
  }
}

// ───────────────────────── renderer ─────────────────────────
const canvas = $('c');
const labelsEl = $('labels');
const engine = new Engine(canvas, true, { adaptToDeviceRatio: false, antialias: true, powerPreference: 'high-performance' });
const QUALITY = [
  { name: 'Low', s: 1.6 },
  { name: 'Medium', s: 1.15 },
  { name: 'High', s: 0.8 },
];
let quality = clamp(parseInt(LS.get('rt_quality', '1'), 10) || 0, 0, 2);
function applyQuality() {
  engine.setHardwareScalingLevel(QUALITY[quality].s);
  $('quality').textContent = 'Graphics: ' + QUALITY[quality].name;
}
applyQuality();
$('sound').textContent = 'Sound: ' + (soundOn ? 'On' : 'Off');

const scene = new Scene(engine);
scene.clearColor = new Color4(0.04, 0.05, 0.1, 1);
scene.skipPointerMovePicking = true;

const camera = new ArcRotateCamera('cam', -Math.PI / 2, 0.95, 25, new Vector3(0, 0, 0), scene);
camera.minZ = 0.5;
camera.maxZ = 200;
camera.fov = 0.8;

const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene);
hemi.intensity = 0.85;
hemi.groundColor = new Color3(0.2, 0.22, 0.35);
const sun = new DirectionalLight('sun', new Vector3(-0.4, -1, 0.35), scene);
sun.intensity = 0.65;

const matCache = new Map();
function makeMat(hex, emissiveMul = 0.12) {
  const key = hex + '|' + emissiveMul;
  let m = matCache.get(key);
  if (m) return m;
  m = new StandardMaterial('m' + key, scene);
  const c = Color3.FromHexString(hex);
  m.diffuseColor = c;
  m.emissiveColor = c.scale(emissiveMul);
  m.specularColor = new Color3(0.25, 0.25, 0.25);
  matCache.set(key, m);
  return m;
}

function makeArenaTexture() {
  const t = new DynamicTexture('arenaTex', { width: 512, height: 512 }, scene, true);
  const g = t.getContext();
  g.fillStyle = '#23375e';
  g.fillRect(0, 0, 512, 512);
  g.strokeStyle = 'rgba(255,255,255,0.10)';
  g.lineWidth = 3;
  for (let r = 40; r < 256; r += 40) {
    g.beginPath();
    g.arc(256, 256, r, 0, Math.PI * 2);
    g.stroke();
  }
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    g.beginPath();
    g.moveTo(256, 256);
    g.lineTo(256 + Math.cos(a) * 256, 256 + Math.sin(a) * 256);
    g.stroke();
  }
  g.fillStyle = 'rgba(255,255,255,0.07)';
  g.beginPath();
  g.arc(256, 256, 28, 0, Math.PI * 2);
  g.fill();
  t.update();
  return t;
}

const arenaMat = new StandardMaterial('arenaMat', scene);
arenaMat.diffuseTexture = makeArenaTexture();
arenaMat.specularColor = new Color3(0.05, 0.05, 0.05);
const arena = MeshBuilder.CreateCylinder('arena', { height: 1.2, diameter: 28, tessellation: 64 }, scene);
arena.position.y = -0.6;
arena.material = arenaMat;

const edgeMat = new StandardMaterial('edgeMat', scene);
edgeMat.diffuseColor = new Color3(1, 0.45, 0.15);
edgeMat.emissiveColor = new Color3(1, 0.4, 0.1);
const edge = MeshBuilder.CreateTorus('edge', { diameter: 28, thickness: 0.4, tessellation: 64 }, scene);
edge.position.y = 0.02;
edge.material = edgeMat;

const shadowMat = new StandardMaterial('shadowMat', scene);
shadowMat.diffuseColor = new Color3(0, 0, 0);
shadowMat.emissiveColor = new Color3(0, 0, 0);
shadowMat.specularColor = new Color3(0, 0, 0);
shadowMat.alpha = 0.35;
shadowMat.backFaceCulling = false;

const noseMat = makeMat('#ffffff', 0.5);

// a few floating cubes in the void so the world has depth
for (let i = 0; i < 10; i++) {
  const s = 0.8 + Math.random() * 2;
  const b = MeshBuilder.CreateBox('d' + i, { size: s }, scene);
  const ang = Math.random() * Math.PI * 2;
  const rad = 22 + Math.random() * 22;
  b.position.set(Math.cos(ang) * rad, -6 - Math.random() * 14, Math.sin(ang) * rad);
  b.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
  b.material = makeMat(COLORS[i % COLORS.length], 0.1);
  b.isPickable = false;
  b.freezeWorldMatrix();
  b.doNotSyncBoundingInfo = true;
}

// ───────────────────────── game state ─────────────────────────
const views = new Map(); // player id -> view
const rosterInfo = new Map(); // player id -> {id,n,c,b,w}
let myId = 0;
let roomCode = '';
let inGame = false;
let phase = 'countdown';
let phaseTimer = 0;
let elapsed = 0;
let winnerId = 0;
let targetR = 14;
let curR = 14;
let lastSnapAt = 0;
let lastTickSec = -1;
let aliveCount = 0;
let ws = null;
let pingMs = 0;

function setText(el, txt) {
  if (el._t !== txt) {
    el._t = txt;
    el.textContent = txt;
  }
}

function makeView(info) {
  const root = new TransformNode('p' + info.id, scene);
  const body = MeshBuilder.CreateSphere('b' + info.id, { diameter: 1.3, segments: 16 }, scene);
  body.parent = root;
  body.position.y = 0.65;
  body.material = makeMat(COLORS[info.c % COLORS.length], 0.18);
  body.isPickable = false;
  const nose = MeshBuilder.CreateSphere('n' + info.id, { diameter: 0.42, segments: 8 }, scene);
  nose.parent = root;
  nose.position.set(0, 0.75, 0.56);
  nose.material = noseMat;
  nose.isPickable = false;
  const blob = MeshBuilder.CreateDisc('s' + info.id, { radius: 0.78, tessellation: 20 }, scene);
  blob.rotation.x = Math.PI / 2;
  blob.position.y = 0.03;
  blob.material = shadowMat;
  blob.isPickable = false;
  const el = document.createElement('div');
  el.className = 'lbl' + (info.id === myId ? ' me' : '');
  el.textContent = info.n;
  labelsEl.appendChild(el);
  return {
    id: info.id,
    info,
    root,
    body,
    nose,
    blob,
    el,
    x: 0, z: 0, y: 0, a: 0,
    tx: 0, tz: 0, ty: 0, ta: 0,
    vx: 0, vz: 0,
    st: 0,
    dashing: false,
    cd: 0,
    pulse: 0,
    fresh: true,
  };
}

function disposeView(v) {
  v.body.dispose();
  v.nose.dispose();
  v.blob.dispose();
  v.root.dispose();
  v.el.remove();
}

function clearViews() {
  for (const v of views.values()) disposeView(v);
  views.clear();
  rosterInfo.clear();
}

// ───────────────────────── input ─────────────────────────
const keys = new Set();
let stickX = 0;
let stickY = 0;
let stickActive = false;
let dashCounter = 0;

const zone = $('zone');
const stickBase = $('stickBase');
const stickKnob = $('stickKnob');
let stickPointer = -1;
let stickOx = 0; // client coordinates of the current stick centre
let stickOy = 0;
let stickMax = 60;
let defX = 100; // default stick centre, relative to the zone
let defY = 200;

function placeStick(x, y) {
  stickBase.style.left = x + 'px';
  stickBase.style.top = y + 'px';
}
function layoutStick() {
  const r = zone.getBoundingClientRect();
  const size = stickBase.offsetWidth || 150;
  stickMax = size * 0.4;
  defX = size / 2 + 30;
  defY = Math.max(size / 2 + 10, r.height - size / 2 - 30);
  if (!stickActive) placeStick(defX, defY);
}
function stickMove(e) {
  let dx = e.clientX - stickOx;
  let dy = e.clientY - stickOy;
  const len = Math.hypot(dx, dy);
  if (len > stickMax) {
    dx = (dx / len) * stickMax;
    dy = (dy / len) * stickMax;
  }
  stickKnob.style.transform = `translate(${dx}px, ${dy}px)`;
  stickX = dx / stickMax;
  stickY = dy / stickMax;
  if (Math.hypot(stickX, stickY) < 0.1) {
    stickX = 0;
    stickY = 0;
  }
  sendInput(false);
}
function stickEnd() {
  stickPointer = -1;
  stickActive = false;
  stickX = 0;
  stickY = 0;
  stickKnob.style.transform = 'translate(0px, 0px)';
  stickBase.classList.remove('active');
  placeStick(defX, defY);
}
zone.addEventListener('pointerdown', (e) => {
  if (stickPointer !== -1 || !inGame) return;
  e.preventDefault();
  stickPointer = e.pointerId;
  stickActive = true;
  const r = zone.getBoundingClientRect();
  const lx = e.clientX - r.left;
  const ly = e.clientY - r.top;
  // touching on/near the visible stick uses it as it is; touching elsewhere moves the stick under your thumb
  if (Math.hypot(lx - defX, ly - defY) <= stickBase.offsetWidth * 0.9) {
    stickOx = r.left + defX;
    stickOy = r.top + defY;
  } else {
    stickOx = e.clientX;
    stickOy = e.clientY;
    placeStick(lx, ly);
  }
  stickBase.classList.add('active');
  try {
    zone.setPointerCapture(e.pointerId);
  } catch {
    /* ignore */
  }
  stickMove(e);
});
zone.addEventListener('pointermove', (e) => {
  if (e.pointerId === stickPointer) {
    e.preventDefault();
    stickMove(e);
  }
});
zone.addEventListener('pointerup', (e) => {
  if (e.pointerId === stickPointer) stickEnd();
});
zone.addEventListener('pointercancel', (e) => {
  if (e.pointerId === stickPointer) stickEnd();
});
window.addEventListener('resize', layoutStick);
window.addEventListener('orientationchange', () => setTimeout(layoutStick, 250));

// Client-side prediction: the local player moves instantly using the same rules as the server,
// then is gently pulled toward the server's authoritative state.
const pred = { on: false, x: 0, z: 0, vx: 0, vz: 0, a: 0, dashT: 0, dashCd: 0 };

function predictStep(dt, me, since) {
  if (!(inGame && phase === 'play' && me && me.st === 1)) {
    pred.on = false;
    return;
  }
  if (!pred.on) {
    pred.on = true;
    pred.x = me.x;
    pred.z = me.z;
    pred.vx = me.vx;
    pred.vz = me.vz;
    pred.a = me.a;
    pred.dashT = 0;
    pred.dashCd = me.cd;
  }
  const v = currentVector();
  pred.dashCd = Math.max(0, pred.dashCd - dt);
  pred.dashT = Math.max(0, pred.dashT - dt);
  pred.vx += v.dx * CFG.acc * dt;
  pred.vz += v.dz * CFG.acc * dt;
  const k = Math.exp(-CFG.friction * dt);
  pred.vx *= k;
  pred.vz *= k;
  if (v.dx * v.dx + v.dz * v.dz > 0.02) pred.a = Math.atan2(v.dx, v.dz);
  pred.x += pred.vx * dt;
  pred.z += pred.vz * dt;

  // where the server probably is right now
  const lat = pingMs / 2000 + since;
  const ex = me.tx + me.vx * lat;
  const ez = me.tz + me.vz * lat;
  const err = Math.hypot(ex - pred.x, ez - pred.z);
  if (err > 3) {
    pred.x = ex;
    pred.z = ez;
    pred.vx = me.vx;
    pred.vz = me.vz;
  } else {
    const gain = err > 0.8 ? 10 : 3;
    const c = 1 - Math.exp(-gain * dt);
    pred.x += (ex - pred.x) * c;
    pred.z += (ez - pred.z) * c;
    const cv = 1 - Math.exp(-gain * 0.6 * dt);
    pred.vx += (me.vx - pred.vx) * cv;
    pred.vz += (me.vz - pred.vz) * cv;
  }
}

function doDash() {
  if (!inGame) return;
  dashCounter = (dashCounter + 1) % 1000000;
  sendInput(true);
  buzz(15);
  if (pred.on && pred.dashCd <= 0) {
    pred.vx = Math.sin(pred.a) * CFG.dashSpeed;
    pred.vz = Math.cos(pred.a) * CFG.dashSpeed;
    pred.dashT = CFG.dashTime;
    pred.dashCd = CFG.dashCd;
    sfx.dash();
  }
}
$('dash').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  doDash();
});

window.addEventListener('keydown', (e) => {
  if (!inGame) return;
  const k = e.key.toLowerCase();
  if (k === ' ' || k === 'shift' || k === 'j') {
    e.preventDefault();
    if (!e.repeat) doDash();
    return;
  }
  keys.add(k);
});
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
window.addEventListener('blur', () => keys.clear());

function currentVector() {
  if (stickActive && (stickX !== 0 || stickY !== 0)) return { dx: stickX, dz: -stickY };
  let x = 0;
  let z = 0;
  if (keys.has('a') || keys.has('arrowleft')) x -= 1;
  if (keys.has('d') || keys.has('arrowright')) x += 1;
  if (keys.has('w') || keys.has('arrowup')) z += 1;
  if (keys.has('s') || keys.has('arrowdown')) z -= 1;
  const m = Math.hypot(x, z);
  if (m > 1) {
    x /= m;
    z /= m;
  }
  return { dx: x, dz: z };
}

let lastSent = { dx: 9, dz: 9, d: -1, t: 0 };
function sendInput(force) {
  if (!ws || ws.readyState !== 1 || !inGame) return;
  const v = document.hidden ? { dx: 0, dz: 0 } : currentVector();
  const now = performance.now();
  const same =
    Math.abs(v.dx - lastSent.dx) < 0.02 && Math.abs(v.dz - lastSent.dz) < 0.02 && dashCounter === lastSent.d && now - lastSent.t < 250;
  if (same && !force) return;
  if (!force && now - lastSent.t < 25) return;
  lastSent = { dx: v.dx, dz: v.dz, d: dashCounter, t: now };
  ws.send(JSON.stringify({ t: 'in', dx: Math.round(v.dx * 100) / 100, dz: Math.round(v.dz * 100) / 100, d: dashCounter }));
}
setInterval(() => sendInput(false), 33);
setInterval(() => {
  if (ws && ws.readyState === 1 && inGame) ws.send(JSON.stringify({ t: 'ping', c: Date.now() }));
}, 2000);

// ───────────────────────── HUD ─────────────────────────
const feedEl = $('feed');
const bannerEl = $('banner');
let bannerTimer = 0;

function banner(text, color) {
  bannerEl.textContent = text;
  bannerEl.style.color = color || '#fff';
  bannerEl.style.setProperty('--dur', '1400ms');
  bannerEl.classList.remove('show');
  void bannerEl.offsetWidth; // restart the CSS animation
  bannerEl.classList.add('show');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => bannerEl.classList.remove('show'), 1500);
}

function feed(text) {
  const d = document.createElement('div');
  d.textContent = text;
  feedEl.appendChild(d);
  while (feedEl.children.length > 4) feedEl.firstChild.remove();
  setTimeout(() => d.remove(), 3500);
}

const nameOf = (id) => (rosterInfo.get(id) ? rosterInfo.get(id).n : 'Someone');
const colorOf = (id) => (rosterInfo.get(id) ? COLORS[rosterInfo.get(id).c % COLORS.length] : '#fff');

function updateBoard() {
  const list = [...rosterInfo.values()].sort((a, b) => b.w - a.w || a.id - b.id).slice(0, 6);
  const el = $('board');
  el.textContent = '';
  for (const p of list) {
    const row = document.createElement('div');
    if (p.id === myId) row.className = 'me';
    const dot = document.createElement('i');
    dot.style.background = COLORS[p.c % COLORS.length];
    const nm = document.createElement('span');
    nm.textContent = (p.b ? '\u{1F916} ' : '') + p.n;
    const w = document.createElement('b');
    w.textContent = String(p.w);
    row.appendChild(dot);
    row.appendChild(nm);
    row.appendChild(w);
    el.appendChild(row);
  }
}

function updateHud() {
  const me = views.get(myId);
  let txt = '';
  let sub = '';
  if (phase === 'countdown') {
    const n = Math.max(1, Math.ceil(phaseTimer));
    txt = `Get ready… ${n}`;
    if (n !== lastTickSec) {
      lastTickSec = n;
      sfx.tick();
    }
  } else if (phase === 'play') {
    lastTickSec = -1;
    if (!me || me.st === 0) txt = 'Spectating - next round soon';
    else if (me.st === 2) txt = 'Falling!';
    else txt = elapsed < CFG.grace ? 'Shove them off!' : 'The ring is shrinking!';
    sub = `${aliveCount} left`;
  } else {
    txt = winnerId ? `${nameOf(winnerId)} wins!` : 'No winner';
  }
  setText($('msg'), txt);
  setText($('sub'), sub);
  setText($('ping'), pingMs ? `${pingMs} ms` : '');
  $('ping').style.color = pingMs < 80 ? '#34d399' : pingMs < 150 ? '#fbbf24' : '#fb7185';
}

// ───────────────────────── networking ─────────────────────────
const statusEl = $('status');
function setStatus(t, err) {
  statusEl.textContent = t || '';
  statusEl.style.color = err ? '' : '#94a3b8';
}

function setButtons(busy) {
  for (const id of ['play', 'create', 'join']) $(id).disabled = busy;
}

function showMenu(msg, err) {
  inGame = false;
  stickEnd();
  $('menu').classList.remove('hide');
  $('hud').classList.remove('on');
  bannerEl.classList.remove('show');
  clearViews();
  setStatus(msg || '', err);
  setButtons(false);
}

let historyPushed = false;
let wakeLock = null;
async function keepAwake() {
  try {
    if (navigator.wakeLock && inGame && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
      });
    }
  } catch {
    wakeLock = null;
  }
}

function showGame() {
  inGame = true;
  $('menu').classList.add('hide');
  $('hud').classList.add('on');
  setStatus('');
  setButtons(false);
  layoutStick();
  requestAnimationFrame(layoutStick);
  keepAwake();
  try {
    if (!historyPushed) {
      history.pushState({ rtGame: 1 }, '');
      historyPushed = true;
    }
  } catch {
    /* ignore */
  }
}

// Android back button / browser back: leave the match instead of closing the app
window.addEventListener('popstate', () => {
  if (historyPushed) {
    historyPushed = false;
    if (inGame) leave();
  }
});

let connectToken = 0;

function connect(mode, code) {
  audioInit();
  const name = $('name').value.trim() || 'Player';
  LS.set('rt_name', name);
  setButtons(true);
  const token = ++connectToken;
  const url = serverUrl();
  const MAX_TRIES = 6;
  // Inside the installed app there is no local server, so "localhost" means nobody set an address yet.
  if (location.protocol === 'https:' && /^wss:\/\/localhost(:|$)/i.test(url)) {
    setStatus('No server address yet. Tap "Server" below and enter your server (wss://...).', true);
    setButtons(false);
    return;
  }

  const attempt = (n) => {
    if (token !== connectToken) return;
    setStatus(n === 1 ? 'Connecting…' : `Waking up the server… (try ${n}/${MAX_TRIES})`);
    let opened = false;
    let settled = false;
    let sock;
    try {
      sock = new WebSocket(url);
    } catch {
      setStatus('Bad server address. Tap "Server" to fix it.', true);
      setButtons(false);
      return;
    }
    const failTimer = setTimeout(() => {
      if (!opened) {
        try {
          sock.close();
        } catch {
          /* ignore */
        }
      }
    }, 9000);
    sock.onopen = () => {
      opened = true;
      clearTimeout(failTimer);
      ws = sock;
      sock.send(JSON.stringify({ t: 'join', name, mode, code }));
    };
    sock.onmessage = (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      settled = true;
      handle(m, sock);
    };
    sock.onerror = () => {};
    sock.onclose = () => {
      clearTimeout(failTimer);
      if (token !== connectToken) return;
      if (!opened) {
        if (n < MAX_TRIES) setTimeout(() => attempt(n + 1), 1500);
        else {
          setStatus(`Cannot reach the server (${url}). Check the server address.`, true);
          setButtons(false);
        }
      } else if (inGame) {
        showMenu('Disconnected from the server.', true);
      } else if (!settled) {
        setStatus('Connection closed. Try again.', true);
        setButtons(false);
      }
    };
  };
  attempt(1);
}

function leave() {
  connectToken++;
  if (ws) {
    try {
      ws.send(JSON.stringify({ t: 'leave' }));
    } catch {
      /* ignore */
    }
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
  ws = null;
  showMenu('');
  if (historyPushed) {
    historyPushed = false;
    try {
      history.back();
    } catch {
      /* ignore */
    }
  }
}

function handle(m, sock) {
  switch (m.t) {
    case 'joined':
      myId = m.id;
      roomCode = m.code;
      if (m.cfg) CFG = { ...CFG, ...m.cfg };
      curR = targetR = CFG.r0;
      lastSent = { dx: 9, dz: 9, d: -1, t: 0 };
      dashCounter = 0;
      pingMs = 0;
      showGame();
      break;
    case 'roster':
      onRoster(m);
      break;
    case 's':
      onSnap(m);
      break;
    case 'ev':
      onEvent(m);
      break;
    case 'pong':
      pingMs = clamp(Date.now() - m.c, 0, 9999);
      break;
    case 'err':
      setStatus(m.m || 'Could not join.', true);
      setButtons(false);
      connectToken++;
      try {
        sock.close();
      } catch {
        /* ignore */
      }
      if (ws === sock) ws = null;
      break;
    default:
      break;
  }
}

function onRoster(m) {
  const seen = new Set();
  for (const info of m.list) {
    seen.add(info.id);
    rosterInfo.set(info.id, info);
    const v = views.get(info.id);
    if (!v) views.set(info.id, makeView(info));
    else {
      v.info = info;
      if (v.el.textContent !== info.n) v.el.textContent = info.n;
    }
  }
  for (const [id, v] of [...views]) {
    if (!seen.has(id)) {
      disposeView(v);
      views.delete(id);
      rosterInfo.delete(id);
    }
  }
  if (m.code) {
    roomCode = m.code;
  }
  const chip = $('roomchip');
  chip.hidden = !roomCode;
  chip.textContent = 'Room ' + roomCode;
  updateBoard();
}

function onSnap(m) {
  lastSnapAt = performance.now();
  phase = m.ph;
  phaseTimer = m.tm;
  elapsed = m.el;
  targetR = m.r;
  winnerId = m.w;
  let alive = 0;
  for (const a of m.p) {
    const v = views.get(a[0]);
    if (!v) continue;
    const st = a[7] & 3;
    const far = Math.hypot(a[1] - v.x, a[2] - v.z) > 4 || Math.abs(a[5] - v.y) > 3;
    v.tx = a[1];
    v.tz = a[2];
    v.vx = a[3];
    v.vz = a[4];
    v.ty = a[5];
    v.ta = a[6];
    v.dashing = (a[7] & 4) !== 0;
    v.cd = a[8];
    if (v.fresh || far) {
      v.x = v.tx;
      v.z = v.tz;
      v.y = v.ty;
      v.a = v.ta;
      v.fresh = false;
    }
    v.st = st;
    if (st === 1) alive++;
  }
  aliveCount = alive;
  updateHud();
}

function onEvent(m) {
  const me = myId;
  switch (m.k) {
    case 'go':
      banner('FIGHT!', '#fde68a');
      sfx.go();
      buzz(30);
      break;
    case 'dash':
      if (m.id !== me) sfx.dash();
      break;
    case 'hit': {
      sfx.hit(m.f || 3);
      for (const id of [m.a, m.b]) {
        const v = views.get(id);
        if (v) v.pulse = 1;
      }
      if (m.a === me || m.b === me) buzz(25);
      break;
    }
    case 'fall': {
      sfx.fall();
      const who = nameOf(m.id);
      feed(m.by ? `${nameOf(m.by)} knocked ${who} off!` : `${who} fell off`);
      if (m.id === me) {
        banner(m.by ? 'KNOCKED OFF!' : 'YOU FELL!', '#fca5a5');
        buzz(120);
      }
      break;
    }
    case 'win': {
      if (m.id) {
        sfx.win();
        banner(m.id === me ? 'YOU WIN!' : `${nameOf(m.id)} wins!`, m.id === me ? '#fde68a' : colorOf(m.id));
      } else banner('Draw!', '#e5e7eb');
      break;
    }
    default:
      break;
  }
}

// ───────────────────────── render loop ─────────────────────────
const tmpV = new Vector3();
const dashBtn = $('dash');

scene.onBeforeRenderObservable.add(() => {
  const dt = Math.min(engine.getDeltaTime() / 1000, 0.1);
  const since = Math.min((performance.now() - lastSnapAt) / 1000, 0.12);
  const kp = 1 - Math.exp(-14 * dt);
  const ka = 1 - Math.exp(-16 * dt);

  curR += (targetR - curR) * (1 - Math.exp(-8 * dt));
  const s = Math.max(0.05, curR / CFG.r0);
  arena.scaling.x = arena.scaling.z = s;
  edge.scaling.x = edge.scaling.z = s;

  const vp = camera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight());
  const tm = scene.getTransformMatrix();
  const sx = canvas.clientWidth / Math.max(1, engine.getRenderWidth());
  const sy = canvas.clientHeight / Math.max(1, engine.getRenderHeight());

  const meV = views.get(myId);
  predictStep(dt, meV, since);

  for (const v of views.values()) {
    const px = v.tx + v.vx * since;
    const pz = v.tz + v.vz * since;
    v.x += (px - v.x) * kp;
    v.z += (pz - v.z) * kp;
    v.y += (v.ty - v.y) * kp;
    const local = v === meV && pred.on;
    if (local) {
      v.x = pred.x;
      v.z = pred.z;
    }
    let da = (local ? pred.a : v.ta) - v.a;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    v.a += da * ka;

    const visible = v.st !== 0 && inGame;
    v.root.setEnabled(visible);
    v.blob.setEnabled(visible && v.st === 1);
    if (!visible) {
      v.el.style.display = 'none';
      continue;
    }
    v.root.position.set(v.x, v.y, v.z);
    v.root.rotation.y = v.a;
    v.blob.position.x = v.x;
    v.blob.position.z = v.z;

    v.pulse = Math.max(0, v.pulse - dt * 5);
    const sq = 1 + 0.22 * v.pulse;
    if (v.dashing || (local && pred.dashT > 0)) v.body.scaling.set(0.88, 0.88, 1.35);
    else v.body.scaling.set(sq, 1 / sq, sq);

    tmpV.set(v.x, v.y + 1.95, v.z);
    const p = Vector3.Project(tmpV, Matrix.IdentityReadOnly, tm, vp);
    v.el.style.display = 'block';
    v.el.style.transform = `translate(${(p.x * sx).toFixed(1)}px, ${(p.y * sy).toFixed(1)}px) translate(-50%, -100%)`;
  }

  const me = views.get(myId);

  // dash button cooldown ring (dark wedge shrinks as it recharges)
  if (me && me.st === 1) {
    const frac = clamp(me.cd / CFG.dashCd, 0, 1);
    dashBtn.style.setProperty('--cd', (frac * 360).toFixed(0) + 'deg');
    dashBtn.classList.toggle('ready', frac <= 0.001);
  } else {
    dashBtn.style.setProperty('--cd', '360deg');
    dashBtn.classList.remove('ready');
  }
});

engine.runRenderLoop(() => scene.render());
window.addEventListener('resize', () => engine.resize());

// ───────────────────────── menu wiring ─────────────────────────
$('name').value = LS.get('rt_name', '');
$('play').addEventListener('click', () => connect('quick'));
$('create').addEventListener('click', () => connect('create'));
$('join').addEventListener('click', () => {
  const code = $('code').value.trim().toUpperCase();
  if (code.length !== 4) {
    setStatus('Enter the 4-letter room code.', true);
    return;
  }
  connect('code', code);
});
$('code').addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '');
});
$('quality').addEventListener('click', () => {
  quality = (quality + 1) % QUALITY.length;
  LS.set('rt_quality', String(quality));
  applyQuality();
});
$('sound').addEventListener('click', () => {
  soundOn = !soundOn;
  LS.set('rt_sound', soundOn ? '1' : '0');
  $('sound').textContent = 'Sound: ' + (soundOn ? 'On' : 'Off');
  audioInit();
  if (soundOn) sfx.go();
});
$('server').addEventListener('click', () => {
  const cur = LS.get('rt_server', '');
  const v = window.prompt('Server address (e.g. wss://my-game.onrender.com). Leave empty to use the default.', cur || serverUrl());
  if (v === null) return;
  LS.set('rt_server', v.trim());
  setStatus(v.trim() ? 'Server set to ' + normalizeServerUrl(v) : 'Using the default server.');
});
$('leave').addEventListener('click', leave);
$('roomchip').addEventListener('click', async () => {
  const text = `Join my RT Arena room: ${roomCode}`;
  try {
    if (navigator.share) await navigator.share({ text });
    else if (navigator.clipboard) {
      await navigator.clipboard.writeText(roomCode);
      feed('Room code copied');
    }
  } catch {
    /* user cancelled */
  }
});
document.addEventListener('visibilitychange', () => {
  sendInput(true);
  if (!document.hidden) keepAwake();
});
document.addEventListener('contextmenu', (e) => e.preventDefault());

let slowChecks = 0;
setInterval(() => {
  if (!inGame || document.hidden) {
    slowChecks = 0;
    return;
  }
  if (engine.getFps() < 38) slowChecks++;
  else slowChecks = 0;
  if (slowChecks >= 3 && quality > 0) {
    quality--;
    slowChecks = 0;
    LS.set('rt_quality', String(quality));
    applyQuality();
    feed('Graphics lowered for smoother play');
  }
}, 2000);

showMenu('');
