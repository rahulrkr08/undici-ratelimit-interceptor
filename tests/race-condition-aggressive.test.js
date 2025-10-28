const test = require('node:test');
const assert = require('node:assert');
const InMemoryStore = require('../lib/store/memory');

// More aggressive test that directly exposes the race condition
test('CRITICAL Race Condition: Direct read-modify-write interleaving', async (t) => {
  const store = new InMemoryStore();
  const identifier = 'race-victim';

  // Directly access the cache to demonstrate the issue
  // In real scenarios, this happens through the async add() method

  // Initial state
  await store.add(1000, identifier);

  // Simulate interleaved execution
  let lost = false;

  const addWithDelay = async (timestamp) => {
    // READ
    const requests = store.cache.get(identifier) || [];
    const originalLength = requests.length;

    // Simulate async delay (this is where another operation could interleave)
    await new Promise(resolve => setImmediate(resolve));

    // MODIFY
    requests.push(timestamp);

    // WRITE
    store.cache.set(identifier, requests);

    // Check if we lost data
    const afterLength = store.cache.get(identifier).length;
    if (afterLength <= originalLength) {
      lost = true;
      console.log(`Lost data! Expected > ${originalLength}, got ${afterLength}`);
    }
  };

  // Run multiple operations that will interleave
  await Promise.all([
    addWithDelay(2000),
    addWithDelay(3000),
    addWithDelay(4000),
    addWithDelay(5000)
  ]);

  const finalCount = await store.count(identifier);
  console.log(`Final count: ${finalCount}, Expected: 5`);

  // This will likely fail due to race conditions
  if (finalCount < 5) {
    console.log(`RACE CONDITION DETECTED: Lost ${5 - finalCount} timestamps`);
  }

  assert.strictEqual(finalCount, 5, 'Race condition: timestamps were lost');
});

test('CRITICAL Race Condition: Array mutation during iteration', async (t) => {
  const store = new InMemoryStore();
  const identifier = 'mutation-race';
  const now = Date.now();

  // Add some initial timestamps
  await store.add(now - 5000, identifier);
  await store.add(now - 4000, identifier);
  await store.add(now - 3000, identifier);

  // Create a race: while cleanup is filtering the array,
  // another operation modifies it

  const raceyCleanup = async (cutoff) => {
    const requests = store.cache.get(identifier);
    if (!requests) return;

    // Simulate delay during filtering
    const filtered = [];
    for (const t of requests) {
      await new Promise(resolve => setImmediate(resolve)); // Allow interleaving
      if (t > cutoff) {
        filtered.push(t);
      }
    }

    if (filtered.length > 0) {
      store.cache.set(identifier, filtered);
    } else {
      store.cache.delete(identifier);
    }
  };

  const raceyAdd = async (timestamp) => {
    await new Promise(resolve => setImmediate(resolve));
    await store.add(timestamp, identifier);
  };

  // Run cleanup and add concurrently
  await Promise.all([
    raceyCleanup(now - 2000),
    raceyAdd(now),
    raceyAdd(now + 1000)
  ]);

  const final = await store.getAll(identifier);
  console.log(`Final timestamps: ${final}`);

  // The behavior here is unpredictable due to race conditions
  // We might lose the new timestamps if cleanup runs after they're added
});

test('CRITICAL Race Condition: Simulated high-frequency real-world scenario', async (t) => {
  // This simulates what happens in production with high request rates

  const store = new InMemoryStore();
  const identifier = 'high-frequency';
  let successfulAdds = 0;

  // Simulate rapid requests
  const addRequest = async (timestamp) => {
    try {
      await store.add(timestamp, identifier);
      successfulAdds++;
    } catch (err) {
      console.log(`Add failed: ${err.message}`);
    }
  };

  // Start with some data
  for (let i = 0; i < 10; i++) {
    await store.add(Date.now() - 10000 + i, identifier);
  }

  // Simulate high-frequency requests (1000 req/sec)
  const promises = [];
  const now = Date.now();

  for (let i = 0; i < 1000; i++) {
    promises.push(addRequest(now + i));

    // Every 100 requests, run cleanup
    if (i % 100 === 0) {
      promises.push(store.cleanup(now - 5000, identifier));
    }
  }

  await Promise.all(promises);

  const finalCount = await store.count(identifier);
  console.log(`Attempted adds: ${successfulAdds}, Final count: ${finalCount}`);

  // In a perfect world, these should match
  // If there's a significant difference, we have race conditions
  const lost = successfulAdds - finalCount + 10; // +10 for initial data that should be cleaned

  if (lost > 0) {
    console.log(`POTENTIAL DATA LOSS: ${lost} requests not properly recorded`);
  }

  // Allow for some variance due to cleanup, but large losses indicate races
  assert.ok(
    Math.abs(lost) < 50,
    `Too many requests lost (${lost}), indicating race conditions`
  );
});

