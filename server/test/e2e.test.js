import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createApp } from '../app.js';

function client(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const msgs = [];
  const waiters = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    msgs.push(m);
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.res(m); }
  });
  const opened = new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  const wait = (pred, ms = 3000) => {
    const hit = msgs.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((res, rej) => {
      const w = { pred, res };
      waiters.push(w);
      setTimeout(() => rej(new Error('timeout waiting for message')), ms).unref();
    });
  };
  return { ws, msgs, opened, wait, send: (o) => ws.send(JSON.stringify(o)) };
}

test('end to end: join, snapshots, input, private room, errors', async () => {
  const app = await createApp(0, '127.0.0.1');
  try {
    const a = client(app.port);
    await a.opened;
    a.send({ t: 'join', name: 'Alice<script>', mode: 'quick' });
    const joined = await a.wait((m) => m.t === 'joined');
    assert.ok(joined.id > 0);
    assert.equal(joined.code.length, 4);
    const roster = await a.wait((m) => m.t === 'roster');
    assert.ok(roster.list.find((p) => p.id === joined.id).n === 'Alicescript');
    assert.ok(roster.list.length >= 2, 'bots should fill the room');

    // second quick-play player lands in the same room
    const b = client(app.port);
    await b.opened;
    b.send({ t: 'join', name: 'Bob', mode: 'quick' });
    const jb = await b.wait((m) => m.t === 'joined');
    assert.equal(jb.code, joined.code);

    // snapshots flow and the game starts
    await a.wait((m) => m.t === 's');
    await a.wait((m) => m.t === 's' && m.ph === 'play', 8000);

    // input moves the player
    const snapA = await a.wait((m) => m.t === 's' && m.ph === 'play');
    const me0 = snapA.p.find((r) => r[0] === joined.id);
    a.send({ t: 'in', dx: 1, dz: 0, d: 0 });
    await new Promise((r) => setTimeout(r, 500));
    const last = [...a.msgs].reverse().find((m) => m.t === 's');
    const me1 = last.p.find((r) => r[0] === joined.id);
    assert.ok(me1[3] > 0 || me1[1] > me0[1], 'player should move to +x');

    // ping / pong
    a.send({ t: 'ping', c: 123 });
    const pong = await a.wait((m) => m.t === 'pong');
    assert.equal(pong.c, 123);

    // private room + join by code
    const c = client(app.port);
    await c.opened;
    c.send({ t: 'join', name: 'Cara', mode: 'create' });
    const jc = await c.wait((m) => m.t === 'joined');
    assert.equal(jc.priv, 1);
    const d = client(app.port);
    await d.opened;
    d.send({ t: 'join', name: 'Dan', mode: 'code', code: jc.code.toLowerCase() });
    const jd = await d.wait((m) => m.t === 'joined');
    assert.equal(jd.code, jc.code);

    // bad code
    const e = client(app.port);
    await e.opened;
    e.send({ t: 'join', name: 'Eve', mode: 'code', code: 'ZZZZ' });
    const err = await e.wait((m) => m.t === 'err');
    assert.match(err.m, /not found/i);

    // garbage does not crash the server
    a.ws.send('not json');
    a.send({ t: 'in', dx: 'abc', dz: null, d: {} });
    await new Promise((r) => setTimeout(r, 100));
    const health = await fetch(`http://127.0.0.1:${app.port}/health`);
    assert.equal(await health.text(), 'ok');

    for (const x of [a, b, c, d, e]) x.ws.close();
  } finally {
    await app.close();
  }
});
