# Undici Rate Limiter Interceptor

A lightweight, production-ready rate limiter interceptor for [Undici](https://github.com/nodejs/undici) HTTP client with in-memory storage using LRU cach and Redis.

## Features

- 🎯 **Per-Endpoint Rate Limiting** - Automatically limits based on method:origin:path
- 🔧 **Customizable Identifiers** - Rate limit by user, IP, API key, or custom logic
- 💾 **LRU Cache Storage** - Efficient memory management with automatic eviction
- ⚡ **High Performance** - Minimal overhead with O(1) lookups
- 📊 **Flexible Windows** - Sliding window rate limiting
- 📋 **Rate Limit Headers** - Automatic response headers (X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset)

## Installation

```bash
npm install undici-rate-limiter-interceptor
```

## Architecture

### Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Undici HTTP Client                        │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│              Rate Limiter Interceptor                        │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  1. Extract Identifier (method:origin:path or custom)  │ │
│  └──────────────────────┬─────────────────────────────────┘ │
│                         ▼                                    │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  2. Check Rate Limit                                   │ │
│  │     - Cleanup old timestamps                           │ │
│  │     - Count current requests                           │ │
│  │     - Check if (count + 1) > maxRequests               │ │
│  └──────────────────────┬─────────────────────────────────┘ │
│                         │                                    │
│           ┌─────────────┴─────────────┐                     │
│           ▼                           ▼                     │
│  ┌──────────────────┐      ┌──────────────────┐            │
│  │  Rate Limited    │      │  Allowed         │            │
│  │  - Return 429    │      │  - Record req    │            │
│  │  - Call callback │      │  - Forward req   │            │
│  └──────────────────┘      └──────────────────┘            │
└─────────────────────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                   InMemoryStore (LRU Cache)                  │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  Key: Identifier (e.g., "GET:api.com:/users")         │ │
│  │  Value: [timestamp1, timestamp2, timestamp3, ...]      │ │
│  └────────────────────────────────────────────────────────┘ │
│  - Max identifiers: 10,000 (configurable)                   │
│  - TTL: 2x window duration                                  │
│  - Automatic eviction of least recently used                │
└─────────────────────────────────────────────────────────────┘
```

### Components

### Rate Limiting Algorithm

**Sliding Window Implementation:**

```
Time Window: 60 seconds
Max Requests: 5

Timeline:
|----|----|----|----|----|----|----|----|
0s   10s  20s  30s  40s  50s  60s  70s

Requests: ●    ●    ●    ●    ●              
          t1   t2   t3   t4   t5

At t=70s:
- Cleanup: Remove timestamps < (70 - 60) = 10s
- Remaining: [t2, t3, t4, t5] = 4 requests
- Check: (4 + 1) > 5? No → Allow request
- New state: [t2, t3, t4, t5, t6]
```

**Steps:**
1. **Cleanup**: Remove timestamps older than (now - windowMs)
2. **Count**: Count remaining timestamps
3. **Check**: If (count + 1) > maxRequests, block request
4. **Record**: If allowed, add current timestamp

### Default Identifier Format

Format: `{method}:{origin}:{path}`

**Examples:**
```
GET:https://api.example.com:/users
POST:https://api.example.com:/posts
DELETE:https://api.example.com:/users/123
```

This ensures each unique endpoint is rate limited independently.

### Custom Identifiers

You can provide a custom function to generate identifiers:

```javascript
identifier: (opts) => {
  // Rate limit by user
  const userId = opts.headers['x-user-id'] || 'anonymous';
  return `user:${userId}`;
  
  // Rate limit by IP
  const ip = opts.headers['x-forwarded-for'] || 'unknown';
  return `ip:${ip}`;
  
  // Combine user + endpoint
  const userId = opts.headers['x-user-id'] || 'anonymous';
  return `${userId}:${opts.method}:${opts.path}`;
}
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxRequests` | number | 100 | Maximum requests allowed per window |
| `windowMs` | number | 60000 | Time window in milliseconds (1 minute) |
| `maxIdentifiers` | number | 10000 | Max unique identifiers to track in memory |
| `identifier` | function | null | Custom function to extract identifier from request |
| `onRateLimitExceeded` | function | null | Callback when rate limit is exceeded |
| `includeHeaders` | boolean | true | Include rate limit headers in responses (X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset) |

### Error Handling

**Rate Limit Exceeded:**
```javascript
{
  code: 'RATE_LIMIT_EXCEEDED',
  statusCode: 429,
  message: 'Rate limit exceeded: 100 requests per 60000ms',
  identifier: 'GET:https://api.example.com:/users'
}
```

### Rate Limit Headers

When `includeHeaders` is enabled (default: `true`), the following headers are automatically added to all responses:

| Header | Description | Example |
|--------|-------------|---------|
| `X-RateLimit-Limit` | Maximum number of requests allowed in the time window | `100` |
| `X-RateLimit-Remaining` | Number of requests remaining in the current window | `42` |
| `X-RateLimit-Reset` | Unix timestamp (seconds) when the rate limit window resets | `1634567890` |

**Example Response Headers:**
```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 42
X-RateLimit-Reset: 1634567890
```

The reset time is calculated based on the oldest request in the current window plus the window duration. This provides accurate information about when the rate limit will reset.

**Disabling Headers:**
```javascript
const client = new Agent().compose(
  createRateLimiterInterceptor({
    maxRequests: 100,
    windowMs: 60000,
    includeHeaders: false // Disable rate limit headers
  })
);
```

## Usage Examples

### Basic Usage

```javascript
const { Agent } = require('undici');
const createRateLimiterInterceptor = require('undici-rate-limiter-interceptor');

const client = new Agent().compose(
  createRateLimiterInterceptor({
    maxRequests: 100,
    windowMs: 60000 // 1 minute
  })
);
```

### Per-User Rate Limiting

```javascript
const client = new Agent().compose(
  createRateLimiterInterceptor({
    maxRequests: 50,
    windowMs: 60000,
    identifier: (opts) => {
      const userId = opts.headers['x-user-id'] || 'anonymous';
      return `user:${userId}`;
    },
    onRateLimitExceeded: (info) => {
      console.warn(`User ${info.identifier} exceeded rate limit`);
    }
  })
);
```

### Global Dispatcher

```javascript
const { setGlobalDispatcher, Agent } = require('undici');
const createRateLimiterInterceptor = require('undici-rate-limiter-interceptor');

setGlobalDispatcher(
  new Agent().compose(
    createRateLimiterInterceptor({
      maxRequests: 1000,
      windowMs: 3600000 // 1 hour
    })
  )
);

// Now all undici requests use the rate limiter
const { request } = require('undici');
await request('https://api.example.com/data');
```

## Redis

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

### Performance Considerations

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

## License

MIT
