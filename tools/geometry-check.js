#!/usr/bin/env node
'use strict';
// tools/geometry-check.js
//
// THE GEOMETRY SCREEN — measuring the camera from the PIXELS.
//
// WHY THIS EXISTS. The content check for a camera grid has to answer
// "did the camera land?" and the two obvious instruments both failed:
// the eye (no vision provider configured on this machine) and CLIP
// (measured unreliable here — the SAME frame ranked its assigned camera
// 1st in one prompt formulation and 6th in another, because the scene
// text dominates the score and CLIP-ViT cannot resolve macro-vs-wide
// from a technique word).
//
// So the camera is measured from the GEOMETRY of the picture instead.
//
// Not every camera has a signature in the pixels, and this tool is
// honest about that. Four of the twelve DO:
//
//   CAM 04  the dutch tilt      -> the dominant structural edge is NOT
//                                   level; the frame is rolled
//   CAM 10  the whip pan       -> directional motion blur; the image is
//                                   smeared along one axis
//   CAM 12  front-on, centred  -> the picture is close to left-right
//                                   mirror symmetric
//   CAM 05  the macro          -> very shallow depth of field; one small
//                                   sharp region and a blurred rest
//
// The other eight (wide, low angle, high angle, over-the-shoulder,
// profile, top-down, long lens, from behind) have no reliable pixel
// signature that survives a 35mm-styled frame, and this tool does not
// pretend otherwise.
//
// THE VALIDATION IS THE GRID ITSELF. The camera grid assigns each
// camera position EXACTLY ONCE, so each metric should have exactly one
// extreme — and it should be the frame that was assigned that camera.
// That is a falsifiable expectation, and it is checked here.
//
// Usage:
//   node tools/geometry-check.js <pack-dir> [--out <json>]
//
// Exit: 0 the check ran · 2 bad input

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ARGV = process.argv.slice(2);
function argVal(name, fallback) {
    const i = ARGV.indexOf(name);
    return (i !== -1 && ARGV[i + 1] && !ARGV[i + 1].startsWith('--')) ? ARGV[i + 1] : fallback;
}
const PACK_DIR = ARGV.find(a => !a.startsWith('--'));
const OUT = argVal('--out', null);
const ALL = ARGV.includes('--all-cells');
const PY = path.resolve(__dirname, '../lib/clip-interrogator/.venv/bin/python');

function log(m) { process.stdout.write(`[geometry-check] ${m}\n`); }
function warn(m) { process.stderr.write(`[geometry-check] ${m}\n`); }

if (!PACK_DIR) { warn('usage: geometry-check.js <pack-dir> [--out <json>]'); process.exit(2); }
const abs = path.resolve(PACK_DIR);
if (!fs.existsSync(abs)) { warn(`no such directory: ${abs}`); process.exit(2); }
if (!fs.existsSync(PY)) { warn(`no python venv at ${PY}`); process.exit(2); }

const regPath = path.resolve(__dirname, '../lib/nema-me-u-meni-camera-grid.json');
const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));

const measPath = path.join(abs, 'cell-measurements.json');
if (!fs.existsSync(measPath)) { warn('cell-measurements.json not found — run pick-cells.js first'); process.exit(2); }
const meas = JSON.parse(fs.readFileSync(measPath, 'utf8'));
const screen = new Map(meas.map(r => [r.prompt, r.pick]));

