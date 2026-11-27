"""Register interrupted fine ruled ink from the unprinted sides of a sound effect."""
import numpy as np
from scipy.ndimage import distance_transform_edt, gaussian_filter, label, map_coordinates
from scipy.signal import find_peaks


def sample_ridge(gray, line, columns, offsets):
    positions = line[columns] + offsets[:, None]
    return map_coordinates(gray, [positions, np.broadcast_to(columns, positions.shape)], order=1)


def brush_ray_banks(gray, known):
    """Find parallel fine pens independently on the exposed side of the effect."""
    height, width = gray.shape
    y, _ = np.indices(gray.shape)
    contrast = np.minimum(np.roll(gray, 4, 0), np.roll(gray, -4, 0))-gray
    eligible = known & (contrast > 48) & (gray < 185) & (gray+contrast > 184)
    rows, columns = np.where(eligible & (y >= 6) & (y < height-6))
    if len(columns) < 160:
        return []
    center = (width-1)/2
    candidates = []
    for slope in np.arange(-.54, .541, .005):
        levels = np.rint(rows-slope*(columns-center)).astype(int)
        inside = (levels > 0) & (levels < height-1)
        weight = np.minimum(1, contrast[rows[inside], columns[inside]]/130)
        hist = np.bincount(levels[inside], weights=weight, minlength=height)
        for peak in find_peaks(hist, height=max(27, width*.081), distance=3)[0]:
            candidates.append((hist[peak], slope, peak))
    found = []
    for _, slope, peak in sorted(candidates, reverse=True):
        if any(abs(slope-s) < .035 and abs(peak-b) < 3 for s, b, _ in found):
            continue
        fitted = fit_brush_ray(contrast, known, slope, peak)
        if fitted:
            slope, peak, runs = fitted
            if not any(abs(slope-s) < .022 and abs(peak-b) < 2.9 for s, b, _ in found):
                found.append((slope, peak, runs))
    long = [s for s, _, runs in found if max(map(len, runs)) >= max(54, .21*width)]
    if len(long) < 4:
        return []
    cluster = max(([t for t in long if abs(t-s) < .006] for s in long), key=len)
    if len(cluster) < max(4, .38*len(long)):
        return []
    axis = np.median(cluster)
    return [(s, b, runs) for s, b, runs in found if abs(s-axis) < .006]


def fit_brush_ray(contrast, known, slope, peak):
    height, width = known.shape
    columns = np.arange(width)
    centered = columns-(width-1)/2
    offsets = np.arange(-2, 3)[:, None]
    for _ in range(3):
        line = peak+slope*centered
        rows = np.rint(line).astype(int)
        inside = (rows > 6) & (rows < height-7)
        rows = rows.clip(6, height-7)
        density = np.maximum(0, contrast[rows+offsets, columns]-22)
        mass = density.sum(0)
        points = rows+(density*offsets).sum(0)/np.maximum(1, mass)
        usable = inside & known[rows, columns] & (density.max(0) > 43) & (mass > 50) & (abs(points-line) < 1.12)
        if usable.sum() < 35:
            return
        slope, peak = np.polyfit(centered[usable], points[usable], 1)
    visible = columns[usable]
    runs = [seg for seg in np.split(visible, np.flatnonzero(np.diff(visible) > 2)+1) if len(seg) > 10]
    if runs and sum(map(len, runs)) >= max(42, width*.11):
        return slope, peak, runs


