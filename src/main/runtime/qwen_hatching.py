"""Continue a narrow band of ink hatching between two visible printed contours."""
import numpy as np
from scipy.ndimage import (distance_transform_edt, find_objects, gaussian_filter,
                           gaussian_filter1d, label, map_coordinates, sobel, uniform_filter)


def vertical_strokes(gray):
    horizontal = uniform_filter(abs(sobel(gray, axis=1)) / 8, (7, 11))
    vertical = uniform_filter(abs(sobel(gray, axis=0)) / 8, (7, 11))
    mean = uniform_filter(gray, (7, 11))
    deviation = np.sqrt(np.maximum(0, uniform_filter(gray ** 2, (7, 11)) - mean ** 2))
    smooth = gaussian_filter1d(gray, .55, axis=1)
    falling = smooth < np.roll(smooth, 1, axis=1)
    peaks = falling & ~np.roll(falling, 1, axis=1)
    cycles = uniform_filter(peaks.astype(np.float32), (5, 19)) * 19
    return ((mean >= 103) & (mean <= 229) & (horizontal > 4) & (vertical < .77 * horizontal)
            & (deviation >= 7) & (deviation <= 78) & (cycles >= 2.5) & (cycles <= 7))


def trace_contour(gray, extent, columns):
    offsets = np.arange(-17, 18)
    search = offsets[:, None] + extent
    slope = np.gradient(gaussian_filter1d(extent, 3))
    cost = .6 * abs(offsets[:, None]) + np.zeros_like(search)
    for dx in range(-5, 6):
        coords = [search + dx * slope, np.broadcast_to(columns + dx, search.shape)]
        cost += map_coordinates(gray, coords, order=1, mode="nearest") / 11
    distance = abs(offsets[:, None] - offsets)
    penalty = 6 * distance + 12 * np.maximum(0, distance - 2)
    path = np.zeros(cost.shape, np.int32)
    best = cost[:, 0]
    for x in range(1, len(columns)):
        moves = best[:, None] + penalty
        path[:, x] = moves.argmin(0)
        best = cost[:, x] + moves.min(0)
    pos = best.argmin()
    result = extent.copy()
    for x in range(len(columns)-1, -1, -1):
        result[x] += offsets[pos]
        pos = path[pos, x]
    return gaussian_filter1d(result, .8)


def printed_contours(source, mask, columns, top, bottom):
    offsets = np.arange(-3, 4)[:, None]
    xs = np.broadcast_to(columns, (7, len(columns)))
    center = .5 * (top + bottom) + offsets
    center_clear = (map_coordinates(mask, [center, xs], order=0) == 0).all(0)
    center_tone = np.median(map_coordinates(source, [center, xs], order=1), axis=0)
    for contour in (top, bottom):
        points = [contour + offsets, xs]
        known = center_clear & (map_coordinates(mask, points, order=0) == 0).all(0)
        ink = map_coordinates(source, points, order=1).min(0)
        if known.sum() < 30 or ((ink < 105) & (center_tone-ink > 49))[known].mean() < .64:
            return False
    return True


def bands(source, mask, result):
    original = vertical_strokes(source) & (distance_transform_edt(~mask) > 3)
    active = gaussian_filter(vertical_strokes(result).astype(np.float32), 1.2) > .47
    parts, _ = label(active, np.ones((3, 3)))
    for index, box in enumerate(find_objects(parts), 1):
        ys, xs = box
        height, width = ys.stop-ys.start, xs.stop-xs.start
        if width < 70 or height < 18 or height > width*3:
            continue
        band = parts[box] == index
        if (band & original[box]).sum() < 200 or (band & mask[box]).sum() < 80:
            continue
        first = band.argmax(0)
        last = height-1-band[::-1].argmax(0)
        thick = 1 + last-first
        valid = band.any(0) & (thick >= 8)
        if valid.sum() < 50 or np.median(thick[valid]) > 100:
            continue
        columns = np.arange(xs.start, xs.stop)
        def boundary(values):
            return gaussian_filter1d(np.interp(columns, columns[valid], values[valid]), 1.7) + ys.start
        top, bottom = boundary(first), boundary(last)
        if max(np.quantile(abs(np.diff(line)), .95) for line in (top, bottom)) > 3:
            continue
        top, bottom = (trace_contour(result, line, columns) for line in (top, bottom))
        if (bottom-top).min() > 13.6 and printed_contours(source, mask, columns, top, bottom):
            yield columns, top+2.6, bottom-2.