test('CRITICAL Race Condition: Concurrent getAll + cleanup = corruption', async (t) => {
  const store = new InMemoryStore();
  const identifier = 'corruption-test';
  const now = Date.now();

  // Add data
  for (let i = 0; i < 100; i++) {
    await store.add(now - 10000 + i, identifier);
  }

  let corruptionDetected = false;

  const getAllAndCheck = async () => {
    for (let i = 0; i < 20; i++) {
      const arr1 = await store.getAll(identifier);
      await new Promise(resolve => setImmediate(resolve));
      const arr2 = await store.getAll(identifier);

      // The array should only decrease (due to cleanup) or stay same
      if (arr2.length > arr1.length) {
        corruptionDetected = true;
        console.log(`Corruption: array grew from ${arr1.length} to ${arr2.length}`);
      }
    }
  };

  const continuousCleanup = async () => {
    for (let i = 0; i < 20; i++) {
      await store.cleanup(now - 5000, identifier);
      await new Promise(resolve => setImmediate(resolve));
    }
  };

  await Promise.all([
    getAllAndCheck(),
    continuousCleanup(),
    continuousCleanup()
  ]);

  // If corruption detected, the data structure is inconsistent
  if (corruptionDetected) {
    console.log('Data structure corruption detected during concurrent operations');
  }
});

test('BENCHMARK: Measure race condition probability', async (t) => {
  const iterations = 10;
  let raceDetected = 0;

  for (let iter = 0; iter < iterations; iter++) {
    const store = new InMemoryStore();
    const identifier = `bench-${iter}`;
    const expectedCount = 500;

    const promises = [];
    for (let i = 0; i < expectedCount; i++) {
      promises.push(store.add(Date.now() + i, identifier));
    }

    await Promise.all(promises);

    const actualCount = await store.count(identifier);

    if (actualCount !== expectedCount) {
      raceDetected++;
      console.log(`Iteration ${iter}: Expected ${expectedCount}, got ${actualCount} (lost ${expectedCount - actualCount})`);
    }
  }

  console.log(`Race conditions detected in ${raceDetected}/${iterations} iterations`);

  if (raceDetected > 0) {
    console.log(`RACE CONDITIONS ARE REPRODUCIBLE: ${(raceDetected / iterations * 100).toFixed(1)}% of the time`);
  }
});

test('Edge case: Cleanup deletes key while another operation reads it', async (t) => {
  const store = new InMemoryStore();
  const identifier = 'delete-race';
  const now = Date.now();

  // Add old timestamps that will be cleaned up
  await store.add(now - 10000, identifier);
  await store.add(now - 9000, identifier);

  let readDuringDelete = false;

  const cleanupAll = async () => {
    await new Promise(resolve => setImmediate(resolve));
    await store.cleanup(now, identifier); // This will delete the key
  };

  const readDuringCleanup = async () => {
    for (let i = 0; i < 10; i++) {
      const all = await store.getAll(identifier);
      if (all.length === 0) {
        readDuringDelete = true;
      }
      await new Promise(resolve => setImmediate(resolve));
    }
  };

  await Promise.all([
    cleanupAll(),
    readDuringCleanup(),
    readDuringCleanup()
  ]);

  console.log(`Read during/after delete: ${readDuringDelete}`);
});
