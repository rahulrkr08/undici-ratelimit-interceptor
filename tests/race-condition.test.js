'use strict';

const { RateLimiter } = require('../src/rate-limiter');
const { expect } = require('chai');
const { promisify } = require('util');

const limiter = new RateLimiter({
    points: 1,
    duration: 1,
});

describe('Race Condition Handling', () => {
    it('should handle multiple concurrent requests for the same identifier', async () => {
        const identifier = 'test_id';
        const requests = Array.from({ length: 10 }, () => promisify(limiter.consume.bind(limiter))(identifier));

        const results = await Promise.allSettled(requests);
        const successfulRequests = results.filter(result => result.status === 'fulfilled');

        // Expect that only one request should succeed per duration
        expect(successfulRequests.length).to.be.at.most(1);
    });

    it('should not exceed the limit', async () => {
        const identifier = 'test_id';
        const requests = Array.from({ length: 10 }, () => limiter.consume(identifier));

        const results = await Promise.allSettled(requests);
        const successfulRequests = results.filter(result => result.status === 'fulfilled');

        // Expect that no requests are processed if the limit is exceeded
        expect(successfulRequests.length).to.equal(1);
    });
});