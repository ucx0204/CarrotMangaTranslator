"""Continue an interrupted bright rib when the same moulding repeats on the exposed screen."""
import numpy as np
from scipy.ndimage import gaussian_filter
from scipy.optimize import least_squares


def find_sill(field, mask, xs, ys):
    left, right = xs.min(), xs.max()
    columns = np.arange(max(0, left-115), min(field.shape[1], right+22))
    intercepts = np.arange(max(8, ys.min()), min(ys.max()+23, len(field)-10))
    if len(columns) < 80 or not len(intercepts):
        return
    best = None
    x = columns[None, :]
    exterior = columns < left-3
    near = (columns > left-3) & (columns < right-3)
    for slope in np.arange(-.17, .18, .01):
        rows = np.rint(intercepts[:, None]+slope*(x-right)).astype(int).clip(8, len(field)-11)
        below = np.mean([field[rows+j, x] for j in (1, 2, 3)], axis=0)
        above = np.mean([field[rows-j, x] for j in (2, 3, 4)], axis=0)
        edges = (below > 224) & (below-above > 52)
        exposed = (edges[:, exterior] & ~mask[rows[:, exterior], x[:, exterior]]).sum(1)
        across = edges[:, near].sum(1)
        score = exposed+1.3*across
        index = score.argmax()
        if exposed[index] >= 34 and across[index] >= 26 and (best is None or score[index] > best[0]):
            best = score[index], slope, intercepts[index]-slope*right
    return best and best[1:]


def exposed_ribs(gray, mask, xs, sill):
    left, right = xs.min(), xs.max()
    columns = np.arange(max(5, left-165), min(gray.shape[1]-15, right+4))
    rows = np.rint(sill[1]+sill[0]*columns-np.arange(2, 27)[:, None]).astype(int)
    if not rows.size or rows.min() < 0 or rows.max() >= len(gray):
        return [], []
    values, hidden = gray[rows, columns], mask[rows, columns]
    before = np.mean([gray[rows, columns-j] for j in (1, 2, 3)], axis=0)
    edge = ~hidden & (values >= 215) & (values-before > 39) & ~mask[rows, columns-2]
    peers, interrupted = [], []
    for i, col in enumerate(columns[:-14]):
        heights = np.flatnonzero(edge[:, i])
        if len(heights) < 7:
            continue
        light = ~hidden[:, i:i+13] & (values[:, i:i+13] > 206)
        span = np.minimum.accumulate(light, axis=1).sum(1)
        whole, clipped = [], []
        for level in heights:
            end = i+span[level]
            if end >= i+13:
                continue
            if hidden[level, end]:
                clipped.append(level)
            elif span[level] and values[level, end] < 205:
                whole.append(level)
        if len(whole) >= 7 and col < left-10:
            widths = []
            for level in whole:
                profile = values[level, i:i+14]
                bank = before[level, i]+18
                ends = np.flatnonzero((profile[:-1] < bank) & (profile[1:] < bank))
                if len(ends) and 2 <= ends[0] <= 12:
                    widths.append(ends[0])
            if len(widths) >= 5:
                peers.append((col, len(whole), np.median(widths)))
        if len(clipped) >= max(9, .85*len(heights)) and np.ptp(clipped) >= 8 and left <= col <= right:
            interrupted.append((col, np.quantile(span[clipped], .9)))
    return peers, interrupted


def foreground_curve(edit, gray, mask, col, sill):
    """Trace the solid pen that passes in front of the rib. Both its exposed
    native segments and its decoded trajectory have to support the occlusion."""
    x = np.arange(max(2, col-25), min(edit.shape[1]-3, col+42))
    track, verified, previous = [], 0, None
    for y in range(sill-2, max(2, sill-125), -1):
        window = (x >= col+7) & (x <= col+36) if previous is None else abs(x-previous) < 5.5
        seen = (edit[y, x] < 83) & (edit[y, x+1] < 73) & (edit[y, x+2] < 85)
        hits = x[window & seen]
        if not len(hits):
            if previous is None:
                continue
            break
        previous = hits[0]
        while previous > 2 and edit[y, previous-1] < 90:
            previous -= 1
        bank = np.s_[y, previous:previous+4]
        verified += np.any(~mask[bank] & (gray[bank] < 104))
        track.append((y, previous-.35))
        if previous < col-3:
            break
    if len(track) < 38 or verified < 8 or track[-1][1] > col-1 or track[0][1] < col+10:
        return
    y, x = np.array(track).T
    curve = np.polynomial.Polynomial.fit(y, x, 3)
    if np.median(abs(curve(y)-x)) <= .95:
        return curve, int(y[-1])


