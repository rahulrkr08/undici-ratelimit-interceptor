const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { setTimeout: sleep } = require('node:timers/promises');
const { request, Agent, setGlobalDispatcher, getGlobalDispatcher } = require('undici');
const createRateLimiterInterceptor = require('..');

const originalGlobalDispatcher = getGlobalDispatcher();

test.afterEach(() => setGlobalDispatcher(originalGlobalDispatcher));

test('should allow requests under the limit', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('OK');
  });

  await new Promise(resolve => server.listen(0, resolve));

  t.after(() => server.close());

  const dispatcher = new Agent().compose(
    createRateLimiterInterceptor({
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

test('should block requests over the limit', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('OK');
  });

  await new Promise(resolve => server.listen(0, resolve));

  t.after(() => server.close());

  const dispatcher = new Agent().compose(
    createRateLimiterInterceptor({
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

test('should reset after window expires', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('OK');
  });

  await new Promise(resolve => server.listen(0, resolve));

  t.after(() => server.close());

  const dispatcher = new Agent().compose(
    createRateLimiterInterceptor({
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

test('should call onRateLimitExceeded callback', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('OK');
  });

  await new Promise(resolve => server.listen(0, resolve));

  t.after(() => server.close());

  let callbackData = null;

  const dispatcher = new Agent().compose(
    createRateLimiterInterceptor({
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

test('should use default identifier (method:origin:path)', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('OK');
  });

  await new Promise(resolve => server.listen(0, resolve));

  t.after(() => server.close());

  let capturedIdentifier = null;

  const dispatcher = new Agent().compose(
    createRateLimiterInterceptor({
      maxRequests: 1,
      windowMs: 1000,
      onRateLimitExceeded: (info) => {
        capturedIdentifier = info.identifier;
      }
    })
  );

  setGlobalDispatcher(dispatcher);

  const port = server.address().port;

  // First request succeeds
  await request(`http://localhost:${port}/test`);

  // Second request should be rate limited
  await assert.rejects(
    async () => {
      await request(`http://localhost:${port}/test`);
    },
    (err) => err.code === 'RATE_LIMIT_EXCEEDED'
  );

  assert.ok(capturedIdentifier, 'Identifier should be captured');
  assert.match(capturedIdentifier, /GET:.*:\/test/, 'Should match default format');
});

test('should rate limit per endpoint separately', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('OK');
  });

  await new Promise(resolve => server.listen(0, resolve));

  t.after(() => server.close());

  const dispatcher = new Agent().compose(
    createRateLimiterInterceptor({
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

test('should support custom identifier function', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('OK');
  });

  await new Promise(resolve => server.listen(0, resolve));

  t.after(() => server.close());

  let capturedIdentifier = null;

  const dispatcher = new Agent().compose(
    createRateLimiterInterceptor({
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

test('should handle missing custom identifier gracefully', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('OK');
  });

  await new Promise(resolve => server.listen(0, resolve));

  t.after(() => server.close());

  const dispatcher = new Agent().compose(
    createRateLimiterInterceptor({
      maxRequests: 1,
      windowMs: 1000,
      identifier: (opts) => {
        const userId = opts.headers?.['x-user-id'] || 'anonymous';
        return `user:${userId}`;
      }
    })
  );

  setGlobalDispatcher(dispatcher);

  const port = server.address().port;

  // Request without x-user-id header should use 'anonymous'
  const { statusCode } = await request(`http://localhost:${port}`);
  assert.strictEqual(statusCode, 200, 'Should handle missing identifier');
});

test('should handle concurrent requests correctly', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('OK');
  });

  await new Promise(resolve => server.listen(0, resolve));

  t.after(() => server.close());

  const dispatcher = new Agent().compose(
    createRateLimiterInterceptor({
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

test('should handle different HTTP methods separately', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('OK');
  });

  await new Promise(resolve => server.listen(0, resolve));

  t.after(() => server.close());

  const dispatcher = new Agent().compose(
    createRateLimiterInterceptor({
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

test('should handle very low maxRequests (1 request limit)', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('OK');
  });

  await new Promise(resolve => server.listen(0, resolve));

  t.after(() => server.close());

  const dispatcher = new Agent().compose(
    createRateLimiterInterceptor({
      maxRequests: 1,
      windowMs: 1000
    })
  );

  setGlobalDispatcher(dispatcher);

  const port = server.address().port;

  // First request should succeed
  const { statusCode } = await request(`http://localhost:${port}`);
  assert.strictEqual(statusCode, 200, 'First request should succeed');

  // Second request should be blocked
  try {
    await request(`http://localhost:${port}`);
    assert.fail('Should have thrown rate limit error');
  } catch (err) {
    assert.strictEqual(err.code, 'RATE_LIMIT_EXCEEDED', 'Second request should be blocked');
    assert.strictEqual(err.statusCode, 429);
  }
});

test('should include identifier in error object', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('OK');
  });

  await new Promise(resolve => server.listen(0, resolve));

  t.after(() => server.close());

  const dispatcher = new Agent().compose(
    createRateLimiterInterceptor({
      maxRequests: 1,
      windowMs: 1000
    })
  );

  setGlobalDispatcher(dispatcher);

  const port = server.address().port;

  // First request
  await request(`http://localhost:${port}/test`);

  // Second request should include identifier in error
  await assert.rejects(
    async () => {
      await request(`http://localhost:${port}/test`);
    },
    (err) => {
      assert.strictEqual(err.code, 'RATE_LIMIT_EXCEEDED');
      assert.ok(err.identifier, 'Error should include identifier');
      assert.match(err.identifier, /GET:.*:\/test/);
      return true;
    }
  );
});

test('should work with default options', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('OK');
  });

  await new Promise(resolve => server.listen(0, resolve));

  t.after(() => server.close());

  // No options provided - should use defaults
  const dispatcher = new Agent().compose(createRateLimiterInterceptor());

  setGlobalDispatcher(dispatcher);

  const port = server.address().port;

  // Should work with default maxRequests (100)
  const { statusCode } = await request(`http://localhost:${port}`);
  assert.strictEqual(statusCode, 200, 'Should work with default options');
});

test('should handle store cleanup errors gracefully', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('OK');
  });

  await new Promise(resolve => server.listen(0, resolve));

  t.after(() => server.close());

  const InMemoryStore = require('../lib/store/memory');
  
  // Mock the cleanup to throw an error
  const originalCleanup = InMemoryStore.prototype.cleanup;
  InMemoryStore.prototype.cleanup = async function() {
    throw new Error('Cleanup failed');
  };

  t.after(() => {
    InMemoryStore.prototype.cleanup = originalCleanup;
  });

  const dispatcher = new Agent().compose(
    createRateLimiterInterceptor({
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

test('should handle store count errors', async (t) => {
  const InMemoryStore = require('../lib/store/memory');
  
  // Mock count to throw an error
  const originalCount = InMemoryStore.prototype.count;
  let errorThrown = false;
  
  InMemoryStore.prototype.count = async function() {
    errorThrown = true;
    throw new Error('Count failed');
  };

  t.after(() => {
    InMemoryStore.prototype.count = originalCount;
  });

  const mockDispatch = (opts, handler) => {
    handler.onHeaders(200, [], () => {});
    handler.onData(Buffer.from('OK'));
    handler.onComplete([]);
  };

  const interceptor = createRateLimiterInterceptor({
    maxRequests: 5,
    windowMs: 1000
  });

  const wrappedDispatch = interceptor(mockDispatch);

  // Call the interceptor directly
  try {
    await wrappedDispatch(
      { path: '/', method: 'GET', origin: 'http://localhost' },
      {
        onHeaders: () => {},
        onData: () => {},
        onComplete: () => {},
        onError: (err) => {
          throw err;
        }
      }
    );
    assert.fail('Should have thrown error');
  } catch (err) {
    assert.ok(errorThrown, 'Count should have been called');
    assert.match(err.message, /Count failed/, 'Should propagate count errors');
  }
});

test('should handle store add errors', async (t) => {
  const InMemoryStore = require('../lib/store/memory');
  
  // Mock add to throw an error
  const originalAdd = InMemoryStore.prototype.add;
  let errorThrown = false;
  
  InMemoryStore.prototype.add = async function() {
    errorThrown = true;
    throw new Error('Add failed');
  };

  t.after(() => {
    InMemoryStore.prototype.add = originalAdd;
  });

  const mockDispatch = (opts, handler) => {
    handler.onHeaders(200, [], () => {});
    handler.onData(Buffer.from('OK'));
    handler.onComplete([]);
  };

  const interceptor = createRateLimiterInterceptor({
    maxRequests: 5,
    windowMs: 1000
  });

  const wrappedDispatch = interceptor(mockDispatch);

  // Call the interceptor directly
  try {
    await wrappedDispatch(
      { path: '/', method: 'GET', origin: 'http://localhost' },
      {
        onHeaders: () => {},
        onData: () => {},
        onComplete: () => {},
        onError: (err) => {
          throw err;
        }
      }
    );
    assert.fail('Should have thrown error');
  } catch (err) {
    assert.ok(errorThrown, 'Add should have been called');
    assert.match(err.message, /Add failed/, 'Should propagate add errors');
  }
});

test('should handle getCurrentCount errors', async (t) => {
  const InMemoryStore = require('../lib/store/memory');
  
  let callCount = 0;
  const originalCount = InMemoryStore.prototype.count;
  
  // Mock count to fail on second call (first succeeds for isRateLimited check)
  InMemoryStore.prototype.count = async function() {
    callCount++;
    if (callCount > 1) {
      throw new Error('Count failed on getCurrentCount');
    }
    return 100; // Return high count to trigger rate limit
  };

  t.after(() => {
    InMemoryStore.prototype.count = originalCount;
  });

  const mockDispatch = (opts, handler) => {
    handler.onHeaders(200, [], () => {});
    handler.onData(Buffer.from('OK'));
    handler.onComplete([]);
  };

  const interceptor = createRateLimiterInterceptor({
    maxRequests: 5,
    windowMs: 1000
  });

  const wrappedDispatch = interceptor(mockDispatch);

  // Call the interceptor directly
  try {
    await wrappedDispatch(
      { path: '/', method: 'GET', origin: 'http://localhost' },
      {
        onHeaders: () => {},
        onData: () => {},
        onComplete: () => {},
        onError: (err) => {
          throw err;
        }
      }
    );
    assert.fail('Should have thrown error');
  } catch (err) {
    assert.ok(callCount > 1, 'Count should have been called multiple times');
    assert.match(err.message, /Count failed on getCurrentCount/, 'Should propagate getCurrentCount errors');
  }
});