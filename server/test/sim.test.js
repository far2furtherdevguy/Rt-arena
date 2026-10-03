import test from 'node:test';
import assert from 'node:assert/strict';
import { Sim, CFG } from '../sim.js';

function seeded(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function finite(sim) {
  for (const p of sim.players.values()) {
    for (const k of ['x', 'z', 'vx', 'vz', 'y', 'a']) assert.ok(Number.isFinite(p[k]), `${p.name}.${k} is not finite`);
  }
}

test('room starts in countdown with bots filling to fillTo', () => {
  const sim = new Sim(() => {}, seeded(3));
  sim.addHuman('Me');
  assert.equal(sim.humanCount(), 1);
  assert.equal(sim.players.size, CFG.fillTo);
  assert.equal(sim.phase, 'countdown');
});

test('bots shrink away as humans join', () => {
  const sim = new Sim(() => {}, seeded(4));
  for (let i = 0; i < 3; i++) sim.addHuman('H' + i);
  assert.equal(sim.players.size, CFG.fillTo);
  assert.equal([...sim.players.values()].filter((p) => p.bot).length, CFG.fillTo - 3);
  for (let i = 3; i < CFG.fillTo; i++) sim.addHuman('H' + i);
  assert.equal(sim.players.size, CFG.fillTo);
  assert.equal([...sim.players.values()].filter((p) => p.bot).length, 0);
});

test('rounds finish, a winner is crowned and a new round starts (bots only fight)', () => {
  const events = [];
  const sim = new Sim((e) => events.push(e), seeded(7));
  sim.addHuman('Me'); // human never moves and will fall off when the ring shrinks
  let wins = 0;
  const dt = 1 / CFG.tick;
  for (let i = 0; i < CFG.tick * 400; i++) {
    sim.step(dt);
    if (i % 30 === 0) finite(sim);
    if (events.some((e) => e.k === 'win')) wins++;
    events.length = 0;
  }
  finite(sim);
  assert.ok(wins > 0 || sim.round > 1, 'at least one round should have completed');
  assert.ok(sim.round >= 2, 'a second round should have begun');
});

test('dash has a cooldown and moves the player', () => {
  const sim = new Sim(() => {}, seeded(11));
  const me = sim.addHuman('Me');
  const dt = 1 / CFG.tick;
  while (sim.phase === 'countdown') sim.step(dt);
  me.x = 0;
  me.z = 0;
  me.vx = 0;
  me.vz = 0;
  me.a = 0; // facing +z
  sim.setInput(me.id, 0, 0, 1); // dash pulse
  sim.step(dt);
  assert.ok(me.vz > 5, 'dash should launch the player forward');
  assert.ok(me.dashCd > 1, 'cooldown should be running');
  const v = me.vz;
  sim.setInput(me.id, 0, 0, 2); // second dash while cooling down
  sim.step(dt);
  assert.ok(me.vz < v, 'a second dash during cooldown must not boost speed');
});

test('collision pushes players apart and conserves sanity', () => {
  const sim = new Sim(() => {}, seeded(21));
  const a = sim.addHuman('A');
  const b = sim.addHuman('B');
  const dt = 1 / CFG.tick;
  while (sim.phase === 'countdown') sim.step(dt);
  for (const p of sim.players.values()) if (p !== a && p !== b) p.st = 0;
  a.x = -0.5; a.z = 0; b.x = 0.5; b.z = 0;
  a.vx = 6; b.vx = 0;
  sim.step(dt);
  assert.ok(b.vx > 0, 'B should be pushed away');
  assert.ok(Math.hypot(b.x - a.x, b.z - a.z) >= CFG.playerR * 2 - 1e-6, 'players must not overlap after resolve');
});

test('falling off the edge eliminates the player', () => {
  const events = [];
  const sim = new Sim((e) => events.push(e), seeded(5));
  const me = sim.addHuman('Me');
  const dt = 1 / CFG.tick;
  while (sim.phase === 'countdown') sim.step(dt);
  me.x = CFG.arenaR0 + 2;
  me.z = 0;
  sim.step(dt);
  assert.equal(me.st, 2);
  for (let i = 0; i < CFG.tick * 3; i++) sim.step(dt);
  assert.equal(me.st, 0);
  assert.ok(events.some((e) => e.k === 'fall' && e.id === me.id));
});

test('input validation ignores garbage', () => {
  const sim = new Sim(() => {}, seeded(9));
  const me = sim.addHuman('Me');
  sim.setInput(me.id, 'x', NaN, 0);
  sim.setInput(me.id, 999, 999, 0);
  assert.ok(Math.hypot(me.in.dx, me.in.dz) <= 1.0000001);
  sim.setInput(999, 1, 1, 0); // unknown id
});