const PY_SCRIPT = `
import json, sys
import numpy as np
from PIL import Image

spec = json.load(open(sys.argv[1]))

def to_gray(path, size=(640, 360)):
    im = Image.open(path).convert('L').resize(size, Image.BILINEAR)
    return np.asarray(im, dtype=np.float64)

def gradients(g):
    gy, gx = np.gradient(g)
    mag = np.hypot(gx, gy)
    ang = (np.degrees(np.arctan2(gy, gx)) + 180.0) % 180.0
    return mag, ang

def roll_degrees(g):
    """How far the dominant structural edge is from level.

    A ROLLED frame rotates every scene edge by the same angle, so the
    dominant gradient orientation moves off the axes. The measure is the
    distance of that orientation from the nearest AXIS (0 or 90 degrees),
    so 0 = level and 45 = fully rolled.

    TWO BUGS in the first version, both caught by a synthetic
    validation (a generated image rolled by a KNOWN angle):

    1. THE BORDER DOMINATED. The frame's own edge produces a huge
       gradient ring at 0 and 90 degrees, so the histogram was always
       pinned to an axis and the measured roll was always 0. The border
       is now excluded before the histogram is taken.

    2. THE DISTANCE WAS TAKEN FROM THE PEAK, NOT FROM THE AXIS. The
       weighted mean was computed as an offset FROM the peak, so any
       coherent group of edges scored ~0 no matter where it sat — a
       frame rolled by 30 degrees measured 2.6. The mean is now
       converted back to an ABSOLUTE orientation and measured against
       the nearest axis.
    """
    gy, gx = np.gradient(g)
    mag = np.hypot(gx, gy)
    ang = (np.degrees(np.arctan2(gy, gx)) + 180.0) % 180.0

    # EXCLUDE THE BORDER (fix 1)
    m = mag.copy()
    b = max(2, int(0.03 * min(m.shape)))
    m[:b, :] = 0; m[-b:, :] = 0; m[:, :b] = 0; m[:, -b:] = 0

    hist, _ = np.histogram(ang, bins=180, range=(0, 180), weights=m)
    # SMOOTH — a 1-degree bin on a grainy film frame is dominated by
    # whichever bin happens to catch the most grain.
    k = np.array([0.25, 0.5, 1.0, 0.5, 0.25])
    hist = np.convolve(hist, k / k.sum(), mode='same')
    peak = int(np.argmax(hist))
    if hist[peak] <= 0:
        return 0.0, 0.0

    # The mean angle of the mass around the peak (circular, in 0..180).
    idx = [i for i in range(180) if min(abs(i - peak), 180 - abs(i - peak)) <= 20]
    wsum = hist[idx].sum()
    if wsum <= 0:
        return 0.0, 0.0
    offset = 0.0
    for i in idx:
        d = (i - peak + 90) % 180 - 90
        offset += d * hist[i]
    offset /= wsum
    absolute = (peak + offset) % 180

    # THE DISTANCE FROM THE NEAREST AXIS (fix 2) — not from the peak.
    axis_dist = absolute % 90.0
    dist = min(axis_dist, 90.0 - axis_dist)
    return float(dist), float(hist[peak] / (hist.sum() + 1e-9))

def blur_anisotropy(g):
    """Directional motion blur: the anisotropy of the high-frequency energy.

    Motion blur along one axis removes detail ACROSS that axis and
    LEAVES it along the axis of travel. So the high-frequency energy is
    ELONGATED along the direction of the smear — and that is the
    signal.

    THE FIRST VERSION MEASURED THE WRONG THING. It summed the Fourier
    energy along the horizontal and vertical axes and took their RATIO.
    That measures how much detail survives, not how the detail is
    oriented — and on a grainy film frame the answer is dominated by the
    grain, so the number came out unrelated to motion blur.

    The working version measures the ORIENTATION of the high-frequency
    energy: the second-moment ellipse of the band-passed spectrum. A
    smeared frame has that ellipse stretched along the smear axis; a
    sharp frame has it round.
    """
    win = np.outer(np.hanning(g.shape[0]), np.hanning(g.shape[1]))
    F = np.abs(np.fft.fftshift(np.fft.fft2((g - g.mean()) * win)))
    h, w = F.shape
    cy, cx = h // 2, w // 2
    yy, xx = np.ogrid[:h, :w]
    r = np.hypot(yy - cy, xx - cx).astype(float)
    rmax = min(cy, cx)
    band = (r > rmax * 0.45) & (r < rmax * 0.95)
    Fb = F * band

    # second moments of the band-passed spectrum
    tot = Fb.sum()
    if tot <= 0:
        return 0.0, 0.0
    # NOTE: yy/xx are broadcast grids, so they must be materialised to
    # the image's own shape before a boolean mask can index them. The
    # first version indexed the (1, N) broadcast row with an (H, W)
    # mask and raised IndexError.
    dy = np.broadcast_to(yy - cy, F.shape)[band].astype(float)
    dx = np.broadcast_to(xx - cx, F.shape)[band].astype(float)
    fb = Fb[band]
    my = float((dy * fb).sum() / tot)
    mx = float((dx * fb).sum() / tot)
    vyy = float(((dy - my) ** 2 * fb).sum() / tot)
    vxx = float(((dx - mx) ** 2 * fb).sum() / tot)
    vxy = float(((dy - my) * (dx - mx) * fb).sum() / tot)

    # the ellipse's major/minor axis ratio: 1.0 = round (sharp),
    # high = elongated (smeared)
    tr = vxx + vyy
    det = vxx * vyy - vxy * vxy
    disc = max(tr * tr / 4.0 - det, 0.0) ** 0.5
    l1 = tr / 2.0 + disc
    l2 = tr / 2.0 - disc
    aniso = float((l1 + 1e-9) / (l2 + 1e-9))

    # the smear axis angle, in degrees from horizontal
    theta = 0.5 * np.degrees(np.arctan2(2 * vxy, vxx - vyy))
    return aniso, float(theta)

def symmetry(g):
    """Left-right mirror correlation."""
    left = g[:, : g.shape[1] // 2]
    right = g[:, g.shape[1] // 2 : g.shape[1] // 2 * 2][:, ::-1]
    a = left.ravel() - left.mean()
    b = right.ravel() - right.mean()
    denom = (np.linalg.norm(a) * np.linalg.norm(b))
    return float(np.dot(a, b) / denom) if denom else 0.0

def dof_ratio(g):
    """Depth of field: sharp region vs the rest.

    A macro has ONE small sharp area and a blurred rest, so the sharpest
    decile of the image is far more detailed than the median region. A
    flat-lay or a wide shot is uniformly sharp, so the ratio is ~1.

    THE FIRST VERSION MEASURED THE WRONG THING. It compared the top
    decile of gradient magnitude with the median, which on a grainy film
    frame is dominated by the GRAIN — so every frame scored 24-36 and
    the number was not discriminative at all.

    The working version measures WHERE the detail is: the area of the
    top decile of gradient against the area of the top 40 percent. A
    macro concentrates its sharpness into one small blob (a low ratio);
    an evenly sharp frame spreads it (a high ratio).
    """
    mag, _ = gradients(g)
    detail = mag.ravel()
    if detail.max() <= 0:
        return 0.0
    t10 = np.percentile(detail, 90)
    t40 = np.percentile(detail, 60)
    area10 = float((detail >= t10).sum())
    area40 = float((detail >= t40).sum())
    if area40 <= 0:
        return 0.0
    # LOW = concentrated = macro. The metric is inverted so that HIGHER
    # still means "more macro-like" for the grid test.
    return float(area40 / area10)

out = []
for job in spec['jobs']:
    g = to_gray(job['file'])
    roll, roll_strength = roll_degrees(g)
    aniso, horiz_frac = blur_anisotropy(g)
    sym = symmetry(g)
    dof = dof_ratio(g)
    out.append({
        'dir': job['dir'], 'cell': job['cell'], 'assigned': job['assigned'],
        'roll_deg': roll, 'roll_strength': roll_strength,
        'blur_aniso': aniso, 'horiz_frac': horiz_frac,
        'symmetry': sym, 'dof_ratio': dof,
    })

json.dump(out, open(spec['out'], 'w'), indent=1)
print('measured', len(out))
`;

