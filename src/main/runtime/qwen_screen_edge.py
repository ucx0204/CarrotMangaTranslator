"""Continue a printed dot field through lettering crossing its edge against white paper."""
import numpy as np
from scipy.ndimage import (distance_transform_edt as edt, find_objects, label, map_coordinates,
                           minimum_filter, uniform_filter1d)
from scipy.optimize import least_squares, minimize, minimize_scalar
from scipy.signal import find_peaks


def paper_transition(gray, left, right, top, bottom):
    banks = []
    for start, stop in ((left-25, left-7), (right+7, right+25)):
        values = gray[:, start:stop]
        ink = uniform_filter1d((values < 150).mean(1), 7)
        for row in range(max(18, top-8), min(bottom-15, top+43)):
            if (np.median(ink[row-15:row-5]) > .19 and ink[row] < .095
                    and np.max(ink[row+4:row+14]) < .065
                    and np.quantile(values[row+7:row+18], .09) > 241):
                banks.append(row)
                break
    if len(banks) == 2 and abs(banks[0]-banks[1]) <= 9:
        return round(np.mean(banks))


def repeat_vectors(gray, bank, edge):
    sy, sx = np.where(bank & (np.indices(gray.shape)[0] < edge-12))
    if len(sy) < 900:
        return []
    rng = np.random.default_rng(8145)
    take = rng.choice(len(sy), min(len(sy), 1800), replace=False)
    sy, sx = sy[take], sx[take]
    measured = gray[sy, sx]
    if np.std(measured) < 56:
        return []
    h, w = bank.shape
    ranked = []
    for dy in range(-25, 1):
        for dx in range(-17, 18):
            if dx*dx+dy*dy < 22:
                continue
            y, x = sy+dy, sx+dx
            valid = (y >= 2) & (x >= 2) & (x < w-2) & (y < h-2)
            valid &= bank[y.clip(0, h-1), x.clip(0, w-1)]
            if valid.sum() < 190:
                continue
            loss = np.minimum(100, abs(gray[y[valid], x[valid]]-measured[valid])).mean()
            if loss < 29:
                ranked.append((loss, dx, dy, valid))
    vectors = []
    held = (sx//6+sy//6) % 3 == 0
    for _, dx, dy, valid in sorted(ranked, key=lambda item: item[0])[:18]:
        train, test = valid & ~held, valid & held
        if min(train.sum(), test.sum()) < 60:
            continue

        def error(offset, sample):
            val = map_coordinates(gray, [sy[sample]+offset[1], sx[sample]+offset[0]], order=3)
            return np.minimum(100, abs(val-measured[sample])).mean()

        trial = minimize(error, [dx, dy], args=(train,), method="Nelder-Mead",
                         options={"maxiter": 43, "xatol": .008})
        score = error(trial.x, test)
        if np.linalg.norm(trial.x-[dx, dy]) < 1.3 and score < 16:
            vectors.append((score, *trial.x))
    return sorted(vectors)


def registered_bank(gray, available, transition):
    import warnings
    y, x = np.indices(gray.shape)
    bank = available & (y < transition-9)
    vectors = repeat_vectors(gray, bank, transition)
    if len(vectors) < 3 or vectors[0][0] > 9:
        return
    h, w = gray.shape
    upper = y <= transition+18
    sy, sx = y[upper], x[upper]
    samples = []
    for error, dx, dy in vectors[:10]:
        for multiple in (1, 2, 3):
            yy, xx = sy+multiple*dy, sx+multiple*dx
            row, col = np.rint(yy).astype(int).clip(0, h-1), np.rint(xx).astype(int).clip(0, w-1)
            live = (yy > 1) & (xx > 1) & (xx < w-2) & (yy < transition-9) & bank[row, col]
            if not live.any():
                continue
            sample = np.full(len(sy), np.nan)
            sample[live] = map_coordinates(gray, [yy[live], xx[live]], order=3)
            samples.append(sample)
    if not samples:
        return
    pred = np.full(gray.shape, np.nan)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        pred[upper] = np.nanmedian(samples, axis=0)
    test = bank & (y >= transition-15) & np.isfinite(pred)
    if test.sum() > 180 and np.mean(abs(pred[test]-gray[test])) < 18:
        return pred


def fitted_paper_edge(gray, projected, visible, guess, left, right):
    h, w = gray.shape
    rows, cols = np.indices((h, w))
    probes = (np.isfinite(projected) & (projected < 165) & visible
              & (rows > guess-14) & (rows < guess+13))
    xx, upper, lower = [], [], []
    for x in range(max(6, left-40), min(w-5, right+40)):
        dark = np.where(probes[:, x] & (gray[:, x] < 200)
                        & (abs(gray[:, x]-projected[:, x]) < 65))[0]
        light = np.where(probes[:, x] & (rows[:, x] > guess-5) & (gray[:, x] > 225))[0]
        if len(dark) and len(light) and 0 < light[0]-dark[-1] < 11:
            xx.append(x)
            upper.append(dark[-1])
            lower.append(light[0])
    xx, upper, lower = (np.asarray(k) for k in (xx, upper, lower))
    if min(np.sum(xx < left-2), np.sum(xx > right+2)) < 8:
        return
    u = (xx-.5*(left+right))/50.
    design = np.column_stack((np.ones(len(u)), u, u*u))
    train = xx % 4 != 0
    middle = .5*(upper+lower)

    def residual(c):
        p = design[train] @ c
        return np.r_[np.minimum(0, p-upper[train]-.15), np.maximum(0, p-lower[train]+.15),
                     .11*(middle[train]-p), .25*c[2]]

    c = least_squares(residual, [guess, 0, 0], loss="soft_l1").x
    if ((~train).sum() < 6 or np.quantile(abs(design[~train] @ c-middle[~train]), .85) > 3.6
            or abs(c[2]) > 14 or abs(c[0]-guess) > 12):
        return
    u = (cols-.5*(left+right))/50.
    return c[0]+c[1]*u+c[2]*u*u


def restore_source_paper_below_edge(gray, mask, out, paper, valid):
    # Original dark components attached to the drawing must survive. A real
    # letter has independently exposed white stock all around its outside.
    changed = False
    shape = np.ones((3,3))
    groups, _ = label((gray < 243) & paper, shape)
    near = edt(~mask)
    bounds = find_objects(groups)
    owned = np.zeros(groups.max()+1, dtype=bool)
    for k, box in enumerate(bounds, 1):
        local = groups[box] == k
        if 2 <= local.sum() <= 1800 and (near[box][local] <= 2.5).mean() >= .92:
            owned[k] = True
    foreign = (groups > 0) & ~owned[groups]
    clear = edt(~foreign) if foreign.any() else np.full(gray.shape, 100.)
    for k in np.flatnonzero(owned):
        a, b = bounds[k-1]
        if a.start < 6 or b.start < 6 or a.stop >= gray.shape[0]-6 or b.stop >= gray.shape[1]-6:
            continue
        view = np.s_[a.start-6:a.stop+6, b.start-6:b.stop+6]
        dist = edt(groups[view] != k)
        bank = ((dist > 2.) & (dist <= 5.5) & paper[view] & valid[view]
                & ~owned[groups[view]] & (clear[view] >= 1.4))
        if bank.sum() < 22 or np.quantile(gray[view][bank], .10) < 241 or np.median(gray[view][bank]) < 250:
            continue
        selected = (dist < 4.2) & paper[view] & valid[view] & (clear[view] > 1.)
        out[view][selected] = round(np.median(gray[view][bank]))
        changed |= bool(selected.any())
    return changed


def restore_column_screen_edge(source, mask, result, opaque=None):
    y, x = np.where(mask)
    if not 85 <= len(x) <= 2600:
        return False
    w, h = np.ptp(x)+1, np.ptp(y)+1
    if not 48 <= h <= 220 or not 6 <= w <= min(65, .62*h):
        return False
    area = np.s_[max(0,y.min()-50):y.max()+19, max(0,x.min()-46):x.max()+47]
    rgb, marked, out = source[area], mask[area], result[area]
    valid = np.ones_like(marked) if opaque is None else opaque[area]
    yy, xx = np.where(marked)
    top, bottom, left, right = yy.min(), yy.max()+1, xx.min(), xx.max()+1
    if left < 26 or right > marked.shape[1]-26 or top < 29 or (np.ptp(rgb, axis=2) > 6).mean() > .015:
        return False
    gray = rgb.mean(2)
    guess = paper_transition(gray, left, right, top, bottom)
    if guess is None:
        return False
    distance = edt(~marked)
    visible = (distance > 8.5) & valid
    projected = registered_bank(gray, visible, guess)
    if projected is None:
        return False
    edge = fitted_paper_edge(gray, projected, visible, guess, left, right)
    if edge is None:
        return False
    rows = np.indices(marked.shape)[0]
    zone = (distance < 8) & valid
    boundary = zone & (rows < edge+3)
    if boundary.sum() < 50 or np.isfinite(projected[boundary]).mean() < .98:
        return False
    alpha = np.clip(edge-rows+.5, 0, 1)
    target = np.clip(np.nan_to_num(projected, nan=255), 0, 255)
    weak_ink = ((gray+60 < target) & (distance > 1.3) & np.isfinite(projected)
                & (rows < edge-1) & valid)
    components, _ = label(weak_ink, np.ones((3,3)))
    for k, box in enumerate(find_objects(components), 1):
        ink = components[box] == k
        if ink.sum() >= 11 and distance[box][ink].max() > 9 and (boundary[box] & ink).sum() >= 4:
            return False
    proposal = out.copy()
    proposal[boundary] = np.rint(255+alpha[boundary,None]*(target[boundary,None]-255)).astype('u1')
    retained = boundary & (distance > 1.5) & (abs(gray-proposal.mean(2)) <= 9)
    proposal[retained] = rgb[retained]
    paper = (rows >= edge+1.5) & valid
    white = paper & zone & (minimum_filter(gray, 3) >= 247)
    proposal[white] = rgb[white]
    if not restore_source_paper_below_edge(gray, marked, proposal, paper, valid):
        return False
    out[:] = proposal
    return True


def horizontal_dot_period(gray, visible, distance):
    sy, sx = np.where(visible & (distance < 33))
    if len(sy) < 800:
        return
    sample = np.random.default_rng(239).choice(len(sy), min(2800, len(sy)), replace=False)
    sy, sx = sy[sample], sx[sample]
    held = (sx//7 + 3*(sy//9)) % 5 == 0
    native = gray[sy, sx]
    if np.std(native) < 28:
        return
    width = gray.shape[1]

    def error(period, test=False):
        col = sx + period
        valid = (held if test else ~held) & (col < width-2)
        valid &= visible[sy, np.rint(col).astype(int).clip(0, width-1)]
        if valid.sum() < 65:
            return 250.
        other = map_coordinates(gray, [sy[valid], col[valid]], order=3, mode='nearest')
        return np.minimum(90, abs(native[valid]-other)).mean()

    offsets = np.arange(3., 22., .25)
    scores = np.array([error(p) for p in offsets])
    for index in find_peaks(-scores)[0]:
        if scores[index] > 25:
            continue
        offset = offsets[index]
        period = minimize_scalar(error, bounds=(offset-.35, offset+.35), method='bounded').x
        if error(period, True) < 15:
            return period


def adjacent_dot_rows(gray, visible, period, direction):
    import warnings
    y, x = np.indices(gray.shape)
    width = gray.shape[1]
    bank = minimum_filter(visible, size=(1, 5))
    samples = []
    for step in range(1, 11):
        xx = x + direction*step*period
        candidates = (xx > 3) & (xx < width-3) & bank[y, np.rint(xx).astype(int).clip(0, width-1)]
        sample = map_coordinates(gray, [y, xx], order=3, mode='nearest')
        samples.append(np.where(candidates, sample, np.nan))
    samples = np.array(samples)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        mid = np.nanmedian(samples, axis=0)
        spread = np.nanmedian(abs(samples-mid), axis=0)
    return mid, spread, np.isfinite(samples).sum(0)


def restore_sound_screen_rows(source, mask, result, opaque):
    """Recover a graded screen under a narrow knockout from repeats in the same printed row."""
    y, x = np.where(mask)
    if not 300 <= len(y) <= 5500 or not 46 <= np.ptp(y) <= 220 or np.ptp(x) > .8*np.ptp(y):
        return False
    area = np.s_[max(0,y.min()-22):y.max()+23, max(0,x.min()-64):x.max()+65]
    rgb, marked, out, valid = source[area], mask[area], result[area], opaque[area]
    if (np.ptp(rgb, axis=2) > 5).mean() > .012 or not valid[marked].all():
        return False
    gray = rgb.mean(2)
    if (gray[marked] > 238).mean() < .23 or (gray[marked] < 65).mean() < .09:
        return False
    distance = edt(~marked)
    visible = (distance > 3.8) & valid
    visible[:2] = visible[-2:] = False
    visible[:, :2] = visible[:, -2:] = False
    period = horizontal_dot_period(gray, visible, distance)
    if period is None:
        return False
    left, left_noise, left_count = adjacent_dot_rows(gray, visible, period, -1)
    right, right_noise, right_count = adjacent_dot_rows(gray, visible, period, 1)
    both = (left_count >= 2) & (right_count >= 2)
    agree = both & (abs(left-right) < 33) & (left_noise < 22) & (right_noise < 22)
    if agree[marked].mean() < .88 or both[marked].mean() < .992:
        return False
    level = (left+right)/2
    hold = agree & visible & (distance < 17)
    if hold.sum() < 450 or np.quantile(abs(gray[hold]-level[hold]), .9) > 24:
        return False
    # A real pen crossing the word must remain visible in the exposed annulus.
    # A connected discrepancy on that annulus rules out an all-screen repair.
    foreign = (distance > .5) & (distance < 19) & both & (abs(gray-level) > 64)
    pieces, _ = label(foreign, np.ones((3, 3)))
    for k, box in enumerate(find_objects(pieces), 1):
        region = pieces[box] == k
        ring = distance[box][region]
        if region.sum() >= 10 and ring.min() < 3 and ring.max() > 7:
            return False
    write = (distance < 2.2) & both & valid
    if not write.any():
        return False
    out[write] = np.rint(np.clip(level[write, None], 0, 255)).astype('u1')
    return True
