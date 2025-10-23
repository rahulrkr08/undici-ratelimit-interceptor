// Global counter for instance IDs
let globalInstanceCounter = 0;

class RedisStore {
  constructor(redis, options = {}) {
    if (!redis) {
      throw new Error('Redis client is required');
    }
    this.redis = redis;
    this.keyPrefix = options.keyPrefix || 'ratelimit:';
    this.ttl = options.ttl || 3600; // TTL in seconds (default 1 hour)
    this._counter = 0; // Counter for generating unique member IDs
    this._instanceId = `${process.pid}.${globalInstanceCounter++}.${Math.random().toString(36).substring(2, 9)}`; // Unique instance ID
  }

  _getKey(identifier = 'default') {
    return `${this.keyPrefix}${identifier}`;
  }

  async add(timestamp, identifier = 'default') {
    const key = this._getKey(identifier);

    // Generate a unique member by combining timestamp with instance ID and counter
    // This ensures we can have multiple requests at the same timestamp across different instances
    const member = `${timestamp}:${this._instanceId}:${this._counter++}`;

    // Add timestamp to sorted set with score = timestamp
    await this.redis.zadd(key, timestamp, member);

    // Set expiration on the key
    await this.redis.expire(key, this.ttl);
  }

  async cleanup(cutoff, identifier = 'default') {
    const key = this._getKey(identifier);

    // Remove all timestamps older than cutoff
    await this.redis.zremrangebyscore(key, '-inf', cutoff);
  }

  async count(identifier = 'default') {
    const key = this._getKey(identifier);

    // Count all members in the sorted set
    const count = await this.redis.zcard(key);
    return count;
  }

  async getAll(identifier = 'default') {
    const key = this._getKey(identifier);

    // Get all members with scores from sorted set
    const result = await this.redis.zrange(key, 0, -1, 'WITHSCORES');

    // Parse the result: [member1, score1, member2, score2, ...]
    // We only need the scores (timestamps)
    const timestamps = [];
    for (let i = 1; i < result.length; i += 2) {
      timestamps.push(parseInt(result[i], 10));
    }

    return timestamps.sort((a, b) => a - b);
  }

  async clear(identifier = 'default') {
    const key = this._getKey(identifier);
    await this.redis.del(key);
  }

  async clearAll() {
    // Get all keys with the prefix
    const keys = await this.redis.keys(`${this.keyPrefix}*`);
    if (keys.length > 0) {
      await this.redis.del(...keys);
    }
  }
}

module.exports = RedisStore;
