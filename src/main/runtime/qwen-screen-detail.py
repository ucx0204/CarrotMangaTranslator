"""Restore native screentone lost in a Qwen decode using the original scan."""
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.fft import irfft2, next_fast_len, rfft2
from scipy.linalg import cho_factor, cho_solve
from scipy.ndimage import distance_transform_edt, find_objects, gaussian_filter, gaussian_filter1d, label
from scipy.optimize import minimize
from scipy.spatial import cKDTree


def masked_average(values, mask, sigma):
    return gaussian_filter(values * mask, sigma) / np.maximum(0.0001, gaussian_filter(mask, sigma))


def ruled_screen_slice(gray, mask):
    if min(gray.shape) < 64 or gray.size > 1_200_000:
        return
    selected = np.count_nonzero(mask)
    labels, _ = label(gray > 80, structure=np.ones((3, 3)))
    for index, box in enumerate(find_objects(labels), start=1):
        y, x = box
        if (min(x.start, y.start) < 1 or x.stop >= gray.shape[1] or y.stop >= gray.shape[0]
                or min(x.stop-x.start, y.stop-y.start) < 60):
            continue
        marked = mask[box]
        if np.count_nonzero(marked) < .93 * selected:
            continue
        interior = labels[box] == index
        if interior.mean() < .32 or np.count_nonzero(interior & marked) < .015 * selected:
            continue
        banks = (gray[y.start-1, x], gray[y.stop, x], gray[y, x.start-1], gray[y, x.stop])
        if all(np.mean(bank < 101) >= .86 for bank in banks):
            return box


def screen_field(values, known):
    weight = known.astype(float)
    result = None
    for sigma in (45, 24, 13, 7, 3):
        mass = gaussian_filter(weight, sigma)
        average = gaussian_filter(values * weight, sigma) / np.maximum(.00001, mass)
        strength = np.clip((mass - .17) / .46, 0, 1)
        result = average if result is None else strength * average + (1 - strength) * result
    return result


def screen_covariance(signal, known):
    shape = tuple(next_fast_len(length * 2) for length in signal.shape)
    def autocorrelation(field):
        spectrum = rfft2(field, s=shape)
        return irfft2(spectrum * spectrum.conj(), s=shape)
    cov = autocorrelation(signal * known) / np.maximum(.1 * known.sum(), autocorrelation(known))
    dy, dx = np.ogrid[:shape[0], :shape[1]]
    dx, dy = np.minimum(dx, shape[1]-dx), np.minimum(dy, shape[0]-dy)
    cov *= np.exp(-(dx*dx + dy*dy) / (2 * 77**2))
    cov /= max(.01, cov[0, 0])
    # Project the empirical autocovariance onto a nonnegative spectrum.
    cov = irfft2(np.maximum(0, rfft2(cov).real), s=shape)
    return cov / max(.01, cov[0, 0])


