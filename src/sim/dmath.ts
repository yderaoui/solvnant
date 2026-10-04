// Deterministic math. IEEE-754 guarantees +, -, *, / and sqrt are bit-identical
// everywhere, but Math.sin/cos/atan2 are not (engines use different libm code).
// The simulation must give the same result in Node and every browser, so it uses only these.

export const PI = 3.141592653589793;
export const TAU = 6.283185307179586;
export const HALF_PI = 1.5707963267948966;
const SQRT3 = 1.7320508075688772;

/** Wrap an angle to [-PI, PI). */
export function wrapAngle(a: number): number {
  return a - TAU * Math.floor((a + PI) / TAU);
}

export function sin(x: number): number {
  x = wrapAngle(x);
  if (x > HALF_PI) x = PI - x;
  else if (x < -HALF_PI) x = -PI - x;
  const x2 = x * x;
  // Taylor series to x^17 (error < 1e-11 on [-pi/2, pi/2]).
  return (
    x *
    (1 +
      x2 *
        (-1 / 6 +
          x2 *
            (1 / 120 +
              x2 *
                (-1 / 5040 +
                  x2 *
                    (1 / 362880 +
                      x2 * (-1 / 39916800 + x2 * (1 / 6227020800 + x2 * (-1 / 1307674368000 + x2 / 355687428096000))))))))
  );
}

export function cos(x: number): number {
  return sin(x + HALF_PI);
}

export function atan(x: number): number {
  const neg = x < 0;
  if (neg) x = -x;
  const inv = x > 1;
  if (inv) x = 1 / x;
  let off = 0;
  if (x > 0.2679491924311227) {
    // atan(x) = pi/6 + atan((x*sqrt3 - 1) / (sqrt3 + x))
    x = (x * SQRT3 - 1) / (SQRT3 + x);
    off = PI / 6;
  }
  const x2 = x * x;
  let r =
    x *
    (1 +
      x2 *
        (-1 / 3 +
          x2 * (1 / 5 + x2 * (-1 / 7 + x2 * (1 / 9 + x2 * (-1 / 11 + x2 * (1 / 13 + x2 * (-1 / 15 + x2 / 17))))))));
  r += off;
  if (inv) r = HALF_PI - r;
  return neg ? -r : r;
}

export function atan2(y: number, x: number): number {
  if (x > 0) return atan(y / x);
  if (x < 0) return y >= 0 ? atan(y / x) + PI : atan(y / x) - PI;
  return y > 0 ? HALF_PI : y < 0 ? -HALF_PI : 0;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