def restore_brush_motion(source, mask, output, allowed, opaque):
    """Reconnect a missing motion line only between independently printed banks."""
    gray = source[:, :, 1].astype('f')
    if min(gray.shape) < 90 or (np.ptp(source[:, :, :3], axis=2) > 5).mean() > .015:
        return
    safe = distance_transform_edt(opaque) > 5 if not opaque.all() else opaque
    known = safe & ~mask
    columns = np.arange(gray.shape[1])
    current = output[:, :, 1].astype('f')
    for slope, peak, banks in brush_ray_banks(gray, known):
        line = peak+slope*(columns-(len(columns)-1)/2)
        for left, right in zip(banks, banks[1:]):
            middle = columns[left[-1]+1:right[0]]
            if not 9 <= len(middle) <= 164:
                continue
            y = np.rint(line[middle]).astype(int)
            if mask[y, middle].mean() < .46:
                continue
            join_brush_banks(gray, current, allowed, line, left[-32:], right[:32], middle)
    changed = allowed & (current < output[:, :, 1])
    output[changed, :3] = np.rint(current[changed, None]).clip(0, 255).astype('u1')


def join_brush_banks(gray, current, allowed, line, left, right, middle):
    phases = np.arange(-4, 4.01, .125)
    sides = abs(phases) > 3
    samples = [np.median(sample_ridge(gray, line, bank, phases), axis=1) for bank in (left, right)]
    if min(np.quantile(v[sides], .1) for v in samples) < 184:
        return
    ridges = [np.median(v[sides])-v for v in samples]
    depths = [v.max() for v in ridges]
    if min(depths) < 31 or max(min(abs(phases[v > .83*v.max()])) for v in ridges) > .7:
        return
    if np.mean(abs(ridges[0]/depths[0]-ridges[1]/depths[1])) > .19:
        return
    check = sample_ridge(current, line, middle, np.arange(-4, 4.01, .5))
    shoulder = np.minimum(check[0], check[-1])
    if np.median(shoulder) < 184 or ((shoulder-check[5:12].min(0)) < .36*np.mean(depths)).mean() < .70:
        return
    # End the repaired pen with a taper inside the covered drawing. A hard
    # cut at the first visible bank leaves a short rectangular dash.
    length = max(5, min(42, 2*len(left), 2*len(right)))
    x = np.arange(max(0, left[0]-length), min(gray.shape[1], right[-1]+length+1))
    x = x[(line[x] >= 5) & (line[x] < gray.shape[0]-5)]
    y = np.rint(line[x]).astype(int)+np.arange(-3, 4)[:, None]
    phase = y-line[x]
    fraction = np.clip((x-left.mean())/(right.mean()-left.mean()), 0, 1)
    ink = np.maximum(0, np.interp(phase, phases, ridges[0])*(1-fraction)+np.interp(phase, phases, ridges[1])*fraction)
    taper = np.clip(1+np.minimum(x-left[0], right[-1]-x)/length, 0, 1)
    ink *= taper*taper*(3-2*taper)
    base = sample_ridge(current, line, x, np.array([-3., 3.])).min(0)
    desired = np.maximum(0, base-ink)
    apply = allowed[y, x] & (abs(phase) < 2.1) & (base > 165) & (current[y, x] > desired+4) & (ink > 9)
    if apply.sum() >= 9:
        current[y[apply], np.broadcast_to(x, y.shape)[apply]] = desired[apply]


def votes_for_lines(gray, known, center):
    # Paper on both sides of the pen rejects solid fills and screen dots.
    thin = (gray < 139) & known & (np.roll(gray, 4, axis=0) > 217) & (np.roll(gray, -4, axis=0) > 217)
    thin[:5] = thin[-5:] = False
    y, x = np.where(thin)
    if len(y) < 42:
        return []
    density = (255-gray[y, x])/255
    candidates = []
    for slope in np.arange(-.43, .431, .012):
        intercept = np.rint(y-slope*(x-center)).astype(int)
        minimum = intercept.min()
        votes = np.bincount(intercept-minimum, weights=density)
        peaks = find_peaks(votes, height=30, distance=4)[0]
        candidates.extend((votes[k], slope, k+minimum) for k in peaks)
    return sorted(candidates, reverse=True)