def measured_density(stock, known):
    mass = gaussian_filter(known, (4., 5.))
    mean = gaussian_filter(stock*known, (4., 5.)) / np.maximum(.002, mass)
    domain = np.arange(stock.shape[1])
    base = np.empty_like(mean)
    for row in range(len(mean)):
        visible = mass[row] > .74
        if visible.sum() < 22:
            return None
        base[row] = np.interp(domain, domain[visible], mean[row, visible])
    return base


def donor_columns(stock, proposal, visible, occupied):
    width = stock.shape[1]
    columns = np.arange(width)
    pool = columns[(~occupied[3:-3]).mean(0) > .98]
    pool = pool[(pool > 2) & (pool < width-3)]
    if len(pool) < 40:
        return None
    native = gaussian_filter(stock, (1.5, .38))[3:-3]
    guide = gaussian_filter(proposal, (2., .55))[3:-3]
    weight = gaussian_filter(visible.astype(np.float32), (1., .5))[3:-3] ** 2
    cost = np.empty((width, len(pool)), np.float32)
    for x in columns:
        native_error = np.minimum(60, abs(native[:, pool]-native[:, x, None]))
        confidence = weight[:, x].sum()
        observed = (native_error * weight[:, x, None]).sum(0) / max(confidence, 2)
        guide_error = np.minimum(45, abs(native[:, pool]-guide[:, x, None])).mean(0)
        cost[x] = .58*guide_error + .85*min(1, confidence/14)*observed + .045*np.minimum(75, abs(pool-x))
    shifts = []
    for step, bias in ((1, 0), (0, 9), (2, 9)):
        previous = np.searchsorted(pool, pool-step).clip(0, len(pool)-1)
        shifts.append((previous, np.where(pool[previous] == pool-step, bias, 1e4)))
    best = cost[0].copy()
    route = np.zeros(cost.shape, np.int32)
    states = np.arange(len(pool))
    for x in columns[1:]:
        cheapest = best.argmin()
        choices = [best[previous]+bias for previous, bias in shifts]
        choices.append(np.full(len(pool), best[cheapest]+27))
        paths = [previous for previous, _ in shifts] + [np.full(len(pool), cheapest)]
        choose = np.argmin(choices, axis=0)
        route[x] = np.stack(paths)[choose, states]
        best = cost[x] + np.stack(choices)[choose, states]
    idx = best.argmin()
    picked = np.empty(width, np.int32)
    for x in columns[::-1]:
        picked[x] = pool[idx]
        idx = route[x, idx]
    return picked


def restore_band(source, mask, pixels, allowed, columns, top, bottom):
    height = len(source)
    depth = np.linspace(0, 1, 48)[:, None]
    ys = top + depth*(bottom-top)
    view = [ys, np.broadcast_to(columns, ys.shape)]
    def sample(image, order=1):
        return map_coordinates(image, view, order=order, mode="nearest")
    stock = sample(source)
    result = pixels.mean(2).astype(np.float32)
    guide = sample(result)
    occupied = sample(allowed, 0)
    known = (~occupied).astype(np.float32)
    base = measured_density(stock, known)
    if base is None:
        return False
    low, high = np.quantile(stock[~occupied], [.01, .99])
    ink = ((source < max(32, low-6)) | (source > min(248, high+4))) & mask
    clearance = distance_transform_edt(~ink)
    surviving = (sample(clearance) >= 2.8) & (abs(stock-base) < 100)
    visible = (~occupied) | surviving
    picked = donor_columns(stock, guide, visible, occupied)
    if picked is None:
        return False
    known_mass = gaussian_filter(visible.astype(np.float32), (6., .25))
    remainder = gaussian_filter((stock-base)*visible, (6., .25)) / np.maximum(.001, known_mass)
    interpolation = np.clip((known_mass-.12)/.52, 0, 1)
    texture = interpolation*remainder + (1-interpolation)*(stock-gaussian_filter(stock,(3,3)))[:,picked]
    guide_high = guide-gaussian_filter1d(guide, 2.1, axis=1)
    native_high = stock-gaussian_filter1d(stock, 2.1, axis=1)
    strength = measured_density(native_high**2, known)
    contrast = np.sqrt(gaussian_filter(guide_high**2,(3.,4.))/np.maximum(9, strength))
    mix = .45*np.clip((contrast-.11)/.27,0,1)
    restored = base + (1-mix)*texture + mix*guide_high*np.clip(1/np.maximum(.12,contrast),.85,3.5)
    y = np.arange(height)[:, None]
    t = (y-top)*47/(bottom-top)
    local = [t, np.broadcast_to(np.arange(len(columns)), t.shape)]
    target = map_coordinates(restored, local, order=1, mode="nearest")
    estimated = map_coordinates(base, local, order=1, mode="nearest")
    native = source[:, columns]
    keep = np.clip((clearance[:, columns]-2)/2, 0, 1) * (clearance[:, columns]>3.5) * (abs(native-estimated)<90)
    target = keep*native + (1-keep)*target
    write = allowed[:, columns] & (t >= 0) & (t <= 47)
    feather = np.clip(np.minimum(y-top+1, bottom-y+1)/2., 0, 1) * write
    delta = feather * (target-result[:, columns])
    if not np.any(abs(delta) > .5):
        return False
    pixels[:, columns] = np.rint(np.clip(pixels[:,columns]+delta[:,:,None], 0, 255)).astype(np.uint8)
    return True


