const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { setTimeout: sleep } = require('node:timers/promises');
const { request, Agent, setGlobalDispatcher, getGlobalDispatcher } = require('undici');
const Redis = require('ioredis');
const createRateLimiterInterceptor = require('..');

const originalGlobalDispatcher = getGlobalDispatcher();

let redis;

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
    console.error('Redis connection failed. Skipping Redis integration tests.');
    console.error('Please ensure Redis is running: docker run -d -p 6379:6379 redis:alpine');
    process.exit(0);
  }
});

test.beforeEach(async () => {
  // Clean up Redis before each test
  await redis.flushdb();
});

test.afterEach(() => setGlobalDispatcher(originalGlobalDispatcher));

test.after(async () => {
  if (redis) {
    await redis.quit();
  }
});

test('Redis - should allow requests under the limit', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('OK');
  });

  await new Promise(resolve => server.listen(0, resolve));

  t.after(() => server.close());

  const dispatcher = new Agent().compose(
    createRateLimiterInterceptor({
      redis,
      redisKeyPrefix: 'test:',
      maxRequests: 5,
      windowMs: 1000
    })
  );

  setGlobalDispatcher(dispatcher);

  const port = server.address().port;

  // Make 5 requests (should all succeed)
  for (let i = 0; i < 5; i++) {
    const { statusCode } = await request(`http://localhost:${port}`);
    assert.strictEqual(statusCode, 200, `Request ${i + 1} should succeed`);
  }
});

test('Redis - should block requests over the limit', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('OK');
  });

  await new Promise(resolve => server.listen(0, resolve));

  t.after(() => server.close());

  const dispatcher = new Agent().compose(
    createRateLimiterInterceptor({
      redis,
      redisKeyPrefix: 'test:',
      maxRequests: 3,
      windowMs: 1000
    })
  );

  setGlobalDispatcher(dispatcher);

  const port = server.address().port;

  // Make 3 requests (should succeed)
  for (let i = 0; i < 3; i++) {
    const { statusCode } = await request(`http://localhost:${port}`);
    assert.strictEqual(statusCode, 200);
  }

  // 4th request should be blocked
  await assert.rejects(
    async () => {
      await request(`http://localhost:${port}`);
    },
    (err) => {
      assert.strictEqual(err.code, 'RATE_LIMIT_EXCEEDED');
      assert.strictEqual(err.statusCode, 429);
      assert.match(err.message, /Rate limit exceeded/);
      return true;
    },
    'Should throw rate limit error'
  );
});

test('Redis - should reset after window expires', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('OK');
  });

  await new Promise(resolve => server.listen(0, resolve));

  t.after(() => server.close());

  const dispatcher = new Agent().compose(
    createRateLimiterInterceptor({
      redis,
      redisKeyPrefix: 'test:',
      maxRequests: 2,
      windowMs: 200 // 200ms window
    })
  );

  setGlobalDispatcher(dispatcher);

  const port = server.address().port;

  // Make 2 requests
  for (let i = 0; i < 2; i++) {
    const { statusCode } = await request(`http://localhost:${port}`);
    assert.strictEqual(statusCode, 200);
  }

  // Wait for window to expire
  await sleep(250);

  // Should allow new requests
  const { statusCode } = await request(`http://localhost:${port}`);
  assert.strictEqual(statusCode, 200, 'Should allow request after window expires');
});

