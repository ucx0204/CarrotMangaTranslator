"""Locate screened speed lines whose angular pattern survives the Qwen edit."""
import numpy as np
from scipy.ndimage import (distance_transform_edt, find_objects, gaussian_filter, gaussian_filter1d,
                           label, map_coordinates, minimum_filter)


def screened_edges(scan, guide, distance, opaque):
    gy, gx = np.gradient(scan)
    hy, hx = np.gradient(guide)
    xx, yy, xy = (gaussian_filter(value, 3) for value in (gx*gx, gy*gy, gx*gy))
    energy = xx+yy
    angle = .5*np.arctan2(2*xy, xx-yy)
    row, col = np.indices(scan.shape)
    known = ((row % 3 == 1) & (col % 3 == 1) & (distance > 8) & (distance < 83)
             & (scan > 151) & (scan < 248) & (minimum_filter(scan, 9) > 142)
             & (energy > 2.8) & (np.hypot(xx-yy, 2*xy) > .89*energy)
             & (abs(scan-guide) < 18) & opaque
             & (abs(gx*hx+gy*hy) > .88*np.hypot(gx, gy)*np.hypot(hx, hy)))
    y, x = np.where(known)
    return np.column_stack((x, y)), np.column_stack((np.cos(angle[known]), np.sin(angle[known])))


def fit_focus(points, normals):
    offsets = np.sum(normals*points, axis=1)

    def inliers(focus):
        radius = np.linalg.norm(points-focus, axis=1)
        return (radius > 50) & (abs(normals@focus-offsets) < .041*radius)

    best = np.zeros(len(points), bool)
    # Sample deterministically and refine with all corroborating tangents.
    for pair in np.random.default_rng(1279).integers(0, len(points), size=(180, 2)):
        sample = normals[pair]
        if abs(np.linalg.det(sample)) < .4:
            continue
        supported = inliers(np.linalg.solve(sample, offsets[pair]))
        if supported.sum() > best.sum():
            best = supported
    if best.sum() < 175:
        return
    for _ in range(3):
        center = np.linalg.lstsq(normals[best], offsets[best], rcond=None)[0]
        best = inliers(center)
        if best.sum() < 175:
            return
    return center, points[best]


def angular_profile(indices, selected, tone):
    count = np.bincount(indices[selected], minlength=80)
    known = count >= 2
    if known.sum() < 18:
        return
    values = np.bincount(indices[selected], weights=tone[selected], minlength=80)/count.clip(1)
    series = np.interp(np.arange(80), np.where(known)[0], values[known])
    return series-gaussian_filter1d(series, 3.5), known


def agrees_across_ink(scan, model, mask, distance, radius, angle, start):
    offset = (angle-start+180) % 360-180
    wedge = (abs(offset-4) < 10) & (radius > 55) & (model > 120)
    paper = wedge & (distance > 6) & (scan > 110)
    covered = wedge & mask
    if min(paper.sum(), covered.sum()) < 65:
        return False
    cells = np.rint((offset+12)/.35).astype(int).clip(0, 79)
    first = np.arange(len(mask))[:, None] % 4 < 2
    profiles = (angular_profile(cells, paper & first, scan),
                angular_profile(cells, paper & ~first, scan),
                angular_profile(cells, covered, model))
    if any(profile is None for profile in profiles):
        return False
    shared = np.logical_and.reduce([known for _, known in profiles])
    if shared.sum() < 17:
        return False
    a, b, predicted = (profile[shared] for profile, _ in profiles)
    if min(np.std(a), np.std(b), np.std(predicted)) < 2.4:
        return False
    return min(np.corrcoef(a, predicted)[0, 1], np.corrcoef(b, predicted)[0, 1]) > .52