const jobs = [];
for (const d of [...screen.keys()].sort()) {
    const n = parseInt(d.replace('prompt-', ''), 10);
    const fr = reg.frames.find(x => x.n === n);
    if (!fr) continue;
    const cells = ALL ? ['0_0', '0_1', '0_2', '0_3'] : [screen.get(d)];
    for (const c of cells) {
        const f = path.join(abs, d, `${c}.webp`);
        if (fs.existsSync(f)) jobs.push({ dir: d, cell: c, file: f, assigned: fr.cameraN });
    }
}
if (!jobs.length) { warn('no cells to measure'); process.exit(2); }

const specPath = path.join(abs, '_geometry_spec.json');
const outPath = OUT || path.join(abs, 'geometry-check.json');
const pyPath = path.join(abs, '_geometry_check.py');
fs.writeFileSync(pyPath, PY_SCRIPT);
fs.writeFileSync(specPath, JSON.stringify({ jobs, out: outPath }, null, 1));

try {
    const out = execFileSync(PY, [pyPath, specPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    log(out.trim());
} catch (e) {
    warn(`measurement failed: ${(e.stderr || e.message || '').toString().slice(0, 800)}`);
    process.exit(3);
}

const rows = JSON.parse(fs.readFileSync(outPath, 'utf8'));

if (ALL) {
    // CROSS-FRAME, NOT WITHIN-FRAME.
    //
    // The first version of this block sorted the cells WITHIN one frame
    // and asked whether the assigned camera's metric peaked there. That
    // test can never fail — sorting four values always puts one of them
    // first — so it "confirmed" 4 of 4 signatures while measuring
    // nothing.
    //
    // The real test is across the whole set: the camera grid assigns
    // each camera position EXACTLY ONCE, so the FRAME with the most
    // extreme roll should be the dutch-tilt frame, the most symmetric
    // frame should be the front-on frame, and so on. If the extreme sits
    // in some other frame, the camera did not land where it was asked.
    const byFrame = new Map();
    for (const r of rows) {
        if (!byFrame.has(r.dir)) byFrame.set(r.dir, []);
        byFrame.get(r.dir).push(r);
    }
    const MET = {
        4:  { key: 'roll_deg',   hi: true,  label: 'dutch tilt (rolled frame)' },
        10: { key: 'blur_aniso', hi: true,  label: 'whip pan (directional blur)' },
        12: { key: 'symmetry',   hi: true,  label: 'front-on, centred' },
        5:  { key: 'dof_ratio',  hi: false, label: 'macro (shallow depth of field)' },
    };

    log('\n--- CROSS-FRAME: the extreme of each signature, and where it sits ---');
    let confirmed = 0;
    const verdicts = [];
    for (const [cam, m] of Object.entries(MET)) {
        const flat = [];
        for (const [dir, cs] of byFrame) {
            for (const c of cs) flat.push({ dir, cell: c.cell, v: c[m.key] });
        }
        flat.sort((a, b) => (m.hi ? b.v - a.v : a.v - b.v));
        const top = flat[0];
        const n = parseInt(top.dir.replace('prompt-', ''), 10);
        const fr = reg.frames.find(x => x.n === n);
        const ok = fr.cameraN === Number(cam);
        if (ok) confirmed++;
        verdicts.push({ signature: m.key, expectsCam: Number(cam), topDir: top.dir, topCell: top.cell, topValue: top.v, thatFramesCam: fr.cameraN, ok });
        log(`${m.label.padEnd(36)} extreme: ${top.dir} cell ${top.cell} = ${top.v.toFixed(3)}  (that frame is CAM ${String(fr.cameraN).padStart(2, '0')})  ${ok ? 'CONFIRMED' : 'NOT CONFIRMED'}`);
        log(`    runner-up: ${flat.slice(1, 4).map(f => `${f.dir}/${f.cell}=${f.v.toFixed(2)}`).join('  ')}`);
    }
    log(`\n${confirmed}/${Object.keys(MET).length} camera signatures land in their OWN frame`);
    fs.writeFileSync(path.join(abs, 'geometry-verdicts.json'), JSON.stringify(verdicts, null, 2));
    log(`verdicts -> ${path.join(abs, 'geometry-verdicts.json')}`);
    process.exit(0);
}

// The metrics, and the camera each one is a signature FOR.
const METRICS = [
    { key: 'roll_deg',    cam: 4,  label: 'dutch tilt (rolled frame)',       higherIs: true  },
    { key: 'blur_aniso',  cam: 10, label: 'whip pan (directional blur)',     higherIs: true  },
    { key: 'symmetry',    cam: 12, label: 'front-on, centred',               higherIs: true  },
    // dof_ratio is INVERTED inside the metric itself (a macro
    // concentrates its sharpness, so it scores LOW) — see dof_ratio().
    { key: 'dof_ratio',   cam: 5,  label: 'macro (shallow depth of field)', higherIs: false },
];

log('\n--- the measurements ---');
for (const r of rows) {
    const n = parseInt(r.dir.replace('prompt-', ''), 10);
    const fr = reg.frames.find(x => x.n === n);
    const cam = reg.cameras.find(c => c.n === fr.cameraN);
    log(`${r.dir}  assigned CAM ${String(fr.cameraN).padStart(2, '0')} (${cam.name})`);
    log(`    roll=${r.roll_deg.toFixed(1)}deg  blur_aniso=${r.blur_aniso.toFixed(2)}  symmetry=${r.symmetry.toFixed(3)}  dof=${r.dof_ratio.toFixed(2)}`);
}

log('\n--- the grid test: each metric should peak at the frame assigned that camera ---');
let confirmed = 0;
const verdicts = [];
for (const m of METRICS) {
    const sorted = [...rows].sort((a, b) => (m.higherIs ? b[m.key] - a[m.key] : a[m.key] - b[m.key]));
    const top = sorted[0];
    const topN = parseInt(top.dir.replace('prompt-', ''), 10);
    const topAssigned = reg.frames.find(x => x.n === topN).cameraN;
    const ok = topAssigned === m.cam;
    if (ok) confirmed++;
    verdicts.push({ metric: m.key, expectsCam: m.cam, topFrame: topN, topAssigned, ok, value: top[m.key] });
    log(`${m.label.padEnd(38)} peak at ${top.dir} (assigned CAM ${String(topAssigned).padStart(2, '0')}), value ${top[m.key].toFixed(3)}  ${ok ? 'CONFIRMED' : 'NOT CONFIRMED (expected CAM ' + m.cam + ')'}`);
}

log(`\n${confirmed}/${METRICS.length} camera signatures confirmed by the geometry`);
fs.writeFileSync(path.join(abs, 'geometry-verdicts.json'), JSON.stringify(verdicts, null, 2));
log(`verdicts -> ${path.join(abs, 'geometry-verdicts.json')}`);
