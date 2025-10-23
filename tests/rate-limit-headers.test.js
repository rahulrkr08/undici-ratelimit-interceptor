const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { request, Agent, setGlobalDispatcher, getGlobalDispatcher } = require('undici');
const createRateLimiterInterceptor = require('..');

const originalGlobalDispatcher = getGlobalDispatcher();

test.afterEach(() => setGlobalDispatcher(originalGlobalDispatcher));

test('should include rate limit headers in response', async (t) => {
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

test('should update remaining count in headers', async (t) => {
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

  // Make 3 requests and check remaining decreases
  for (let i = 0; i < 3; i++) {
    const response = await request(`http://localhost:${port}`);
    const expectedRemaining = 3 - i - 1;

    assert.strictEqual(response.headers['x-ratelimit-remaining'], String(expectedRemaining),
      `Request ${i + 1}: Remaining should be ${expectedRemaining}`);
  }
});

test('should exclude headers when includeHeaders is false', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('OK');
  });

  await new Promise(resolve => server.listen(0, resolve));

  t.after(() => server.close());

  const dispatcher = new Agent().compose(
    createRateLimiterInterceptor({
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

test('should include headers by default when includeHeaders is not specified', async (t) => {
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
      // includeHeaders not specified, should default to true
    })
  );

  setGlobalDispatcher(dispatcher);

  const port = server.address().port;

  // Make request and verify headers are present
  const response = await request(`http://localhost:${port}`);

  assert.strictEqual(response.statusCode, 200);
  assert.ok(response.headers['x-ratelimit-limit'], 'Should have x-ratelimit-limit header by default');
  assert.ok(response.headers['x-ratelimit-remaining'], 'Should have x-ratelimit-remaining header by default');
  assert.ok(response.headers['x-ratelimit-reset'], 'Should have x-ratelimit-reset header by default');
});

test('should include headers when includeHeaders is explicitly true', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('OK');
  });

  await new Promise(resolve => server.listen(0, resolve));

  t.after(() => server.close());

  const dispatcher = new Agent().compose(
    createRateLimiterInterceptor({
      maxRequests: 5,
      windowMs: 1000,
      includeHeaders: true
    })
  );

  setGlobalDispatcher(dispatcher);

  const port = server.address().port;

  // Make request and verify headers are present
  const response = await request(`http://localhost:${port}`);

  assert.strictEqual(response.statusCode, 200);
  assert.ok(response.headers['x-ratelimit-limit'], 'Should have x-ratelimit-limit header');
  assert.ok(response.headers['x-ratelimit-remaining'], 'Should have x-ratelimit-remaining header');
  assert.ok(response.headers['x-ratelimit-reset'], 'Should have x-ratelimit-reset header');
});

test('should handle getOldestTimestamp errors', async (t) => {
  const InMemoryStore = require('../lib/store/memory');

  // Mock getAll to throw an error
  const originalGetAll = InMemoryStore.prototype.getAll;
  InMemoryStore.prototype.getAll = async function() {
    throw new Error('getAll failed');
  };

  t.after(() => {
    InMemoryStore.prototype.getAll = originalGetAll;
  });

  const mockDispatch = (opts, handler) => {
    handler.onHeaders(200, [], () => {});
    handler.onData(Buffer.from('OK'));
    handler.onComplete([]);
  };

  const interceptor = createRateLimiterInterceptor({
    maxRequests: 5,
    windowMs: 1000,
    includeHeaders: true
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
    assert.match(err.message, /getAll failed/, 'Should propagate getOldestTimestamp errors');
  }
});

test('should calculate reset time when no requests exist (fallback path)', async (t) => {
  const InMemoryStore = require('../lib/store/memory');

  // Mock getAll to return empty array to simulate no requests
  const originalGetAll = InMemoryStore.prototype.getAll;
  let callCount = 0;
  InMemoryStore.prototype.getAll = async function() {
    callCount++;
    // First call is for the identifier that was just recorded, return empty to trigger fallback
    return [];
  };

  t.after(() => {
    InMemoryStore.prototype.getAll = originalGetAll;
  });

  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('OK');
  });

  await new Promise(resolve => server.listen(0, resolve));

  t.after(() => server.close());

  const dispatcher = new Agent().compose(
    createRateLimiterInterceptor({
      maxRequests: 5,
      windowMs: 1000,
      includeHeaders: true
    })
  );

  setGlobalDispatcher(dispatcher);

  const port = server.address().port;

  // Make request - getAll will return empty, forcing the fallback reset calculation
  const beforeRequest = Math.floor(Date.now() / 1000);
  const response = await request(`http://localhost:${port}`);
  const afterRequest = Math.floor(Date.now() / 1000);

  assert.strictEqual(response.statusCode, 200);
  assert.ok(response.headers['x-ratelimit-reset'], 'Should have x-ratelimit-reset header');

  const resetTime = parseInt(response.headers['x-ratelimit-reset']);

  // Reset time should be approximately now + windowMs (1 second)
  assert.ok(resetTime >= beforeRequest, 'Reset time should be at least the time before request');
  assert.ok(resetTime <= afterRequest + 2, 'Reset time should be within reasonable range');
  assert.ok(callCount > 0, 'getAll should have been called');
});