def registered_screened_rays(source, aligned, mask, opaque):
    rows, cols = np.where(mask)
    if len(cols) < 900:
        return
    box = np.s_[max(0, rows.min()-85):rows.max()+86, max(0, cols.min()-85):cols.max()+86]
    selected = mask[box]
    distance = distance_transform_edt(~selected)
    scan, model = (gaussian_filter(im[box].mean(2).astype("f"), 1.85) for im in (source, aligned))
    points, normals = screened_edges(scan, model, distance, opaque[box])
    if len(points) < 175:
        return
    fit = fit_focus(points, normals)
    if fit is None:
        return
    focus, support = fit
    dx, dy = (support-focus).T
    sectors = (np.rad2deg(np.arctan2(dy, dx)) % 360 // 8).astype(int)
    populated = np.flatnonzero(np.bincount(sectors, minlength=45) >= 15)
    if len(populated) < 6:
        return
    y, x = np.indices(selected.shape)
    dx, dy = x-focus[0], y-focus[1]
    radius, angle = np.hypot(dx, dy), np.rad2deg(np.arctan2(dy, dx)) % 360
    matches = [8*b for b in populated if agrees_across_ink(scan, model, selected, distance, radius, angle, 8*b)]
    if len(matches) < 4:
        return
    # Keep the model's continuation only through angular sectors where the
    # separate exposed scan samples register with what Qwen drew under the type.
    protected = np.zeros_like(mask)
    for start in matches:
        protected[box] |= (abs((angle-start-4+180) % 360-180) < 16) & (radius > 35)
    return protected


def dark_strokes(tone, selected):
    labels, _ = label(tone < 139, np.ones((3, 3)))
    ink = np.zeros_like(selected)
    count = 0
    for number, box in enumerate(find_objects(labels), 1):
        if box is None or max(tone[box].shape) > 160:
            continue
        part = labels[box] == number
        if not 12 <= part.sum() <= 2700 or selected[box][part].mean() < .70:
            continue
        if np.quantile(tone[box][part], .65) > 78:
            continue
        ink[box] |= part
        count += 1
    if 4 <= count <= 25 and (ink & selected).sum() >= .985 * ((tone < 139) & selected).sum():
        return ink


def stripe_direction(tone, exposed):
    gy, gx = np.gradient(gaussian_filter(tone, 1.1))
    xx, xy, yy = (gaussian_filter(np.where(exposed, v, 0), 8.5) for v in (gx*gx, gx*gy, gy*gy))
    return (.5*np.arctan2(2*xy, xx-yy) + np.pi/2,
            np.hypot(xx-yy, 2*xy)/np.maximum(.025, xx+yy))


def read_stripe(samples, y, x):
    return map_coordinates(samples, (y, x), order=1, mode="nearest")


def find_stripe_bank(clearance, y, x, dy, dx):
    reach = np.full(len(x), np.nan)
    for step in np.arange(1, 51, 1.35):
        remaining = np.flatnonzero(~np.isfinite(reach))
        sy, sx = y[remaining]+step*dy[remaining], x[remaining]+step*dx[remaining]
        good = ((sy > 2) & (sx > 2) & (sy < clearance.shape[0]-3) & (sx < clearance.shape[1]-3)
                & (read_stripe(clearance, sy, sx) > 1.6))
        reach[remaining[good]] = step
    return reach


def across_pale_strokes(tone, available, target, angle):
    # Tangents vary across a fan. Compare the stripe profiles on both exposed
    # sides before using their native tones to continue the line under ink.
    y, x = np.where(target)
    clearance = distance_transform_edt(available)
    smooth = gaussian_filter(tone, .7)
    best = np.full(len(x), np.inf)
    closest, total, mass = (np.zeros(len(x)) for _ in range(3))
    for degrees in (0, -3, 3, -6, 6, -9, 9, -12, 12, -16, 16, -20, 20):
        direction = angle[y, x]+np.deg2rad(degrees)
        dy, dx = np.sin(direction), np.cos(direction)
        a, b = (find_stripe_bank(clearance, y, x, sign*dy, sign*dx) for sign in (-1, 1))
        paired = np.isfinite(a+b)
        a, b = np.nan_to_num(a), np.nan_to_num(b)
        ay, ax, by, bx = y-a*dy, x-a*dx, y+b*dy, x+b*dx
        loss, support = np.zeros(len(x)), np.zeros(len(x))
        for offset in (-7, -4, -2, 0, 2, 4, 7):
            ya, xa, yb, xb = ay+offset*dx, ax-offset*dy, by+offset*dx, bx-offset*dy
            exposed = (read_stripe(clearance, ya, xa) > .7) & (read_stripe(clearance, yb, xb) > .7)
            weight = exposed*np.exp(-.5*(offset/5)**2)
            loss += weight*np.minimum(225, (read_stripe(smooth, ya, xa)-read_stripe(smooth, yb, xb))**2)
            support += weight
        cost = (loss+9)/np.maximum(.1, support)+.065*degrees**2+.10*(a+b)
        good = paired & (support > 1.55)
        value = (read_stripe(tone, ay, ax)*b+read_stripe(tone, by, bx)*a)/np.maximum(1, a+b)
        weight = np.where(good, 1/np.maximum(1, cost)**2, 0)
        better = good & (cost < best)
        closest[better], best[better] = value[better], cost[better]
        total += weight*value
        mass += weight
    return .77*total/np.maximum(1e-12, mass)+.23*closest, mass > 0


def printed_fan_focus(tone, distance, opaque):
    smooth = gaussian_filter(tone, 1.4)
    gy, gx = np.gradient(smooth)
    a, b, c = (gaussian_filter(v, 4) for v in (gx*gx, gx*gy, gy*gy))
    angle = .5*np.arctan2(2*b, a-c)
    y, x = np.indices(tone.shape)
    exposed = ((distance > 10) & (distance < 76) & opaque & (minimum_filter(tone, 9) > 142)
               & (a+c > 4) & (np.hypot(a-c, 2*b) > .88*(a+c)) & (x % 3 == 0) & (y % 3 == 0))
    y, x = np.where(exposed)
    if len(x) < 200:
        return
    points = np.column_stack((x, y))
    normals = np.column_stack((np.cos(angle[y, x]), np.sin(angle[y, x])))
    fit = fit_focus(points, normals)
    if fit is not None:
        focus, support = fit
        if len(support) >= .33*len(points) and np.linalg.norm(focus-points.mean(0)) < 4*max(tone.shape):
            return focus


def carry_fan_profile(tone, known, focus, target):
    y, x = np.where(target)
    dy, dx = y-focus[1], x-focus[0]
    length = np.maximum(1, np.hypot(dx, dy))
    clearance = distance_transform_edt(known)
    sides = []
    for direction in (-1, 1):
        first = np.full(len(x), np.inf)
        value, mass = np.zeros((2, len(x)))
        for step in np.arange(1, 87, .9):
            sy, sx = y+direction*step*dy/length, x+direction*step*dx/length
            visible = ((sy >= 1) & (sx >= 1) & (sy < len(tone)-2) & (sx < tone.shape[1]-2)
                       & (read_stripe(clearance, sy, sx) > 1.6))
            first = np.where(visible & ~np.isfinite(first), step, first)
            weight = np.where(visible, np.exp(-.5*((step-first)/3.6)**2), 0)
            mass += weight
            value += weight*read_stripe(tone, sy, sx)
        sides.append((np.where(mass > 0, first, 1000), value/np.maximum(.0001, mass), mass > 0))
    (da, a, left), (db, b, right) = sides
    level = np.where(left & right, (a*db+b*da)/(da+db), np.where(left, a, b))
    return level, left | right


def paper_patch_cost(field, target, weight):
    from scipy.signal import correlate
    # Subtracting a paper level avoids cancellation in the squared difference.
    field, target = field-224., target-224.
    energy = correlate(field*field, weight, mode="valid", method="fft")
    agreement = correlate(field, target*weight, mode="valid", method="fft")
    return np.maximum(0, energy-2*agreement+np.sum(target*target*weight))/weight.sum()


def restore_projected_print(tone, ink, distance, target, opaque, result, hold):
    if not target.any() or not hold.any() or distance_transform_edt(ink).max() < 5:
        return
    focus = printed_fan_focus(tone, distance, opaque)
    if focus is None:
        return
    known = (distance > 9) & (tone > 139) & opaque
    predicted, seen = carry_fan_profile(tone, known & ~hold, focus, hold)
    if seen.mean() < .94 or np.quantile(abs(predicted[seen]-tone[hold][seen]), .9) > 16:
        return
    value, seen = carry_fan_profile(tone, known, focus, target)
    if seen.mean() < .98:
        return
    guide = result[:, :, 1].astype(float)
    alpha = np.clip((12-distance[target])/3, 0, 1)*seen
    guide[target] = alpha*value+(1-alpha)*tone[target]
    # Move complete neighboring ink samples along the fan. Merely averaging
    # its two sides leaves a smooth stripe in the middle of the rough scan.
    native, broad = gaussian_filter(tone, .92), gaussian_filter(tone, 2.6)
    fine_guide, broad_guide = gaussian_filter(guide, 1.28), gaussian_filter(guide, 2.6)
    available = (distance > 6) & (tone > 138) & opaque
    donors = minimum_filter(available, 11)
    stamp = np.outer(np.hanning(13)[1:-1], np.hanning(13)[1:-1])
    total, mass, grain = np.zeros((3, *tone.shape))
    y, x = np.where(target)
    for cy in range(max(5, y.min()//4*4), min(len(tone)-5, y.max()+4), 4):
        for cx in range(max(5, x.min()//4*4), min(tone.shape[1]-5, x.max()+4), 4):
            tile = np.s_[cy-5:cy+6, cx-5:cx+6]
            active = target[tile]
            if active.sum() < 6:
                continue
            top, left = max(0, cy-57), max(0, cx-57)
            area = np.s_[top:cy+58, left:cx+58]
            by, bx = np.where(donors[area][5:-5, 5:-5])
            if not len(bx):
                continue
            local = by, bx
            by, bx = by+top+5, bx+left+5
            dx, dy = cx-focus[0], cy-focus[1]
            across = abs(dx*(by-cy)-dy*(bx-cx))/max(1, np.hypot(dx, dy))
            weight = stamp*(available[tile]+.24)
            cost = (paper_patch_cost(native[area], fine_guide[tile], weight)[local]
                    + .45*paper_patch_cost(broad[area], broad_guide[tile], stamp)[local]
                    + .035*np.hypot(by-cy, bx-cx)**1.55+.2*across)
            best = np.argmin(cost)
            sy, sx = by[best], bx[best]
            original = tone[sy-5:sy+6, sx-5:sx+6]
            patch = original+np.clip(gaussian_filter(guide[tile]-original, 3), -10, 10)
            mix = stamp**3*active
            total[tile] += mix*patch
            mass[tile] += mix
            grain[tile] += mix*gaussian_filter(abs(original-gaussian_filter(original, 1.4)), 2.5)
    use = mass > .01
    merged = np.where(use, total/np.maximum(.0001, mass), guide)
    fine = merged-gaussian_filter(merged, 1.55)
    gain = np.clip(grain/np.maximum(.001, mass)/np.maximum(.8, gaussian_filter(abs(fine), 2.5)), 1, 2.2)
    weight = np.clip((11-distance[use])/3, 0, 1)
    value = np.clip(merged[use]+(gain[use]-1)*fine[use], 0, 255)
    result[use] = np.rint(guide[use]+weight*(value-guide[use])).clip(0, 255).astype('u1')[:, None]


def restore_pale_stripes(source, mask, prediction, opaque=None):
    rows, cols = np.where(mask)
    if not 500 <= len(rows) <= 22000:
        return False
    box = np.s_[max(0, rows.min()-60):rows.max()+61, max(0, cols.min()-60):cols.max()+61]
    selected = mask[box]
    if selected.size > 550_000:
        return False
    original, result = source[box], prediction[box]
    tone = original.mean(2)
    ink = dark_strokes(tone, selected)
    if ink is None or np.quantile(result[ink & selected].mean(1), .12) < 162:
        return False
    distance = distance_transform_edt(~ink)
    bank = (distance > 8) & (distance < 30)
    if (np.quantile(tone[bank], .03) < 178 or np.median(tone[bank]) < 225
            or np.quantile(np.ptp(original[bank], axis=1), .98) > 3):
        return False
    clear = minimum_filter(tone, 5) > 130
    available = (distance > 4.5) & (tone > 130)
    if opaque is not None:
        available &= opaque[box]
    y, x = np.indices(selected.shape)
    hold = available & clear & (distance > 11) & (distance < 27) & ((y//6+2*(x//7)) % 8 == 3)
    if hold.sum() < 250 or tone[hold].std() < 8:
        return False
    training = available & ~hold
    direction, _ = stripe_direction(tone, clear & training & (distance > 6) & (distance_transform_edt(~hold) > 3))
    check, valid = across_pale_strokes(tone, training, hold, direction)
    flat = gaussian_filter(np.where(training, tone, 0), 6)/np.maximum(.00001, gaussian_filter(training.astype(float), 6))
    error = abs(check[valid]-tone[hold][valid])
    if (valid.mean() < .92 or np.quantile(error, .85) > 9 or np.quantile(error, .95) > 19
            or error.mean() > .66*np.mean(abs(flat[hold][valid]-tone[hold][valid]))):
        return False
    direction, coherence = stripe_direction(tone, clear & available & (distance > 6))
    paint = (distance <= 6.5) & selected
    if np.median(coherence[paint]) < .54:
        return False
    value, paired = across_pale_strokes(tone, available, paint, direction)
    if paired.mean() < .96:
        return False
    alpha = np.clip((6.5-distance[paint])/2, 0, 1)
    colour = np.where(paired, value, result[paint].mean(1))
    result[paint] = np.rint(alpha*colour+(1-alpha)*tone[paint]).clip(0, 255).astype("u1")[:, None]
    # Narrow white keylines around the selected strokes are printed on top of
    # the same paper. Keep exposed scan pixels between them at native contrast.
    # The decoder feathers outside its conditioning mask. Its pale rim can be
    # wider than the black stroke. The registered scan is intact in this band.
    exposed = (distance > 6.5) & (distance <= 22) & clear
    if opaque is not None:
        exposed &= opaque[box]
    result[exposed] = original[exposed]
    valid = np.ones_like(selected) if opaque is None else opaque[box]
    band = (distance < 11) & (minimum_filter(np.where(ink, 255, tone), 3) > 139) & valid
    restore_projected_print(tone, ink, distance, band, valid, result, hold)
    return True
