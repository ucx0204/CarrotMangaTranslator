"""Restore fine, irregular print grain on both sides of small erased lettering."""

import numpy as np
from scipy.ndimage import distance_transform_edt, gaussian_filter


def density(values):
    return np.quantile(values, [.025, .10, .5, .88])


def translated_patch(y, x, dy, dx, bank):
    sy, sx = y[:, None]+dy, x[:, None]+dx
    rows, cols = sy.clip(0, bank.shape[0]-1), sx.clip(0, bank.shape[1]-1)
    return rows, cols, (sy == rows) & (sx == cols) & bank[rows, cols]


def matching_stipple_patch(center, points, bank, light, broad, grain, mottle, decoded, offsets):
    """Match an original patch by the tone and grain on its independently visible border."""
    cy, cx = center
    y, x = points
    dy, dx = offsets
    ry, rx, fits = translated_patch(y, x, dy, dx, bank)
    coverage = fits.mean(0)
    keep = coverage > .85
    if keep.sum() < 3:
        return
    dy, dx, coverage = dy[keep], dx[keep], coverage[keep]
    ry, rx, fits = ry[:, keep], rx[:, keep], fits[:, keep]
    gy, gx = np.mgrid[-48:49:4, -48:49:4]
    gy, gx = gy.ravel()+cy, gx.ravel()+cx
    valid = (gy >= 0) & (gy < bank.shape[0]) & (gx >= 0) & (gx < bank.shape[1])
    gy, gx = gy[valid], gx[valid]
    visible = bank[gy, gx]
    gy, gx = gy[visible], gx[visible]
    if len(gx) < 40:
        return
    sy, sx, pairs = translated_patch(gy, gx, dy, dx, bank)
    radius = np.hypot(gy-cy, gx-cx)
    window = np.exp(-.5*(radius/32)**2)
    weight = pairs*window[:, None]
    mass = weight.sum(0)
    def average(values):
        return (weight*values).sum(0)/np.maximum(.01, mass)
    delta = broad[gy, gx, None]-broad[sy, sx]
    shift = average(delta).clip(-14, 14)
    fine = light-broad
    cost = (average(np.minimum(16, abs(delta-shift)))+.7*average(abs(grain[gy, gx, None]-grain[sy, sx]))
            +.75*average(abs(mottle[gy, gx, None]-mottle[sy, sx]))
            +.15*average(np.minimum(14, abs(fine[gy, gx, None]-fine[sy, sx])))
            +.08*abs(shift)+.015*np.hypot(dy, dx)+.22*np.maximum(0, average(radius[:, None])-30)
            +22*(1-coverage)+.15*np.maximum(0, abs((broad[ry, rx]+shift).mean(0)-decoded[y, x].mean())-6))
    cost[mass < max(12, .25*window.sum())] = np.inf
    index = np.argmin(cost)
    if cost[index] > 7.5:
        return
    use = fits[:, index]
    return (y[use], x[use]), (ry[use, index], rx[use, index]), shift[index]


