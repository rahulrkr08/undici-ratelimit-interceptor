const test = require('node:test');
const assert = require('node:assert');
const Redis = require('ioredis');
const RedisStore = require('../lib/store/redis');

// Helper to check if Redis is available
async function isRedisAvailable() {
  const testClient = new Redis({ lazyConnect: true });
  try {
    await testClient.connect();
    await testClient.quit();
    return true;
  } catch (err) {
    return false;
  }
}

test('Redis Race Condition: ZADD + EXPIRE is not atomic', async (t) => {
  const redisAvailable = await isRedisAvailable();
  if (!redisAvailable) {
    t.skip('Redis not available');
    return;
  }

  const redis = new Redis();
  const store = new RedisStore(redis, { keyPrefix: 'test:race1:' });

  try {
    const identifier = 'test-user';
    const now = Date.now();

    // This test demonstrates the theoretical race condition
    // In practice, a crash between ZADD and EXPIRE would leave orphaned keys

    await store.add(now, identifier);

    // Check if key has TTL
    const ttl = await redis.ttl(`test:race1:${identifier}`);
    console.log(`TTL after add: ${ttl}`);

    assert.ok(ttl > 0, 'Key should have TTL set');

    // Simulate what would happen if process crashed between ZADD and EXPIRE
    // by manually removing TTL
    await redis.persist(`test:race1:${identifier}`);

    const ttlAfterPersist = await redis.ttl(`test:race1:${identifier}`);
    console.log(`TTL after persist: ${ttlAfterPersist}`);

    assert.strictEqual(ttlAfterPersist, -1, 'Key should now have no TTL (orphaned)');

    // Clean up
    await store.clear(identifier);
  } finally {
    await redis.quit();
  }
});

test('Redis Race Condition: Multiple instances calling cleanup simultaneously', async (t) => {
  const redisAvailable = await isRedisAvailable();
  if (!redisAvailable) {
    t.skip('Redis not available');
    return;
  }

  // Simulate multiple distributed instances
  const redis1 = new Redis();
  const redis2 = new Redis();
  const redis3 = new Redis();

  const store1 = new RedisStore(redis1, { keyPrefix: 'test:race2:' });
  const store2 = new RedisStore(redis2, { keyPrefix: 'test:race2:' });
  const store3 = new RedisStore(redis3, { keyPrefix: 'test:race2:' });

  try {
    const identifier = 'shared-user';
    const now = Date.now();

    // Add timestamps from different instances
    await Promise.all([
      store1.add(now - 10000, identifier),
      store1.add(now - 9000, identifier),
      store2.add(now - 8000, identifier),
      store2.add(now - 1000, identifier),
      store3.add(now, identifier),
      store3.add(now + 1000, identifier)
    ]);

    // All instances run cleanup simultaneously
    const cutoff = now - 5000;
    await Promise.all([
      store1.cleanup(cutoff, identifier),
      store2.cleanup(cutoff, identifier),
      store3.cleanup(cutoff, identifier)
    ]);

    // Verify cleanup worked correctly despite concurrent execution
    const count = await store1.count(identifier);
    const all = await store1.getAll(identifier);

    console.log(`Count after concurrent cleanup: ${count}`);
    console.log(`Timestamps: ${all}`);

    assert.strictEqual(count, 3, 'Should have exactly 3 timestamps after cleanup');

    // All remaining timestamps should be > cutoff
    assert.ok(
      all.every(t => t > cutoff),
      'All remaining timestamps should be newer than cutoff'
    );

    // Clean up
    await store1.clear(identifier);
  } finally {
    await redis1.quit();
    await redis2.quit();
    await redis3.quit();
  }
});