test('Redis - should call onRateLimitExceeded callback', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('OK');
  });

  await new Promise(resolve => server.listen(0, resolve));

  t.after(() => server.close());

  let callbackData = null;

  const dispatcher = new Agent().compose(
    createRateLimiterInterceptor({
      redis,
      redisKeyPrefix: 'test:',
      maxRequests: 2,
      windowMs: 1000,
      onRateLimitExceeded: (info) => {
        callbackData = info;
      }
    })
  );

  setGlobalDispatcher(dispatcher);

  const port = server.address().port;

  // Exhaust limit
  for (let i = 0; i < 2; i++) {
    await request(`http://localhost:${port}`);
  }

  // Trigger rate limit
  await assert.rejects(
    async () => {
      await request(`http://localhost:${port}`);
    },
    (err) => err.code === 'RATE_LIMIT_EXCEEDED'
  );

  assert.ok(callbackData, 'Callback should be called');
  assert.strictEqual(callbackData.maxRequests, 2);
  assert.strictEqual(callbackData.windowMs, 1000);
  assert.ok(callbackData.currentRequests >= 2);
  assert.ok(callbackData.identifier);
});

test('Redis - should include rate limit headers in response', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('OK');
  });

  await new Promise(resolve => server.listen(0, resolve));

  t.after(() => server.close());

  const dispatcher = new Agent().compose(
    createRateLimiterInterceptor({
      redis,
      redisKeyPrefix: 'test:',
      maxRequests: 5,
      windowMs: 1000
    })
  );

  setGlobalDispatcher(dispatcher);

  const port = server.address().port;

  // Make first request and check headers
  const response = await request(`http://localhost:${port}`);

  assert.strictEqual(response.statusCode, 200);
  assert.ok(response.headers['x-ratelimit-limit'], 'Should have x-ratelimit-limit header');
  assert.ok(response.headers['x-ratelimit-remaining'], 'Should have x-ratelimit-remaining header');
  assert.ok(response.headers['x-ratelimit-reset'], 'Should have x-ratelimit-reset header');

  assert.strictEqual(response.headers['x-ratelimit-limit'], '5', 'Limit should be 5');
  assert.strictEqual(response.headers['x-ratelimit-remaining'], '4', 'Remaining should be 4 after first request');

  const resetTime = parseInt(response.headers['x-ratelimit-reset']);
  assert.ok(resetTime > Math.floor(Date.now() / 1000), 'Reset time should be in the future');
});

test('Redis - should exclude headers when includeHeaders is false', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('OK');
  });

  await new Promise(resolve => server.listen(0, resolve));

  t.after(() => server.close());

  const dispatcher = new Agent().compose(
    createRateLimiterInterceptor({
      redis,
      redisKeyPrefix: 'test:',
      maxRequests: 5,
      windowMs: 1000,
      includeHeaders: false
    })
  );

  setGlobalDispatcher(dispatcher);

  const port = server.address().port;

  // Make request and verify no rate limit headers
  const response = await request(`http://localhost:${port}`);

  assert.strictEqual(response.statusCode, 200);
  assert.strictEqual(response.headers['x-ratelimit-limit'], undefined, 'Should not have x-ratelimit-limit header');
  assert.strictEqual(response.headers['x-ratelimit-remaining'], undefined, 'Should not have x-ratelimit-remaining header');
  assert.strictEqual(response.headers['x-ratelimit-reset'], undefined, 'Should not have x-ratelimit-reset header');
});

test('Redis - should support custom identifier function', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('OK');
  });

  await new Promise(resolve => server.listen(0, resolve));

  t.after(() => server.close());

  let capturedIdentifier = null;

  const dispatcher = new Agent().compose(
    createRateLimiterInterceptor({
      redis,
      redisKeyPrefix: 'test:',
      maxRequests: 2,
      windowMs: 1000,
      identifier: (opts) => {
        const userId = opts.headers['x-user-id'] || 'anonymous';
        return `user:${userId}`;
      },
      onRateLimitExceeded: (info) => {
        capturedIdentifier = info.identifier;
      }
    })
  );

  setGlobalDispatcher(dispatcher);

  const port = server.address().port;

  // Make 2 requests with user-1
  for (let i = 0; i < 2; i++) {
    await request(`http://localhost:${port}`, {
      headers: { 'x-user-id': 'user-1' }
    });
  }

  // 3rd request for user-1 should be blocked
  await assert.rejects(
    async () => {
      await request(`http://localhost:${port}`, {
        headers: { 'x-user-id': 'user-1' }
      });
    },
    (err) => err.code === 'RATE_LIMIT_EXCEEDED'
  );

  assert.strictEqual(capturedIdentifier, 'user:user-1', 'Should use custom identifier');

  // But user-2 should still work
  const { statusCode } = await request(`http://localhost:${port}`, {
    headers: { 'x-user-id': 'user-2' }
  });
  assert.strictEqual(statusCode, 200, 'Different user should not be rate limited');
});