def restore_stipple_gradation(gray, result, opaque, allowed, distance, verified):
    """Continue a registered light screen where it grades into nonperiodic printed stipple."""
    bank = (distance > 6.5) & opaque
    clearance = distance_transform_edt(~(bank & (gaussian_filter(gray, 1.05) < 142)))
    bank &= (clearance > 4) & (gray > 148)
    def average(values, mask, scale):
        return gaussian_filter(values*mask, scale)/np.maximum(.0001, gaussian_filter(mask.astype(float), scale))
    light, broad = (average(gray, bank, scale) for scale in (4, 9))
    grain = np.sqrt(average((gray-light)**2, bank, 4))
    mottle = np.sqrt(average((light-broad)**2, bank, 6))
    bank &= (distance > 7.2) & (distance < 130) & (clearance > 5) & (broad > 198)
    model = result[:, :, 1].astype(float)
    smooth = gaussian_filter(model, 4)
    decoded_grain = np.sqrt(gaussian_filter((model-smooth)**2, 4))
    pen = distance_transform_edt(gaussian_filter(model, 1.25) > 154)
    target = (allowed & (distance < 6.6) & (pen > 5) & (smooth > 196)
              & (distance_transform_edt(~bank) < 64) & (distance_transform_edt(~verified) < 95))
    textured = bank & (grain > 5.5) & (mottle > 1)
    if textured.sum() < 300 or not target.any():
        return False
    target &= distance_transform_edt(~textured) < 66
    y, x = np.where(target)
    if len(x) < 85:
        return False
    angles = np.linspace(0, 2*np.pi, 30, endpoint=False)
    radii = np.arange(12, 99, 8)[:, None]
    offsets = tuple(np.rint(radii*f(angles)).astype(int).ravel() for f in (np.sin, np.cos))
    mass, paper, micro, coarse = np.zeros((4, *gray.shape))
    for cy in range(max(12, y.min()//10*10), min(len(gray)-12, y.max()+10), 10):
        for cx in range(max(12, x.min()//10*10), min(gray.shape[1]-12, x.max()+10), 10):
            yy, xx = np.where(target[cy-11:cy+12, cx-11:cx+12])
            if len(xx) < 12:
                continue
            patch = matching_stipple_patch((cy, cx), (yy+cy-11, xx+cx-11), bank, light,
                                          broad, grain, mottle, smooth, offsets)
            if patch is None:
                continue
            pos, ref, shift = patch
            expected = grain[ref].mean()
            if expected <= 4.5 or (expected < 1.14*decoded_grain[pos].mean() and mottle[ref].mean() < 1.6):
                continue
            weight = (np.maximum(.04, 1-abs(pos[0]-cy)/12)*np.maximum(.04, 1-abs(pos[1]-cx)/12))**1.4
            paper[pos] += (gray[ref]+shift)*weight
            micro[pos] += grain[ref]*weight
            coarse[pos] += mottle[ref]*weight
            mass[pos] += weight
    use = (mass > .045) & target
    if not use.any():
        return False
    norm = np.maximum(.0001, mass)
    value = np.where(use, paper/norm, model)
    fine, wide = (average(value, use, scale) for scale in (3.4, 8.5))
    # Overlapping tiles damp both stipple and the wider texture of the printed
    # wash. Restore their separately measured amplitudes only on the same paper.
    for band, energy, strength in ((value-fine, micro/norm, 1), (fine-wide, coarse/norm, .85)):
        sampled = np.sqrt(average(band**2, use, 5))
        gain = np.clip(energy/np.maximum(.25, sampled), .85, 2.4)
        value += strength*(gain-1)*band
    alpha = np.minimum(1, mass[use]/.4)*np.clip((pen[use]-4)/5, 0, 1)*np.clip((7-distance[use])/2, 0, 1)
    result[use, :3] = np.rint(model[use]+alpha*(value[use]-model[use])).clip(0, 255).astype('u1')[:, None]
    return True


def irregular_detail(gray, bank):
    detail = gray - gaussian_filter(gray, 1.65)
    y, x = np.where(bank)
    step = max(1, len(x) // 1500)
    y, x = y[::step], x[::step]
    # Periodic dots and screen rulings must retain their original phase.
    for dy in range(-6, 7):
        for dx in range(7):
            if dx*dx + dy*dy < 8:
                continue
            ey, ex = y + dy, x + dx
            safe = (ey >= 0) & (ex >= 0) & (ey < len(gray)) & (ex < gray.shape[1])
            safe[safe] &= bank[ey[safe], ex[safe]]
            if safe.sum() < 110:
                return
            a, b = detail[y[safe], x[safe]], detail[ey[safe], ex[safe]]
            power = max(.1, np.sqrt(np.mean(a*a) * np.mean(b*b)))
            if np.mean(a*b) > .36 * power:
                return
    return detail


def matching_density(gray, bank, y, x):
    by, bx = np.where(bank)
    native = gray[by, bx]
    if len(native) < 380 or native.min() < 100 or not 224 <= native.mean() <= 248:
        return
    if not 7 <= native.std() <= 33:
        return
    reference = density(native)
    for upper in (True, False):
        for left in (True, False):
            quarter = ((by < y.mean()) == upper) & ((bx < x.mean()) == left)
            if quarter.sum() < 95 or np.max(abs(density(native[quarter]) - reference)) > 15:
                return
    return reference


def original_patch(source, opaque, gray, distance, detail, target, reference, contrast):
    py, px = np.where(target)
    by, bx = np.where((distance > 4.25) & (distance <= 6.5))
    if not len(by):
        return
    positions = np.concatenate([np.column_stack((py, px)), np.column_stack((by, bx))])
    lower, upper = -positions.min(axis=0), np.asarray(gray.shape) - positions.max(axis=0)
    candidates = []
    for radius in (23, 32, 43, 57, 74, 93):
        for angle in np.linspace(0, 2*np.pi, 24, endpoint=False):
            dy, dx = np.rint(radius * np.array([np.sin(angle), np.cos(angle)])).astype(int)
            if not (lower[0] <= dy < upper[0] and lower[1] <= dx < upper[1]):
                continue
            sy, sx = py + dy, px + dx
            if distance[sy, sx].min() < 7 or not opaque[sy, sx].all():
                continue
            values = gray[sy, sx]
            if values.min() < 100 or np.ptp(source[sy, sx], axis=1).max() > 4:
                continue
            difference = abs(density(values) - reference)
            if difference.max() > 10 or abs(np.quantile(detail[sy, sx], .025) + contrast) > 9:
                continue
            seam = np.minimum(48, abs(gray[by+dy, bx+dx] - gray[by, bx]))
            candidates.append((difference.mean() + .22*seam.mean() + .008*radius, dy, dx))
    if len(candidates) < 3:
        return
    _, dy, dx = min(candidates)
    if any(oy*dy + ox*dx < -.35*np.hypot(oy, ox)*np.hypot(dy, dx) for _, oy, ox in candidates):
        return dy, dx


def restore_stipple(source, mask, result, opaque):
    if not 200 <= mask.sum() <= 4800:
        return False
    y, x = np.where(mask)
    if max(np.ptp(y), np.ptp(x)) > 144:
        return False
    distance = distance_transform_edt(~mask)
    bank = (distance > 7) & (distance < 23)
    target = distance <= 4.25
    if not opaque[target | bank].all() or np.ptp(source[target | bank], axis=1).max() > 4:
        return False
    gray, out = source[:, :, 1].astype(float), result[:, :, 1].astype(float)
    reference = matching_density(gray, bank, y, x)
    if reference is None or out[mask].min() < reference[0] - 24:
        return False
    if abs(out[mask].mean() - gray[bank].mean()) > 7:
        return False
    detail = irregular_detail(gray, bank)
    if detail is None:
        return False
    contrast = abs(np.quantile(detail[bank], .025))
    model_detail = (out - gaussian_filter(out, 1.65))[mask]
    if contrast < 17 or abs(np.quantile(model_detail, .025)) > .77*contrast:
        return False
    shift = original_patch(source, opaque, gray, distance, detail, target, reference, contrast)
    if shift is None:
        return False
    # Preserve original scan pixels outside the model's actual edit. Inside,
    # take a contiguous patch so the shape of each printed dot stays intact.
    py, px = np.where(mask | (target & np.any(source != result, axis=2)))
    result[py, px] = source[py+shift[0], px+shift[1]]
    outside = (distance > 4.25) & (distance < 12) & (gray > 112) & opaque
    result[outside] = source[outside]
    return True
