import { DurableObject } from 'cloudflare:workers';
import { limits } from './shared.js';

/**
 * The one place that sees every room: how many rooms are open, how many bytes all of them hold, and how often
 * each address has tried to create or guess a room in the last minute. There is a single instance, named "gate".
 *
 * The room count and bytes are kept in storage, so they survive the object being moved or restarted.
 * The attempt counts only matter for a minute, so they live in memory.
 */
export class Gate extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.limits = limits(env);
    this.attempts = new Map();
    this.windowStart = Date.now();
    ctx.blockConcurrencyWhile(async () => {
      this.rooms = (await ctx.storage.get('rooms')) ?? 0;
      this.bytes = (await ctx.storage.get('bytes')) ?? 0;
    });
  }

  #roll() {
    if (Date.now() - this.windowStart >= 60_000) {
      this.attempts.clear();
      this.windowStart = Date.now();
    }
  }

  limited(ip) {
    this.#roll();
    return (this.attempts.get(ip) ?? 0) >= this.limits.roomAttemptsPerMinute;
  }

  count(ip) {
    this.#roll();
    this.attempts.set(ip, (this.attempts.get(ip) ?? 0) + 1);
  }

  async openRoom() {
    if (this.rooms >= this.limits.maxRooms) return false;
    this.rooms += 1;
    await this.ctx.storage.put('rooms', this.rooms);
    return true;
  }

  async closeRoom(bytes = 0) {
    this.rooms = Math.max(0, this.rooms - 1);
    this.bytes = Math.max(0, this.bytes - bytes);
    await this.ctx.storage.put({ rooms: this.rooms, bytes: this.bytes });
  }

  async reserve(size) {
    if (this.bytes + size > this.limits.maxTotalBytes) return false;
    this.bytes += size;
    await this.ctx.storage.put('bytes', this.bytes);
    return true;
  }

  async release(size) {
    this.bytes = Math.max(0, this.bytes - size);
    await this.ctx.storage.put('bytes', this.bytes);
  }

  /** For tests and troubleshooting. Only the Worker can call it, and it never does from a public route. */
  inspect() {
    return { rooms: this.rooms, bytes: this.bytes };
  }
}
