// RT Arena - pure game simulation (no network code, fully testable).
// World is the X/Z plane. +x = right on screen, +z = up on screen. y = height.

export const CFG = {
  tick: 30, // simulation steps per second
  maxHumans: 8, // humans per room
  fillTo: 6, // bots fill the room up to this many participants
  playerR: 0.65, // player radius
  arenaR0: 14, // starting platform radius
  arenaRMin: 5.5, // smallest platform radius
  grace: 8, // seconds before the ring starts shrinking
  shrink: 50, // seconds the ring takes to shrink to min
  acc: 22, // movement acceleration
  friction: 3.0, // velocity damping (terminal speed ~ acc / friction)
  dashSpeed: 15,
  dashTime: 0.28,
  dashCd: 1.5,
  dashKnock: 9, // extra knockback a dash adds on hit
  restitution: 0.85,
  gravity: 26,
  killY: -14,
  firstWait: 4, // first countdown when a room is created
  countdown: 3, // countdown between rounds
  overTime: 4, // time the winner banner stays
};

const BOT_NAMES = ['Bolt', 'Pogo', 'Nova', 'Rex', 'Zig', 'Moxie', 'Taco', 'Blip', 'Waffle', 'Comet', 'Pixel', 'Yeti'];
const COLOR_COUNT = 10;

