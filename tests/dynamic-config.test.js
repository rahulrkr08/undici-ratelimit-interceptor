const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { setTimeout: sleep } = require('node:timers/promises');
const { request, Agent, setGlobalDispatcher, getGlobalDispatcher } = require('undici');
const createRateLimiterInterceptor = require('..');

const originalGlobalDispatcher = getGlobalDispatcher();

test.afterEach(() => setGlobalDispatcher(originalGlobalDispatcher));

test('maxRequests as callback function - static return', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('OK');
  });

  await new Promise(resolve => server.listen(0, resolve));

  t.after(() => server.close());

  const dispatcher = new Agent().compose(
    createRateLimiterInterceptor({
      maxRequests: (opts) => 3, // Dynamic but always returns 3
      windowMs: 1000
    })
  );

  setGlobalDispatcher(dispatcher);

  const port = server.address().port;

  // Make 3 requests (should succeed)
  for (let i = 0; i < 3; i++) {
    const { statusCode } = await request(`http://localhost:${port}`);
    assert.strictEqual(statusCode, 200, `Request ${i + 1} should succeed`);
  }

  // 4th request should be blocked
  await assert.rejects(
    async () => {
      await request(`http://localhost:${port}`);
    },
    (err) => {
      assert.strictEqual(err.code, 'RATE_LIMIT_EXCEEDED');
      return true;
    }
  );
});

test('windowMs as callback function - static return', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('OK');
  });

  await new Promise(resolve => server.listen(0, resolve));

  t.after(() => server.close());

  const dispatcher = new Agent().compose(
    createRateLimiterInterceptor({
      maxRequests: 2,
      windowMs: (opts) => 200 // Dynamic but always returns 200ms
    })
  );

  setGlobalDispatcher(dispatcher);

  const port = server.address().port;

  // Make 2 requests (should succeed)
  for (let i = 0; i < 2; i++) {
    const { statusCode } = await request(`http://localhost:${port}`);
    assert.strictEqual(statusCode, 200);
  }

  // 3rd request should be blocked
  await assert.rejects(
    async () => {
      await request(`http://localhost:${port}`);
    },
    (err) => {
      assert.strictEqual(err.code, 'RATE_LIMIT_EXCEEDED');
      return true;
    }
  );

  // Wait for window to expire
  await sleep(250);

  // Request should succeed after window expires
  const { statusCode } = await request(`http://localhost:${port}`);
  assert.strictEqual(statusCode, 200, 'Request should succeed after window reset');
});

test('maxRequests callback receives opts parameter', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('OK');
  });

  await new Promise(resolve => server.listen(0, resolve));

  t.after(() => server.close());

  let callCount = 0;
  let receivedOpts = null;

  const dispatcher = new Agent().compose(
    createRateLimiterInterceptor({
      maxRequests: (opts) => {
        callCount++;
        receivedOpts = opts;
        return 2;
      },
      windowMs: 1000
    })
  );

  setGlobalDispatcher(dispatcher);

  const port = server.address().port;

  // Make a request
  await request(`http://localhost:${port}`);

  assert.ok(callCount > 0, 'maxRequests callback should be called');
  assert.ok(receivedOpts, 'maxRequests callback should receive opts');
  assert.strictEqual(typeof receivedOpts.method, 'string', 'opts should contain method');
  assert.ok(receivedOpts.origin, 'opts should contain origin');
  assert.ok(receivedOpts.path, 'opts should contain path');
});

test('windowMs callback receives opts parameter', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('OK');
  });

  await new Promise(resolve => server.listen(0, resolve));

  t.after(() => server.close());

  let callCount = 0;
  let receivedOpts = null;

  const dispatcher = new Agent().compose(
    createRateLimiterInterceptor({
      maxRequests: 2,
      windowMs: (opts) => {
        callCount++;
        receivedOpts = opts;
        return 200;
      }
    })
  );

  setGlobalDispatcher(dispatcher);

  const port = server.address().port;

  // Make a request
  await request(`http://localhost:${port}`);

  assert.ok(callCount > 0, 'windowMs callback should be called');
  assert.ok(receivedOpts, 'windowMs callback should receive opts');
  assert.strictEqual(typeof receivedOpts.method, 'string', 'opts should contain method');
});

test('Dynamic maxRequests based on path', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('OK');
  });

  await new Promise(resolve => server.listen(0, resolve));

  t.after(() => server.close());

  const dispatcher = new Agent().compose(
    createRateLimiterInterceptor({
      maxRequests: (opts) => {
        // Higher limit for /premium paths
        if (opts.path.includes('premium')) {
          return 5;
        }
        return 2;
      },
      windowMs: 1000
    })
  );

  setGlobalDispatcher(dispatcher);

  const port = server.address().port;

  // Test standard path - limit is 2
  for (let i = 0; i < 2; i++) {
    const { statusCode } = await request(`http://localhost:${port}/standard`);
    assert.strictEqual(statusCode, 200);
  }

  // Third request on standard path should be blocked
  await assert.rejects(
    async () => {
      await request(`http://localhost:${port}/standard`);
    },
    (err) => {
      assert.strictEqual(err.code, 'RATE_LIMIT_EXCEEDED');
      return true;
    }
  );

  // Premium path should have higher limit (5)
  for (let i = 0; i < 5; i++) {
    const { statusCode } = await request(`http://localhost:${port}/premium`);
    assert.strictEqual(statusCode, 200, `Premium request ${i + 1} should succeed`);
  }

  // 6th premium request should be blocked
  await assert.rejects(
    async () => {
      await request(`http://localhost:${port}/premium`);
    },
    (err) => {
      assert.strictEqual(err.code, 'RATE_LIMIT_EXCEEDED');
      return true;
    }
  );
});

