import { Redis } from 'ioredis';
import type { Env } from '../config/env.js';

export interface RedisHandle {
  client: Redis;
  ping: () => Promise<void>;
  close: () => Promise<void>;
}

export function createRedis(env: Env): RedisHandle {
  const client = new Redis(env.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
    connectTimeout: 5_000,
  });
  client.on('error', () => undefined);

  return {
    client,
    ping: async () => {
      if (client.status === 'wait' || client.status === 'end') await client.connect();
      await client.ping();
    },
    close: () => {
      client.disconnect();
      return Promise.resolve();
    },
  };
}
