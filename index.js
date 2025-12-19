const InMemoryStore = require("./lib/store/memory");
const RedisStore = require("./lib/store/redis");

class RateLimiterInterceptor {
  constructor(options = {}) {
    // Store original values (can be functions or primitives)
    this.maxRequestsConfig = options.maxRequests || 100;
    this.windowMsConfig = options.windowMs || 60000;
    this.onRateLimitExceeded = options.onRateLimitExceeded;
    this.identifier = options.identifier; // Function to extract identifier from request
    this.includeHeaders = options.includeHeaders !== undefined ? options.includeHeaders : true;

    // Get default windowMs for store initialization
    const defaultWindowMs = typeof this.windowMsConfig === 'function' ? 60000 : this.windowMs;

    // Setup stores
    if (options.redis) {
      // Use Redis store if redis client is provided
      this.store = new RedisStore(options.redis, {
        keyPrefix: options.redisKeyPrefix,
        ttl: Math.ceil(defaultWindowMs / 1000) * 2 // Convert to seconds, keep for 2x window
      });
    } else {
      // Fall back to memory store
      this.store = new InMemoryStore({
        max: options.maxIdentifiers || 10000,
        ttl: defaultWindowMs * 2 // Keep entries for 2x the window duration
      });
    }
  }

  // Resolve maxRequests - can be a function or a static value
  resolveMaxRequests(opts) {
    if (typeof this.maxRequestsConfig === 'function') {
      return this.maxRequestsConfig(opts);
    }
    return this.maxRequestsConfig;
  }

  // Resolve windowMs - can be a function or a static value
  resolveWindowMs(opts) {
    if (typeof this.windowMsConfig === 'function') {
      return this.windowMsConfig(opts);
    }
    return this.windowMsConfig;
  }

  // Getter for maxRequests (for backwards compatibility)
  get maxRequests() {
    return this.maxRequestsConfig;
  }

  // Getter for windowMs (for backwards compatibility)
  get windowMs() {
    return this.windowMsConfig;
  }

  async getStore() {
    return this.store;
  }

  async cleanupOldRequests(store, identifier, opts) {
    const now = Date.now();
    const windowMs = this.resolveWindowMs(opts);
    const cutoff = now - windowMs;
    try {
      await store.cleanup(cutoff, identifier);
    } catch (err) {
      console.warn('Store cleanup failed, falling back to memory:', err.message);
    }
  }

  async isRateLimited(identifier, opts) {
    let store = await this.getStore();

    try {
      await this.cleanupOldRequests(store, identifier, opts);
      const count = await store.count(identifier);

      // Check if adding one more request would exceed the limit
      const maxRequests = this.resolveMaxRequests(opts);
      const wouldExceedLimit = (count + 1) > maxRequests;

      return wouldExceedLimit;
    } catch (err) {
      throw err;
    }
  }

  async recordRequest(identifier) {
    const now = Date.now();
    let store = await this.getStore();
    
    try {
      await store.add(now, identifier);
    } catch (err) {
      throw err;
    }
  }

  getRequestIdentifier(opts) {
    if (this.identifier) {
      return this.identifier(opts);
    }

    // Default identifier: method:origin:path
    const method = opts.method;
    const origin = opts.origin;
    const path = opts.path;
    
    return `${method}:${origin}:${path}`;
  }

  async getCurrentCount(identifier) {
    const store = await this.getStore();
    try {
      return await store.count(identifier);
    } catch (err) {
      throw err;
    }
  }

  async getOldestTimestamp(identifier) {
    const store = await this.getStore();
    try {
      const requests = await store.getAll(identifier);
      if (!requests || requests.length === 0) {
        return null;
      }
      return Math.min(...requests);
    } catch (err) {
      throw err;
    }
  }

  async getRateLimitInfo(identifier, opts) {
    const maxRequests = this.resolveMaxRequests(opts);
    const windowMs = this.resolveWindowMs(opts);
    const currentCount = await this.getCurrentCount(identifier);
    const remaining = Math.max(0, maxRequests - currentCount);

    // Calculate reset time based on oldest request + window duration
    const oldestTimestamp = await this.getOldestTimestamp(identifier);
    let reset;
    if (oldestTimestamp) {
      reset = Math.ceil((oldestTimestamp + windowMs) / 1000);
    } else {
      // If no requests yet, reset is current time + window
      reset = Math.ceil((Date.now() + windowMs) / 1000);
    }

    return {
      limit: maxRequests,
      remaining,
      reset
    };
  }
}

function createRateLimiterInterceptor(options) {
      return dispatch => {
    const interceptor = new RateLimiterInterceptor(options);

    return (opts, handler) => {
      // Extract identifier from request using default or custom function
      const identifier = interceptor.getRequestIdentifier(opts);

      // Wrap in async context
      const checkRateLimit = async () => {
        const limited = await interceptor.isRateLimited(identifier, opts);

        if (limited) {
          const maxRequests = interceptor.resolveMaxRequests(opts);
          const windowMs = interceptor.resolveWindowMs(opts);
          const currentCount = await interceptor.getCurrentCount(identifier);

          if (interceptor.onRateLimitExceeded) {
            interceptor.onRateLimitExceeded({
              maxRequests,
              windowMs,
              currentRequests: currentCount,
              identifier
            });
          }

          const error = new Error(
            `Rate limit exceeded: ${maxRequests} requests per ${windowMs}ms`
          );
          error.code = 'RATE_LIMIT_EXCEEDED';
          error.statusCode = 429;
          error.identifier = identifier;

          // Use error handling method
          return handler.onError(error);
        }

        await interceptor.recordRequest(identifier);

        // Only add headers if includeHeaders is enabled
        if (interceptor.includeHeaders) {
          // Get rate limit info after recording the request
          const rateLimitInfo = await interceptor.getRateLimitInfo(identifier, opts);

          // Create a wrapped handler
          const wrappedHandler = {
            onConnect: (...args) => handler.onConnect?.(...args),
            onError: (...args) => handler.onError?.(...args),
            onUpgrade: (...args) => handler.onUpgrade?.(...args),
            onBodySent: (...args) => handler.onBodySent?.(...args),
            onHeaders: (statusCode, headers, resume, statusText) => {
              // Add rate limit headers
              const rateLimitHeaders = [
                Buffer.from('x-ratelimit-limit'),
                Buffer.from(String(rateLimitInfo.limit)),
                Buffer.from('x-ratelimit-remaining'),
                Buffer.from(String(rateLimitInfo.remaining)),
                Buffer.from('x-ratelimit-reset'),
                Buffer.from(String(rateLimitInfo.reset))
              ];

              // Combine existing headers with rate limit headers
              const combinedHeaders = [...headers, ...rateLimitHeaders];

              return handler.onHeaders(statusCode, combinedHeaders, resume, statusText);
            },
            onData: (...args) => handler.onData?.(...args),
            onComplete: (...args) => handler.onComplete?.(...args)
          };

          return dispatch(opts, wrappedHandler);
        }

        // If headers are disabled, dispatch normally
        return dispatch(opts, handler);
      };

      return checkRateLimit();
    };
  };
}

module.exports = createRateLimiterInterceptor;