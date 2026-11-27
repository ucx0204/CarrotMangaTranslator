"""Recover a light periodic screen only where independently visible banks agree."""

from pathlib import Path
from runpy import run_path
import numpy as np
from scipy.ndimage import find_objects, gaussian_filter, label, maximum_filter, minimum_filter, map_coordinates, distance_transform_edt as edt
from scipy.spatial import cKDTree


def title_paper_samples(gray, distance, opaque):
    """Measure the two printed axes on exposed paper. Retain source tiles
    where the same axes predict complete withheld blocks of native dots."""
    low = gaussian_filter(gray, 2.8)
    detail = gray - low
    power = np.sqrt(gaussian_filter(detail*detail, 3.8))
    sparse = opaque & (low > 179) & (gaussian_filter((gray < 150).astype('f'), 7) < .06)
    bank = sparse & (distance > 7) & (distance < 225) & (low > 195) & (low < 251)
    bank &= (power > 4) & (power < 37) & (edt(low > 174) > 9)
    sy, sx = np.where(bank)
    if len(sx) < 1200 or max(gray.shape) > 2048:
        return
    sampled = np.random.default_rng(92).choice(len(sx), min(24000, len(sx)), False)
    positions = np.column_stack((sx[sampled], sy[sampled]))
    estimate = run_path(str(Path(__file__).with_name("qwen-screen-detail.py")))["screen_frequencies"]
    modes = estimate(positions, (detail / np.maximum(4, power))[sy[sampled], sx[sampled]], gray.shape)
    if len(modes) < 2:
        return
    a = modes[0]
    b = next((v for v in modes[1:] if abs(a[0]*v[1] - a[1]*v[0]) > .04), None)
    if b is None:
        return
    y, x = np.indices(gray.shape)
    bank &= distance > 25
    held = (x//13 + 3*(y//11)) % 7 == 2
    train = bank & ~held
    mass = np.maximum(.04, gaussian_filter(train.astype('f'), 8))
    prediction = np.zeros_like(gray)
    for u, v in (a, b, a+b, a-b, 2*a, 2*b):
        phase = 2*np.pi*(x*u + y*v)
        for wave in (np.cos(phase).astype('f'), np.sin(phase).astype('f')):
            prediction += 2*wave*gaussian_filter(np.where(train, detail*wave, 0), 8)/mass
    energy = gaussian_filter(np.where(bank, detail**2, 0), 7)
    agreement = gaussian_filter(np.where(bank, detail*prediction, 0), 7)
    agreement /= np.sqrt(np.maximum(.01, energy*gaussian_filter(np.where(bank, prediction**2, 0), 7)))
    fine = gaussian_filter(gray, 2.1)
    irregular = gaussian_filter((fine-gaussian_filter(gray, 6.5))**2, 6)
    contrast = np.sqrt(gaussian_filter((gray-fine)**2, 4))
    stable = gaussian_filter((contrast < 2.4).astype('f'), 6) < .035
    donors = ((edt(sparse & (distance > 12)) > 13) & (distance < 210) & (agreement > .70)
              & (irregular < 18) & stable & (low < 252) & (x % 3 == 0) & (y % 3 == 0))
    test = donors & held
    if test.sum() < 32:
        return
    truth, predicted = detail[test], prediction[test]
    if min(truth.std(), predicted.std()) < 3 or np.corrcoef(truth, predicted)[0, 1] < .70:
        return
    return donors, sparse, low, np.stack([a, b])


def transfer_title_paper(gray, density, known_density, donors, axes, weight):
    """Translate native samples by whole screen periods. Use the fine ink
    from each sample and bound its broad variation so objects and highlights
    visible elsewhere on the page cannot be stamped onto the restored art."""
    ys, xs = np.where(donors)
    tree = cKDTree(np.column_stack((xs/80, ys/65, known_density[ys, xs]/9)))
    broad = gaussian_filter(gray, 7.5)
    fine = gaussian_filter(gray, 2.3)
    residual = 1.26*(gray-fine) + .86*np.clip(fine-broad, -4.2, 4.2)
    inverse = np.linalg.inv(axes)
    rng = np.random.default_rng(717)
    texture, mass = np.zeros_like(gray), np.zeros_like(gray)
    radius = 17
    for cy in range(0, gray.shape[0], radius):
        for cx in range(0, gray.shape[1], radius):
            bounds = np.s_[max(0, cy-radius):min(gray.shape[0], cy+radius+1),
                           max(0, cx-radius):min(gray.shape[1], cx+radius+1)]
            if weight[bounds].max() < .01:
                continue
            scores, ids = tree.query((cx/80, cy/65, density[cy, cx]/9), k=min(70, len(xs)))
            probabilities = 1 / (.18 + scores)**3
            donor = rng.choice(ids, p=probabilities/probabilities.sum())
            shift = inverse @ np.rint(axes @ [xs[donor]-cx, ys[donor]-cy])
            yy, xx = np.mgrid[bounds]
            uv = [yy+shift[1], xx+shift[0]]
            band = map_coordinates(residual, uv, order=1, mode='nearest')
            level = map_coordinates(broad, uv, order=1, mode='nearest')
            scale = np.clip((255-density[bounds])/np.maximum(3, 255-level), .45, 1.7)
            window = (1-abs(xx-cx)/radius)*(1-abs(yy-cy)/radius)
            texture[bounds] += window*scale*band
            mass[bounds] += window
    return density + texture/np.maximum(.02, mass)


def restore_washed_title_paper(source, ink, result, opaque):
    if not ink.any():
        return
    gray = source[:, :, 1].astype('f')
    distance = edt(~ink)
    samples = title_paper_samples(gray, distance, opaque)
    if samples is None:
        return
    donors, sparse, low, axes = samples
    current = result[:, :, 1].astype('f')
    density = paper_average(current, current > 185, 8).astype('f')
    native = paper_average(gray, gray > 158, 8).astype('f')
    bank = sparse & (distance > 20) & (distance < 170) & (low > 188) & (edt(low > 165) > 7)
    mass = gaussian_filter(bank.astype('f'), 26)
    offset = gaussian_filter(np.where(bank, np.clip(native-density, -15, 15), 0), 26)
    density += offset/np.maximum(.03, mass)*np.clip(mass/.25, 0, 1)
    shade = gaussian_filter((current < 153).astype('f'), 12)
    gradient = np.hypot(*np.gradient(gaussian_filter(current, 1.5)))
    weight = opaque*np.clip((47-distance)/16, 0, 1)*np.clip((395-edt(~donors))/120, 0, 1)
    weight *= np.clip((254.5-density)/8, 0, 1)*np.clip((.135-shade)/.085, 0, 1)
    weight *= np.clip((gaussian_filter(current, 4)-177)/22, 0, 1)
    weight *= 1 - np.clip((maximum_filter(gradient, 3)-4.5)/7, 0, 1)
    texture = transfer_title_paper(gray, density, native, donors, axes, weight)
    selected = weight > 0
    mixed = np.rint(np.clip(current[selected]+weight[selected]*(texture[selected]-current[selected]), 0, 255))
    result[selected, :3] = mixed[:, None]
    blend_title_highlights(result, distance, opaque, axes)


def blend_title_highlights(result, distance, opaque, axes):
    """Near white, a small step between two estimates of paper density can
    reveal the old lettering. Diffuse only on the same side of the surviving
    pen line, and quantize the highlight on the measured native screen axes."""
    tone = result[:, :, 1].astype('f')
    soft = gaussian_filter(tone, 1.25)
    surfaces, _ = label(opaque & (minimum_filter(soft, 3) > 211))
    support = opaque * np.clip((47-distance)/18, 0, 1)
    y, x = np.indices(tone.shape, dtype='f')
    dither = sum(.23*np.cos(2*np.pi*(u*x+v*y)) for u, v in axes)
    for i, box in enumerate(find_objects(surfaces), 1):
        field = surfaces[box] == i
        if field.sum() < 850 or np.count_nonzero(field & (support[box] > .02)) < 180:
            continue
        original = tone[box]
        local = paper_average(original, field, 2.4, 'constant')
        broad = paper_average(original, field, 23, 'constant')
        fade = (support[box] * np.clip((soft[box]-222)/18, 0, 1)
                * np.clip((broad-238)/10, 0, 1) * np.clip((original-193)/38, 0, 1))
        grain = np.sqrt(paper_average((original-local)**2, field, 3, 'constant'))
        detail = (np.clip((253.8-broad)/12, 0, 1) * np.clip((grain-1.5)/3, 0, 1)
                  * np.clip(original-local, -12, 10))
        active = field & (fade > 0)
        value = original + fade*(broad + detail + dither[box] - original)
        result[box][:, :, :3][active] = np.rint(value[active]).clip(0, 255).astype('u1')[:, None]


def paper_average(values, light, scale, mode='reflect'):
    weights = gaussian_filter(light.astype(float), scale, mode=mode)
    return gaussian_filter(np.where(light, values, 0.), scale, mode=mode) / np.maximum(1e-5, weights)


def whitened_caption_columns(ink, marked, gray, decoded, opaque):
    from scipy.ndimage import binary_fill_holes
    spans, _ = label(ink.sum(0) > 4)
    if sum(box[0].stop-box[0].start >= 9 for box in find_objects(spans) if box) < 2:
        return
    expanded = binary_fill_holes(edt(~marked) <= 6)
    distance = edt(~expanded)
    exposed = ((~expanded) & opaque & (distance < 100)
               & (edt(~((gray < 130) & ~expanded)) > 5))
    broad = paper_average(gray, exposed, 6)
    bank = exposed & (distance > 1) & (broad > 195)
    border = bank & (distance < 45)
    if border.sum() < 2000:
        return
    low, middle, high = np.quantile(gray[border], [.08, .50, .90])
    shaded = border & (broad < 248) & (broad > 212)
    if low >= 243 or middle < 249 or high < 254 or shaded.sum() < 650:
        return
    measured = paper_average(gray, border, 13)
    crossed = (ink & (measured > 212) & (measured < 249) & (gaussian_filter(border.astype(float), 13) > .08)
               & (gaussian_filter(shaded.astype(float), 13) > .07))
    if (crossed.sum() < 180 or (decoded[crossed] >= 250).mean() < .86 or decoded[crossed].std() >= 7
            or np.quantile((decoded-measured)[crossed], .62) <= 6):
        return
    return exposed, bank


def cloud_tone_between_columns(gray, native, bank):
    from scipy.ndimage import convolve
    field = np.zeros_like(gray)
    for scale in (46, 27, 16, 9, 4.5):
        mass = gaussian_filter(bank.astype(float), scale)
        weight = np.clip((mass-.05)/.17, 0, 1)
        field += weight*(gaussian_filter(gray*bank, scale)/np.maximum(.00001, mass)-field)
    stencil = np.array([[0, .25, 0], [.25, 0, .25], [0, .25, 0]])
    surface = np.where(bank, native, field)
    for _ in range(240):
        surface = np.where(bank, native, .99*convolve(surface, stencil, mode="nearest")+.01*field)
    return surface


def cloud_grain_patch(center, positions, train, donors, native, field, axes):
    cy, cx = center
    y, x = positions
    by, bx = donors
    nearby = np.flatnonzero((abs(by-cy) < 85) & (abs(bx-cx) < 85)
                            & (abs(native[by, bx]-field[cy, cx]) < 12))
    if len(nearby) < 12:
        return
    sample = nearby[::max(1, len(nearby)//1000)]
    dy, dx = by[sample]-cy, bx[sample]-cx
    sy, sx = y[:, None]+dy, x[:, None]+dx
    ry, rx = sy.clip(0, len(train)-1), sx.clip(0, train.shape[1]-1)
    fits = train[ry, rx] & (sy == ry) & (sx == rx)
    coverage = fits.mean(0)
    cost = (abs(native[ry, rx]-field[y, x, None]).mean(0) + .018*np.hypot(dy, dx)
            + 100*(1-coverage) + .8*(1-np.cos(2*np.pi*np.column_stack((dx, dy)) @ axes.T)).mean(1))
    best = np.argmin(cost)
    if coverage[best] >= .78 and cost[best] <= 12:
        use = fits[:, best]
        return (y[use], x[use]), (ry[use, best], rx[use, best])


def finish_clear_sky_rows(gray, mask, output, valid):
    from scipy.ndimage import binary_closing, binary_fill_holes, minimum_filter, uniform_filter1d
    _, columns = np.where(mask)
    distance = edt(~mask)
    hidden = binary_fill_holes(distance <= 4.8)
    clearance = edt(~((gray < 163) & ~hidden))
    known = valid & ~hidden & (clearance > 3.3)
    edges = np.linspace(max(0, columns.min()-19), min(gray.shape[1], columns.max()+20), 5).astype(int)
    white, shaded = [], []
    for left, right in zip(edges[:-1], edges[1:]):
        bank, native = known[:, left:right], gray[:, left:right]
        def average(values):
            return uniform_filter1d(values.sum(1).astype(float), 5)
        area = average(bank)
        dots = average(bank & (native < 248))
        fresh = average(bank & (native >= 254))
        tone = average(np.where(bank, np.minimum(22, 255-native), 0))
        white.append((area > 2.5) & (dots < .085*area) & (fresh > .72*area) & (tone < 1.1*area))
        shaded.append((area > 3.8) & ((dots > .20*area) | (tone > 2.9*area)))
    # A horizontal roof can be closer to the last character than the next
    # patch of sky. Establish paper from several independent banks on its own row.
    rows = (np.sum(white, axis=0) >= 3) & (np.sum(shaded, axis=0) <= 1)
    spans, _ = label(binary_closing(rows, structure=np.ones(4)))
    long = np.bincount(spans) >= 7
    long[0] = False
    current = output[:, :, 1]
    paint = (valid & long[spans, None] & (distance < 11) & (clearance > 2.8)
             & (current >= 216) & (minimum_filter(current, 3) > 210))
    output[paint, :3] = 255


def restore_clouded_caption(source, mask, result, opaque, frequencies):
    """Restore the exposed cloud gradation and scan grain across washed-out vertical type."""
    y, x = np.where(mask)
    if (len(x) < 800 or mask.size > 800_000 or not 49 <= np.ptp(y) <= 270 or not 48 <= np.ptp(x) <= 205
            or np.quantile(np.ptp(source[mask], axis=1), .985) > 5):
        return False
    valid = np.ones_like(mask) if opaque is None else opaque
    gray, model = (rgb[:, :, 1].astype(float) for rgb in (source, result))
    typeset = run_path(str(Path(__file__).with_name("qwen_typeset_stock.py")))
    ink = typeset["erased_dark_type"](gray, mask, model)
    if ink is None or not typeset["has_typeset_column"](ink):
        return False
    known = whitened_caption_columns(ink, mask, gray, model, valid)
    if known is None:
        return False
    exposed, bank = known
    native = paper_average(gray, exposed, 2.7)
    power = np.sqrt(paper_average((gray-native)**2, exposed, 3))
    field = cloud_tone_between_columns(gray, native, bank)
    train = bank & (edt(bank) > 3) & (native > 190)
    by, bx = np.where(train)
    if len(bx) < 800:
        return False
    axes = frequencies(np.column_stack((bx, by)), (gray-native)[train]/np.maximum(2, power[train]), gray.shape)
    if len(axes) < 2 or abs(np.linalg.det(axes[:2])) < .035:
        return False
    donors = np.where(train & (edt(bank) > 5.2))
    distance = edt(~mask)
    pen_clearance = edt(gaussian_filter(model, 2) > 185)
    target = (valid & (distance < 11) & (model > 182) & (edt(~bank) < 48)
              & (gaussian_filter(model, 2.5) > 208) & (pen_clearance > 2))
    y, x = np.where(target)
    if not len(x):
        return False
    value, mass, amplitude = np.zeros((3, *mask.shape))
    tone = paper_average(gray, exposed, 3.5)
    for cy in range(max(8, y.min()//8*8), min(len(mask)-8, y.max()+8), 8):
        for cx in range(max(8, x.min()//8*8), min(mask.shape[1]-8, x.max()+8), 8):
            sy, sx = np.where(target[cy-8:cy+9, cx-8:cx+9])
            if len(sx) < 7:
                continue
            patch = cloud_grain_patch((cy, cx), (sy+cy-8, sx+cx-8), train, donors, tone, field, axes[:2])
            if patch is None:
                continue
            pos, ref = patch
            weight = (np.maximum(.01, 1-abs(pos[0]-cy)/9)*np.maximum(.01, 1-abs(pos[1]-cx)/9))**1.4
            value[pos] += weight*np.minimum(255, gray[ref]+(field[pos]-tone[ref]).clip(-10, 10))
            mass[pos] += weight
            amplitude[pos] += weight*power[ref]
    use = mass > .025
    if not use.any():
        return False
    value = np.where(use, value/np.maximum(.0001, mass), model)
    fine = value-paper_average(value, use, 3)
    gain = np.clip(amplitude/np.maximum(.0001, mass)/np.maximum(.4, np.sqrt(paper_average(fine**2, use, 4))), 1, 2.25)
    value = np.clip(value+.85*(gain-1)*fine, 0, 255)
    alpha = np.clip((11-distance[use])/3, 0, 1)*np.clip((pen_clearance[use]-2)/5, 0, 1)
    result[use, :3] = np.rint(model[use]+alpha*(value[use]-model[use])).clip(0, 255).astype('u1')[:, None]
    finish_clear_sky_rows(gray, mask, result, valid)
    return True


def pale_paper_field(tone, bank, target):
    """Fit a gradual paper tone twice, holding out disjoint blocks of the original in each fit."""
    y, x = np.indices(tone.shape)
    cy, cx = (np.median(v[target]) for v in (y, x))
    u, v = (x-cx)/38, (y-cy)/38
    design = np.stack([np.ones(tone.shape), u, v, u*u, u*v, v*v], axis=2)
    points, values = design[bank], tone[bank]
    partition = (x[bank]//10 + 3*(y[bank]//9)) % 4 < 2
    fits, errors = [], []
    for training in (partition, ~partition):
        if training.sum() < 200:
            return
        weights = training.astype(float)
        for cutoff in (12, 7, 4.7, 3.5, 3.1):
            gram = points.T @ (weights[:, None]*points) + np.diag([.0001, .004, .004, .17, .17, .17])
            fit = np.linalg.solve(gram, points.T @ (weights*values))
            residual = points @ fit-values
            weights = training / (1 + (residual/cutoff)**2)**1.35
        fits.append(design @ fit)
        errors.extend(abs(residual[~training]))
    if np.quantile(errors, .8) > 5.4 or np.quantile(abs(fits[0][target]-fits[1][target]), .9) > 4:
        return
    return np.mean(fits, axis=0), np.quantile(errors, .90)


def repeated_screen_offsets(bank, detail):
    """Find native translations that bring the dots back into phase across a missing stroke."""
    from scipy.signal import fftconvolve
    h, w = bank.shape
    ry, rx = min(h-1, 96), min(w-1, 96)
    area = np.s_[h-1-ry:h+ry, w-1-rx:w+rx]
    def correlate(a, b):
        return fftconvolve(a, b[::-1, ::-1], mode="full")[area]
    weight = bank.astype(float)
    signal = np.clip(detail, -3.5, 3.5)*weight
    pairs = correlate(weight, weight)
    power = correlate(signal**2, weight)
    score = correlate(signal, signal)/np.sqrt(np.maximum(.001, power*power[::-1, ::-1]))
    y, x = np.indices(score.shape)
    distance = np.hypot(y-ry, x-rx)
    peaks = ((score == maximum_filter(score, 3)) & (pairs > 700) & (score > .12)
             & (distance > 4) & (distance < 94))
    y, x = np.where(peaks)
    order = np.argsort(-score[peaks]+.001*distance[peaks])[:200]
    return [(int(y[i]-ry), int(x[i]-rx), score[y[i], x[i]]) for i in order]


def borrow_repeated_dots(bank, detail, target, offsets):
    y, x = np.where(target)
    total, mass, sharp, strongest = np.zeros((4, len(x)))
    for dy, dx, agreement in offsets:
        sy, sx = (y+dy).clip(0, bank.shape[0]-1), (x+dx).clip(0, bank.shape[1]-1)
        valid = bank[sy, sx] & (sy == y+dy) & (sx == x+dx)
        weight = valid*agreement**4/np.hypot(dy, dx)**1.5
        value = detail[sy, sx]
        total += weight*value
        mass += weight
        sharp = np.where(weight > strongest, value, sharp)
        strongest = np.maximum(weight, strongest)
    return total/np.maximum(1e-12, mass), sharp, mass > 0


def restore_weathered_screen_plane(gray, native, edited, power, region, mask, allowed, distance, result):
    from scipy.ndimage import convolve
    bank = region & (distance > 8) & (distance < 77) & (power < 7.7)
    if bank.sum() < 950 or np.median(power[bank]) > 5.5:
        return False
    gap = edt(~bank)
    covered = region & mask & (gap < 38)
    if covered.sum() < 250:
        return False
    field = pale_paper_field(native, bank, covered)
    if field is None:
        return False
    density, error = field
    y, x = np.indices(bank.shape)
    hold = bank & ((x//7+3*(y//10)) % 7 == 0)
    if (hold.sum() < 125 or error > 3.8 or np.quantile(abs(native[hold]-density[hold]), .9) > 3
            or np.quantile(abs(density[covered]-edited[covered]), .68) < 2.3):
        return False
    detail = (gray-native)/np.maximum(.85, power)
    train = bank & ~hold
    offsets = repeated_screen_offsets(train, detail)
    if len(offsets) < 8:
        return False
    prediction, _, measured = borrow_repeated_dots(train, detail, hold, offsets)
    if measured.mean() < .90:
        return False
    truth, prediction = detail[hold][measured], prediction[measured]
    if min(truth.std(), prediction.std()) < .15 or np.corrcoef(truth, prediction)[0, 1] < .39:
        return False
    target = region & allowed & (distance < 7) & (gap < 38)
    if not target.any():
        return False
    dots, sharp, registered = borrow_repeated_dots(bank, detail, target, offsets)
    if registered.mean() < .90:
        return False
    mass = np.maximum(.0001, gaussian_filter(bank.astype(float), 15))
    contrast = (gaussian_filter(power*bank, 15)/mass)[target]
    gain = np.clip(truth.std()/prediction.std(), .7, 2.4)
    texture = np.clip(.45*gain*dots+.55*sharp, -3.5, 3.5)*contrast
    # Match the measured brightness right up to both banks without transporting
    # unrelated lines or extending a fitted brightness gradient into the canopy.
    delta = np.where(bank, native-density, 0.)
    surface = gaussian_filter(delta, 15)/mass
    stencil = np.array([[0, .25, 0], [.25, 0, .25], [0, .25, 0]])
    for _ in range(330):
        surface = np.where(bank, delta, np.where(gap < 48, convolve(surface, stencil, mode="nearest"), 0.))
    edge = edt(np.pad(region, 1))[1:-1, 1:-1][target]
    alpha = registered*np.clip((edge-.6)/3.5, 0, 1)*np.clip((7-distance[target])/2, 0, 1)
    value = np.clip((density+surface)[target]+texture, 0, 255)
    current = result[target, 1].astype(float)
    result[target, :3] = np.rint(current+alpha*(value-current)).clip(0, 255).astype('u1')[:, None]
    return True


def restore_weathered_impact_screen(gray, decoded, mask, opaque, allowed, distance, result):
    native, edited = (gaussian_filter(image, 2.2) for image in (gray, decoded))
    power = np.sqrt(gaussian_filter((gray-native)**2, 3.1))
    decoded_power = np.sqrt(gaussian_filter((decoded-edited)**2, 3.1))
    level = np.where(distance > 6.5, native, edited)
    plane = (opaque & (level > 153) & (level < 246) & (np.where(distance > 6.5, power, decoded_power) < 11)
             & (maximum_filter(level, 7)-minimum_filter(level, 7) < 12))
    regions, _ = label(plane, np.ones((3, 3)))
    verified = np.zeros_like(mask)
    for index, box in enumerate(find_objects(regions), 1):
        if box is None or not np.any(mask[box] & (regions[box] == index)):
            continue
        region = regions[box] == index
        if restore_weathered_screen_plane(gray[box], native[box], edited[box], power[box],
                                          region, mask[box], allowed[box], distance[box], result[box]):
            verified[box] |= region & allowed[box]
    if not verified.any():
        return False
    grain = run_path(str(Path(__file__).with_name("qwen_print_grain.py")))
    grain["restore_stipple_gradation"](gray, result, opaque, allowed, distance, verified)
    return True


def pale_background_bank(gray, edited, mask, target, distance):
    native = gaussian_filter(gray, 2.1)
    surface = np.where(distance <= 3, gaussian_filter(edited, 2.1), native)
    areas, count = label(surface > 186, np.ones((3, 3)))
    support = np.bincount(areas[mask], minlength=count+1)
    support[0] = 0
    if support.max() < .99*mask.sum():
        return
    # Paper across a dark panel rule or behind a face is a different material.
    clearance = edt(areas == support.argmax())
    valid = (distance > 2.8) & (clearance > 2)
    bank = (distance >= 3.3) & (distance < 42) & (clearance > 3.5)
    bank &= gaussian_filter(valid.astype(float), 3.2) > .64
    if bank.sum() < 730:
        return
    tone = paper_average(gray, valid, 3.2)
    if not 244 <= np.median(tone[bank]) <= 252.5:
        return
    if np.std((gray-gaussian_filter(gray, 1.1))[bank]) < 2.8:
        return
    fitted = pale_paper_field(tone, bank, target)
    if fitted is None:
        return
    field, uncertainty = fitted
    residual = tone-field
    bank &= abs(residual) < min(9, max(4, uncertainty+2))
    nearest = edt(~bank)
    if nearest[target].max() > 33:
        return
    near = bank & (distance > 4)
    adjustment = paper_average(residual, near, 8)
    return field + np.clip(adjustment, -6, 6)*np.exp(-nearest/28), field, bank, native


def restore_pale_caption_tone(source, mask, result, opaque):
    """Remove a verified low-frequency stain while retaining the fine scan texture."""
    y, x = np.where(mask)
    if not 180 <= len(y) <= 3700 or not 12 <= min(np.ptp(x), np.ptp(y)) <= max(np.ptp(x), np.ptp(y)) <= 114:
        return False
    area = np.s_[max(0, y.min()-55):y.max()+56, max(0, x.min()-55):x.max()+56]
    src, written, output = source[area], mask[area], result[area]
    gray, edited = (image[:, :, 1].astype(float) for image in (src, output))
    if np.quantile(np.ptp(src[written], axis=1), .90) > 4 or (gray[written] < 125).sum() < 32:
        return False
    target = written | ((edt(~written) <= 8) & np.any(src != output, axis=2))
    if opaque is not None and not opaque[area].all():
        return False
    distance = edt(~target)
    measured = pale_background_bank(gray, edited, written, target, distance)
    if measured is None:
        return False
    expected, field, bank, native = measured
    delta = gaussian_filter(edited, 2.2)-expected
    inside = edt(target)
    core = inside > 2.9
    rows, cols = np.indices(target.shape)
    held = bank & (distance > 7) & ((rows//8 + 2*(cols//9)) % 5 == 1)
    if core.sum() < 92 or held.sum() < 160:
        return False
    noise = abs(native[held]-field[held])
    limit = max(4.6, np.quantile(noise, .92)+1.5)
    if limit > 7:
        return False
    sizes = np.bincount(label(core & (abs(delta) > limit), np.ones((3, 3)))[0].ravel())
    if len(sizes) < 2 or np.max(sizes[1:]) < max(35, .028*core.sum()):
        return False
    if (delta[core] < -2).mean() < .68:
        return False
    if np.mean(np.minimum(abs(delta[core]), 18)) < max(2.6, 1.45*np.mean(np.minimum(noise, 18))+.4):
        return False
    weight = (1-np.exp(-inside**2/3.5))*np.clip((abs(delta)-1)/3, 0, 1)
    adjustment = np.clip(-delta*weight, -19, 19)
    use = target & (abs(adjustment) > .5)
    output[use] = np.rint(output[use].astype(float) + adjustment[use, None]).clip(0, 255).astype(np.uint8)
    return True


def facing_paper_patches(y, x, offsets, original, guide, edge, bank, grain, native_level):
    """Find two original patches on opposite sides of the type with the same light stock."""
    dy, dx = offsets
    yy, xx = y[:, None] + dy, x[:, None] + dx
    bounded = (yy >= 0) & (xx >= 0) & (yy < len(guide)) & (xx < guide.shape[1])
    yy, xx = np.clip(yy, 0, len(guide)-1), np.clip(xx, 0, guide.shape[1]-1)
    valid = bank[yy, xx] & bounded
    coverage = valid.mean(0)
    shade = guide[y, x, None] - guide[yy, xx]
    boundary = np.minimum(15, abs(edge[y, x, None] - edge[yy, xx]))
    length = np.hypot(dx, dy)
    cost = np.mean(np.minimum(24, abs(shade)) + .3*boundary, axis=0) + .028*length + 100*(1-coverage)
    cost[coverage < .92] = np.inf
    first = np.argmin(cost)
    if cost[first] >= 11:
        return
    opposing = dx*dx[first] + dy*dy[first] < -.25*length*length[first]
    second = np.argmin(np.where(opposing, cost, np.inf))
    if not opposing[second] or cost[second] > 15:
        return
    a, b = (yy[:, first], xx[:, first]), (yy[:, second], xx[:, second])
    if np.mean(abs(native_level[a] - native_level[b])) > 8:
        return
    noise = .5 * (np.median(grain[a]) + np.median(grain[b]))
    usable = valid[:, first] & (abs(shade[:, first]) < 11)
    values = original[a] + np.clip(.42*shade[:, first], -3, 3)
    return values, usable, noise


def restore_light_paper_grain(source, mask, result, aligned, opaque):
    """Replace model-added stipple along lettering with the surrounding scan's own grain."""
    if mask.size > 800_000 or mask.sum() < 150:
        return False
    native, guide, current = (im.mean(2) for im in (source, aligned, result))
    changed = np.any(source != result, axis=2)
    if not changed.any() or np.quantile(np.ptp(source, axis=2)[changed], .9) > 7:
        return False
    distance = edt(~mask)
    pale, native_pale = guide > 163, native > 161
    eligible = opaque & changed & (distance < 13) & pale & (abs(guide-current) < 48)
    if eligible.sum() < 300:
        return False
    # Ignore the dark side of nearby pen lines when measuring the white paper.
    # A black edge next to bare paper otherwise looks like high-contrast grain.
    model_tone = paper_average(guide, pale, 5)
    native_tone = paper_average(native, native_pale, 5)
    def grain(values, light):
        detail = values - paper_average(values, light, 1)
        return np.sqrt(paper_average(detail**2, light, 2.8))
    model_noise, native_noise = grain(guide, pale), grain(native, native_pale)
    bank = ((distance > 3) & native_pale & opaque & (native_tone > 207) & (native > native_tone-31)
            & (abs(guide-native) < 45) & (abs(native_tone-model_tone) < 15))
    edge = np.minimum(32, edt(guide >= 182))
    target = eligible & (model_tone > 215) & (guide > model_tone-50) & (edge >= 1) & (model_noise > 1.65)
    if target.sum() >= 110:
        registered_screened_rays = run_path(str(Path(__file__).with_name("qwen_radial_stock.py")))["registered_screened_rays"]
        rays = registered_screened_rays(source, aligned, mask, opaque)
        if rays is not None:
            target &= ~rays
    rows, cols = np.where(target)
    if len(cols) < 110:
        return False
    angles = np.deg2rad(np.arange(0, 360, 15))
    offsets = np.array([(round(np.sin(t)*r), round(np.cos(t)*r)) for t in angles
                        for r in (12, 20, 28, 36, 45, 56, 70)]).T
    dy, dx = np.indices((19, 19))-9
    window = np.exp(-(dx*dx + dy*dy)/29.)
    strength = np.zeros(mask.shape)
    total = np.zeros(mask.shape)
    for cy in range(max(10, (rows.min()-3)//7*7), min(len(mask)-10, rows.max()+5), 7):
        for cx in range(max(10, (cols.min()-3)//7*7), min(mask.shape[1]-10, cols.max()+5), 7):
            sy, sx = np.where(target[cy-9:cy+10, cx-9:cx+10])
            if len(sx) < 5:
                continue
            y, x = sy+cy-9, sx+cx-9
            sample = facing_paper_patches(y, x, offsets, native, model_tone, edge, bank, native_noise, native_tone)
            if sample is None:
                continue
            values, valid, expected_noise = sample
            if np.median(model_noise[y, x]) < 1.45*expected_noise+1.1:
                continue
            weights = window[sy, sx] * valid
            strength[y, x] += weights
            total[y, x] += weights*values
    used = strength > 0
    if not used.any():
        return False
    weight = np.minimum(1, strength[used]/.28)[:, None]
    tone = (total[used]/strength[used])[:, None]
    result[used] = np.rint(np.clip(result[used]+(tone-result[used])*weight, 0, 255)).astype('u1')
    # At the outer edge of print, a large patch of uniform original gray can
    # already be bare paper. Preserve its exact scan values when the recovered
    # tone agrees and the same patch reaches unprinted stock.
    same = np.max(np.abs(result.astype(float)-source), axis=2) <= 4
    anchor = bank & (distance > 4)
    for corner in ((-3, -3), (-3, 3), (3, -3), (3, 3)):
        high = maximum_filter(native, 7, origin=corner)
        low = minimum_filter(native, 7, origin=corner)
        connected = maximum_filter(anchor, 7, origin=corner)
        keep = used & same & connected & (high-low <= 4)
        result[keep] = source[keep]
    return True


def missing_dot_contrast(observed, prediction, measured, heldout_prediction):
    """Recover the phase-aligned contrast lost relative to the untouched scan."""
    def metrics(signal, estimate):
        gain = np.dot(signal, estimate)/max(.01, np.dot(estimate, estimate))
        spread = np.std(signal)/max(.01, np.std(estimate))
        return gain, spread, np.mean(abs(signal-estimate))

    target, spread, error = metrics(observed, prediction)
    native, reference_spread, heldout_error = metrics(measured, heldout_prediction)
    if target >= .78*native or not .36*reference_spread < spread < .88*reference_spread:
        return 0.
    # Clean regions with particularly predictable phase can have less local
    # contrast than the broader validation bank.
    if (min(np.std(observed), np.std(prediction)) < .1 or
            (np.corrcoef(observed, prediction)[0, 1] >= .945 and error < .75*max(1, heldout_error))):
        return 0.
    return np.clip(native-target, 0, .68)


def local_screen_model(area, coordinates, train, held, design, smooth, native, x, y):
    if train.sum() < 150 or held.sum() < 24:
        return
    yy, xx = coordinates
    distance = (xx[area] - x - 3.5) ** 2 + (yy[area] - y - 3.5) ** 2
    weight = np.exp(-0.6 * distance / 400)
    w = weight[train]
    basis = design[area][train]
    gram = basis.T @ (w[:, None] * basis)
    gram.flat[:: len(gram) + 1] += 0.03
    coeff = np.linalg.solve(gram, basis.T @ (w * native[area][train]))
    if (
        not 195 < coeff[0] < 249
        or np.average(abs(smooth[area][train] - coeff[0]), weights=w) > 6
    ):
        return
    pred = design[area][held] @ coeff
    err = np.average(abs(native[area][held] - pred), weights=weight[held])
    base = np.average(abs(native[area][held] - coeff[0]), weights=weight[held])
    if err <= min(7.5, 0.52 * base):
        return coeff, err


def backed_by_paper_banks(same, xx, yy, x, y):
    nearby_x = abs(xx - x - 3.5) < 16
    nearby_y = abs(yy - y - 3.5) < 16
    sides = [
        np.count_nonzero(same & near & side)
        for near, side in (
            (nearby_y, xx < x - 3),
            (nearby_y, xx > x + 10),
            (nearby_x, yy < y - 3),
            (nearby_x, yy > y + 10),
        )
    ]
    return sum(n > 32 for n in sides) >= 3 and min(sides[:2]) + min(sides[2:]) >= 45


def restore_light_screen(source, mask, result, opaque, frequencies):
    rows, cols = np.where(mask)
    if not 20 <= len(rows) <= 48_000 or np.ptp(cols) > 420 or np.ptp(rows) > 420:
        return False
    area = np.s_[
        max(0, rows.min() - 70) : rows.max() + 71,
        max(0, cols.min() - 70) : cols.max() + 71,
    ]
    src, m, output = source[area], mask[area], result[area]
    native, guide = [z.mean(axis=2) for z in (src, output)]
    dist = edt(~m)
    known = dist > 8
    if np.quantile(np.ptp(src, axis=2), 0.95) > 9:
        return False
    lo = gaussian_filter(native, 1.9)
    hi = native - lo
    smooth = gaussian_filter(lo, 3)
    amp = np.sqrt(gaussian_filter(hi**2, 3))
    bank = (
        known
        & (smooth > 197)
        & (smooth < 249)
        & (minimum_filter(lo, 5) > 179)
        & (amp > 5)
        & (amp < 39)
        & (abs(lo - smooth) < 8)
    )
    if bank.sum() < 350:
        return False
    yy, xx = np.indices(m.shape)
    held = (xx // 7 + 3 * (yy // 7)) % 8 == 2
    sy, sx = np.where(bank & ~held)
    if len(sy) > 13000:
        pick = np.random.default_rng(611).choice(len(sy), 13000, replace=False)
        sy, sx = sy[pick], sx[pick]
    freq = frequencies(
        np.column_stack([sx, sy]), hi[sy, sx] / np.maximum(7, amp[sy, sx]), m.shape
    )
    if len(freq) < 2:
        return False
    phase = 2 * np.pi * (xx[:, :, None] * freq[:, 0] + yy[:, :, None] * freq[:, 1])
    design = np.concatenate(
        [np.ones((*m.shape, 1)), np.cos(phase), np.sin(phase)], axis=2
    ).astype("float32")
    guide_low = gaussian_filter(guide, 2.2)
    target = (
        (m | ((dist <= 4) & np.any(output != src, axis=2)))
        & (edt(gaussian_filter(guide, 1.35) >= 184) >= 2)
        & (gaussian_filter(guide, 2.6) > 195)
    )
    if opaque is not None:
        target &= opaque[area]
    ys, xs = np.where(target)
    if not len(ys):
        return False
    distance_bank = edt(~bank)
    wrote = False
    for y in range(ys.min() // 8 * 8, ys.max() + 1, 8):
        for x in range(xs.min() // 8 * 8, xs.max() + 1, 8):
            tile = np.s_[y : y + 8, x : x + 8]
            if not target[tile].any():
                continue
            local = np.s_[max(0, y - 36) : y + 44, max(0, x - 36) : x + 44]
            train = bank[local] & ~held[local]
            fitted = local_screen_model(
                local,
                (yy, xx),
                train,
                bank[local] & held[local],
                design,
                smooth,
                native,
                x,
                y,
            )
            if fitted is None:
                continue
            coeff, err = fitted
            same = train & (abs(smooth[local] - coeff[0]) < 8)
            if not backed_by_paper_banks(same, xx[local], yy[local], x, y):
                continue
            other = known[local] & (abs(smooth[local] - coeff[0]) > 12)
            sub = np.s_[
                y - local[0].start : y - local[0].start + 8,
                x - local[1].start : x - local[1].start + 8,
            ]
            boundary = np.minimum(24, edt(~other)[sub]) if other.any() else 24
            active = (
                target[tile]
                & (abs(guide_low[tile] - coeff[0]) < 9)
                & (distance_bank[tile] < boundary)
                & (abs(guide[tile] - guide_low[tile]) < 60)
            )
            values = np.rint(design[tile] @ coeff).clip(0, 255)
            if active.sum() < 18 or np.mean(
                abs(guide[tile][active] - values[active])
            ) <= max(6, 1.5 * err + 2):
                continue
            output[tile][active] = values[active, None].astype(np.uint8)
            wrote = True
    return wrote
