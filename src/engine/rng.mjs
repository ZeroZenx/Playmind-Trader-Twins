export function createRng(seed = 1) {
  let state = Number(seed) >>> 0;

  return {
    next() {
      state = (1664525 * state + 1013904223) >>> 0;
      return state / 4294967296;
    },
    integer(min, max) {
      return Math.floor(min + this.next() * (max - min + 1));
    },
    normal(mean = 0, standardDeviation = 1) {
      const u = Math.max(this.next(), Number.EPSILON);
      const v = Math.max(this.next(), Number.EPSILON);
      const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
      return mean + z * standardDeviation;
    },
    pick(values) {
      return values[Math.min(values.length - 1, Math.floor(this.next() * values.length))];
    },
    get state() {
      return state;
    }
  };
}

export function stableSeed(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