def fit_line_centers(gray, known, x, slope, intercept):
    offsets = np.arange(-4, 5)[:, None]
    for _ in range(3):
        line = slope*x+intercept
        if line.min() < 7 or line.max() >= gray.shape[0]-7:
            return
        y = np.rint(line).astype(int)
        # Record the subpixel center of mass of a single thin dark pen.
        ink = np.maximum(0, 232-gray[y+offsets, np.arange(len(x))])
        mass = ink.sum(0)
        usable = known[y, np.arange(len(x))] & ((ink*(abs(offsets) > 2)).sum(0) < 42) & (mass > 140) & (mass < 880)
        if usable.sum() < 27:
            return
        centers = y+(ink*offsets).sum(0)/np.maximum(1, mass)
        slope, intercept = np.polyfit(x[usable], centers[usable], 1)
    line = slope*x+intercept
    if line.min() >= 7 and line.max() < gray.shape[0]-7:
        return line, usable, abs(centers-line)


def exposed_pen_bank(gray, line, columns, usable, error):
    stable = usable[columns] & (error[columns] < .8)
    if stable.sum() < 13 or not stable[:7].any():
        return
    near = np.convolve(stable, np.ones(13), mode="valid")[:9]
    if near.max() < 12:
        return
    x = columns[stable]
    if np.quantile(error[x], .9) > .6:
        return
    positions = line[x]+np.arange(-5, 5.01, .25)[:, None]
    density = map_coordinates(gray, [positions, np.broadcast_to(x, positions.shape)], order=1)
    if np.quantile(density[[0, 1, -2, -1]], .1) < 234:
        return
    return x, np.median(density, axis=1)


