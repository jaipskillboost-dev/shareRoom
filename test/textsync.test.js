'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Doc, Session, apply, diff, transform } = require('../public/textsync.js');

test('diff finds the smallest single replacement', () => {
  assert.equal(diff('same', 'same'), null);
  assert.deepEqual(diff('hello world', 'hello brave world'), { from: 6, to: 6, insert: 'brave ' });
  assert.deepEqual(diff('abcd', 'ad'), { from: 1, to: 3, insert: '' });
  assert.deepEqual(diff('aa', 'aaa'), { from: 2, to: 2, insert: 'a' });
  assert.deepEqual(diff('', 'new'), { from: 0, to: 0, insert: 'new' });
  assert.deepEqual(diff('old', ''), { from: 0, to: 3, insert: '' });
});

test('diff and apply round-trip, including emoji and non-Latin text', () => {
  const pairs = [['కాఫీ ☕', 'కాఫీ 🍵 ☕'], ['नमस्ते दुनिया', 'नमस्ते'], ['😀😀', '😀😁😀']];
  for (const [before, after] of pairs) assert.equal(apply(before, diff(before, after)), after);
});

test('transform moves a change past earlier ones and refuses overlaps', () => {
  const insertX = { from: 10, to: 10, insert: 'x' };
  assert.equal(transform(insertX, 3, 3, 2).from, 12); // Two characters were added before it.
  assert.equal(transform(insertX, 3, 8, 0).from, 5); // Five characters were removed before it.
  assert.equal(transform({ from: 2, to: 2, insert: 'x' }, 3, 5, 0).from, 2); // After it changes nothing.
  assert.equal(transform({ from: 4, to: 6, insert: '' }, 3, 5, 1), null); // Same characters.
  assert.equal(transform({ from: 4, to: 4, insert: 'x' }, 3, 6, 0), null); // Inside what was removed.
  assert.equal(transform({ from: 5, to: 5, insert: 'x' }, 5, 5, 3).from, 5); // Two inserts at one spot.
});

test('the server keeps two changes made from the same text', () => {
  const doc = new Doc(100);
  assert.ok(doc.accept({ base: 0, from: 0, to: 0, insert: 'AB' }));
  assert.ok(doc.accept({ base: 0, from: 0, to: 0, insert: 'CD' }));
  assert.equal(doc.text, 'CDAB');
  assert.equal(doc.version, 2);

  assert.ok(doc.accept({ base: 1, from: 2, to: 2, insert: '!' })); // Made when the text was "AB".
  assert.equal(doc.text, 'CDAB!');
});

test('the server refuses overlapping, stale, out-of-range and oversized changes', () => {
  const doc = new Doc(10, 3);
  doc.accept({ base: 0, from: 0, to: 0, insert: 'hello' });
  doc.accept({ base: 1, from: 0, to: 5, insert: 'HOWDY' });

  assert.equal(doc.accept({ base: 1, from: 0, to: 2, insert: 'x' }), null); // Overlaps the second change.
  assert.equal(doc.accept({ base: 9, from: 0, to: 0, insert: 'x' }), null); // From a version that does not exist.
  assert.equal(doc.accept({ base: 2, from: 3, to: 99, insert: '' }), null); // Past the end.
  assert.equal(doc.accept({ base: 2, from: 0, to: 0, insert: 'too long for it' }), null);
  assert.equal(doc.text, 'HOWDY');

  for (let i = 0; i < 4; i += 1) doc.accept({ base: doc.version, from: 0, to: 0, insert: '' });
  assert.equal(doc.accept({ base: 0, from: 0, to: 0, insert: 'x' }), null); // Older than the kept history.
});

test('a session keeps typing made while offline if nothing changed on the server, and drops it otherwise', () => {
  const session = new Session();
  session.init('abc', 3);
  session.edit('abcd');

  const kept = session.init('abc', 3);
  assert.equal(kept.value, null);
  assert.equal(session.value, 'abcd');
  assert.equal(kept.send.insert, 'd');

  const reset = session.init('abcxyz', 4);
  assert.equal(reset.value, 'abcxyz');
  assert.equal(session.value, 'abcxyz');
  assert.equal(reset.send, null);
});