test('Dynamic windowMs based on headers', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('OK');
  });

  await new Promise(resolve => server.listen(0, resolve));

  t.after(() => server.close());

  const dispatcher = new Agent().compose(
    createRateLimiterInterceptor({
      maxRequests: 2,
      windowMs: (opts) => {
        // VIP users get 1 hour window
        if (opts.headers && opts.headers['x-user-tier'] === 'vip') {
          return 3600000;
        }
        // Standard users get 100ms window for testing
        return 100;
      }
    })
  );

  setGlobalDispatcher(dispatcher);

  const port = server.address().port;

  // Standard user - 100ms window
  for (let i = 0; i < 2; i++) {
    const { statusCode } = await request(`http://localhost:${port}`, {
      headers: { 'x-user-tier': 'standard' }
    });
    assert.strictEqual(statusCode, 200);
  }

  // Third request should be blocked
  await assert.rejects(
    async () => {
      await request(`http://localhost:${port}`, {
        headers: { 'x-user-tier': 'standard' }
      });
    },
    (err) => {
      assert.strictEqual(err.code, 'RATE_LIMIT_EXCEEDED');
      return true;
    }
  );

  // Wait for window to reset
  await sleep(120);

  // Should be able to make more requests now
  const { statusCode } = await request(`http://localhost:${port}`, {
    headers: { 'x-user-tier': 'standard' }
  });
  assert.strictEqual(statusCode, 200, 'Should succeed after window reset');
});

test('Both maxRequests and windowMs as callbacks', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('OK');
  });

  await new Promise(resolve => server.listen(0, resolve));

  t.after(() => server.close());

  const dispatcher = new Agent().compose(
    createRateLimiterInterceptor({
      maxRequests: (opts) => {
        return opts.path === '/strict' ? 1 : 3;
      },
      windowMs: (opts) => {
        return opts.path === '/quick' ? 50 : 200;
      }
    })
  );

  setGlobalDispatcher(dispatcher);

  const port = server.address().port;

  // Test strict path with 1 request limit
  const { statusCode: s1 } = await request(`http://localhost:${port}/strict`);
  assert.strictEqual(s1, 200);

  await assert.rejects(
    async () => {
      await request(`http://localhost:${port}/strict`);
    },
    (err) => {
      assert.strictEqual(err.code, 'RATE_LIMIT_EXCEEDED');
      return true;
    }
  );

  // Test quick path with 50ms window
  for (let i = 0; i < 3; i++) {
    const { statusCode } = await request(`http://localhost:${port}/quick`);
    assert.strictEqual(statusCode, 200);
  }

  await assert.rejects(
    async () => {
      await request(`http://localhost:${port}/quick`);
    },
    (err) => {
      assert.strictEqual(err.code, 'RATE_LIMIT_EXCEEDED');
      return true;
    }
  );

  // Wait for quick window to reset
  await sleep(60);

  // Should be able to make requests on quick path again
  const { statusCode: s2 } = await request(`http://localhost:${port}/quick`);
  assert.strictEqual(s2, 200, 'Should succeed after quick window reset');
});

test('Rate limit info reflects dynamic values', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('OK');
  });

  await new Promise(resolve => server.listen(0, resolve));

  t.after(() => server.close());

  const dispatcher = new Agent().compose(
    createRateLimiterInterceptor({
      maxRequests: (opts) => 5,
      windowMs: (opts) => 1000,
      includeHeaders: true
    })
  );

  setGlobalDispatcher(dispatcher);

  const port = server.address().port;

  // Make a request
  const { headers } = await request(`http://localhost:${port}`);

  // Check rate limit headers
  const limit = headers['x-ratelimit-limit'];
  const remaining = headers['x-ratelimit-remaining'];
  const reset = headers['x-ratelimit-reset'];

  assert.strictEqual(limit, '5', 'Limit header should reflect callback result');
  assert.ok(remaining, 'Should have remaining header');
  assert.ok(reset, 'Should have reset header');
  assert.strictEqual(parseInt(remaining), 4, 'Should have 4 remaining after 1 request');
});

test('onRateLimitExceeded callback receives correct dynamic values', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('OK');
  });

  await new Promise(resolve => server.listen(0, resolve));

  t.after(() => server.close());

  let callbackData = null;

  const dispatcher = new Agent().compose(
    createRateLimiterInterceptor({
      maxRequests: (opts) => 2,
      windowMs: (opts) => 1000,
      onRateLimitExceeded: (info) => {
        callbackData = info;
      }
    })
  );

  setGlobalDispatcher(dispatcher);

  const port = server.address().port;

  // Make 2 requests
  for (let i = 0; i < 2; i++) {
    await request(`http://localhost:${port}`);
  }

  // This should trigger the callback
  try {
    await request(`http://localhost:${port}`);
  } catch (err) {
    // Expected to fail
  }

  assert.ok(callbackData, 'Callback should be called');
  assert.strictEqual(callbackData.maxRequests, 2, 'Should have correct maxRequests from callback');
  assert.strictEqual(callbackData.windowMs, 1000, 'Should have correct windowMs from callback');
  assert.strictEqual(callbackData.currentRequests, 2, 'Should have correct currentRequests');
});
