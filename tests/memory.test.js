const test = require('node:test');
const assert = require('node:assert');
const InMemoryStore = require('../lib/store/memory');

test('InMemoryStore - add timestamps', async (t) => {
  const store = new InMemoryStore();
  const now = Date.now();

  await store.add(now, 'test-id');
  await store.add(now + 1000, 'test-id');
  await store.add(now + 2000, 'test-id');

  const count = await store.count('test-id');
  assert.strictEqual(count, 3, 'Should have 3 timestamps');

  const all = await store.getAll('test-id');
  assert.strictEqual(all.length, 3, 'getAll should return 3 timestamps');
  assert.deepStrictEqual(all, [now, now + 1000, now + 2000]);
});

test('InMemoryStore - count returns 0 for non-existent identifier', async (t) => {
  const store = new InMemoryStore();
  
  const count = await store.count('non-existent');
  assert.strictEqual(count, 0, 'Count should be 0 for non-existent identifier');
});

test('InMemoryStore - getAll returns empty array for non-existent identifier', async (t) => {
  const store = new InMemoryStore();
  
  const all = await store.getAll('non-existent');
  assert.deepStrictEqual(all, [], 'Should return empty array');
});

test('InMemoryStore - cleanup removes old timestamps', async (t) => {
  const store = new InMemoryStore();
  const now = Date.now();

  // Add timestamps at different times
  await store.add(now - 5000, 'test-id'); // 5 seconds ago
  await store.add(now - 3000, 'test-id'); // 3 seconds ago
  await store.add(now - 1000, 'test-id'); // 1 second ago
  await store.add(now, 'test-id');        // now

  // Cleanup timestamps older than 2 seconds
  const cutoff = now - 2000;
  await store.cleanup(cutoff, 'test-id');

  const count = await store.count('test-id');
  assert.strictEqual(count, 2, 'Should have 2 timestamps after cleanup');

  const all = await store.getAll('test-id');
  assert.ok(all.every(t => t > cutoff), 'All timestamps should be newer than cutoff');
});

test('InMemoryStore - cleanup removes identifier when no timestamps left', async (t) => {
  const store = new InMemoryStore();
  const now = Date.now();

  await store.add(now - 5000, 'test-id');
  await store.add(now - 4000, 'test-id');

  // Cleanup all timestamps
  const cutoff = now;
  await store.cleanup(cutoff, 'test-id');

  const count = await store.count('test-id');
  assert.strictEqual(count, 0, 'Count should be 0 after cleanup removes all');

  // Verify identifier is removed from cache
  const all = await store.getAll('test-id');
  assert.deepStrictEqual(all, [], 'Should return empty array after cleanup');
});

test('InMemoryStore - cleanup does nothing for non-existent identifier', async (t) => {
  const store = new InMemoryStore();
  const now = Date.now();

  // Should not throw
  await store.cleanup(now, 'non-existent');
  
  const count = await store.count('non-existent');
  assert.strictEqual(count, 0);
});

test('InMemoryStore - supports multiple identifiers', async (t) => {
  const store = new InMemoryStore();
  const now = Date.now();

  await store.add(now, 'user-1');
  await store.add(now + 1000, 'user-1');
  await store.add(now, 'user-2');
  await store.add(now + 1000, 'user-2');
  await store.add(now + 2000, 'user-2');

  const count1 = await store.count('user-1');
  const count2 = await store.count('user-2');

  assert.strictEqual(count1, 2, 'user-1 should have 2 timestamps');
  assert.strictEqual(count2, 3, 'user-2 should have 3 timestamps');
});

test('InMemoryStore - cleanup only affects specified identifier', async (t) => {
  const store = new InMemoryStore();
  const now = Date.now();

  await store.add(now - 5000, 'user-1');
  await store.add(now, 'user-1');
  await store.add(now - 5000, 'user-2');
  await store.add(now, 'user-2');

  // Cleanup only user-1
  const cutoff = now - 2000;
  await store.cleanup(cutoff, 'user-1');

  const count1 = await store.count('user-1');
  const count2 = await store.count('user-2');

  assert.strictEqual(count1, 1, 'user-1 should have 1 timestamp after cleanup');
  assert.strictEqual(count2, 2, 'user-2 should still have 2 timestamps');
});

test('InMemoryStore - LRU eviction when max limit reached', async (t) => {
  const store = new InMemoryStore({ max: 3 }); // Only allow 3 identifiers
  const now = Date.now();

  // Add 4 identifiers
  await store.add(now, 'id-1');
  await store.add(now, 'id-2');
  await store.add(now, 'id-3');
  await store.add(now, 'id-4'); // This should evict id-1 (least recently used)

  const count1 = await store.count('id-1');
  const count4 = await store.count('id-4');

  assert.strictEqual(count1, 0, 'id-1 should be evicted');
  assert.strictEqual(count4, 1, 'id-4 should exist');
});

test('InMemoryStore - TTL expiration', async (t) => {
  const store = new InMemoryStore({ ttl: 100 }); // 100ms TTL
  const now = Date.now();

  await store.add(now, 'test-id');
  
  // Immediately check - should exist
  let count = await store.count('test-id');
  assert.strictEqual(count, 1, 'Should have 1 timestamp immediately');

  // Wait for TTL to expire
  await new Promise(resolve => setTimeout(resolve, 150));

  // After TTL expires
  count = await store.count('test-id');
  assert.strictEqual(count, 0, 'Should have 0 timestamps after TTL expiration');
});

test('InMemoryStore - default identifier handling', async (t) => {
  const store = new InMemoryStore();
  const now = Date.now();

  // Add without specifying identifier (should use 'default')
  await store.add(now);
  await store.add(now + 1000);

  const count = await store.count(); // No identifier specified
  assert.strictEqual(count, 2, 'Should count default identifier');

  const all = await store.getAll(); // No identifier specified
  assert.strictEqual(all.length, 2, 'Should get all for default identifier');
});

test('InMemoryStore - handles concurrent operations', async (t) => {
  const store = new InMemoryStore();
  const now = Date.now();

  // Add multiple timestamps concurrently
  await Promise.all([
    store.add(now, 'test-id'),
    store.add(now + 1000, 'test-id'),
    store.add(now + 2000, 'test-id'),
    store.add(now + 3000, 'test-id'),
    store.add(now + 4000, 'test-id')
  ]);

  const count = await store.count('test-id');
  assert.strictEqual(count, 5, 'Should handle concurrent adds');
});

test('InMemoryStore - preserves timestamp order', async (t) => {
  const store = new InMemoryStore();
  const timestamps = [1000, 2000, 3000, 4000, 5000];

  for (const ts of timestamps) {
    await store.add(ts, 'test-id');
  }

  const all = await store.getAll('test-id');
  assert.deepStrictEqual(all, timestamps, 'Should preserve insertion order');
});

test('InMemoryStore - cleanup with boundary conditions', async (t) => {
  const store = new InMemoryStore();
  const now = Date.now();

  await store.add(now - 1000, 'test-id');
  await store.add(now, 'test-id'); // Exactly at cutoff
  await store.add(now + 1000, 'test-id');

  // Cleanup with cutoff exactly at one timestamp
  await store.cleanup(now, 'test-id');

  const all = await store.getAll('test-id');
  assert.strictEqual(all.length, 1, 'Should only keep timestamps after cutoff');
  assert.ok(all[0] > now, 'Remaining timestamp should be greater than cutoff');
});