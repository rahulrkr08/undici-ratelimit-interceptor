# Redis Store for Undici Rate Limiter

This package now includes a Redis-backed store for distributed rate limiting across multiple servers or processes.

## Features

- ✅ **Distributed Rate Limiting**: Share rate limits across multiple Node.js processes or servers
- ✅ **Persistent Storage**: Rate limit data survives process restarts
- ✅ **Automatic Expiration**: Uses Redis TTL for automatic cleanup
- ✅ **High Performance**: Leverages Redis sorted sets for efficient operations
- ✅ **100% Test Coverage**: Comprehensive test suite with both unit and integration tests

## Installation

The Redis store uses `ioredis` as the Redis client. Install it as a dependency:

```bash
npm install ioredis
```

## Usage

### Basic Example

```javascript
const Redis = require('ioredis');
const { Agent } = require('undici');
const createRateLimiterInterceptor = require('undici-ratelimit-interceptor');

// Create Redis client
const redis = new Redis({
  host: 'localhost',
  port: 6379
});

// Create rate limiter with Redis store
const agent = new Agent().compose(
  createRateLimiterInterceptor({
    redis: redis,                    // Pass Redis client
    redisKeyPrefix: 'myapp:limit:',  // Optional: custom key prefix
    maxRequests: 100,
    windowMs: 60000
  })
);

// Use the agent for requests
const { request } = require('undici');
const response = await request('https://api.example.com', {
  dispatcher: agent
});
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `redis` | Redis | - | **Required**. ioredis client instance |
| `redisKeyPrefix` | string | `'ratelimit:'` | Prefix for Redis keys |
| `maxRequests` | number | `100` | Maximum requests per window |
| `windowMs` | number | `60000` | Time window in milliseconds |
| `includeHeaders` | boolean | `true` | Include rate limit headers in responses |
| `identifier` | function | - | Custom function to extract identifier from request |
| `onRateLimitExceeded` | function | - | Callback when rate limit is exceeded |

### Custom Identifier

Rate limit per user instead of per endpoint:

```javascript
const agent = new Agent().compose(
  createRateLimiterInterceptor({
    redis: redis,
    maxRequests: 10,
    windowMs: 60000,
    identifier: (opts) => {
      // Extract user ID from request headers
      const userId = opts.headers['x-user-id'] || 'anonymous';
      return `user:${userId}`;
    }
  })
);
```

### Multiple Applications

Use different key prefixes to isolate rate limits between applications:

```javascript
// App 1
const app1Agent = new Agent().compose(
  createRateLimiterInterceptor({
    redis: redis,
    redisKeyPrefix: 'app1:ratelimit:',
    maxRequests: 100,
    windowMs: 60000
  })
);

// App 2
const app2Agent = new Agent().compose(
  createRateLimiterInterceptor({
    redis: redis,
    redisKeyPrefix: 'app2:ratelimit:',
    maxRequests: 200,
    windowMs: 60000
  })
);
```

## Redis Store Implementation Details

### Data Structure

The Redis store uses **sorted sets** (ZSET) to store timestamps:

- **Key**: `{keyPrefix}{identifier}` (e.g., `ratelimit:GET:http://api.com:/users`)
- **Score**: Timestamp in milliseconds
- **Member**: Unique ID combining timestamp, instance ID, and counter

### Operations

1. **Add Request**: `ZADD` to add timestamp to sorted set
2. **Count Requests**: `ZCARD` to count members in set
3. **Cleanup Old Requests**: `ZREMRANGEBYSCORE` to remove old timestamps
4. **Get All Timestamps**: `ZRANGE` with scores to retrieve all timestamps
5. **Clear Identifier**: `DEL` to remove specific identifier
6. **Clear All**: `KEYS` + `DEL` to remove all keys with prefix

### TTL Management

Each key has an automatic expiration set to `2 × windowMs` to prevent unbounded growth of Redis memory.

## Testing

### Running Redis Tests

Start Redis (using Docker):

```bash
npm run redis
```

Run Redis-specific tests:

```bash
npm run test:redis
```

Stop Redis:

```bash
npm run redis:stop
```

### Running All Tests

```bash
npm test
```

## Performance Considerations

### Redis Connection

Use a single Redis client instance and reuse it across all interceptors:

```javascript
// Good: Reuse Redis client
const redis = new Redis();
const interceptor1 = createRateLimiterInterceptor({ redis, ... });
const interceptor2 = createRateLimiterInterceptor({ redis, ... });

// Bad: Create multiple clients
const interceptor1 = createRateLimiterInterceptor({ redis: new Redis(), ... });
const interceptor2 = createRateLimiterInterceptor({ redis: new Redis(), ... });
```

### Connection Pooling

For high-traffic applications, consider using Redis Cluster or connection pooling:

```javascript
const Redis = require('ioredis');

const redis = new Redis.Cluster([
  { host: 'redis-1', port: 6379 },
  { host: 'redis-2', port: 6379 },
  { host: 'redis-3', port: 6379 }
]);
```

### Memory Usage

The Redis store automatically cleans up old timestamps, but you can manually clear data:

```javascript
const RedisStore = require('undici-ratelimit-interceptor/lib/store/redis');
const store = new RedisStore(redis, { keyPrefix: 'myapp:' });

// Clear specific identifier
await store.clear('GET:http://api.com:/users');

// Clear all rate limit data
await store.clearAll();
```

## Comparison: Memory Store vs Redis Store

| Feature | Memory Store | Redis Store |
|---------|-------------|-------------|
| **Distributed** | ❌ No | ✅ Yes |
| **Persistent** | ❌ No | ✅ Yes |
| **Performance** | ⚡ Fastest | 🚀 Fast |
| **Setup** | None | Requires Redis |
| **Best For** | Single process | Multiple processes/servers |

## Troubleshooting

### Connection Errors

If Redis is not running, the tests will exit gracefully with a message. Ensure Redis is accessible:

```bash
redis-cli ping
# Should return: PONG
```

### Memory Issues

If Redis runs out of memory, configure maxmemory and eviction policy:

```bash
redis-cli config set maxmemory 256mb
redis-cli config set maxmemory-policy allkeys-lru
```

### Debugging

Enable Redis command logging:

```javascript
const redis = new Redis({
  host: 'localhost',
  port: 6379,
  showFriendlyErrorStack: true,
  lazyConnect: false
});

redis.on('connect', () => console.log('Redis connected'));
redis.on('error', (err) => console.error('Redis error:', err));
```

## License

ISC
