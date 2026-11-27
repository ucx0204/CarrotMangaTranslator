"""Restore scanned checks underneath outlined type, retaining the edited folds."""
import numpy as np
from scipy.ndimage import (distance_transform_edt, gaussian_filter, grey_closing,
                           map_coordinates, maximum_filter)

from qwen_crossed_screen import local_dot_prediction


def stripe_slopes(low, bank, near):
    rows, cols = np.where(bank & near)
    rows, cols = rows[::3], cols[::3]
    tiles = (cols//16+rows//20) % 2
    relief = np.clip(low-gaussian_filter(low, 7), -16, 31)
    result = []
    for vertical in (False, True):
        best = (0., 0.)
        for slope in (-.24, -.12, -.055, 0., .055, .12, .24):
            values, peers, groups = [], [], []
            for shift in (-31, -22, 21, 32):
                x = cols+shift*(slope if vertical else 1)
                y = rows+shift*(1 if vertical else slope)
                valid = map_coordinates(bank.astype("u1"), [y, x], order=0, mode="constant") > 0
                values.extend(relief[rows[valid], cols[valid]])
                peers.extend(map_coordinates(relief, [y[valid], x[valid]], order=1))
                groups.extend(tiles[valid])
            observed, prediction, group = map(np.asarray, (values, peers, groups))
            scores = []
            for half in (0, 1):
                one, two = observed[group == half], prediction[group == half]
                if len(one) < 160 or min(one.std(), two.std()) < 2:
                    break
                scores.append(np.corrcoef(one, two)[0, 1])
            if len(scores) == 2 and min(scores) > best[0]:
                best = min(scores), slope
        result.append(best)
    correlations, slopes = zip(*result)
    if min(correlations) > .12 and max(correlations) > .32:
        return slopes


def woven_density(low, valid, slopes, rank, iterations):
    y, x = np.indices(low.shape)
    cy, cx = (np.array(low.shape)-1)/2
    dy, dx = slopes
    points = [y+dy*(x-cx), x+dx*(y-cy)]
    cloth = map_coordinates(low, points, order=1, mode="nearest")
    visible = map_coordinates(valid.astype(float), points, order=1) > .88
    current = np.full(low.shape, np.median(cloth[visible]))
    known = visible
    # In cloth coordinates the illumination of crossing translucent yarns
    # varies slowly. Exclude the surviving pen from the fit after convergence.
    for step in range(iterations):
        if step in (13, 20):
            known = visible & (cloth-current > -16) & (cloth-current < 22)
        filled = np.where(known, cloth, current)
        mean = filled.mean()
        left, spectrum, right = np.linalg.svd(filled-mean, full_matrices=False)
        amplitude = np.maximum(0, spectrum[:rank]-max(12, 33-step*.8))
        current = (left[:, :rank]*amplitude)@right[:rank]+mean
    scale = 1-dx*dy
    return map_coordinates(current, [(y-cy-dy*(x-cx))/scale+cy,
                                     (x-cx-dx*(y-cy))/scale+cx], order=1, mode="nearest")


def adjacent_scan_detail(gray, low, density, bank, mask, axes):
    """Choose an actual sample whose pixel phase and surrounding scan agree."""
    height, width = mask.shape
    offsets = []
    for dy in range(-88, 89):
        dx = np.arange(-88, 89)
        radius = np.hypot(dx, dy)
        phase = (dx[:, None]*axes[:, 0]+dy*axes[:, 1]+.5) % 1-.5
        error = (phase[:, :2]**2).sum(1)+.12*(phase[:, 2:]**2).sum(1)
        for i in np.flatnonzero((radius >= 6) & (radius < 89) & (error < .012)):
            offsets.append((error[i]+.00004*radius[i], dy, int(dx[i])))
    high = gray-low
    best = np.full(gray.shape, np.inf)
    sample = np.zeros(gray.shape)
    for _, dy, dx in sorted(offsets)[:220]:
        other = np.roll(bank, (dy, dx), (0, 1))
        other[:max(0, dy)] = other[max(0, height+dy):] = False
        other[:, :max(0, dx)] = other[:, max(0, width+dx):] = False
        common = bank & other
        mass = gaussian_filter(common.astype(float), 12)
        donor = np.roll(high, (dy, dx), (0, 1))
        error = gaussian_filter(np.minimum(2500, (high-donor)**2)*common, 12)
        drift = abs(density-np.roll(low, (dy, dx), (0, 1)))
        cost = (np.sqrt(error/np.maximum(.004, mass))+.22*drift+.027*np.hypot(dx, dy)
                +2.4/np.maximum(.06, np.sqrt(mass)))
        choose = mask & other & (mass > .012) & (cost < best)
        best[choose], sample[choose] = cost[choose], donor[choose]
    missing = mask & ~np.isfinite(best)
    if missing.sum() > .1*mask.sum():
        return
    if missing.any():
        by, bx = np.where(bank)
        y, x = np.where(missing)
        sample[missing] = local_dot_prediction(np.column_stack((bx, by)), high[bank], axes, x, y)
    return sample


def retained_folds(edited):
    y, x = np.indices(edited.shape)
    soft = gaussian_filter(edited, .85)
    background = gaussian_filter(grey_closing(soft, size=(13, 13)), 1.5)
    depth = background-soft
    strength = np.zeros_like(soft)
    for angle in np.arange(0, np.pi, np.pi/36):
        dx, dy = np.cos(angle), np.sin(angle)
        def exposure(steps, offset):
            return np.mean([map_coordinates(depth, [y+t*dy+offset*dx, x+t*dx-offset*dy],
                                            order=1, mode="nearest") for t in steps], axis=0)
        core = exposure(range(-6, 7, 2), 0)
        left = exposure((-4, 0, 4), -3.5)
        right = exposure((-4, 0, 4), 3.5)
        contrast = core-.56*np.minimum(left, right)-.44*np.maximum(left, right)
        strength = np.maximum(strength, contrast)
    weight = np.clip((maximum_filter(strength, size=5)-11)/19, 0, 1)*np.clip((depth-4)/14, 0, 1)
    return np.maximum(0, background-edited)*weight


def restore_woven_screen(source, mask, output, opaque, frequencies):
    sy, sx = np.where(mask)
    if not (1700 <= len(sx) <= 38000 and 36 <= np.ptp(sx) <= 260 and 55 <= np.ptp(sy) <= 350):
        return False
    area = np.s_[max(0, sy.min()-37):sy.max()+38, max(0, sx.min()-37):sx.max()+38]
    source, mask, output = source[area], mask[area], output[area]
    if not opaque[area].all() or (np.ptp(source, axis=2) > 10).mean() > .02:
        return False
    gray = source.mean(2)
    low = gaussian_filter(gray, 1.3)
    clear = distance_transform_edt(~mask)
    near = (clear > 4) & (clear < 29)
    mid = (low > 112) & (low < 238)
    bank = mid & (clear > 3.6) & (abs(low-gaussian_filter(low, 2)) < 15)
    if ((gray[mask] < 100).mean() < .064 or (gray[mask] > 236).mean() < .27 or
            (near & mid).sum() < .64*near.sum() or (near & bank).sum() < 850):
        return False
    detail = gray-low
    if not 9 < np.median(abs(detail[near & bank])) or detail[near & bank].std() > 43:
        return False
    slopes = stripe_slopes(low, bank, near)
    if slopes is None:
        return False
    by, bx = np.where(bank & (clear < 40))
    axes = np.array(frequencies(np.column_stack((bx, by)), detail[by, bx], gray.shape)[:4])
    if len(axes) < 2 or abs(np.linalg.det(axes[:2])) < .055:
        return False
    hold = (bx//7+3*(by//6)) % 4 == 1
    points = np.column_stack((bx, by))
    expected = detail[by, bx]
    predicted = local_dot_prediction(points[~hold], expected[~hold], axes, bx[hold], by[hold])
    if np.corrcoef(expected[hold], predicted)[0, 1] < .7:
        return False
    y, x = np.indices(mask.shape)
    held = bank & ((x//9+2*(y//8)) % 7 == 2) & (clear < 28)
    fits = []
    for dy in (slopes[0]-.05, slopes[0]):
        for dx in (slopes[1]-.04, slopes[1]+.035):
            candidate = woven_density(low, bank & ~held, (dy, dx), 4, 14)
            error = abs(candidate[held]-low[held])
            fits.append((np.median(error)+.5*np.minimum(20, error).mean(), dy, dx))
    _, dy, dx = min(fits)
    validation = woven_density(low, bank & ~held, (dy, dx), 6, 35)
    if (np.median(abs(validation[held]-low[held])) >= 7 or
            abs(validation[held]-low[held]).mean() > .82*abs(low[held]-np.median(low[held])).mean()):
        return False
    density = woven_density(low, bank, (dy, dx), 6, 35)
    fine = adjacent_scan_detail(gray, low, density, bank, mask, axes)
    if fine is None:
        return False
    restored = density+fine-retained_folds(output.mean(2))
    output[mask] = np.rint(restored[mask, None]).clip(0, 255).astype("u1")
    return True
