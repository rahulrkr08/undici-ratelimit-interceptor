const InMemoryStore = require("./lib/store/memory");

class RateLimiterInterceptor {
  constructor(options = {}) {
    this.maxRequests = options.maxRequests || 100;
    this.windowMs = options.windowMs || 60000;
    this.onRateLimitExceeded = options.onRateLimitExceeded;
    this.identifier = options.identifier; // Function to extract identifier from request
    
    // Setup stores
    this.memoryStore = new InMemoryStore({
      max: options.maxIdentifiers || 10000,
      ttl: options.windowMs * 2 // Keep entries for 2x the window duration
    });
  }

  async getStore() {
    return this.memoryStore;
  }

  async cleanupOldRequests(store, identifier) {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    try {
      await store.cleanup(cutoff, identifier);
    } catch (err) {
      console.warn('Store cleanup failed, falling back to memory:', err.message);
    }
  }

  async isRateLimited(identifier) {
    let store = await this.getStore();
    
    try {
      await this.cleanupOldRequests(store, identifier);
      const count = await store.count(identifier);
      
      // Check if adding one more request would exceed the limit
      const wouldExceedLimit = (count + 1) > this.maxRequests;
      
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
}

function createRateLimiterInterceptor(options) {
      return dispatch => {
    const interceptor = new RateLimiterInterceptor(options);
    
    return (opts, handler) => {
      // Extract identifier from request using default or custom function
      const identifier = interceptor.getRequestIdentifier(opts);

      // Wrap in async context
      const checkRateLimit = async () => {
        const limited = await interceptor.isRateLimited(identifier);
        
        if (limited) {
          const currentCount = await interceptor.getCurrentCount(identifier);
          
          if (interceptor.onRateLimitExceeded) {
            interceptor.onRateLimitExceeded({
              maxRequests: interceptor.maxRequests,
              windowMs: interceptor.windowMs,
              currentRequests: currentCount,
              identifier
            });
          }

          const error = new Error(
            `Rate limit exceeded: ${interceptor.maxRequests} requests per ${interceptor.windowMs}ms`
          );
          error.code = 'RATE_LIMIT_EXCEEDED';
          error.statusCode = 429;
          error.identifier = identifier;

          return handler.onError(error);
        }

        await interceptor.recordRequest(identifier);
        return dispatch(opts, handler);
      };

      return checkRateLimit();
    };
  };
}

module.exports = createRateLimiterInterceptor;