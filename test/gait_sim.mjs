// Synthetic phone accelerometer data for a runner/walker, used by motion.test.mjs.
// Model: each step is a ground contact. While a foot is down the body is pushed up (a half-sine force pulse, plus a
// short heel-strike jolt); in between the runner is airborne (no force). The forces average out to gravity.
// The phone sees that force plus how it is carried:
//   held   held steady in front of you (reading): body motion, a bit damped, plus hand jitter
//   pocket in a trouser pocket: the far leg's landing is much weaker, and the thigh swings at stride rate
//   hand   swinging in your hand: a big arm pendulum at stride rate on top of the body motion
// Returns { samples: [[t_ms, ax, ay, az], ...], landings: [t_ms of each foot contact] }.
const G = 9.81;

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

// cadence: number (steps/min) or function(t_s) -> steps/min
export function simulate({ cadence, dur = 30, carry = 'held', walk = null, seed = 1, noise = 0.25, gap = null, stopAt = null }) {
  const r = rng(seed), gauss = () => { let s = 0; for (let i = 0; i < 6; i++) s += r(); return (s - 3) / 0.707; };
  const cad = typeof cadence === 'function' ? cadence : () => cadence;
  const landings = [];
  for (let t = 0.5; t < dur; ) {
    if (stopAt != null && t >= stopAt) break;
    if (!(gap && t >= gap[0] && t < gap[1])) landings.push(t);
    t += 60 / cad(t) * (1 + 0.015 * gauss());          // a little natural step-to-step variation
  }
  // is this cadence a walk? (walking: long, overlapping contacts and a gentle bounce)
  const isWalk = walk != null ? (t => walk(t)) : (t => cad(t) < 125);
  const samples = [];
  let t = 0, theta0 = carry === 'hand' ? 0.6 : carry === 'pocket' ? 0.5 : 0;
  while (t < dur * 1000) {
    t += 12 + r() * 10; if (r() < 0.01) t += 30;         // ~60 Hz with jitter and the odd dropped frame
    const ts = t / 1000;
    let fz = 0;
    for (let i = 0; i < landings.length; i++) {
      const tc = landings[i], d = ts - tc;
      if (d < -0.1 || d > 1.0) continue;
      const step = 60 / cad(tc), walking = isWalk(tc);
      const Ts = walking ? 0.62 * step * 2 : Math.max(0.16, 0.38 * step); // contact time
      const duty = Ts / step, Apk = G / ((2 / Math.PI) * duty);     // pulse height so forces average to g
      const leg = i % 2, far = carry === 'pocket' && leg === 1 ? 0.6 : 1;
      if (walking) {                                                // gentle bounce peaking just after heel strike
        if (d >= -step / 2 && d < step / 2) fz += G * (1 / 1) * 0 + 0.28 * G * Math.cos(2 * Math.PI * (d - 0.09) / step) * far;
        if (d >= 0 && d < 0.06) fz += 2.0 * far * Math.exp(-(((d - 0.015) / 0.012) ** 2));
      } else {
        if (d >= 0 && d < Ts) fz += (Apk * Math.sin(Math.PI * d / Ts) - G) * far + G;
        if (d >= 0 && d < 0.05) fz += 6.0 * far * Math.exp(-(((d - 0.012) / 0.01) ** 2));
      }
    }
    // airborne / stance accounting: in running fz already includes g during stance; add the airborne baseline
    let inStance = false;
    for (const tc of landings) { const d = ts - tc, step = 60 / cad(tc), Ts = isWalk(tc) ? 1 : Math.max(0.16, 0.38 * step); if (d >= 0 && d < Ts) { inStance = true; break; } }
    const vert = isWalk(ts) ? G + fz : (inStance ? fz - G * 0 : 0) ;
    // body (world frame, z up): vertical force + small fore-aft braking
    let wx = 0.15 * G * Math.sin(2 * Math.PI * ts * cad(ts) / 60), wy = 0, wz = vert;
    const damp = carry === 'held' ? 0.75 : 1;
    wx *= damp; wz = G + (wz - G) * damp;
    // how the phone is carried: tilt and extra pendulum accelerations
    let pitch = carry === 'held' ? 0.9 : 0.2, ex = 0, ey = 0, ez = 0;
    if (carry === 'hand' || carry === 'pocket') {
      const w = 2 * Math.PI * cad(ts) / 120, rad = carry === 'hand' ? 0.55 : 0.3, ph = w * ts;
      const lastL = landings.length ? landings[landings.length - 1] : 0, firstL = landings.length ? landings[0] : 0;
      const amp = ts < firstL - 0.3 || ts > lastL + 0.6 ? 0 : (isWalk(ts) ? 0.6 : 1);   // swing only while moving; smaller when walking
      theta0 = (carry === 'hand' ? 0.6 : 0.5) * amp;
      const th = theta0 * Math.sin(ph); pitch += th;
      ex += -rad * theta0 * w * w * Math.sin(ph);                    // tangential
      ez += rad * (theta0 * w * Math.cos(ph)) ** 2;                  // centripetal, towards the pivot
    }
    if (carry === 'held') { ex += 0.25 * gauss(); ey += 0.25 * gauss(); }   // hand jitter
    // rotate world specific force into the phone frame (rotation about y by pitch), then add phone-frame extras
    const c = Math.cos(pitch), s = Math.sin(pitch);
    const px = c * wx - s * wz + ex, py = wy + ey, pz = s * wx + c * wz + ez;
    samples.push([t, px + noise * gauss(), py + noise * gauss(), pz + noise * gauss()]);
  }
  return { samples, landings: landings.map(x => x * 1000) };
}

// Phone resting on a table or in a still hand: gravity plus sensor noise and a slight tremor
export function still({ dur = 20, seed = 3, tremor = 0.15 }) {
  const r = rng(seed), gauss = () => { let s = 0; for (let i = 0; i < 6; i++) s += r(); return (s - 3) / 0.707; };
  const out = []; let t = 0;
  while (t < dur * 1000) { t += 12 + r() * 10; out.push([t, 0.3 + tremor * gauss(), 0.2 + tremor * gauss(), G + tremor * gauss()]); }
  return { samples: out, landings: [] };
}
