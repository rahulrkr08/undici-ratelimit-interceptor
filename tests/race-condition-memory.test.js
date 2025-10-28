const test = require('node:test');
const assert = require('node:assert');
const InMemoryStore = require('../lib/store/memory');

test('Race Condition: Concurrent adds to same identifier can lose timestamps', async (t) => {
  const store = new InMemoryStore();
  const identifier = 'test-user';
  const concurrentRequests = 100;

  // Start with a baseline
  const baseTime = Date.now();

  // Simulate many concurrent requests
  const promises = [];
  for (let i = 0; i < concurrentRequests; i++) {
    promises.push(store.add(baseTime + i, identifier));
  }

  await Promise.all(promises);

  // Check if all timestamps were recorded
  const count = await store.count(identifier);
  const all = await store.getAll(identifier);

  console.log(`Expected: ${concurrentRequests}, Got: ${count}`);
  console.log(`Unique timestamps: ${new Set(all).size}`);

  // This assertion SHOULD pass, but due to race conditions it often fails
  // When race conditions occur, count < concurrentRequests
  assert.strictEqual(
    count,
    concurrentRequests,
    `Race condition detected: Expected ${concurrentRequests} timestamps, got ${count}. Lost ${concurrentRequests - count} timestamps.`
  );
});

test('Race Condition: Concurrent cleanup and add operations', async (t) => {
  const store = new InMemoryStore();
  const identifier = 'test-user';
  const now = Date.now();

  // Pre-populate with some old timestamps
  for (let i = 0; i < 50; i++) {
    await store.add(now - 10000 + i, identifier);
  }

  // Now run concurrent cleanup and add operations
  const operations = [];

  // Multiple cleanup operations
  for (let i = 0; i < 10; i++) {
    operations.push(store.cleanup(now - 5000, identifier));
  }

  // Multiple add operations during cleanup
  for (let i = 0; i < 50; i++) {
    operations.push(store.add(now + i, identifier));
  }

  await Promise.all(operations);

  const all = await store.getAll(identifier);
  const count = await store.count(identifier);

  console.log(`Count after concurrent operations: ${count}`);
  console.log(`Timestamps: ${all.length}`);

  // Verify data integrity
  assert.strictEqual(count, all.length, 'Count should match array length');

  // All timestamps should be > cutoff
  const cutoff = now - 5000;
  const oldTimestamps = all.filter(t => t <= cutoff);
  assert.strictEqual(
    oldTimestamps.length,
    0,
    `Found ${oldTimestamps.length} timestamps that should have been cleaned up`
  );

  // Check for expected new timestamps (may lose some due to race conditions)
  const newTimestamps = all.filter(t => t >= now);
  console.log(`New timestamps added: ${newTimestamps.length} out of expected 50`);

  // This might fail if race conditions cause timestamp loss
  assert.ok(
    newTimestamps.length > 0,
    'Should have at least some new timestamps'
  );
});

test('Race Condition: Read-modify-write sequence is not atomic', async (t) => {
  const store = new InMemoryStore();
  const identifier = 'test-user';
  const now = Date.now();

  // Add initial timestamp
  await store.add(now, identifier);

  // Simulate race: multiple async operations reading same state
  const operation1 = async () => {
    const requests = await store.getAll(identifier); // READ
    // Simulate some async delay
    await new Promise(resolve => setImmediate(resolve));
    // Now add - this uses the same read-modify-write pattern
    await store.add(now + 1, identifier);
  };

  const operation2 = async () => {
    const requests = await store.getAll(identifier); // READ
    await new Promise(resolve => setImmediate(resolve));
    await store.add(now + 2, identifier);
  };

  await Promise.all([operation1(), operation2()]);

  const count = await store.count(identifier);

  // We expect 3 timestamps (initial + 2 adds)
  // But depending on timing, we might lose one
  console.log(`Expected: 3, Got: ${count}`);
  assert.strictEqual(count, 3, 'All timestamps should be recorded');
});

