import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tempStore, entry, hash } from './helpers.js';
import { createStore } from '../src/store.js';
import { storeOnVolume } from '../src/config.js';

test('a handed-over trade is held, waiting, and found by its round', () => {
  const { store } = tempStore();
  store.register(entry('a'));
  assert.equal(store.get(hash('a')).stage, 'waiting');
  assert.equal(store.findByRound(hash('fa')).commitment, hash('a'));
});

test('an entry without an order or program is not held', () => {
  const { store } = tempStore();
  assert.equal(store.register({ commitment: hash('b') }), null);
  assert.equal(store.list().length, 0);
});

test('handing a finished trade over again never revives it', () => {
  const { store } = tempStore();
  store.register(entry('a'));
  store.update(hash('a'), { stage: 'settled' });
  store.register(entry('a'));
  assert.equal(store.get(hash('a')).stage, 'settled');
});

test('cancelling stops a trade, and cannot undo a settled one', () => {
  const { store } = tempStore();
  store.register(entry('c'));
  assert.equal(store.cancel(hash('c')).stage, 'cancelled');
  store.register(entry('d'));
  store.update(hash('d'), { stage: 'settled' });
  assert.equal(store.cancel(hash('d')).stage, 'settled');
});

test('finished trades go after a day; open ones stay', () => {
  const { store } = tempStore();
  const t0 = 1_800_000_000_000;
  store.register(entry('1'), t0);
  store.update(hash('1'), { stage: 'settled' }, t0);
  store.register(entry('2'), t0);
  store.register(entry('3'), t0 + 25 * 60 * 60 * 1000);
  assert.equal(store.get(hash('1')), null);
  assert.equal(store.get(hash('2')).stage, 'waiting');
});

test('the store says when it cannot be written', () => {
  const { store } = tempStore();
  assert.equal(store.probe(), null);
  // A file where the directory should be: unwritable on every OS.
  const blocked = createStore('/dev/null/settlements.json');
  assert.equal(typeof blocked.probe(), 'string');
  assert.ok(blocked.probe().length > 0);
});

test('an unreadable record is set aside, never overwritten', () => {
  const { store, file } = tempStore();
  fs.writeFileSync(file, '{not json');
  store.register(entry('e'));
  const aside = fs.readdirSync(file.replace(/settlements\.json$/, '')).find((f) => f.includes('unreadable'));
  assert.ok(aside, 'the unreadable file is kept');
  assert.equal(store.get(hash('e')).stage, 'waiting');
});

test('on Railway, a store off the volume is caught', () => {
  assert.equal(storeOnVolume('/data/settlements.json', {}), null, 'not on Railway: nothing to say');
  assert.equal(storeOnVolume('/data/settlements.json', { RAILWAY_ENVIRONMENT_NAME: 'production' }), false, 'no volume attached');
  assert.equal(storeOnVolume('/data/settlements.json', { RAILWAY_ENVIRONMENT_NAME: 'production', RAILWAY_VOLUME_MOUNT_PATH: '/data' }), true);
  assert.equal(storeOnVolume('./data/settlements.json', { RAILWAY_ENVIRONMENT_NAME: 'production', RAILWAY_VOLUME_MOUNT_PATH: '/data' }), false, 'a relative path is not on /data');
  assert.equal(storeOnVolume('/database/s.json', { RAILWAY_ENVIRONMENT_NAME: 'production', RAILWAY_VOLUME_MOUNT_PATH: '/data' }), false, 'a prefix is not a mount');
});