test('Redis Race Condition: Concurrent adds from multiple instances', async (t) => {
  const redisAvailable = await isRedisAvailable();
  if (!redisAvailable) {
    t.skip('Redis not available');
    return;
  }

  // Create multiple Redis instances to simulate distributed system
  const instances = [];
  const stores = [];

  for (let i = 0; i < 5; i++) {
    const redis = new Redis();
    instances.push(redis);
    stores.push(new RedisStore(redis, { keyPrefix: 'test:race3:' }));
  }

  try {
    const identifier = 'concurrent-user';
    const now = Date.now();
    const requestsPerInstance = 20;

    // Each instance adds timestamps concurrently
    const addPromises = [];
    for (let i = 0; i < stores.length; i++) {
      for (let j = 0; j < requestsPerInstance; j++) {
        addPromises.push(stores[i].add(now + (i * 100 + j), identifier));
      }
    }

    await Promise.all(addPromises);

    // Check final count
    const count = await stores[0].count(identifier);
    const expectedCount = stores.length * requestsPerInstance;

    console.log(`Expected: ${expectedCount}, Got: ${count}`);

    // Redis atomic operations should handle this correctly
    assert.strictEqual(
      count,
      expectedCount,
      'All timestamps should be recorded without loss'
    );

    // Clean up
    await stores[0].clear(identifier);
  } finally {
    for (const redis of instances) {
      await redis.quit();
    }
  }
});

test('Redis Race Condition: Interleaved add and cleanup operations', async (t) => {
  const redisAvailable = await isRedisAvailable();
  if (!redisAvailable) {
    t.skip('Redis not available');
    return;
  }

  const redis = new Redis();
  const store = new RedisStore(redis, { keyPrefix: 'test:race4:' });

  try {
    const identifier = 'interleaved-user';
    const now = Date.now();

    // Mix of adds and cleanups running concurrently
    const operations = [];

    // Add old timestamps
    for (let i = 0; i < 50; i++) {
      operations.push(store.add(now - 10000 + (i * 100), identifier));
    }

    // Add new timestamps
    for (let i = 0; i < 50; i++) {
      operations.push(store.add(now + i, identifier));
    }

    // Multiple cleanup operations
    const cutoff = now - 5000;
    for (let i = 0; i < 10; i++) {
      operations.push(store.cleanup(cutoff, identifier));
    }

    await Promise.all(operations);

    const all = await store.getAll(identifier);
    const count = await store.count(identifier);

    console.log(`Final count: ${count}`);

    // Verify no old timestamps remain
    const oldTimestamps = all.filter(t => t <= cutoff);
    assert.strictEqual(
      oldTimestamps.length,
      0,
      'Should not have any old timestamps remaining'
    );

    // Verify consistency
    assert.strictEqual(count, all.length, 'Count should match actual timestamps');

    // Clean up
    await store.clear(identifier);
  } finally {
    await redis.quit();
  }
});

test('Redis Race Condition: EXPIRE race with multiple add operations', async (t) => {
  const redisAvailable = await isRedisAvailable();
  if (!redisAvailable) {
    t.skip('Redis not available');
    return;
  }

  const redis = new Redis();
  const store = new RedisStore(redis, { keyPrefix: 'test:race5:', ttl: 2 }); // Short TTL

  try {
    const identifier = 'expire-race';
    const now = Date.now();

    // Multiple rapid adds - each sets EXPIRE
    // This can cause the TTL to be refreshed multiple times
    await Promise.all([
      store.add(now, identifier),
      store.add(now + 1, identifier),
      store.add(now + 2, identifier),
      store.add(now + 3, identifier),
      store.add(now + 4, identifier)
    ]);

    // Check TTL immediately
    const ttl1 = await redis.ttl(`test:race5:${identifier}`);
    console.log(`TTL after concurrent adds: ${ttl1}`);

    assert.ok(ttl1 > 0 && ttl1 <= 2, 'TTL should be set and reasonable');

    // Wait a bit and check again
    await new Promise(resolve => setTimeout(resolve, 1000));

    const ttl2 = await redis.ttl(`test:race5:${identifier}`);
    console.log(`TTL after 1 second: ${ttl2}`);

    // The TTL should have decreased (or key expired)
    assert.ok(ttl2 <= ttl1, 'TTL should decrease over time');

    // Clean up
    await store.clear(identifier);
  } finally {
    await redis.quit();
  }
});