def restore_hatching(source, mask, pixels, opaque=None):
    rows, cols = np.where(mask)
    if len(rows) < 80:
        return False
    area = (slice(max(0, rows.min()-130), rows.max()+131), slice(max(0, cols.min()-145), cols.max()+146))
    private = mask[area]
    if private.size > 700_000 or min(private.shape) < 45:
        return False
    original, crop = source[area], pixels[area]
    if np.quantile(np.ptp(original[private], axis=1), .95) > 6:
        return False
    # Retain all native pixels outside both the stencil and its existing composite shoulder.
    allowed = private | ((distance_transform_edt(~private) <= 8) & np.any(original != crop, axis=2))
    if opaque is not None:
        allowed &= opaque[area]
    gray = original.mean(2).astype(np.float32)
    decoded = crop.mean(2).astype(np.float32)
    applied = False
    for columns, top, bottom in bands(gray, private, decoded):
        applied |= restore_band(gray, private, crop, allowed, columns, top, bottom)
    return applied

def display_print_mask(gray, stencil):
    """Identify two rows of opaque display type and their measured white keyline."""
    labels, _ = label(stencil, np.ones((3, 3)))
    mass = np.bincount(labels.ravel())
    total = stencil.sum()
    parts = [box for i, box in enumerate(find_objects(labels), 1) if mass[i] > .025 * total]
    if not 5 <= len(parts) <= 24:
        return
    rows = np.zeros(gray.shape[0], bool)
    for ys, _ in parts:
        rows[ys] = True
    lines = find_objects(label(rows)[0])
    if len(lines) != 2 or min(line[0].stop - line[0].start for line in lines) < 75:
        return
    distance = distance_transform_edt(~stencil)
    rim = gray[(distance > 3) & (distance <= 8)]
    bank = gray[(distance > 16) & (distance <= 28)]
    if (rim >= 245).mean() < .78 or (bank < 180).mean() < (rim < 180).mean() + .10:
        return
    selected = stencil.copy()
    top, bottom = lines[0][0].start, lines[-1][0].stop
    selected[:max(0, top - 65)] = False
    selected[bottom + 35:] = False
    if stencil.sum() - selected.sum() > .002 * stencil.sum():
        return
    # Restore a clipped small reading only when a substantial part of its
    # connected stroke is already in the selection.
    dark, _ = label(gray < 175, np.ones((3, 3)))
    for index, box in enumerate(find_objects(dark), 1):
        if max(axis.stop - axis.start for axis in box) > 65:
            continue
        stroke = dark[box] == index
        if (selected[box] & stroke).sum() >= max(3, .12 * stroke.sum()):
            selected[box] |= stroke
    distance = distance_transform_edt(~selected)
    drawing, _ = label((gray < 160) & (distance > 3), np.ones((3, 3)))
    counts = np.bincount(drawing.ravel())
    outside = np.unique(drawing[distance > 27])
    retained = outside[(outside > 0) & (counts[outside] > 70)]
    edge = distance_transform_edt(~np.isin(drawing, retained))
    return (distance <= 21) & ((edge > 2.5) | selected)