test('Race Condition: Concurrent cleanup operations on same identifier', async (t) => {
  const store = new InMemoryStore();
  const identifier = 'test-user';
  const now = Date.now();

  // Add mix of old and new timestamps
  const timestamps = [
    now - 10000, // old
    now - 9000,  // old
    now - 8000,  // old
    now - 1000,  // new
    now,         // new
    now + 1000   // new
  ];

  for (const ts of timestamps) {
    await store.add(ts, identifier);
  }

  // Run multiple concurrent cleanups with same cutoff
  const cutoff = now - 5000;
  await Promise.all([
    store.cleanup(cutoff, identifier),
    store.cleanup(cutoff, identifier),
    store.cleanup(cutoff, identifier),
    store.cleanup(cutoff, identifier),
    store.cleanup(cutoff, identifier)
  ]);

  const all = await store.getAll(identifier);
  const count = await store.count(identifier);

  console.log(`Remaining timestamps: ${count}`);
  console.log(`Timestamps: ${all}`);

  // Should have exactly 3 new timestamps
  assert.strictEqual(count, 3, 'Should have exactly 3 timestamps after cleanup');

  // All should be > cutoff
  assert.ok(all.every(t => t > cutoff), 'All remaining timestamps should be newer than cutoff');
});

test('Race Condition: High-concurrency stress test', async (t) => {
  const store = new InMemoryStore();
  const identifier = 'stress-test';
  const now = Date.now();
  const operations = [];

  // Mix of adds, cleanups, and reads
  for (let i = 0; i < 200; i++) {
    if (i % 3 === 0) {
      operations.push(store.add(now + i, identifier));
    } else if (i % 3 === 1) {
      operations.push(store.cleanup(now - 1000, identifier));
    } else {
      operations.push(store.count(identifier));
    }
  }

  await Promise.all(operations);

  const finalCount = await store.count(identifier);
  const all = await store.getAll(identifier);

  console.log(`Final count: ${finalCount}`);
  console.log(`Actual array length: ${all.length}`);

  // Verify internal consistency
  assert.strictEqual(
    finalCount,
    all.length,
    'Count should always match actual array length'
  );

  // Check for duplicates (shouldn't happen, but worth checking)
  const uniqueTimestamps = new Set(all);
  assert.strictEqual(
    uniqueTimestamps.size,
    all.length,
    'Should not have duplicate timestamps'
  );
});

test('Race Condition: Interleaved cleanup during active recording', async (t) => {
  const store = new InMemoryStore();
  const identifier = 'test-user';
  const now = Date.now();

  // Simulate what happens in real rate limiting:
  // continuous requests coming in while periodic cleanup runs

  const addOperations = [];
  const cleanupOperations = [];

  // Add 100 timestamps spread over time
  for (let i = 0; i < 100; i++) {
    addOperations.push(store.add(now - 10000 + (i * 100), identifier));
  }

  // While adding, run cleanup operations
  for (let i = 0; i < 10; i++) {
    cleanupOperations.push(store.cleanup(now - 5000, identifier));
  }

  // Interleave operations
  const allOperations = [...addOperations, ...cleanupOperations];
  await Promise.all(allOperations);

  const all = await store.getAll(identifier);
  const count = await store.count(identifier);

  console.log(`Final count: ${count}`);

  // All remaining timestamps should be > cutoff
  const cutoff = now - 5000;
  const oldTimestamps = all.filter(t => t <= cutoff);

  assert.strictEqual(
    oldTimestamps.length,
    0,
    `Should not have old timestamps, but found ${oldTimestamps.length}`
  );

  // Verify consistency
  assert.strictEqual(count, all.length, 'Count should match array length');
});

test('Demonstration: Node.js event loop allows interleaving', async (t) => {
  const store = new InMemoryStore();
  const identifier = 'demo';
  let interleaveDetected = false;

  // This test demonstrates that even with async/await,
  // operations can interleave in Node.js

  const operation1 = async () => {
    const before = await store.getAll(identifier);
    // This await allows other operations to run
    await new Promise(resolve => setImmediate(resolve));
    const after = await store.getAll(identifier);

    // If operation2 ran in between, the arrays will differ
    if (before.length !== after.length) {
      interleaveDetected = true;
    }
  };

  const operation2 = async () => {
    await new Promise(resolve => setImmediate(resolve));
    await store.add(Date.now(), identifier);
  };

  await Promise.all([operation1(), operation2()]);

  console.log(`Interleaving detected: ${interleaveDetected}`);

  // This demonstrates that async operations CAN interleave
  assert.ok(
    interleaveDetected,
    'Should demonstrate that async operations can interleave'
  );
});
