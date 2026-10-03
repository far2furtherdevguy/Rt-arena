// RT Arena - networking layer: HTTP health check, WebSocket rooms, game loop.
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { Sim, CFG } from './sim.js';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I / O
const MAX_ROOMS = 200;
const IDLE_SECONDS = 20;

function cleanName(raw) {
  const s = String(raw ?? '')
    .replace(/[^\p{L}\p{N} _\-.!]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 14);
  return s || 'Player';
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

class Room {
  constructor(code, priv) {
    this.code = code;
    this.priv = priv;
    this.socks = new Map(); // player id -> ws
    this.idle = 0;
    this.sim = new Sim((e) => this.onEvent(e));
  }

  onEvent(e) {
    if (e.k === 'roster') {
      if (this.sim) this.sendRoster(); // sim is not assigned yet during construction
    }
    else this.broadcast({ t: 'ev', ...e });
  }

  sendRoster() {
    this.broadcast({ t: 'roster', code: this.code, priv: this.priv ? 1 : 0, list: this.sim.roster() });
  }

  broadcast(obj) {
    this.broadcastRaw(JSON.stringify(obj));
  }

  broadcastRaw(s) {
    for (const ws of this.socks.values()) {
      if (ws.readyState === 1 && ws.bufferedAmount < 256 * 1024) ws.send(s);
    }
  }

  join(ws, name) {
    const p = this.sim.addHuman(name);
    this.socks.set(p.id, ws);
    ws.pid = p.id;
    ws.room = this;
    this.idle = 0;
    send(ws, {
      t: 'joined',
      id: p.id,
      code: this.code,
      priv: this.priv ? 1 : 0,
      cfg: { r0: CFG.arenaR0, rmin: CFG.arenaRMin, pr: CFG.playerR, dashCd: CFG.dashCd, grace: CFG.grace },
    });
    this.sendRoster();
  }

  leave(ws) {
    if (ws.room !== this) return;
    this.socks.delete(ws.pid);
    this.sim.removePlayer(ws.pid);
    ws.room = null;
    ws.pid = 0;
    this.sendRoster();
  }
}

export function createApp(port = 0, host = '0.0.0.0') {
  const rooms = new Map();

  const server = http.createServer((req, res) => {
    const url = req.url || '/';
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (url.startsWith('/health')) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    let players = 0;
    for (const r of rooms.values()) players += r.socks.size;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ name: 'RT Arena server', rooms: rooms.size, players }));
  });

  const wss = new WebSocketServer({ server, maxPayload: 1024, perMessageDeflate: false });

  function makeRoom(priv) {
    let code = '';
    do {
      code = '';
      for (let i = 0; i < 4; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    } while (rooms.has(code));
    const room = new Room(code, priv);
    rooms.set(code, room);
    return room;
  }

  function handleJoin(ws, m) {
    if (ws.room) return;
    const fail = (msg) => send(ws, { t: 'err', m: msg });
    const name = cleanName(m.name);
    let room = null;
    if (m.mode === 'code') {
      const code = String(m.code ?? '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
      room = rooms.get(code);
      if (!room) return fail('Room not found');
      if (room.socks.size >= CFG.maxHumans) return fail('Room is full');
    } else if (m.mode === 'create') {
      if (rooms.size >= MAX_ROOMS) return fail('Server is busy, try again soon');
      room = makeRoom(true);
    } else {
      for (const r of rooms.values()) {
        if (r.priv || r.socks.size >= CFG.maxHumans) continue;
        if (!room || r.socks.size > room.socks.size) room = r;
      }
      if (!room) {
        if (rooms.size >= MAX_ROOMS) return fail('Server is busy, try again soon');
        room = makeRoom(false);
      }
    }
    ws.joined = true;
    room.join(ws, name);
  }

  wss.on('connection', (ws) => {
    ws.alive = true;
    ws.joined = false;
    ws.room = null;
    ws.pid = 0;
    ws.winStart = Date.now();
    ws.cnt = 0;
    ws.on('error', () => {});
    ws.on('pong', () => {
      ws.alive = true;
    });
    const joinTimer = setTimeout(() => {
      if (!ws.joined) ws.close(1008, 'join timeout');
    }, 10000);

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const now = Date.now();
      if (now - ws.winStart > 1000) {
        ws.winStart = now;
        ws.cnt = 0;
      }
      if (++ws.cnt > 80) {
        ws.close(1008, 'rate limit');
        return;
      }
      let m;
      try {
        m = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!m || typeof m.t !== 'string') return;
      switch (m.t) {
        case 'ping':
          send(ws, { t: 'pong', c: Number(m.c) || 0 });
          break;
        case 'join':
          handleJoin(ws, m);
          break;
        case 'in':
          if (ws.room) ws.room.sim.setInput(ws.pid, m.dx, m.dz, m.d);
          break;
        case 'leave':
          if (ws.room) ws.room.leave(ws);
          break;
        default:
          break;
      }
    });

    ws.on('close', () => {
      clearTimeout(joinTimer);
      if (ws.room) ws.room.leave(ws);
    });
  });

  // heartbeat: drop dead connections
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) {
        ws.terminate();
        continue;
      }
      ws.alive = false;
      try {
        ws.ping();
      } catch {
        /* ignore */
      }
    }
  }, 15000);

  // game loop (fixed 30 Hz steps)
  const STEP = 1 / CFG.tick;
  let last = performance.now();
  let acc = 0;
  let sinceSnap = 1;
  const SNAP_EVERY = 0.045; // ~20 snapshots/second saves mobile data and battery
  const loop = setInterval(() => {
    const now = performance.now();
    const real = Math.min((now - last) / 1000, 0.25);
    last = now;
    acc += real;
    let stepped = false;
    while (acc >= STEP) {
      for (const r of rooms.values()) r.sim.step(STEP);
      acc -= STEP;
      stepped = true;
    }
    sinceSnap += real;
    const sendSnap = stepped && sinceSnap >= SNAP_EVERY;
    if (sendSnap) sinceSnap = 0;
    for (const [code, r] of rooms) {
      if (r.socks.size === 0) {
        r.idle += real;
        if (r.idle > IDLE_SECONDS) {
          rooms.delete(code);
          continue;
        }
      } else {
        r.idle = 0;
        if (sendSnap) r.broadcastRaw(JSON.stringify(r.sim.snapshot()));
      }
    }
  }, 15);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      resolve({
        server,
        wss,
        rooms,
        port: typeof addr === 'object' && addr ? addr.port : port,
        close() {
          clearInterval(loop);
          clearInterval(heartbeat);
          for (const ws of wss.clients) ws.terminate();
          wss.close();
          return new Promise((res) => server.close(() => res()));
        },
      });
    });
  });
}