test('Redis - should rate limit per endpoint separately', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('OK');
  });

  await new Promise(resolve => server.listen(0, resolve));

  t.after(() => server.close());

  const dispatcher = new Agent().compose(
    createRateLimiterInterceptor({
      redis,
      redisKeyPrefix: 'test:',
      maxRequests: 2,
      windowMs: 1000
    })
  );

  setGlobalDispatcher(dispatcher);

  const port = server.address().port;

  // Make 2 requests to /api/users
  for (let i = 0; i < 2; i++) {
    const { statusCode } = await request(`http://localhost:${port}/api/users`);
    assert.strictEqual(statusCode, 200);
  }

  // 3rd request to /api/users should be blocked
  await assert.rejects(
    async () => {
      await request(`http://localhost:${port}/api/users`);
    },
    (err) => err.code === 'RATE_LIMIT_EXCEEDED'
  );

  // But /api/posts should still work (different endpoint)
  const { statusCode } = await request(`http://localhost:${port}/api/posts`);
  assert.strictEqual(statusCode, 200, 'Different endpoint should not be rate limited');
});

test('Redis - should handle concurrent requests correctly', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('OK');
  });

  await new Promise(resolve => server.listen(0, resolve));

  t.after(() => server.close());

  const dispatcher = new Agent().compose(
    createRateLimiterInterceptor({
      redis,
      redisKeyPrefix: 'test:',
      maxRequests: 10,
      windowMs: 1000
    })
  );

  setGlobalDispatcher(dispatcher);

  const port = server.address().port;

  // Make 10 concurrent requests
  const promises = [];
  for (let i = 0; i < 10; i++) {
    promises.push(request(`http://localhost:${port}`));
  }

  const results = await Promise.all(promises);
  results.forEach(({ statusCode }) => {
    assert.strictEqual(statusCode, 200);
  });

  // 11th request should be blocked
  await assert.rejects(
    async () => {
      await request(`http://localhost:${port}`);
    },
    (err) => err.code === 'RATE_LIMIT_EXCEEDED'
  );
});

test('Redis - should handle different HTTP methods separately', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('OK');
  });

  await new Promise(resolve => server.listen(0, resolve));

  t.after(() => server.close());

  const dispatcher = new Agent().compose(
    createRateLimiterInterceptor({
      redis,
      redisKeyPrefix: 'test:',
      maxRequests: 1,
      windowMs: 1000
    })
  );

  setGlobalDispatcher(dispatcher);

  const port = server.address().port;

  // GET request
  await request(`http://localhost:${port}/api`, { method: 'GET' });

  // Second GET should be blocked
  await assert.rejects(
    async () => {
      await request(`http://localhost:${port}/api`, { method: 'GET' });
    },
    (err) => err.code === 'RATE_LIMIT_EXCEEDED'
  );

  // But POST should work (different method = different identifier)
  const { statusCode } = await request(`http://localhost:${port}/api`, {
    method: 'POST',
    body: 'test'
  });
  assert.strictEqual(statusCode, 200, 'Different method should not be rate limited');
});

