# Undici Rate Limiter Interceptor

A lightweight, production-ready rate limiter interceptor for [Undici](https://github.com/nodejs/undici) HTTP client with in-memory storage using LRU cache.

## Features

- 🎯 **Per-Endpoint Rate Limiting** - Automatically limits based on method:origin:path
- 🔧 **Customizable Identifiers** - Rate limit by user, IP, API key, or custom logic
- 💾 **LRU Cache Storage** - Efficient memory management with automatic eviction
- ⚡ **High Performance** - Minimal overhead with O(1) lookups
- 📊 **Flexible Windows** - Sliding window rate limiting

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

#### 1. **Rate Limiter Interceptor**
The main interceptor that wraps Undici's dispatch function.

**Responsibilities:**
- Extract request identifier (default or custom)
- Check if request should be rate limited
- Record successful requests
- Return 429 error when rate limit exceeded

**Key Methods:**
- `getRequestIdentifier(opts)` - Determines the identifier for the request
- `isRateLimited(identifier)` - Checks if the identifier has exceeded limits
- `recordRequest(identifier)` - Records a successful request
- `cleanupOldRequests(store, identifier)` - Removes expired timestamps

#### 2. **InMemoryStore**
LRU cache-based storage for tracking request timestamps per identifier.

**Data Structure:**
```javascript
{
  "GET:https://api.example.com:/users": [1634567890000, 1634567891000, ...],
  "POST:https://api.example.com:/posts": [1634567892000, ...],
  "user:12345": [1634567893000, 1634567894000, ...]
}
```

**Features:**
- **LRU Eviction**: Automatically removes least recently used identifiers when cache is full
- **TTL Support**: Entries expire after configured time (default: 2x window duration)
- **Memory Efficient**: Configurable max identifiers (default: 10,000)

**Key Methods:**
- `add(timestamp, identifier)` - Add a request timestamp
- `cleanup(cutoff, identifier)` - Remove timestamps older than cutoff
- `count(identifier)` - Count current requests for identifier
- `getAll(identifier)` - Get all timestamps for identifier

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

**Callback Data:**
```javascript
{
  maxRequests: 100,
  windowMs: 60000,
  currentRequests: 101,
  identifier: 'GET:https://api.example.com:/users'
}
```

### Memory Management

**LRU Cache Strategy:**
- Tracks up to `maxIdentifiers` unique identifiers (default: 10,000)
- When cache is full, evicts least recently used identifiers
- TTL set to 2x window duration to ensure data persistence
- Automatic cleanup of expired timestamps

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

## Testing

```bash
# Run tests
npm test
```

## License

MIT

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.