def repair_join(gray, distance, output, writable, line, x, samples):
    offsets = np.arange(-5, 6)[:, None]
    y = np.rint(line[samples]).astype(int)+offsets
    phase = (y-line[samples]).ravel()
    native = gray[y, samples].ravel()
    axis = np.linspace(-5, 5, 101)
    weights = np.exp(-.5*((phase-axis[:, None])/.22)**2)
    held = np.broadcast_to(samples//4 % 3 == 1, y.shape).ravel()
    if held.sum() < 22 or (~held).sum() < 55:
        return False
    training = weights[:, ~held]
    test_density = (training@native[~held])/np.maximum(.001, training.sum(1))
    if np.quantile(abs(native[held]-np.interp(phase[held], axis, test_density)), .9) > 29:
        return False
    density = (weights@native)/np.maximum(.001, weights.sum(1))
    y = np.rint(line[x]).astype(int)+offsets
    phase = y-line[x]
    model = np.interp(phase, axis, density)
    inside = (distance[y, x] <= 2.9) & writable[y, x]
    core = (abs(phase) < 1.2) & inside
    shoulders = (abs(phase) > 3) & (abs(phase) < 5) & inside
    current = output[y, x, :3].mean(2)
    if (np.sum((gray[y, x] > 210) & core) < 3 or not shoulders.any()
            or np.max(np.where(core, current-model, 0)) < 37
            or np.mean(np.maximum(0, 230-current[shoulders])) > 23):
        return False
    allowed = inside & (abs(phase) < 4.5)
    output[y[allowed], np.broadcast_to(x, y.shape)[allowed], :3] = np.rint(model[allowed, None]).astype('u1')
    return True


def restore_perspective_ink(source, mask, output, opaque):
    yy, xx = np.where(mask)
    if not 80 <= len(xx) <= 36_000 or max(np.ptp(xx), np.ptp(yy)) > 400:
        return False
    area = np.s_[max(0, yy.min()-17):yy.max()+18, max(0, xx.min()-48):xx.max()+49]
    rgb, mask, output, opaque = source[area], mask[area], output[area], opaque[area]
    if (np.ptp(rgb[:, :, :3], axis=2) > 6).mean() > .015:
        return False
    gray = rgb[:, :, :3].mean(2)
    distance = distance_transform_edt(~mask)
    known = (distance > 3) & opaque
    center = int(np.median(np.where(mask)[1]))
    x = np.arange(gray.shape[1])
    tried = set()
    applied = False
    for _, slope, intercept in votes_for_lines(gray, known, center):
        fit = fit_line_centers(gray, known, x-center, slope, intercept)
        if fit is None:
            continue
        line, usable, error = fit
        signature = tuple(np.rint(4*line[[0, center, -1]]))
        if signature in tried:
            continue
        tried.add(signature)
        gap = distance[np.rint(line).astype(int), x] <= 2.9
        for start, end in np.flatnonzero(np.diff(np.r_[False, gap, False])).reshape(-1, 2):
            if not 6 <= end-start <= 111 or start < 13 or end+13 > len(x):
                continue
            left = exposed_pen_bank(gray, line, x[max(0, start-31):start][::-1], usable, error)
            right = exposed_pen_bank(gray, line, x[end:end+31], usable, error)
            if left is None or right is None or abs(left[1]-right[1]).mean() > 18:
                continue
            applied |= repair_join(gray, distance, output, opaque, line, x[start:end], np.r_[left[0], right[0]])
    return applied


def read_level(image, y, x):
    return map_coordinates(image, (y, x), order=1, mode="nearest")


def pencil_direction(gray, distance, opaque):
    """Fit the direction along which independently exposed fine pens retain their contrast."""
    y, x = np.indices(gray.shape)
    known = (distance > 8) & (distance < 60) & opaque
    soft = gaussian_filter(gray, .55)
    gy, gx = np.gradient(gaussian_filter(gray, 1.4))
    xx, xy, yy = (gaussian_filter(term, 3) for term in (gx*gx, gx*gy, gy*gy))
    angle = .5*np.arctan2(2*xy, xx-yy)+np.pi/2
    nx, ny = -np.sin(angle), np.cos(angle)
    shoulders = np.minimum(read_level(gray, y+2.4*ny, x+2.4*nx),
                           read_level(gray, y-2.4*ny, x-2.4*nx))
    seeds = (known & (gray > 115) & (gray < 243) & (shoulders > 222) & (shoulders-gray > 11)
             & (xx+yy > 3) & (np.hypot(xx-yy, 2*xy) > .84*(xx+yy)))
    y, x = np.where(seeds)
    if len(x) < 65:
        return
    tangent = angle[y, x]
    known = known.astype(float)
    best_score, best = .26*len(x), None
    for theta in np.deg2rad(np.arange(-85, 91)):
        aligned = abs(np.sin(tangent-theta)) < .19
        if aligned.sum() < 48:
            continue
        sy, sx = y[aligned], x[aligned]
        dy, dx = np.sin(theta), np.cos(theta)
        hits, count = np.zeros((2, len(sy)))
        for step in (-20, -13, -7, 7, 13, 20):
            rows, cols = sy+step*dy, sx+step*dx
            valid = read_level(known, rows, cols) > .85
            ridge = read_level(soft, rows, cols)
            banks = np.minimum(read_level(soft, rows+2.3*dx, cols-2.3*dy),
                               read_level(soft, rows-2.3*dx, cols+2.3*dy))
            hits += valid*np.clip((banks-ridge)/np.maximum(8, 252-soft[sy, sx]), 0, 1.5)
            count += valid
        score = (hits/np.maximum(1, count))[count >= 2].sum()
        if score > best_score:
            best_score, best = score, theta
    # Horizontal and vertical panel rules alone do not identify a field of slanted speed lines.
    if best is not None and min(abs(np.sin(best)), abs(np.cos(best))) > .115:
        return best


def approaching_pencil(gray, soft, known, y, x, dy, dx, stock):
    steps = np.arange(1., 62)[:, None]
    rows, cols = y+steps*dy, x+steps*dx
    visible = ((read_level(known, rows, cols) > .97) & (rows > 3) & (cols > 3)
               & (rows < len(gray)-4) & (cols < gray.shape[1]-4))
    level = read_level(soft, rows, cols)
    rim = np.minimum(read_level(soft, rows+2.5*dx, cols-2.5*dy),
                     read_level(soft, rows-2.5*dx, cols+2.5*dy))
    ridge = visible & (rim > 223) & (rim-level > 3.8) & (level < 247)
    start = np.where(visible.any(0), visible.argmax(0)+1, 1000)
    weight = visible*np.exp(-.5*((steps-start)/8)**2)
    count = (ridge*weight).sum(0)
    sustained = (count >= 3.6) & (ridge & (steps <= start+8)).any(0)
    depth = (np.maximum(0, stock-level)*weight*ridge).sum(0)/np.maximum(.1, count)
    near = (visible & (steps < start+11)).sum(0) >= 4
    return np.where(sustained, depth, 0), np.where(near, start, 1000), sustained


def restore_pencil_stock(source, mask, output, opaque):
    """Remove sound-effect imprints while continuing thin slanted lines from their native banks."""
    y, x = np.where(mask)
    if not 300 <= len(x) <= 6500 or not 35 <= max(np.ptp(x), np.ptp(y)) <= 190:
        return False
    box = np.s_[max(0, y.min()-60):y.max()+61, max(0, x.min()-65):x.max()+66]
    source, mask, output, valid = source[box], mask[box], output[box], opaque[box]
    gray, model = source.mean(2), output.mean(2)
    groups, _ = label(gray < 155, np.ones((3, 3)))
    size = np.bincount(groups.ravel())
    owned = np.bincount(groups[mask], minlength=len(size))
    selected = (size >= 6) & (size <= 2600) & (owned >= .77*size)
    selected[0] = False
    if not 4 <= selected.sum() <= 23 or owned[selected].sum() <= .98*((gray < 155) & mask).sum():
        return False
    faces = selected[groups]
    distance = distance_transform_edt(~faces)
    if np.quantile(distance[mask], .96) > 4.1 or np.quantile(model[faces], .04) < 219:
        return False
    clearance = distance_transform_edt(~((gray < 153) & ~faces))
    bank = (distance >= 3.3) & (distance < 15) & (clearance > 3) & valid
    if (bank.sum() < 380 or np.median(gray[bank]) < 252 or np.quantile(gray[bank], .12) < 238
            or np.quantile(np.ptp(source[bank], axis=1), .99) > 5
            or (bank & (distance > 4) & (gray > 248) & (model > 228) & (gray-model > 2)).sum() < 48):
        return False
    valid = valid & (clearance > 1.6)
    theta = pencil_direction(gray, distance, valid)
    if theta is None:
        return False
    exposed_paper = (distance > 7) & (distance < 24) & valid
    if exposed_paper.sum() < 80:
        return False
    stock = np.median(gray[exposed_paper])
    if stock < 251:
        return False
    y, x = np.where((distance < 12.8) & valid & (model > 138))
    soft, known = gaussian_filter(gray, .46), ((distance > 6) & valid).astype(float)
    dy, dx = np.sin(theta), np.cos(theta)
    a, da, first = approaching_pencil(gray, soft, known, y, x, dy, dx, stock)
    b, db, second = approaching_pencil(gray, soft, known, y, x, -dy, -dx, stock)
    depth = (a*db+b*da)/(da+db)
    depth *= np.where(first & ~second, np.clip(1-da/37, 0, 1),
                      np.where(second & ~first, np.clip(1-db/37, 0, 1), 1))
    dist, native = distance[y, x], gray[y, x]
    exposed = (dist > 3) & ((native < 171) | ((depth > 2.7) & (native < stock-.63*depth)))
    value = np.where(exposed, native, np.maximum(stock-depth, 135))
    value += np.clip((dist-6)/3, 0, 1)*(depth > 2.7)*(native-value)
    weight = np.clip((12.8-dist)/3, 0, 1)
    output[y, x] = np.rint(model[y, x]+weight*(value-model[y, x])).clip(0, 255).astype('u1')[:, None]
    return True