test('Redis - should persist rate limits across multiple interceptor instances', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('OK');
  });

  await new Promise(resolve => server.listen(0, resolve));

  t.after(() => server.close());

  const port = server.address().port;

  // Create first dispatcher and make 2 requests
  const dispatcher1 = new Agent().compose(
    createRateLimiterInterceptor({
      redis,
      redisKeyPrefix: 'shared:',
      maxRequests: 3,
      windowMs: 1000
    })
  );

  setGlobalDispatcher(dispatcher1);

  for (let i = 0; i < 2; i++) {
    const { statusCode } = await request(`http://localhost:${port}`);
    assert.strictEqual(statusCode, 200);
  }

  // Create second dispatcher with same Redis and make 1 more request
  const dispatcher2 = new Agent().compose(
    createRateLimiterInterceptor({
      redis,
      redisKeyPrefix: 'shared:',
      maxRequests: 3,
      windowMs: 1000
    })
  );

  setGlobalDispatcher(dispatcher2);

  const { statusCode } = await request(`http://localhost:${port}`);
  assert.strictEqual(statusCode, 200);

  // 4th request should be blocked (we made 2 + 1 + 1 = 4 requests with limit of 3)
  await assert.rejects(
    async () => {
      await request(`http://localhost:${port}`);
    },
    (err) => err.code === 'RATE_LIMIT_EXCEEDED',
    'Should block request across different interceptor instances'
  );
});

test('Redis - should handle store cleanup errors gracefully', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('OK');
  });

  await new Promise(resolve => server.listen(0, resolve));

  t.after(() => server.close());

  // Create a Redis client that will fail on cleanup
  const flakyRedis = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    db: process.env.REDIS_DB || 15
  });

  const originalZremrangebyscore = flakyRedis.zremrangebyscore.bind(flakyRedis);
  flakyRedis.zremrangebyscore = async function() {
    throw new Error('Redis cleanup failed');
  };

  t.after(() => flakyRedis.quit());

  const dispatcher = new Agent().compose(
    createRateLimiterInterceptor({
      redis: flakyRedis,
      redisKeyPrefix: 'test:',
      maxRequests: 5,
      windowMs: 1000
    })
  );

  setGlobalDispatcher(dispatcher);

  const port = server.address().port;

  // Should still work despite cleanup error (error is caught and warned)
  const { statusCode } = await request(`http://localhost:${port}`);
  assert.strictEqual(statusCode, 200, 'Should handle cleanup errors gracefully');
});

test('Redis - should update remaining count in headers correctly', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('OK');
  });

  await new Promise(resolve => server.listen(0, resolve));

  t.after(() => server.close());

  const dispatcher = new Agent().compose(
    createRateLimiterInterceptor({
      redis,
      redisKeyPrefix: 'test:',
      maxRequests: 3,
      windowMs: 1000
    })
  );

  setGlobalDispatcher(dispatcher);

  const port = server.address().port;

  // Make 3 requests and check remaining decreases
  for (let i = 0; i < 3; i++) {
    const response = await request(`http://localhost:${port}`);
    const expectedRemaining = 3 - i - 1;

    assert.strictEqual(response.headers['x-ratelimit-remaining'], String(expectedRemaining),
      `Request ${i + 1}: Remaining should be ${expectedRemaining}`);
  }
});

test('Redis - should work with custom key prefix', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('OK');
  });

  await new Promise(resolve => server.listen(0, resolve));

  t.after(() => server.close());

  const dispatcher = new Agent().compose(
    createRateLimiterInterceptor({
      redis,
      redisKeyPrefix: 'myapp:ratelimit:',
      maxRequests: 2,
      windowMs: 1000
    })
  );

  setGlobalDispatcher(dispatcher);

  const port = server.address().port;

  // Make 2 requests
  for (let i = 0; i < 2; i++) {
    const { statusCode } = await request(`http://localhost:${port}`);
    assert.strictEqual(statusCode, 200);
  }

  // Verify key exists in Redis with correct prefix
  const keys = await redis.keys('myapp:ratelimit:*');
  assert.ok(keys.length > 0, 'Should have keys with custom prefix');
});
