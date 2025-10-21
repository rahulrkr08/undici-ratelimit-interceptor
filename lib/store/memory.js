const { LRUCache } = require('lru-cache');

class InMemoryStore {
  constructor(options = {}) {

    this.cache = new LRUCache({
      max: options.max || 10000,
      ttl: options.ttl || 3600000,
      updateAgeOnGet: false,
      updateAgeOnHas: false
    });
  }

  async add(timestamp, identifier = 'default') {
    const requests = this.cache.get(identifier) || [];
    requests.push(timestamp);
    this.cache.set(identifier, requests);
  }

  async cleanup(cutoff, identifier = 'default') {
    const requests = this.cache.get(identifier);
    if (!requests) return;
    
    const filtered = requests.filter(t => t > cutoff);
    if (filtered.length > 0) {
      this.cache.set(identifier, filtered);
    } else {
      this.cache.delete(identifier);
    }
  }

  async count(identifier = 'default') {
    const requests = this.cache.get(identifier);
    return requests ? requests.length : 0;
  }

  async getAll(identifier = 'default') {
    return this.cache.get(identifier) || [];
  }
}

module.exports = InMemoryStore