test('should preserve onBodySent handler when present', async (t) => {
  let onBodySentCalled = false;

  const mockDispatch = (opts, handler) => {
    // Simulate request/response flow
    handler.onHeaders(200, [], () => {});
    handler.onData(Buffer.from('OK'));
    handler.onComplete([]);
    // Call onBodySent if it exists
    if (handler.onBodySent) {
      handler.onBodySent();
    }
  };

  const interceptor = createRateLimiterInterceptor({
    maxRequests: 5,
    windowMs: 1000,
    includeHeaders: true
  });

  const wrappedDispatch = interceptor(mockDispatch);

  await wrappedDispatch(
    { path: '/', method: 'GET', origin: 'http://localhost' },
    {
      onHeaders: () => {},
      onData: () => {},
      onComplete: () => {},
      onError: (err) => {
        throw err;
      },
      onBodySent: () => {
        onBodySentCalled = true;
      }
    }
  );

  assert.ok(onBodySentCalled, 'onBodySent should have been called');
});

test('should preserve onConnect handler when present', async (t) => {
  let onConnectCalled = false;

  const mockDispatch = (opts, handler) => {
    // Call onConnect if it exists
    if (handler.onConnect) {
      handler.onConnect();
    }
    // Simulate request/response flow
    handler.onHeaders(200, [], () => {});
    handler.onData(Buffer.from('OK'));
    handler.onComplete([]);
  };

  const interceptor = createRateLimiterInterceptor({
    maxRequests: 5,
    windowMs: 1000,
    includeHeaders: true
  });

  const wrappedDispatch = interceptor(mockDispatch);

  await wrappedDispatch(
    { path: '/', method: 'GET', origin: 'http://localhost' },
    {
      onHeaders: () => {},
      onData: () => {},
      onComplete: () => {},
      onError: (err) => {
        throw err;
      },
      onConnect: () => {
        onConnectCalled = true;
      }
    }
  );

  assert.ok(onConnectCalled, 'onConnect should have been called');
});

test('should preserve onUpgrade handler when present', async (t) => {
  let onUpgradeCalled = false;

  const mockDispatch = (opts, handler) => {
    // Call onUpgrade if it exists
    if (handler.onUpgrade) {
      handler.onUpgrade(101, []);
    }
    // Note: onUpgrade typically replaces normal flow, but for testing we'll also call the others
    handler.onHeaders(200, [], () => {});
    handler.onData(Buffer.from('OK'));
    handler.onComplete([]);
  };

  const interceptor = createRateLimiterInterceptor({
    maxRequests: 5,
    windowMs: 1000,
    includeHeaders: true
  });

  const wrappedDispatch = interceptor(mockDispatch);

  await wrappedDispatch(
    { path: '/', method: 'GET', origin: 'http://localhost' },
    {
      onHeaders: () => {},
      onData: () => {},
      onComplete: () => {},
      onError: (err) => {
        throw err;
      },
      onUpgrade: (statusCode, headers) => {
        onUpgradeCalled = true;
        assert.strictEqual(statusCode, 101);
      }
    }
  );

  assert.ok(onUpgradeCalled, 'onUpgrade should have been called');
});

test('should properly wrap and call onError handler', async (t) => {
  let onErrorCalled = false;
  const testError = new Error('Test error');

  const mockDispatch = (opts, handler) => {
    // Simulate an error from the backend
    handler.onError(testError);
  };

  const interceptor = createRateLimiterInterceptor({
    maxRequests: 5,
    windowMs: 1000,
    includeHeaders: true
  });

  const wrappedDispatch = interceptor(mockDispatch);

  await wrappedDispatch(
    { path: '/', method: 'GET', origin: 'http://localhost' },
    {
      onHeaders: () => {},
      onData: () => {},
      onComplete: () => {},
      onError: (err) => {
        onErrorCalled = true;
        assert.strictEqual(err, testError);
      }
    }
  );

  assert.ok(onErrorCalled, 'onError should have been called');
});

test('should properly wrap and call onData handler', async (t) => {
  let onDataCalled = false;
  const testData = Buffer.from('test data');

  const mockDispatch = (opts, handler) => {
    handler.onHeaders(200, [], () => {});
    handler.onData(testData);
    handler.onComplete([]);
  };

  const interceptor = createRateLimiterInterceptor({
    maxRequests: 5,
    windowMs: 1000,
    includeHeaders: true
  });

  const wrappedDispatch = interceptor(mockDispatch);

  await wrappedDispatch(
    { path: '/', method: 'GET', origin: 'http://localhost' },
    {
      onHeaders: () => {},
      onData: (chunk) => {
        onDataCalled = true;
        assert.strictEqual(chunk, testData);
      },
      onComplete: () => {},
      onError: (err) => {
        throw err;
      }
    }
  );

  assert.ok(onDataCalled, 'onData should have been called');
});

test('should properly wrap and call onComplete handler', async (t) => {
  let onCompleteCalled = false;
  const testTrailers = ['x-test', 'value'];

  const mockDispatch = (opts, handler) => {
    handler.onHeaders(200, [], () => {});
    handler.onData(Buffer.from('OK'));
    handler.onComplete(testTrailers);
  };

  const interceptor = createRateLimiterInterceptor({
    maxRequests: 5,
    windowMs: 1000,
    includeHeaders: true
  });

  const wrappedDispatch = interceptor(mockDispatch);

  await wrappedDispatch(
    { path: '/', method: 'GET', origin: 'http://localhost' },
    {
      onHeaders: () => {},
      onData: () => {},
      onComplete: (trailers) => {
        onCompleteCalled = true;
        assert.deepStrictEqual(trailers, testTrailers);
      },
      onError: (err) => {
        throw err;
      }
    }
  );

  assert.ok(onCompleteCalled, 'onComplete should have been called');
});
