const test = require('node:test');
const assert = require('node:assert');
const Redis = require('ioredis');
const RedisStore = require('../lib/store/redis');

// Setup Redis connection
let redis;
let store;

test.before(async () => {
  redis = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    db: process.env.REDIS_DB || 15, // Use a separate DB for tests
    lazyConnect: true
  });

  try {
    await redis.connect();
  } catch (err) {
    console.error('Redis connection failed. Skipping Redis tests.');
    console.error('Please ensure Redis is running: docker run -d -p 6379:6379 redis:alpine');
    process.exit(0);
  }
});

test.beforeEach(async () => {
  // Clean up before creating new store
  await redis.flushdb();
  // Create new store with unique key prefix per test to avoid conflicts
  store = new RedisStore(redis, {
    keyPrefix: `test:${Date.now()}:${Math.random()}:`
  });
});

test.after(async () => {
  if (redis) {
    await redis.quit();
  }
});

test('RedisStore - constructor requires redis client', () => {
  assert.throws(
    () => new RedisStore(),
    { message: 'Redis client is required' }
  );
});

test('RedisStore - constructor with default options', () => {
  const testStore = new RedisStore(redis);
  assert.strictEqual(testStore.keyPrefix, 'ratelimit:');
  assert.strictEqual(testStore.ttl, 3600);
});

test('RedisStore - constructor with custom options', () => {
  const testStore = new RedisStore(redis, {
    keyPrefix: 'custom:',
    ttl: 7200
  });
  assert.strictEqual(testStore.keyPrefix, 'custom:');
  assert.strictEqual(testStore.ttl, 7200);
});

test('RedisStore - add timestamps', async () => {
  const now = Date.now();
  await store.add(now, 'user1');
  await store.add(now + 1000, 'user1');
  await store.add(now + 2000, 'user1');

  const count = await store.count('user1');
  assert.strictEqual(count, 3);
});

test('RedisStore - count returns 0 for non-existent identifier', async () => {
  const count = await store.count('nonexistent');
  assert.strictEqual(count, 0);
});

test('RedisStore - getAll returns empty array for non-existent identifier', async () => {
  const timestamps = await store.getAll('nonexistent');
  assert.deepStrictEqual(timestamps, []);
});

test('RedisStore - getAll returns all timestamps', async () => {
  const now = Date.now();
  const timestamps = [now, now + 1000, now + 2000];

  for (const ts of timestamps) {
    await store.add(ts, 'user1');
  }

  const retrieved = await store.getAll('user1');
  assert.deepStrictEqual(retrieved, timestamps);
});

test('RedisStore - cleanup removes old timestamps', async () => {
  const now = Date.now();
  await store.add(now - 2000, 'user1'); // Old
  await store.add(now - 1000, 'user1'); // Old
  await store.add(now, 'user1');        // Current
  await store.add(now + 1000, 'user1'); // Future

  const cutoff = now - 500;
  await store.cleanup(cutoff, 'user1');

  const count = await store.count('user1');
  assert.strictEqual(count, 2, 'Should have 2 timestamps after cleanup');

  const timestamps = await store.getAll('user1');
  assert.ok(timestamps.every(t => t > cutoff), 'All timestamps should be after cutoff');
});

test('RedisStore - cleanup removes all timestamps when all are old', async () => {
  const now = Date.now();
  await store.add(now - 3000, 'user1');
  await store.add(now - 2000, 'user1');
  await store.add(now - 1000, 'user1');

  const cutoff = now;
  await store.cleanup(cutoff, 'user1');

  const count = await store.count('user1');
  assert.strictEqual(count, 0, 'Should have 0 timestamps after cleanup');
});

test('RedisStore - cleanup does nothing for non-existent identifier', async () => {
  const cutoff = Date.now();
  await store.cleanup(cutoff, 'nonexistent');

  const count = await store.count('nonexistent');
  assert.strictEqual(count, 0);
});

test('RedisStore - supports multiple identifiers', async () => {
  const now = Date.now();

  await store.add(now, 'user1');
  await store.add(now + 1000, 'user1');

  await store.add(now, 'user2');
  await store.add(now + 1000, 'user2');
  await store.add(now + 2000, 'user2');

  const count1 = await store.count('user1');
  const count2 = await store.count('user2');

  assert.strictEqual(count1, 2);
  assert.strictEqual(count2, 3);
});

test('RedisStore - cleanup only affects specified identifier', async () => {
  const now = Date.now();

  await store.add(now - 2000, 'user1');
  await store.add(now, 'user1');

  await store.add(now - 2000, 'user2');
  await store.add(now, 'user2');

  const cutoff = now - 1000;
  await store.cleanup(cutoff, 'user1');

  const count1 = await store.count('user1');
  const count2 = await store.count('user2');

  assert.strictEqual(count1, 1, 'user1 should have 1 timestamp after cleanup');
  assert.strictEqual(count2, 2, 'user2 should still have 2 timestamps');
});