const r2 = (v) => Math.round(v * 100) / 100;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export class Sim {
  constructor(emit = () => {}, rng = Math.random) {
    this.emit = emit;
    this.rng = rng;
    this.players = new Map();
    this.nextId = 1;
    this.time = 0;
    this.round = 0;
    this.hitCd = new Map();
    this.beginRound(CFG.firstWait);
  }

  // ---------- roster ----------
  humanCount() {
    let n = 0;
    for (const p of this.players.values()) if (!p.bot) n++;
    return n;
  }

  freeColor() {
    const used = new Set();
    for (const p of this.players.values()) used.add(p.color);
    for (let i = 0; i < COLOR_COUNT; i++) if (!used.has(i)) return i;
    return Math.floor(this.rng() * COLOR_COUNT);
  }

  botName() {
    const used = new Set();
    for (const p of this.players.values()) used.add(p.name);
    for (const n of BOT_NAMES) if (!used.has(n)) return n;
    return 'Bot' + this.nextId;
  }

  makePlayer(name, bot) {
    const p = {
      id: this.nextId++,
      name,
      bot,
      color: this.freeColor(),
      x: 0, z: 0, vx: 0, vz: 0, y: 0, vy: 0, a: 0,
      st: 0, // 0 = out/spectating, 1 = alive, 2 = falling
      dashT: 0, dashCd: 0, dashReq: false, lastD: 0, hit: new Set(),
      in: { dx: 0, dz: 0 },
      wins: 0,
      lastHit: 0, lastHitT: -99,
      botT: 0, skill: 0.7 + this.rng() * 0.25,
    };
    this.players.set(p.id, p);
    return p;
  }

  // Adds a human. Does NOT emit; the caller sends the roster.
  addHuman(name) {
    const p = this.makePlayer(name, false);
    if (this.phase === 'countdown') {
      this.fillBots();
      this.layout();
    }
    return p;
  }

  removePlayer(id) {
    this.players.delete(id);
  }

  fillBots() {
    const want = Math.max(0, CFG.fillTo - this.humanCount());
    const bots = [];
    for (const p of this.players.values()) if (p.bot) bots.push(p);
    while (bots.length > want) this.players.delete(bots.pop().id);
    while (bots.length < want) bots.push(this.makePlayer(this.botName(), true));
  }

  // ---------- rounds ----------
  beginRound(wait) {
    this.round++;
    this.phase = 'countdown';
    this.timer = wait;
    this.elapsed = 0;
    this.radius = CFG.arenaR0;
    this.winnerId = 0;
    this.hitCd.clear();
    this.fillBots();
    this.layout();
    this.emit({ k: 'roster' });
  }

  layout() {
    const list = [...this.players.values()];
    const n = list.length;
    const off = this.rng() * Math.PI * 2;
    const rr = CFG.arenaR0 * 0.55;
    list.forEach((p, i) => {
      const ang = off + (i / n) * Math.PI * 2;
      p.x = Math.cos(ang) * rr;
      p.z = Math.sin(ang) * rr;
      p.vx = p.vz = 0;
      p.y = 0;
      p.vy = 0;
      p.a = Math.atan2(-p.x, -p.z);
      p.st = 1;
      p.dashT = 0;
      p.dashCd = 0;
      p.dashReq = false;
      p.in = { dx: 0, dz: 0 };
      p.lastHit = 0;
      p.lastHitT = -99;
    });
    this.startN = n;
  }

  // ---------- input ----------
  setInput(id, dx, dz, d) {
    const p = this.players.get(id);
    if (!p || p.bot) return;
    dx = Number(dx);
    dz = Number(dz);
    if (!Number.isFinite(dx) || !Number.isFinite(dz)) return;
    const m = Math.hypot(dx, dz);
    if (m > 1) {
      dx /= m;
      dz /= m;
    }
    p.in.dx = dx;
    p.in.dz = dz;
    d = Number(d);
    if (Number.isFinite(d) && d !== p.lastD) {
      p.lastD = d;
      p.dashReq = true;
    }
  }

  // ---------- simulation ----------
  step(dt) {
    this.time += dt;
    if (this.phase === 'countdown') {
      for (const p of this.players.values()) p.dashReq = false;
      this.timer -= dt;
      if (this.timer <= 0) {
        this.phase = 'play';
        this.timer = 0;
        this.elapsed = 0;
        this.emit({ k: 'go' });
      }
    } else if (this.phase === 'play') {
      this.elapsed += dt;
      const s = clamp((this.elapsed - CFG.grace) / CFG.shrink, 0, 1);
      this.radius = CFG.arenaR0 - (CFG.arenaR0 - CFG.arenaRMin) * s;
      this.think(dt);
      this.physics(dt);
      this.checkWin();
    } else {
      this.timer -= dt;
      this.physics(dt);
      if (this.timer <= 0) this.beginRound(CFG.countdown);
    }
  }

  think(dt) {
    for (const p of this.players.values()) {
      if (!p.bot || p.st !== 1) continue;
      p.botT -= dt;
      if (p.botT > 0) continue;
      p.botT = 0.12 + this.rng() * 0.12;
      let best = null;
      let bd = Infinity;
      for (const q of this.players.values()) {
        if (q === p || q.st !== 1) continue;
        const d = Math.hypot(q.x - p.x, q.z - p.z);
        if (d < bd) {
          bd = d;
          best = q;
        }
      }
      let tx = 0;
      let tz = 0;
      if (best) {
        tx = best.x - p.x;
        tz = best.z - p.z;
        const l = Math.hypot(tx, tz) || 1;
        tx /= l;
        tz /= l;
      }
      const dist = Math.hypot(p.x, p.z);
      const safe = this.radius - 3.2;
      if (dist > safe) {
        const w = clamp((dist - safe) / 2.5, 0, 1);
        const l = dist || 1;
        tx = tx * (1 - w) + (-p.x / l) * w * 1.6;
        tz = tz * (1 - w) + (-p.z / l) * w * 1.6;
      }
      tx += (this.rng() - 0.5) * 0.5;
      tz += (this.rng() - 0.5) * 0.5;
      const m = Math.hypot(tx, tz) || 1;
      p.in = { dx: (tx / m) * p.skill, dz: (tz / m) * p.skill };
      if (best && bd < 3.0 && p.dashCd <= 0 && dist < this.radius - 2.5 && this.rng() < 0.35) p.dashReq = true;
    }
  }

  dash(p) {
    p.vx = Math.sin(p.a) * CFG.dashSpeed;
    p.vz = Math.cos(p.a) * CFG.dashSpeed;
    p.dashT = CFG.dashTime;
    p.dashCd = CFG.dashCd;
    p.hit = new Set();
    this.emit({ k: 'dash', id: p.id });
  }

  physics(dt) {
    const alive = [];
    for (const p of this.players.values()) {
      if (p.st === 2) {
        p.vy -= CFG.gravity * dt;
        p.y += p.vy * dt;
        p.x += p.vx * dt;
        p.z += p.vz * dt;
        if (p.y < CFG.killY) p.st = 0;
        continue;
      }
      if (p.st !== 1) continue;
      alive.push(p);
      p.dashCd = Math.max(0, p.dashCd - dt);
      if (p.dashT > 0) p.dashT = Math.max(0, p.dashT - dt);
      if (p.dashReq) {
        p.dashReq = false;
        if (p.dashCd <= 0) this.dash(p);
      }
      const { dx, dz } = p.in;
      p.vx += dx * CFG.acc * dt;
      p.vz += dz * CFG.acc * dt;
      const k = Math.exp(-CFG.friction * dt);
      p.vx *= k;
      p.vz *= k;
      if (dx * dx + dz * dz > 0.02) p.a = Math.atan2(dx, dz);
      p.x += p.vx * dt;
      p.z += p.vz * dt;
    }

    // player vs player
    const min = CFG.playerR * 2;
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i];
        const b = alive[j];
        let dx = b.x - a.x;
        let dz = b.z - a.z;
        let d = Math.hypot(dx, dz);
        if (d >= min) continue;
        if (d < 1e-6) {
          dx = this.rng() - 0.5;
          dz = this.rng() - 0.5;
          d = Math.hypot(dx, dz) || 1;
        }
        const nx = dx / d;
        const nz = dz / d;
        const overlap = min - d;
        a.x -= (nx * overlap) / 2;
        a.z -= (nz * overlap) / 2;
        b.x += (nx * overlap) / 2;
        b.z += (nz * overlap) / 2;
        const rel = (a.vx - b.vx) * nx + (a.vz - b.vz) * nz;
        if (rel > 0) {
          const J = ((1 + CFG.restitution) * rel) / 2;
          a.vx -= J * nx;
          a.vz -= J * nz;
          b.vx += J * nx;
          b.vz += J * nz;
        }
        if (rel > 1.5) {
          a.lastHit = b.id;
          a.lastHitT = this.time;
          b.lastHit = a.id;
          b.lastHitT = this.time;
        }
        if (a.dashT > 0 && !a.hit.has(b.id)) {
          a.hit.add(b.id);
          b.vx += nx * CFG.dashKnock;
          b.vz += nz * CFG.dashKnock;
          a.vx -= nx * CFG.dashKnock * 0.25;
          a.vz -= nz * CFG.dashKnock * 0.25;
          b.lastHit = a.id;
          b.lastHitT = this.time;
        }
        if (b.dashT > 0 && !b.hit.has(a.id)) {
          b.hit.add(a.id);
          a.vx -= nx * CFG.dashKnock;
          a.vz -= nz * CFG.dashKnock;
          b.vx += nx * CFG.dashKnock * 0.25;
          b.vz += nz * CFG.dashKnock * 0.25;
          a.lastHit = b.id;
          a.lastHitT = this.time;
        }
        if (rel > 2.5) {
          const key = a.id < b.id ? a.id + '-' + b.id : b.id + '-' + a.id;
          const last = this.hitCd.get(key) ?? -99;
          if (this.time - last > 0.2) {
            this.hitCd.set(key, this.time);
            this.emit({ k: 'hit', a: a.id, b: b.id, f: r2(Math.min(rel, 20)) });
          }
        }
      }
    }

    // edge of the platform
    for (const p of alive) {
      if (Math.hypot(p.x, p.z) > this.radius + CFG.playerR * 0.5) {
        p.st = 2;
        p.vy = 0;
        p.dashT = 0;
        const by = p.lastHit && this.time - p.lastHitT < 3 ? p.lastHit : 0;
        this.emit({ k: 'fall', id: p.id, by });
      }
    }
  }

  checkWin() {
    if (this.startN < 2) return;
    let n = 0;
    let last = null;
    for (const p of this.players.values()) {
      if (p.st === 1) {
        n++;
        last = p;
      }
    }
    if (n > 1) return;
    this.phase = 'over';
    this.timer = CFG.overTime;
    this.winnerId = last ? last.id : 0;
    if (last) last.wins++;
    for (const p of this.players.values()) if (p.bot) p.in = { dx: 0, dz: 0 };
    this.emit({ k: 'win', id: this.winnerId });
    this.emit({ k: 'roster' });
  }

  // ---------- network views ----------
  snapshot() {
    const p = [];
    for (const q of this.players.values()) {
      p.push([q.id, r2(q.x), r2(q.z), r2(q.vx), r2(q.vz), r2(q.y), r2(q.a), q.st | (q.dashT > 0 ? 4 : 0), r2(q.dashCd)]);
    }
    return { t: 's', ph: this.phase, tm: r2(Math.max(0, this.timer)), el: r2(this.elapsed), r: r2(this.radius), w: this.winnerId, p };
  }

  roster() {
    const list = [];
    for (const q of this.players.values()) list.push({ id: q.id, n: q.name, c: q.color, b: q.bot ? 1 : 0, w: q.wins });
    return list;
  }
}