test('Redis Race Condition: Counter overflow in high-throughput scenario', async (t) => {
  const redisAvailable = await isRedisAvailable();
  if (!redisAvailable) {
    t.skip('Redis not available');
    return;
  }

  const redis = new Redis();
  const store = new RedisStore(redis, { keyPrefix: 'test:race6:' });

  try {
    const identifier = 'counter-test';
    const now = Date.now();

    // The store uses a counter to generate unique member IDs
    // Test that it handles many operations without issues

    const operations = [];
    for (let i = 0; i < 1000; i++) {
      operations.push(store.add(now, identifier)); // Same timestamp
    }

    await Promise.all(operations);

    const count = await store.count(identifier);
    console.log(`Count after 1000 adds with same timestamp: ${count}`);

    // All should be recorded as unique members
    assert.strictEqual(count, 1000, 'Should handle many requests at same timestamp');

    // Clean up
    await store.clear(identifier);
  } finally {
    await redis.quit();
  }
});

test('Redis Race Condition: Distributed instances with same timestamp', async (t) => {
  const redisAvailable = await isRedisAvailable();
  if (!redisAvailable) {
    t.skip('Redis not available');
    return;
  }

  // Multiple instances might generate same timestamp
  const instances = [];
  const stores = [];

  for (let i = 0; i < 3; i++) {
    const redis = new Redis();
    instances.push(redis);
    stores.push(new RedisStore(redis, { keyPrefix: 'test:race7:' }));
  }

  try {
    const identifier = 'same-timestamp';
    const now = Date.now();

    // All instances add with the exact same timestamp
    // This tests the uniqueness mechanism (instanceId + counter)
    await Promise.all([
      stores[0].add(now, identifier),
      stores[0].add(now, identifier),
      stores[1].add(now, identifier),
      stores[1].add(now, identifier),
      stores[2].add(now, identifier),
      stores[2].add(now, identifier)
    ]);

    const count = await stores[0].count(identifier);
    console.log(`Count with same timestamp from multiple instances: ${count}`);

    assert.strictEqual(count, 6, 'Should handle same timestamp from multiple instances');

    // Clean up
    await stores[0].clear(identifier);
  } finally {
    for (const redis of instances) {
      await redis.quit();
    }
  }
});

test('Redis Race Condition: Cleanup during count operation', async (t) => {
  const redisAvailable = await isRedisAvailable();
  if (!redisAvailable) {
    t.skip('Redis not available');
    return;
  }

  const redis = new Redis();
  const store = new RedisStore(redis, { keyPrefix: 'test:race8:' });

  try {
    const identifier = 'cleanup-count-race';
    const now = Date.now();

    // Add old timestamps
    for (let i = 0; i < 100; i++) {
      await store.add(now - 10000 + i, identifier);
    }

    // Run count and cleanup concurrently multiple times
    const operations = [];
    const cutoff = now - 5000;

    for (let i = 0; i < 50; i++) {
      operations.push(store.count(identifier));
      if (i % 5 === 0) {
        operations.push(store.cleanup(cutoff, identifier));
      }
    }

    const results = await Promise.all(operations);

    // Filter out count results
    const counts = results.filter(r => typeof r === 'number');
    console.log(`Count range during concurrent operations: ${Math.min(...counts)} - ${Math.max(...counts)}`);

    // Final count should be 0 (all timestamps were old)
    const finalCount = await store.count(identifier);
    assert.strictEqual(finalCount, 0, 'All old timestamps should be cleaned up');

    // Clean up
    await store.clear(identifier);
  } finally {
    await redis.quit();
  }
});