def predict_screen_pixels(values, known, paint):
    mean = screen_field(values, known)
    scale = np.maximum(2.5, np.sqrt(np.maximum(1, screen_field(
        np.minimum((values - mean)**2, 2800), known))))
    signal = np.clip((values - mean) / scale, -6, 4)
    cov = screen_covariance(signal, known)
    height, width = known.shape
    rows, cols = np.where(paint)
    result = mean.copy()
    for y in range(rows.min()//7*7, rows.max()+1, 7):
        for x in range(cols.min()//7*7, cols.max()+1, 7):
            py, px = np.where(paint[y:y+7, x:x+7])
            if not len(px):
                continue
            py, px = py+y, px+x
            cy, cx = py.mean(), px.mean()
            top, left = max(0, round(cy-47)), max(0, round(cx-47))
            sy, sx = np.where(known[top:min(height, round(cy+47)), left:min(width, round(cx+47))])
            if len(sx) < 20:
                continue
            sy, sx = sy+top, sx+left
            cross = cov[py[:, None]-sy, px[:, None]-sx]
            weight = (np.mean(cross**2, axis=0) + .035) * np.exp(
                -((sy-cy)**2 + (sx-cx)**2) / (2 * 27**2))
            cells = (sy//4) * ((width+3)//4) + sx//4
            order = np.lexsort((-weight, cells))
            first = order[np.r_[True, np.diff(cells[order]) != 0]]
            keep = np.unique(np.r_[np.argsort(-weight)[:135], first[np.argsort(-weight[first])[:175]]])
            ry, rx = sy[keep], sx[keep]
            gram = cov[ry[:, None]-ry, rx[:, None]-rx]
            gram.flat[::len(gram)+1] += .027
            cross = cross[:, keep].T
            coefficients = cho_solve(cho_factor(gram, check_finite=False), cross, check_finite=False)
            uncertainty = np.clip(1 - np.sum(cross * coefficients, axis=0), 0, 1)
            delta = signal[ry, rx] @ coefficients
            result[py, px] += scale[py, px] * delta / np.sqrt(np.maximum(.66, 1 - .55*uncertainty))
    return result, mean


def print_columns(ink):
    occupancy = gaussian_filter(ink.astype(np.float32), (7, 2))
    labels, _ = label(occupancy > .025, structure=np.ones((3, 3)))
    columns = np.zeros_like(ink)
    for index, box in enumerate(find_objects(labels), 1):
        yy, xx = np.nonzero((labels[box] == index) & ink[box])
        if len(xx) < 25 or np.ptp(yy) < max(34, 1.7*np.ptp(xx)):
            continue
        yy, xx = yy+box[0].start, xx+box[1].start
        for y in range(max(0, yy.min()-8), min(len(columns), yy.max()+9)):
            near = xx[abs(yy-y) < 19]
            if len(near) >= 9:
                left, right = np.quantile(near, [.035, .965]).astype(int)
                columns[y, max(0,left-9):min(columns.shape[1],right+10)] = True
    return columns


def match_column_banks(field, known, columns):
    # Register the height of the same pale beam on either side of a printed
    # vertical line. Entirely empty banks and unrelated tones cannot vote.
    height, width = known.shape
    result = field.copy()
    reliability = np.zeros_like(field)
    offsets = np.arange(-16, 17)
    for y in np.flatnonzero(columns.any(axis=1)):
        spans = np.flatnonzero(np.diff(np.r_[False, columns[y], False])).reshape(-1, 2)
        for left, end in spans:
            if end-left < 8 or left < 11 or end > width-12:
                continue
            a, b = slice(left-10, left-2), slice(end+2, end+10)
            rows = np.arange(max(0, y-23), min(height, y+24))
            weight = np.exp(-.5*((rows-y)/12)**2)
            available = weight*(known[rows, a].mean(axis=1) > .65)
            if available.sum() < .55*weight.sum():
                continue
            shifts = (rows[None, :] + offsets[:, None]).clip(0, height-1)
            mass = available*(known[shifts, b].mean(axis=2) > .65)
            lb, rb = field[:, a].mean(axis=1), field[:, b].mean(axis=1)
            errors = np.minimum((lb[rows]-rb[shifts])**2, 81)
            score = np.sum(errors*mass, axis=1)/np.maximum(1, mass.sum(axis=1)) + .021*offsets**2
            score[mass.sum(axis=1) < .52*weight.sum()] = np.inf
            at = np.argmin(score)
            if score[at] > 36:
                continue
            frac = np.arange(1, end-left+1)/(end-left+1)
            dy = offsets[at]
            axis = np.arange(height)
            result[y, left:end] = ((1-frac)*np.interp(y-frac*dy, axis, lb)
                                   + frac*np.interp(y+(1-frac)*dy, axis, rb))
            reliability[y, left:end] = np.clip((38-score[at])/24, 0, 1)
    return result, reliability


def restore_column_density(values, known, ink, fitted, mean):
    columns = print_columns(ink)
    if not columns.any():
        return fitted
    exposed = known & ~columns
    outside = screen_field(values, exposed)
    strength = np.sqrt(np.maximum(1, screen_field(np.minimum((values-outside)**2, 2400), exposed)))
    native = np.sqrt(np.maximum(1, screen_field(np.minimum((values-mean)**2, 2400), known)))
    density, support = match_column_banks(outside, exposed, columns)
    amplitude, matched = match_column_banks(strength, exposed, columns)
    # A genuinely white slit between two separate print textures is retained.
    # Use wide-bank measurements only where the near-type field lost contrast.
    correction = np.maximum(mean-density, amplitude-native)
    gain = support*matched*np.clip(distance_transform_edt(columns)/4, 0, 1)*np.clip(correction/2.5, 0, 1)
    proposal = density+np.clip(amplitude/np.maximum(3.5, native), .55, 1.85)*(fitted-mean)
    return fitted + gain*(proposal-fitted)


def restore_ruled_screen(source, mask, prediction):
    gray = source[:, :, 1]
    box = ruled_screen_slice(gray, mask)
    if box is None:
        return False
    original, selected = gray[box], mask[box]
    if np.percentile(np.ptp(source[box].astype(float), axis=2), 95) > 4:
        return False
    # Preserve native frame and illustration ink even inside a composite window.
    labels, count = label(original < 153, structure=np.ones((3, 3)))
    populations = np.bincount(labels.ravel(), minlength=count+1)
    overlap = np.bincount(labels[selected], minlength=count+1)
    glyphs = (overlap > .61 * populations) & (populations >= 2)
    glyphs[0] = False
    if glyphs.sum() < 4:
        return False
    ink = glyphs[labels]
    if not ink.any():
        return False
    y, x = np.indices(selected.shape)
    edge = np.minimum.reduce((x, y, selected.shape[1]-1-x, selected.shape[0]-1-y))
    foreign = (original < 135) & ~ink
    clear = (distance_transform_edt(~foreign) >= 2.9) if foreign.any() else np.ones_like(selected)
    distance = distance_transform_edt(~ink)
    paper = clear & (edge > 4)
    far = paper & (distance >= 19) & (distance < 27)
    near = paper & (distance >= 2.5) & (distance < 5.5)
    if min(np.count_nonzero(far), np.count_nonzero(near)) < 100:
        return False
    density = np.mean(original[far] < 235)
    if not .018 <= density <= .4 or np.mean(original[near] < 235) > .56 * density:
        return False
    paint = selected & clear & (edge > 2)
    known = (~selected) & clear & (edge > 3) & (distance_transform_edt(~selected) > 2)
    if known.sum() < 650 or paint.sum() < 45 or np.median(original[known]) < 232:
        return False
    # Fit and score different islands of untouched screen. A flat field, a
    # photograph and uncorrelated paper noise cannot supply predictive phase.
    hold = known & (distance < 95) & ((x//8 + 5*(y//9)) % 83 == 11)
    if hold.sum() < 110:
        return False
    values = original.astype(float)
    sample, flat = predict_screen_pixels(values, known & ~hold, hold)
    error = np.abs(sample[hold] - values[hold])
    baseline = np.mean(np.abs(flat[hold] - values[hold]))
    if baseline < 2.2 or np.mean(error) >= .82 * baseline or np.percentile(error, 95) > 24:
        return False
    fitted, mean = predict_screen_pixels(values, known, paint)
    fitted = restore_column_density(values, known, ink, fitted, mean)
    prediction[box][paint] = np.rint(np.clip(fitted[paint, None], 0, 255)).astype(np.uint8)
    return True


def screen_frequencies(points, residual, shape):
    size = 1 << int(np.ceil(np.log2(max(256, *shape))))
    fy, fx = np.meshgrid(np.fft.fftfreq(size), np.fft.rfftfreq(size), indexing="ij")
    magnitude = np.hypot(fx, fy)
    available = (magnitude > 0.12) & (magnitude < 0.68)
    frequencies, basis = [], []
    error = residual.copy()
    extent = np.maximum(50, np.ptp(points, axis=0))
    for _ in range(7):
        grid = np.zeros(shape)
        grid[points[:, 1], points[:, 0]] = error
        spectrum = np.abs(np.fft.rfft2(grid, s=(size, size), axes=(0, 1)))
        spectrum[~available] = 0
        row, col = np.unravel_index(np.argmax(spectrum), spectrum.shape)
        if spectrum[row, col] < 0.038 * np.abs(error).sum():
            break
        peak = np.array([fx[row, col], fy[row, col]])

        def alignment(offset):
            phase = points @ (peak + offset / extent)
            return -abs(error @ np.exp(2j * np.pi * phase))

        fit = minimize(alignment, [0., 0.], method="Nelder-Mead", options={
            "initial_simplex": np.array([[0., 0.], [.1, 0.], [0., .1]]),
            "xatol": .006, "maxiter": 35,
        })
        frequency = peak + fit.x / extent
        frequencies.append(frequency)
        phase = 2 * np.pi * points @ frequency
        basis.extend((np.cos(phase), np.sin(phase)))
        design = np.stack(basis, axis=1)
        error = residual - design @ np.linalg.lstsq(design, residual, rcond=None)[0]
        available &= (fx - frequency[0]) ** 2 + (fy - frequency[1]) ** 2 > .012 ** 2
    return np.asarray(frequencies)


def estimate_patch(design, high, train, hold, weight, x, y, center):
    train_weight, hold_weight = weight[train], weight[hold]
    if train_weight.sum() < 16 or hold_weight.sum() < 3 or hold_weight.max() < .09:
        return None
    samples = design[train]
    gram = samples.T @ (train_weight[:, None] * samples)
    gram.flat[::len(gram) + 1] += max(.04, .006 * train_weight.sum())
    coefficients = np.linalg.solve(gram, samples.T @ (train_weight * high[train]))
    predicted, native = design[hold] @ coefficients, high[hold]
    power = np.sum(hold_weight * native ** 2)
    correlation = np.sum(hold_weight * native * predicted) / np.sqrt(
        max(1, power * np.sum(hold_weight * predicted ** 2)))
    error = np.sum(hold_weight * abs(native - predicted)) / max(1, np.sum(hold_weight * abs(native)))
    cx, cy = center
    bank = train * weight
    support = max(min(bank[x <= cx - 3].sum(), bank[x >= cx + 3].sum()),
                  min(bank[y <= cy - 3].sum(), bank[y >= cy + 3].sum()))
    if support < 5:
        return None
    gain = (np.clip((correlation - .48) / .33, 0, 1) * np.clip((.82 - error) / .32, 0, 1)
            * np.clip((np.sqrt(power / hold_weight.sum()) - 5) / 12, 0, 1) * min(1, support / 22))
    return coefficients, gain


def screen_features(rows, cols, tone, axes):
    coordinates = np.column_stack((cols, rows))
    phase = (2 * np.pi * coordinates) @ axes.T
    return np.column_stack((np.sin(phase), np.cos(phase), coordinates / 122, tone / 26))


def screen_neighbors(tree, points, count):
    distance, indices = tree.query(points, k=count)
    weights = 1 / (.035 + distance) ** 2
    return indices, weights / weights.sum(axis=1, keepdims=True), distance


def density_screen_detail(source, mask, prediction, distance, hold, frequencies):
    # Printed dot screens have two perpendicular axes with a common period.
    # A row of ruled lines or two unrelated peaks cannot establish this lattice.
    if len(frequencies) < 2:
        return None
    axes = frequencies[:2]
    periods = np.linalg.norm(axes, axis=1)
    if abs(axes[0] @ axes[1]) > .12 * periods.prod() or min(periods) < .88 * max(periods):
        return None
    known = distance > 5
    bank = (distance > 9) & (distance < 88)
    rows, cols = np.where(bank & ~hold)
    hy, hx = np.where(bank & hold)
    if len(rows) < 700 or len(hy) < 210:
        return None
    rng = np.random.default_rng(417)
    if len(rows) > 48_000:
        keep = rng.choice(len(rows), 48_000, replace=False)
        rows, cols = rows[keep], cols[keep]
    if len(hy) > 12_000:
        keep = rng.choice(len(hy), 12_000, replace=False)
        hy, hx = hy[keep], hx[keep]
    level = masked_average(source, known.astype(np.float32), 2.15)
    texture = source[rows, cols] - level[rows, cols]
    tree = cKDTree(screen_features(rows, cols, level[rows, cols], axes))
    # Estimate the withheld blocks' optical density from outside those blocks.
    # Qualify this reconstruction against the ink actually observed in them.
    hold_level = masked_average(source, (known & ~hold).astype(np.float32), 3.5)[hy, hx]
    observed = source[hy, hx] - hold_level
    tests = screen_features(hy, hx, hold_level, axes)
    indices, weights, _ = screen_neighbors(tree, tests, 13)
    error = abs(observed - np.sum(weights * texture[indices], axis=1))
    baseline = abs(observed)
    if baseline.mean() < 3 or error.mean() > .5 * baseline.mean():
        return None
    validation = cKDTree(tests)
    model_level = gaussian_filter(prediction, 2.15)
    y, x = np.where(mask)
    detail = np.zeros(mask.shape, dtype=np.float32)
    for start in range(0, len(y), 8192):
        yy, xx = y[start:start+8192], x[start:start+8192]
        density = model_level[yy, xx]
        points = screen_features(yy, xx, density, axes)
        index, weight, separation = screen_neighbors(tree, points, 13)
        target = np.sum(weight * texture[index], axis=1)
        check, support, _ = screen_neighbors(validation, points, 24)
        loss = np.sum(support * error[check], axis=1)
        power = np.sum(support * baseline[check], axis=1)
        confidence = np.clip(1.25 * (1 - loss / np.maximum(.01, power)), 0, 1)
        confidence *= np.clip((2.4 - separation[:, 4]) / 1.6, 0, 1)
        detail[yy, xx] = confidence * (target - (prediction[yy, xx] - density))
    return detail


def native_detail(source, mask, prediction):
    y, x = np.indices(mask.shape)
    distance = distance_transform_edt(~mask)
    bank = ((distance > 3.2) & (distance < 52)).astype(np.float32)
    mean = masked_average(source, bank, 2.2)
    high = source - mean
    amplitude = np.sqrt(masked_average(high ** 2, bank, 3.))
    valid = bank.astype(bool) & (amplitude > 5.5)
    if valid.sum() < 130:
        return None
    # Reserve entire islands of the unedited scan for cross-validation of both
    # the measured frequency and each local phase/contrast prediction.
    hold = (x // 6 + 3 * (y // 6)) % 7 == 2
    train, test = valid & ~hold, valid & hold
    sy, sx = np.where(train)
    if len(sx) > 13500:
        keep = np.random.default_rng(417).choice(len(sx), 13500, replace=False)
        sy, sx = sy[keep], sx[keep]
    frequencies = screen_frequencies(np.column_stack((sx, sy)), high[sy, sx] / np.maximum(8, amplitude[sy, sx]), mask.shape)
    if not len(frequencies):
        return None
    density = density_screen_detail(source, mask, prediction, distance, hold, frequencies)
    if density is not None:
        return density
    phase = 2 * np.pi * (x[:, :, None] * frequencies[:, 0] + y[:, :, None] * frequencies[:, 1])
    design = np.concatenate((np.cos(phase), np.sin(phase)), axis=2).astype(np.float32)
    base = gaussian_filter(prediction, 1.65)
    depth = distance_transform_edt(mask)
    detail, confidence = np.zeros_like(source), np.zeros_like(source)
    rows, cols = np.where(mask)
    for top in range(rows.min() // 6 * 6, rows.max() + 1, 6):
        for left in range(cols.min() // 6 * 6, cols.max() + 1, 6):
            tile = np.s_[top:top + 6, left:left + 6]
            active = mask[tile]
            if not active.any():
                continue
            sigma = np.clip(8 + .82 * np.median(depth[tile][active]), 8, 22)
            radius = int(2.5 * sigma)
            near = np.s_[max(0, top-radius):top+6+radius, max(0, left-radius):left+6+radius]
            observed, withheld = train[near], test[near]
            if observed.sum() < 3 * design.shape[2] or withheld.sum() < 15:
                continue
            cx, cy = left + 2.5, top + 2.5
            spatial = ((x[near] - cx) ** 2 + (y[near] - cy) ** 2) / sigma ** 2
            tonal = ((np.median(base[tile][active]) - mean[near]) / 25) ** 2
            result = estimate_patch(design[near], high[near], observed, withheld,
                                    np.exp(-.5 * (spatial + tonal)), x[near], y[near], (cx, cy))
            if result is None:
                continue
            coefficients, gain = result
            if gain <= .02:
                continue
            target = design[tile] @ coefficients
            present = prediction[tile] - base[tile]
            agreement = np.minimum(1, abs(present) / (10 + abs(target))) * np.clip(present * target / 150, 0, 1)
            detail[tile] = target - present
            confidence[tile] = gain * (1 - .65 * agreement)
    strength = np.minimum(gaussian_filter(confidence, .85), confidence + .03)
    if (strength[mask] > .22).mean() < .55 or strength[mask].mean() < .30:
        return None
    return detail * strength


def measured_shade_rows(sample, positions, left, right):
    # Printed gradients may end at a white highlight. Initialize from the
    # median on each side so that highlight cannot tilt the entire estimate.
    side = left | right
    lx, rx = np.median(positions[left]), np.median(positions[right])
    lv, rv = np.median(sample[:, left], axis=1), np.median(sample[:, right], axis=1)
    expected = lv[:, None] + (rv-lv)[:, None] * (positions-lx) / (rx-lx)
    keep = side & (abs(sample-expected) < 5)
    for _ in range(4):
        mass = np.maximum(1, keep.sum(axis=1))
        sx = (keep * positions).sum(axis=1)
        sy = (keep * sample).sum(axis=1)
        sxx = (keep * positions**2).sum(axis=1)
        sxy = (keep * sample * positions).sum(axis=1)
        slope = (mass*sxy-sx*sy) / np.maximum(.001, mass*sxx-sx*sx)
        level = (sy-slope*sx) / mass
        error = abs(sample-level[:, None]-slope[:, None]*positions)
        # Rows without any agreeing samples cannot bracket an edit.
        enough = keep.any(axis=1)
        cutoff = np.full(len(level), 2.6)
        cutoff[enough] = np.clip(2.7*np.nanmedian(
            np.where(keep[enough], error[enough], np.nan), axis=1), 2.6, 14)
        keep = side & (error < cutoff[:, None])
    usable = np.minimum(keep[:, left].sum(axis=1), keep[:, right].sum(axis=1)) >= 6
    if usable.sum() < 28:
        return None
    usable &= abs(slope-np.median(slope[usable])) <= 8
    if usable.sum() < 28 or usable.mean() < .75 or usable[9:-9].mean() < .88:
        return None
    index = np.arange(len(level))
    level = gaussian_filter1d(np.interp(index, index[usable], level[usable]), 1.4)
    slope = gaussian_filter1d(np.interp(index, index[usable], slope[usable]), 2)
    expected = level[:, None] + slope[:, None] * positions
    gradient = np.diff(level)
    if (np.ptp(np.quantile(level, [.05, .95])) < 13 or np.quantile(abs(slope), .95) > 9
            or max(np.mean(gradient >= -.18), np.mean(gradient <= .18)) < .9
            or np.mean(abs(sample-expected)[keep] <= 3) < .94):
        return None
    return expected


def restore_shaded_balloon(source, mask, prediction, rows, cols):
    left, right = cols.min(), cols.max()+1
    top, bottom = rows.min(), rows.max()+1
    width, height = right-left, bottom-top
    if (len(cols) < 65 or height < 25 or width > min(185, 1.4*height)
            or left < 23 or right+23 >= mask.shape[1] or top < 10 or bottom+10 >= mask.shape[0]):
        return False
    area = np.s_[top-9:bottom+9, left-21:right+21]
    x = np.arange(left-21, right+21)
    rgb = source[area]
    if np.mean(np.ptp(rgb, axis=2) <= 2) < .997:
        return False
    gray = rgb.mean(axis=2)
    expected = measured_shade_rows(gray, (x-(left+right-1)/2)/width, x < left-6, x >= right+6)
    if expected is None:
        return False
    selected = mask[area]
    distance = distance_transform_edt(~selected)
    witness = (distance > 8.3) & (distance < 14) & (x >= left-6) & (x < right+6)
    if witness.sum() < 55 or np.mean(abs(gray[witness]-expected[witness]) <= 4) < .96:
        return False
    contours, _ = label(abs(gray-expected) > 9, structure=np.ones((3, 3)))
    crossing = np.intersect1d(contours[distance > 12], contours[distance < 6])
    if np.any(crossing != 0):
        return False
    decoded = prediction[area].mean(axis=2)
    if np.quantile(abs(decoded-expected)[selected], .8) > 19:
        # A Qwen decode can reproduce the ink and white outline while
        # correctly reconstructing their underlying, slowly changing shade.
        # Compare that scale only when both untouched banks agree closely.
        smooth = gaussian_filter(decoded, 6)
        if (witness.sum() < 120 or np.mean(abs(gray[witness]-expected[witness]) <= 4) < .995
                or np.quantile(abs(decoded[witness]-expected[witness]), .95) > 5
                or np.quantile(abs(smooth-expected)[selected], .8) > 11
                or np.quantile(abs(smooth-expected)[selected], .95) > 16):
            return False
    write = distance <= 8.3
    prediction[area][write] = np.uint8(np.rint(np.clip(expected[write, None], 0, 255)))
    return True


def restore_margin_print(source, mask, prediction, rows, cols):
    """Keep the scan's paper and adjacent panel rule around small baseline print."""
    top, bottom, left, right = rows.min(), rows.max()+1, cols.min(), cols.max()+1
    if bottom-top > 32 or right-left > 85 or right-left < 8 or len(rows) < 30:
        return False
    height, width = mask.shape
    ys = slice(max(0, top-36), min(height, bottom+36))
    xs = slice(max(0, left-28), min(width, right+28))
    rgb = source[ys, xs]
    gray = rgb.mean(axis=2)
    local = mask[ys, xs]
    labels, _ = label(gray < 177, structure=np.ones((3, 3)))
    digits, rules = [], []
    for idx, box in enumerate(find_objects(labels), 1):
        y, x = box
        h, w = y.stop-y.start, x.stop-x.start
        ink = labels[box] == idx
        if min(h, w) >= 3 and 5 <= h <= 26 and w <= 1.05*h and ink.mean() >= .25:
            if np.mean(local[box][ink]) >= .85:
                digits.append((idx, y, x))
        elif y.start == 0 and y.stop == gray.shape[0]:
            # Record the vertical columns that actually carry the rule.
            column = np.mean(ink, axis=0)
            rules.extend((np.where(column >= .96)[0] + x.start).tolist())
    if not rules or not 2 <= len(digits) <= 4:
        return False
    digits.sort(key=lambda d: d[2].start)
    digit_height = np.median([y.stop-y.start for _, y, _ in digits])
    if (np.ptp([y.stop for _, y, _ in digits]) > .2*digit_height
            or np.ptp([y.start for _, y, _ in digits]) > .25*digit_height
            or any(not 0 <= b[2].start-a[2].stop <= .8*digit_height for a, b in zip(digits,digits[1:]))):
        return False
    first, last = digits[0][2].start, digits[-1][2].stop-1
    if min(min(abs(u-first), abs(u-last)) for u in rules) > 1.1*digit_height:
        return False
    glyph = np.isin(labels, [i for i, _, _ in digits])
    distance = distance_transform_edt(~glyph)
    other = distance_transform_edt(~((labels != 0) & ~glyph))
    bank = (distance > 3.3) & (distance <= 15) & (other > 3.3)
    if bank.sum() < 90 or np.quantile(rgb[bank].min(axis=1), .04) < 250:
        return False
    decoded = prediction[ys, xs]
    if np.quantile(decoded[glyph].min(axis=1), .07) < 237:
        return False
    # Whiten only the ink and antialias shoulder. The untouched original
    # takes precedence where the panel border enters the rectangular selection.
    # The panel can drift by a pixel from one row to the next. Its faint
    # JPEG fringe persists above and below the digits even when the local
    # dark rule temporarily recedes. Keep these independently visible columns.
    outside_rows = (np.arange(gray.shape[0]) < min(y.start for _, y, _ in digits)-4) | (
        np.arange(gray.shape[0]) >= max(y.stop for _, y, _ in digits)+4)
    column = np.arange(gray.shape[1])
    near_rule = np.min(np.abs(column[:, None]-np.asarray(rules)), axis=1) <= 3.5
    shoulder = (np.median(gray[outside_rows], axis=0) < 254.5) if outside_rows.sum() >= 12 else False
    panel_fringe = ((column < first) | (column > last)) & near_rule & shoulder
    write = glyph | ((distance <= 4.3) & (distance < other) & (other > 2.45) & ~panel_fringe)
    prediction[:] = source
    decoded[write] = np.median(rgb[bank], axis=0).round().astype(np.uint8)
    return True


def restore(source, mask, prediction, framed_only=False, speech=False, white_banks=None, opaque=None,
            hatching=None, neutral_stock=None, crossed_screen=None, gradual_screen=None):
    if source.shape != prediction.shape or source.shape[:2] != mask.shape:
        raise ValueError("Native Qwen source, print mask and output must share a pixel grid")
    rows, cols = np.where(mask)
    if not len(cols):
        return False
    if not speech and not framed_only and restore_margin_print(source, mask, prediction, rows, cols):
        return True
    if speech and restore_shaded_balloon(source, mask, prediction, rows, cols):
        return True
    if (not speech and not framed_only and crossed_screen is not None
            and crossed_screen(source, mask, prediction, opaque, screen_frequencies)):
        return True
    if restore_ruled_screen(source, mask, prediction):
        return True
    if framed_only:
        return False
    if not speech and gradual_screen is not None and gradual_screen(source, mask, prediction, opaque, screen_frequencies):
        return True
    height, width = mask.shape
    area = np.s_[max(0, rows.min()-54):min(height, rows.max()+55),
                 max(0, cols.min()-54):min(width, cols.max()+55)]
    local = mask[area]
    # Bound CPU memory for an unusually wide spread. The Qwen crop is already complete.
    if local.size > 800_000 or max(local.shape) > 2048:
        return False
    luma = np.array([.299, .587, .114])
    detail = native_detail((source[area] @ luma).astype(np.float32), local,
                           (prediction[area] @ luma).astype(np.float32))
    if detail is not None:
        # A native contour that was copied from the scan has precedence over a fitted screen.
        write = local & np.any(source[area] != prediction[area], axis=2)
        rgb = prediction[area][write].astype(np.float32)
        prediction[area][write] = np.rint(np.clip(rgb + detail[write, None], 0, 255)).astype(np.uint8)
    paper = not speech and white_banks is not None and white_banks(source, mask, prediction, opaque)
    ink = not speech and hatching is not None and hatching(source, mask, prediction, opaque)
    neutral = not speech and neutral_stock is not None and neutral_stock(source, mask, prediction, opaque)
    return bool(neutral or ink or paper or detail is not None)


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from qwen_paper_banks import match_ruled_paper, restore_interrupted_rules, restore_native_white
    from qwen_hatching import restore_hatching
    from qwen_light_screen import restore_light_screen, restore_pale_caption_tone
    from qwen_neutral_stock import restore_neutral_stock
    from qwen_crossed_screen import (restore_balloon_screens, restore_crossed_screen,
                                     restore_gradual_screen, restore_residual_print_dots)

    source_path, mask_path, result_path, destination = sys.argv[1:5]
    with Image.open(source_path) as image:
        source_pixels = np.array(image.convert("RGB"))
    with Image.open(mask_path) as image:
        stencil = np.array(image.convert("L")) > 127
    with Image.open(result_path) as image:
        result_pixels = np.array(image.convert("RGB"))
        alpha = image.getchannel("A") if "A" in image.getbands() else None
        if alpha is not None:
            stencil &= np.asarray(alpha) == 255
    speech = "--speech" in sys.argv[5:] and (alpha is None or np.asarray(alpha).min() == 255)
    opaque = np.asarray(alpha) == 255 if alpha is not None else None
    framed_only = "--framed-only" in sys.argv[5:]
    applied = restore(source_pixels, stencil, result_pixels, framed_only, speech,
                      restore_native_white, opaque, restore_hatching, restore_neutral_stock,
                      restore_crossed_screen, restore_gradual_screen)
    if speech and not framed_only:
        applied = restore_balloon_screens(source_pixels, stencil, result_pixels, opaque, screen_frequencies) or applied
    if not speech and not framed_only:
        applied = restore_light_screen(source_pixels, stencil, result_pixels, opaque, screen_frequencies) or applied
        applied = restore_pale_caption_tone(source_pixels, stencil, result_pixels, opaque) or applied
        from qwen_fading_highlight import restore_fading_highlight
        applied = restore_fading_highlight(source_pixels, stencil, result_pixels, opaque) or applied
    if not speech:
        applied = restore_interrupted_rules(source_pixels, stencil, result_pixels, opaque) or applied
        from qwen_sound_contours import preserve_sound_banks
        applied = preserve_sound_banks(source_pixels, stencil, result_pixels, opaque) or applied
    if not framed_only:
        from runpy import run_path
        from qwen_screen_edge import restore_column_screen_edge
        applied = restore_column_screen_edge(source_pixels, stencil, result_pixels, opaque) or applied
        contours = run_path(str(Path(__file__).with_name("qwen-reconnect-balloon.py")))
        applied = contours["restore_printed_balloon_arc"](source_pixels, stencil, result_pixels, opaque) or applied
        if not speech:
            applied = restore_residual_print_dots(source_pixels, stencil, result_pixels, opaque, screen_frequencies) or applied
        if speech:
            from qwen_typeset_stock import restore_typeset_stock
            applied = restore_typeset_stock(source_pixels, stencil, result_pixels) or applied
            applied = match_ruled_paper(source_pixels, stencil, result_pixels, opaque) or applied
    if not framed_only and not speech:
        from qwen_transparent_caption import restore_transparent_caption
        applied = restore_transparent_caption(source_pixels, stencil, result_pixels, opaque) or applied
        from qwen_radial_stock import restore_pale_stripes
        applied = restore_pale_stripes(source_pixels, stencil, result_pixels, opaque) or applied
        from qwen_typeset_stock import restore_unenclosed_readings_and_pen
        applied = restore_unenclosed_readings_and_pen(source_pixels, stencil, result_pixels, opaque) or applied
        from qwen_paper_banks import restore_hollow_print_stock
        applied = restore_hollow_print_stock(source_pixels, stencil, result_pixels, opaque) or applied
    if not framed_only:
        from qwen_typeset_stock import restore_reversed_type_stock, restore_shaded_type_imprint
        applied = restore_reversed_type_stock(source_pixels, stencil, result_pixels, opaque) or applied
        applied = restore_shaded_type_imprint(source_pixels, stencil, result_pixels, opaque) or applied
        from qwen_caption_grain import restore_caption_grain
        applied = restore_caption_grain(source_pixels, stencil, result_pixels, opaque) or applied
    if not speech:
        from qwen_light_screen import restore_clouded_caption
        applied = restore_clouded_caption(source_pixels, stencil, result_pixels, opaque, screen_frequencies) or applied
        if not framed_only:
            from qwen_caption_contour import restore_open_caption_edge
            applied = restore_open_caption_edge(source_pixels, stencil, result_pixels, opaque) or applied
    if applied:
        restored = Image.fromarray(result_pixels)
        if alpha is not None:
            restored.putalpha(alpha)
        restored.save(destination)
        print("applied")
    else:
        print("unchanged")