test('a person keeps their own typing when someone else edits elsewhere at the same time', () => {
  const session = new Session();
  session.init('hello world', 1);
  session.edit('hello brave world');

  const { value } = session.receive({ v: 2, id: 'someone-else', from: 11, to: 11, insert: '!' });
  assert.equal(value, 'hello brave world!');
});

test('an edit the server accepts is not lost when a collision discards the typing made after it', () => {
  const session = new Session();
  session.init('hello world', 1);
  const sent = session.edit('hello brave world'); // Goes to the server and waits there.
  session.edit('hello brave world!!'); // More typing on top, while waiting.

  // Someone replaces the "o" in "world", which collides with the typing but not with the sent edit.
  const collided = session.receive({ v: 2, id: 'someone-else', from: 7, to: 8, insert: 'X' });
  assert.equal(collided.value, 'hello wXrld');

  // The server then accepts the sent edit after all, and it must show up.
  const accepted = session.receive({ v: 3, id: sent.id, from: 6, to: 6, insert: 'brave ' });
  assert.equal(accepted.value, 'hello brave wXrld');
  assert.equal(accepted.send, null);
});

// Several simulated people type at random while their changes cross on the way to a real Doc.
// However the changes interleave, once everything has been delivered everyone must see the server's text.
function rng(seed) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function simulate(seed, peopleCount, steps) {
  const random = rng(seed);
  const pick = (n) => Math.floor(random() * n);
  const doc = new Doc(120);
  const people = Array.from({ length: peopleCount }, () => ({ session: new Session(), up: [], down: [] }));

  const send = (person, op) => {
    if (op) person.up.push({ id: op.id, base: op.base, from: op.from, to: op.to, insert: op.insert });
  };

  const type = (person) => {
    const text = person.session.value;
    const from = pick(text.length + 1);
    const to = random() < 0.4 ? Math.min(text.length, from + pick(5)) : from;
    const insert = random() < 0.3 ? '' : 'abcdefgh'.slice(pick(4), 4 + pick(5));
    if (to === from && insert === '') return;
    send(person, person.session.edit(apply(text, { from, to, insert })));
  };

  const arriveAtServer = (person) => {
    const op = person.up.shift();
    const applied = doc.accept(op);
    if (!applied) return person.down.push({ rejected: op.id });
    for (const other of people) other.down.push({ v: doc.version, id: op.id, ...applied });
  };

  const arriveAtPerson = (person) => {
    const message = person.down.shift();
    if (message.rejected) person.session.reject(message.rejected);
    else send(person, person.session.receive(message).send);
  };

  const pending = () => people.filter((p) => p.up.length || p.down.length);

  for (let step = 0; step < steps; step += 1) {
    const person = people[pick(peopleCount)];
    const roll = random();
    if (roll < 0.4) type(person);
    else if (roll < 0.7 && person.up.length) arriveAtServer(person);
    else if (person.down.length) arriveAtPerson(person);
  }
  while (pending().length) {
    const person = pending()[0];
    if (person.up.length) arriveAtServer(person);
    else arriveAtPerson(person);
  }

  for (const [index, { session }] of people.entries()) {
    const label = `seed ${seed}, person ${index}`;
    assert.equal(session.text, doc.text, `${label}: confirmed text differs from the server`);
    assert.equal(session.value, doc.text, `${label}: shown text differs from the server`);
    assert.equal(session.version, doc.version, `${label}: version differs`);
    assert.equal(session.inflight, null, `${label}: still waiting for an answer`);
  }
  return doc;
}

test('everyone ends with the same text however their edits interleave', () => {
  let nonEmpty = 0;
  for (let seed = 1; seed <= 400; seed += 1) {
    const doc = simulate(seed, 2 + (seed % 3), 250);
    if (doc.text.length > 0) nonEmpty += 1;
  }
  assert.ok(nonEmpty > 300, 'the simulation should be producing real text');
});