def fit_rib(gray, floor, covered, x, y, edge, col, sill, width):
    height = (sill-2-y)/max(40., .73*(sill-y.min()))
    observed = np.clip((gray-floor)/np.maximum(25, 252-floor), 0, 1)
    known = ~covered & (x < edge-2) & (y < sill-1) & (x > col-4) & (x < col+width+5)
    if known.sum() < 65:
        return
    lip = col-.75
    def optical(params):
        start, slope, curvature, span, taper = params
        left = start+slope*height+curvature*height**2
        right = left+span+taper*height
        return np.clip((x-left+.6)/1.3, 0, 1)*np.clip((right-x+.6)/1.3, 0, 1)
    def loss(p):
        return np.r_[(optical(p)-observed)[known], (p[0]-lip)*.95, p[1]*.19, (p[2]-1.5)*.16,
                     (p[3]-width)*.6, p[4]*.35]
    params = least_squares(loss, [lip, 0, 1.5, width, 0],
                           bounds=([col-2.7, -2.7, 0, width-1.6, -1.8],
                                   [col+.7, 3.1, 4.8, width+1.8, 1.8]),
                           loss="soft_l1", f_scale=.28).x
    alpha = optical(params)*np.clip((edge-x-.8)/1.8, 0, 1)
    witnesses = ~covered & (alpha > .65) & (y < sill-1)
    if (witnesses.sum() >= 14 and (gray[witnesses] > 213).mean() >= .82
            and (gray[witnesses] < 185).mean() <= .045):
        # Preserve the gray horizontal joint immediately above the sill.
        left = params[0]+params[1]*height+params[2]*height**2
        return alpha, left, witnesses


def exposed_outer_pen(source, covered, x, y, lip, front, width):
    """A partly exposed outer pen independently fixes the full rib width.
    Its white inner shoulder and screened exterior must repeat across rows."""
    gray = source.mean(2)
    reach = x-lip
    candidates = np.argwhere(~covered & (reach > width-1) & (reach < width+8) & (x < front-3))
    points = []
    for row, col in candidates:
        if row == 0 or row+3 >= len(y) or col < 3 or col+6 >= gray.shape[1]:
            continue
        profile = gray[row, col-3:col+6]
        stock = np.median(profile[5:])
        if (not 80 < stock < 222 or profile[3] >= min(158, stock-33) or min(profile[:2]) < 224
                or covered[row, col+1:col+6].mean() > .2 or profile[3] > min(profile[2:5])+10):
            continue
        points.append((row, col, reach[row, col]))
    if len(points) < 4:
        return
    points = np.asarray(points)
    def compatible(p):
        return (abs(points[:, 0]-p[0]) <= 8) & (abs(points[:, 2]-p[2]) < .8)
    anchor = max(points, key=lambda p: compatible(p).sum())
    group = points[compatible(anchor)]
    rows, cols = group[:, :2].astype(int).T
    if len(np.unique(rows)) < 4:
        return
    # Hold out alternating rows when checking edge position and nib density.
    widths, relative_ink = [], []
    for select in (rows % 2 == 0, rows % 2 != 0):
        if select.sum() < 2:
            return
        ry, cx = rows[select], cols[select]
        widths.append(np.median(group[select, 2]))
        stock = np.median(gray[ry[:, None], cx[:, None]+np.arange(2, 6)], axis=1)
        relative_ink.append(np.median(gray[ry, cx]/stock))
    if abs(widths[0]-widths[1]) < .8 and abs(relative_ink[0]-relative_ink[1]) < .13:
        return lip+np.median(group[:, 2]), np.mean(relative_ink)


def restore_glass_ribs(source, mask, output, opaque):
    ys, xs = np.where(mask)
    if (not len(xs) or mask.size > 1_500_000 or xs.min() <= 45 or not 28 <= np.ptp(xs) <= 135
            or not 48 <= np.ptp(ys) < 220 or np.ptp(ys) <= 1.15*np.ptp(xs)):
        return False
    if not opaque.all() or np.quantile(np.ptp(source, axis=2), .99) > 12:
        return False
    original = source.mean(2)
    gray = gaussian_filter(original, .65)
    decoded = output.mean(2)
    field = gaussian_filter(decoded, .9)
    sill = find_sill(field, mask, xs, ys)
    if sill is None:
        return False
    peers, interrupted = exposed_ribs(gray, mask, xs, sill)
    for col, partial in interrupted:
        nearby = [p for p in peers if 30 < col-p[0] < 155]
        if not nearby:
            continue
        base = round(sill[1]+sill[0]*col)
        front = foreground_curve(field, gray, mask, col, base)
        if front is None:
            continue
        curve, top = front
        left = max(0, col-7)
        area = np.s_[top:base+2, left:col+21]
        y, x = np.indices(mask[area].shape)
        y, x = y+top, x+left
        width = np.clip(max(partial+1, max(nearby, key=lambda p: p[1])[2]), 4, 11)
        local_tone = gaussian_filter(decoded, 2.2)[area]
        fit = fit_rib(gray[area], local_tone, mask[area],
                      x, y, curve(y), col, base, width)
        if fit is None:
            continue
        alpha, lip, exposed = fit
        front_weight = np.clip((curve(y)-x-.8)/1.8, 0, 1)
        outer = exposed_outer_pen(source[area], mask[area], x, y, lip, curve(y), width)
        nib = np.zeros_like(alpha)
        if outer is not None:
            right, density = outer
            alpha = np.clip((x-lip+.6)/1.3, 0, 1)*np.clip((right-x-.18)/1.63, 0, 1)*front_weight
            nib = np.exp(-.5*((x-right)/.78)**2)*front_weight
        until_joint = np.clip(base-2-y, 0, 1)
        alpha *= until_joint
        nib *= until_joint
        write = mask[area] & (np.maximum(alpha, nib) > .01)
        pigment = np.quantile(source[area][exposed], .68, axis=0)
        before = output[area][write].astype(float)
        after = before+(pigment-before)*alpha[write, None]
        if outer is not None:
            stock = np.clip(local_tone[write]*density, 15, 200)
            after += (stock[:, None]-after)*nib[write, None]
        output[area][write] = np.rint(after).clip(0, 255).astype("u1")
        return write.any()
    return False