def display_donors(gray, hole):
    """Exclude object contours, thick ink, smooth grey plates and text from the donor bank."""
    from scipy.ndimage import maximum_filter, minimum_filter
    source = gray.astype(np.float32)
    distance = distance_transform_edt(~hole)
    dense = (uniform_filter(source, 13) < 125) | (uniform_filter((gray < 95).astype('f'), 19) > .46)
    high = maximum_filter(gray, 5)
    flat = (high.astype(np.int16) - minimum_filter(gray, 5) < 22) & (high < 224)
    strokes, count = label(gray < 155, np.ones((3, 3)))
    contours = np.zeros(count + 1, bool)
    for index, box in enumerate(find_objects(strokes), 1):
        sizes = [axis.stop - axis.start for axis in box]
        contours[index] = max(sizes) > 35 or min(sizes) > 18
    forbidden = ((distance < 5) | (distance_transform_edt(gray < 125) > 2.25)
                 | dense | flat | contours[strokes])
    clearance = distance_transform_edt(~maximum_filter(forbidden, 13))
    half = 23
    y, x = np.where(clearance[half:-half:6, half:-half:6] > half + 2)
    y, x = y * 6 + half, x * 6 + half
    if len(x) < 220:
        return
    means = uniform_filter(source, 47)[y, x]
    # Blank paper alone is insufficient evidence for an illustrated background.
    if np.sum((means < 236) & (means > 165)) < 90:
        return
    known = (distance > 5) & ~maximum_filter(dense, 9)
    tone = None
    for sigma in (110, 56, 30, 16):
        support = gaussian_filter(known.astype('f'), sigma)
        local = gaussian_filter(source * known, sigma) / np.maximum(.00002, support)
        if tone is None:
            if np.min(support[hole]) < .0001:
                return
            tone = local
        else:
            tone += np.clip((support - .08) / .35, 0, 1) * (local - tone)
    return y, x, means, tone


def quilt_display_paper(gray, hole, donors):
    """Match neighboring scan fragments in tone and overlap without repeating a single motif."""
    donor_y, donor_x, means, tone = donors
    rng = np.random.default_rng(7)
    half = 23
    axis = np.arange(-half, half + 1)
    xx, yy = np.meshgrid(axis, axis)
    rim = np.clip((half + .5 - np.maximum(abs(xx), abs(yy))) / 6, 0, 1).astype('f')
    weight = np.clip((1.12 - np.hypot(xx, yy) / (half + 1)) * 3, 0, 1) * rim
    patches = np.lib.stride_tricks.sliding_window_view(gray, (47, 47))
    result = gray.astype('f')
    confidence = np.zeros_like(result)
    usage = np.zeros(len(means), dtype='f')
    height, width = gray.shape
    centers = [(y, x) for y in range(half, height - half, 22) for x in range(half, width - half, 22)]
    for cell in rng.permutation(len(centers)):
        y, x = centers[cell]
        y = np.clip(y + rng.integers(-5, 6), half, height - half - 1)
        x = np.clip(x + rng.integers(-5, 6), half, width - half - 1)
        box = np.s_[y-half:y+half+1, x-half:x+half+1]
        local = hole[box]
        if not local.any():
            continue
        ys, xs = np.nonzero(local)
        cy, cx = y - half + int(ys.mean()), x - half + int(xs.mean())
        cost = (1.02 * abs(means - tone[cy, cx]) + np.minimum(8, .014 * np.hypot(donor_x-cx, donor_y-cy))
                + rng.uniform(0, 18, len(means)) + usage)
        candidates = np.argsort(cost)[:55]
        overlap = np.where(local, confidence[box], 1) * rim
        if overlap.sum() > 8:
            sample = patches[donor_y[candidates]-half, donor_x[candidates]-half, ::2, ::2]
            error = np.minimum(abs(sample - result[box][None, ::2, ::2]), 140)
            cost[candidates] += .9 * (error * overlap[None, ::2, ::2]).sum((1, 2)) / max(1, overlap[::2, ::2].sum())
        chosen = rng.choice(candidates[np.argsort(cost[candidates])[:4]])
        yp, xp = donor_y[chosen], donor_x[chosen]
        usage += 33 * np.exp(-((donor_x-xp)**2 + (donor_y-yp)**2) / (2 * 34**2))
        usage *= .992
        alpha = np.clip((weight - confidence[box] + .18) / .36, 0, 1)
        alpha[confidence[box] == 0] = 1
        result[box] += alpha * local * (patches[yp-half, xp-half] - result[box])
        confidence[box] = np.maximum(confidence[box], weight * local)
    if np.any(hole & (confidence == 0)):
        return
    return np.rint(np.clip(result, 0, 255)).astype('u1')


def restore_display_hatching(rgb, stencil):
    if stencil.size > 1_450_000 or stencil.sum() < 115_000 or not np.all(rgb == rgb[:, :, :1]):
        return
    gray = rgb[:, :, 0]
    levels = np.bincount(gray[stencil], minlength=256)
    # Two distinct mid-grey inks, a dense black plate and a paper shoulder.
    peaks = np.flatnonzero(levels[25:171] > .045 * stencil.sum()) + 25
    if not len(peaks) or np.ptp(peaks) < 15 or levels[:12].sum() < .35 * stencil.sum():
        return
    hole = display_print_mask(gray, stencil)
    if hole is None:
        return
    donors = display_donors(gray, hole)
    if donors is not None:
        print_plane = quilt_display_paper(gray, hole, donors)
        if print_plane is not None:
            return np.repeat(print_plane[:, :, None], 3, axis=2)