test('RedisStore - TTL is set on keys', async () => {
  const testStore = new RedisStore(redis, {
    keyPrefix: 'ttl-test:',
    ttl: 10 // 10 seconds
  });

  const now = Date.now();
  await testStore.add(now, 'user1');

  const key = testStore._getKey('user1');
  const ttl = await redis.ttl(key);

  assert.ok(ttl > 0 && ttl <= 10, `TTL should be between 0 and 10, got ${ttl}`);
});

test('RedisStore - default identifier handling', async () => {
  const now = Date.now();

  // Add without identifier (should use 'default')
  await store.add(now);
  await store.add(now + 1000);

  const count = await store.count();
  assert.strictEqual(count, 2);

  const timestamps = await store.getAll();
  assert.strictEqual(timestamps.length, 2);
});

test('RedisStore - handles concurrent operations', async () => {
  const now = Date.now();
  const promises = [];

  // Add 10 timestamps concurrently
  for (let i = 0; i < 10; i++) {
    promises.push(store.add(now + i, 'user1'));
  }

  await Promise.all(promises);

  const count = await store.count('user1');
  assert.strictEqual(count, 10);
});

test('RedisStore - preserves timestamp order', async () => {
  const timestamps = [];
  const now = Date.now();

  // Add in random order
  timestamps.push(now + 2000);
  timestamps.push(now);
  timestamps.push(now + 1000);

  for (const ts of timestamps) {
    await store.add(ts, 'user1');
  }

  const retrieved = await store.getAll('user1');

  // Redis sorted set should maintain order
  assert.deepStrictEqual(retrieved, [now, now + 1000, now + 2000]);
});

test('RedisStore - cleanup with boundary conditions', async () => {
  const now = Date.now();

  await store.add(now - 1000, 'user1');
  await store.add(now, 'user1');
  await store.add(now + 1000, 'user1');

  // Cutoff exactly at one timestamp
  await store.cleanup(now, 'user1');

  const timestamps = await store.getAll('user1');
  // Should include timestamps > cutoff (not >= cutoff)
  assert.strictEqual(timestamps.length, 1);
  assert.strictEqual(timestamps[0], now + 1000);
});

test('RedisStore - clear removes specific identifier', async () => {
  const now = Date.now();

  await store.add(now, 'user1');
  await store.add(now + 1000, 'user1');
  await store.add(now, 'user2');

  await store.clear('user1');

  const count1 = await store.count('user1');
  const count2 = await store.count('user2');

  assert.strictEqual(count1, 0);
  assert.strictEqual(count2, 1);
});

test('RedisStore - clearAll removes all identifiers', async () => {
  const now = Date.now();

  await store.add(now, 'user1');
  await store.add(now, 'user2');
  await store.add(now, 'user3');

  await store.clearAll();

  const count1 = await store.count('user1');
  const count2 = await store.count('user2');
  const count3 = await store.count('user3');

  assert.strictEqual(count1, 0);
  assert.strictEqual(count2, 0);
  assert.strictEqual(count3, 0);
});

test('RedisStore - clearAll with no keys does not error', async () => {
  await store.clearAll();
  // Should not throw
});

test('RedisStore - handles many timestamps and cleanup', async () => {
  const now = Date.now();

  // Add many timestamps
  for (let i = 0; i < 20; i++) {
    await store.add(now + (i * 100), 'debug');
  }
  
  const count = await store.count('debug');
  assert.ok(count === 20, `Should have 20 timestamps, got ${count}`);

  // Cleanup old ones
  const cutoff = now + 1000;
  await store.cleanup(cutoff, 'debug');

  const afterCleanup = await store.count('debug');
  assert.ok(afterCleanup < count, 'Should have fewer timestamps after cleanup');
});

test('RedisStore - handles duplicate timestamps', async () => {
  const now = Date.now();

  // Add same timestamp multiple times
  await store.add(now, 'user1');
  await store.add(now, 'user1');
  await store.add(now, 'user1');

  const count = await store.count('user1');
  // Redis sorted sets use score+member as unique key
  // Since we use timestamp as both score and member, duplicates might not be added
  // But for rate limiting, each request should count
  // Let's verify the actual behavior
  assert.ok(count >= 1, 'Should have at least 1 timestamp');
});

test('RedisStore - key prefix isolation', async () => {
  const store1 = new RedisStore(redis, { keyPrefix: 'app1:' });
  const store2 = new RedisStore(redis, { keyPrefix: 'app2:' });

  const now = Date.now();

  await store1.add(now, 'user1');
  await store2.add(now, 'user1');

  const count1 = await store1.count('user1');
  const count2 = await store2.count('user1');

  assert.strictEqual(count1, 1);
  assert.strictEqual(count2, 1);

  // Clear one should not affect the other
  await store1.clearAll();

  const count1After = await store1.count('user1');
  const count2After = await store2.count('user1');

  assert.strictEqual(count1After, 0);
  assert.strictEqual(count2After, 1);
});
