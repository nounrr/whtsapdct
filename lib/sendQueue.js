'use strict';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toFiniteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

class RateLimitedQueue {
  constructor({
    name = 'queue',
    minIntervalMs = 0,
    maxPerWindow = Infinity,
    windowMs = 0,
    jitterMs = 0,
    logger = console,
  } = {}) {
    this.name = name;
    this.minIntervalMs = Math.max(0, toFiniteNumber(minIntervalMs, 0));
    this.maxPerWindow = toFiniteNumber(maxPerWindow, Infinity);
    if (!Number.isFinite(this.maxPerWindow) || this.maxPerWindow <= 0) this.maxPerWindow = Infinity;
    this.windowMs = Math.max(0, toFiniteNumber(windowMs, 0));
    this.jitterMs = Math.max(0, toFiniteNumber(jitterMs, 0));
    this.logger = logger || console;

    this._queue = [];
    this._processing = false;
    this._lastStartAt = null;
    this._sentAt = [];

    this._enqueued = 0;
    this._processed = 0;
    this._failed = 0;
  }

  stats() {
    const now = Date.now();
    const recentSent = this._sentAt.filter((t) => (this.windowMs ? t > now - this.windowMs : true));
    return {
      name: this.name,
      queued: this._queue.length,
      processing: this._processing,
      enqueued: this._enqueued,
      processed: this._processed,
      failed: this._failed,
      minIntervalMs: this.minIntervalMs,
      maxPerWindow: this.maxPerWindow,
      windowMs: this.windowMs,
      jitterMs: this.jitterMs,
      sentInWindow: recentSent.length,
    };
  }

  enqueue(fn, meta = {}) {
    if (typeof fn !== 'function') throw new Error('queue_fn_required');

    this._enqueued++;

    return new Promise((resolve, reject) => {
      this._queue.push({ fn, resolve, reject, meta });
      this._kick();
    });
  }

  _kick() {
    if (this._processing) return;
    this._processing = true;
    this._run().catch((e) => {
      this._processing = false;
      this.logger?.error?.(`[${this.name}] queue runner crashed`, e);
    });
  }

  async _run() {
    while (this._queue.length > 0) {
      const item = this._queue.shift();
      if (!item) continue;

      try {
        await this._waitForSlot();
        this._lastStartAt = Date.now();
        const result = await item.fn();
        this._processed++;
        this._recordSent();
        item.resolve(result);
      } catch (e) {
        this._failed++;
        item.reject(e);
      }
    }

    this._processing = false;
  }

  _recordSent() {
    const now = Date.now();
    this._sentAt.push(now);

    if (this.windowMs > 0) {
      const cutoff = now - this.windowMs;
      while (this._sentAt.length && this._sentAt[0] <= cutoff) {
        this._sentAt.shift();
      }
    }
  }

  async _waitForSlot() {
    const now = Date.now();

    let waitMs = 0;

    // Smooth sending with a minimum interval
    if (this._lastStartAt !== null && this.minIntervalMs > 0) {
      const since = now - this._lastStartAt;
      if (since < this.minIntervalMs) {
        waitMs = Math.max(waitMs, this.minIntervalMs - since);
      }
    }

    // Hard cap per sliding window
    if (this.windowMs > 0 && Number.isFinite(this.maxPerWindow) && this.maxPerWindow !== Infinity) {
      const cutoff = now - this.windowMs;
      this._sentAt = this._sentAt.filter((t) => t > cutoff);

      if (this._sentAt.length >= this.maxPerWindow) {
        const oldest = this._sentAt[0];
        const until = oldest + this.windowMs;
        waitMs = Math.max(waitMs, Math.max(0, until - now));
      }
    }

    if (this.jitterMs > 0) {
      waitMs += Math.floor(Math.random() * (this.jitterMs + 1));
    }

    if (waitMs > 0) {
      await sleep(waitMs);
    }
  }
}

module.exports = { RateLimitedQueue };
