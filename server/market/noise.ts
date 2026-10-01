/**
 * Deterministic price path: a pure function of (symbol seed, path index).
 *
 * The log price is a sum of ~20 octaves of seeded, smoothly interpolated value noise
 * with wavelengths doubling from a few minutes to ~12 years and amplitude growing as
 * sqrt(wavelength). That amplitude law is what makes the sum behave like Brownian
 * motion: the variance of a difference over any lag L is dominated by octaves near L
 * and grows linearly with L, so minute, hourly, daily and multi-year moves are all
 * mutually consistent in scale. Because every octave is a hash lookup at a lattice
 * point, any index can be evaluated in O(octaves) without generating what precedes it.
 *
 * There is no state that influences results: `PathCursor` only memoises lattice values
 * for sequential access, and a fresh cursor returns bit-identical numbers.
 */

/** Path indices per trading day. 390 are session minutes; the rest is the overnight gap. */
export const PATH_STRIDE = 512;

/**
 * Std-dev of a one-index log-price change, as a fraction of the daily volatility.
 * Measured (not Brownian: the shortest octave is smooth, so minute moves are damped).
 * Used to size minute-bar wicks.
 */
export const MINUTE_VOL_FRACTION = 0.0245;

const OCTAVE_COUNT = 20;
const BASE_WAVELENGTH = 3; // minutes; non-power-of-two so integer samples never alias lattice points

/**
 * Std-dev of `logPrice(i + PATH_STRIDE) - logPrice(i)` for unit amplitude scale,
 * measured empirically (see noise.test.ts, which guards it). Divides the requested
 * daily volatility so `dailyVol` means what it says.
 */
const UNIT_STRIDE_STDEV = 29;

export function hash32(a: number, b: number): number {
  let h = Math.imul(a | 0, 0x85ebca6b) ^ Math.imul(((b | 0) + 0x7f4a7c15) | 0, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return h >>> 0;
}

/** FNV-1a over UTF-16 code units. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Map a 32-bit hash to [0, 1). */
export function unit(h: number): number {
  return h / 4294967296;
}

interface Octave {
  invWavelength: number;
  phase: number;
  amplitude: number;
  seed: number;
  /** Lattice cell the cached values belong to; NaN = nothing cached. */
  cell: number;
  v0: number;
  v1: number;
}

function lattice(seed: number, cell: number): number {
  return unit(hash32(seed, cell)) * 2 - 1;
}

export class PricePath {
  private readonly params: readonly Omit<Octave, 'cell' | 'v0' | 'v1'>[];
  /** log(price) offset so the path passes through `basePrice` at `anchorIndex`. */
  private readonly offset: number;

  constructor(seed: number, basePrice: number, dailyVol: number, anchorIndex: number) {
    const scale = dailyVol / UNIT_STRIDE_STDEV;
    const params: Omit<Octave, 'cell' | 'v0' | 'v1'>[] = [];
    for (let k = 0; k < OCTAVE_COUNT; k++) {
      const wavelength = BASE_WAVELENGTH * 2 ** k;
      params.push({
        invWavelength: 1 / wavelength,
        // A per-octave phase decorrelates lattice boundaries across octaves.
        phase: unit(hash32(seed, 0x1000 + k)) * wavelength,
        amplitude: scale * Math.sqrt(wavelength),
        seed: hash32(seed, k),
      });
    }
    this.params = params;
    this.offset = 0;
    // Evaluate the anchor with a throwaway cursor, then bake the offset in.
    const anchorLog = this.cursorWithOffset(0).logPrice(anchorIndex);
    this.offset = Math.log(basePrice) - anchorLog;
  }

  cursor(): PathCursor {
    return this.cursorWithOffset(this.offset);
  }

  private cursorWithOffset(offset: number): PathCursor {
    return new PathCursor(
      this.params.map((p) => ({ ...p, cell: Number.NaN, v0: 0, v1: 0 })),
      offset,
    );
  }
}

export class PathCursor {
  constructor(
    private readonly octaves: Octave[],
    private readonly offset: number,
  ) {}

  /** log(price) at a path index. Cheap when called with nearby indices in order. */
  logPrice(index: number): number {
    let sum = 0;
    for (const o of this.octaves) {
      const x = (index + o.phase) * o.invWavelength;
      const cell = Math.floor(x);
      const f = x - cell;
      if (cell !== o.cell) {
        o.v0 = cell === o.cell + 1 ? o.v1 : lattice(o.seed, cell);
        o.v1 = lattice(o.seed, cell + 1);
        o.cell = cell;
      }
      const t = f * f * (3 - 2 * f);
      sum += o.amplitude * (o.v0 + (o.v1 - o.v0) * t);
    }
    return sum + this.offset;
  }
}
