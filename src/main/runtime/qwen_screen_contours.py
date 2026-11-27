"""Continue an inked, screened form across an independently identified white-backed word."""
from pathlib import Path
from runpy import run_path

import numpy as np
from scipy.ndimage import (binary_fill_holes, convolve, distance_transform_edt as distance,
                           find_objects, gaussian_filter, label, map_coordinates)
from scipy.spatial import cKDTree


def brush_distance(gray, selected):
    rows, cols = np.where(selected)
    if not 2300 <= len(cols) <= 54000 or np.ptp(cols) < max(105, 1.7*np.ptp(rows)):
        return
    groups, _ = label(gaussian_filter(gray, .65) < 166, np.ones((3, 3)))
    ink = np.zeros_like(selected)
    count = 0
    for index, box in enumerate(find_objects(groups), 1):
        stroke = groups[box] == index
        if not 140 < stroke.sum() < 14000 or selected[box][stroke].mean() <= .94:
            continue
        depth = distance(np.pad(stroke, 1))[1:-1, 1:-1]
        if (depth[stroke] > 2.5).mean() <= .13:
            continue
        ink[box] |= binary_fill_holes(stroke)
        count += 1
    if 4 <= count <= 30 and ink.sum() >= .34*selected.sum():
        return distance(~ink)


def pen_ends(gray, clearance, tracing):
    skeleton = tracing["centre_lines"]((gray < 148) & (clearance > 3.1))
    degree = convolve(skeleton, np.ones((3, 3), "u1"))
    ends = []
    for y, x in zip(*np.where((degree == 2) & (skeleton > 0) & (clearance < 11))):
        if min(x, y, gray.shape[1]-x, len(gray)-y) < 12:
            continue
        trail = tracing["follow_branch"](skeleton, y, x)[:, ::-1]
        if len(trail) < 6:
            continue
        tip = trail[0].astype(float)
        neighbours = trail[1:8]
        tangent = tip-neighbours[1:].mean(0)
        length = np.linalg.norm(tangent)
        if length < 1.65:
            continue
        tangent /= length
        offsets = neighbours-tip
        deviation = abs(offsets[:, 0]*tangent[1]-offsets[:, 1]*tangent[0])
        if np.median(deviation) < .9 and np.median(gray[tuple(neighbours.T[::-1])]) <= 131:
            ends.append((tip, tangent, trail))
    return ends


def sample_bank(gray, clearance, trail, normal):
    points = (trail[None, 1:9] + np.arange(3, 12)[:, None, None]*normal).reshape(-1, 2).T[::-1]
    known = map_coordinates(clearance, points, order=1) > 4.25
    if known.sum() < 8:
        return
    values = map_coordinates(gray, points[:, known], order=1)
    return values.mean(), (values < 222).mean(), values.std()


def screened_side(gray, clearance, first, second):
    _, v, a = first
    _, w, b = second
    normals = np.array([[-v[1], v[0]], [w[1], -w[0]]])
    banks = [[sample_bank(gray, clearance, trail, sign*n) for trail, n in zip((a, b), normals)]
             for sign in (1, -1)]
    for sign, paper, stock in ((1, banks[1], banks[0]), (-1, banks[0], banks[1])):
        visible = [side for side in paper if side is not None]
        if not visible or any(side is None for side in stock):
            continue
        if (min(side[0] for side in visible) < 240 or max(side[1] for side in visible) > .13
                or min(side[2] for side in stock) < 13 or min(side[1] for side in stock) < .09
                or max(side[1] for side in stock) < .39):
            continue
        if min(p[0]-s[0] for p, s in zip(paper, stock) if p is not None) >= 18:
            return sign


def contour_pairs(gray, clearance, tracing):
    ends = pen_ends(gray, clearance, tracing)
    if len(ends) < 4:
        return []
    pairs = []
    for i, j in sorted(cKDTree([p for p, _, _ in ends]).query_pairs(52)):
        p, v, _ = ends[i]
        q, w, _ = ends[j]
        span = np.linalg.norm(q-p)
        if span < 15:
            continue
        axis = (q-p)/span
        if min(v@axis, -w@axis) < .78 or -v@w < .54:
            continue
        t = np.linspace(0, 1, int(span*3))[:, None]
        path = ((2*t**3-3*t*t+1)*p+(t**3-2*t*t+t)*span*v
                +(-2*t**3+3*t*t)*q-(t**3-t*t)*span*w)
        crossing = map_coordinates(clearance, path.T[::-1], order=1)
        middle = crossing[len(t)//5:-len(t)//5]
        if middle.min() > 4.7 or (middle < 6.5).mean() < .7 or crossing.max() > 11.5:
            continue
        side = screened_side(gray, clearance, ends[i], ends[j])
        if side is not None:
            pairs.append((ends[i], ends[j], path, side))
    return pairs


def contour_window(shape, first, second, path, sign):
    nodes = np.concatenate((first[2][1:12][::-1], path, second[2][1:12]))
    nodes = nodes[np.r_[True, np.linalg.norm(np.diff(nodes, axis=0), axis=1) > .12]]
    tangent = np.gradient(nodes, axis=0)
    tangent /= np.maximum(.001, np.linalg.norm(tangent, axis=1))[:, None]
    normal = sign*np.stack((-tangent[:, 1], tangent[:, 0]), 1)
    step = np.r_[0, np.cumsum(np.linalg.norm(np.diff(nodes, axis=0), axis=1))]
    y0, x0 = np.maximum(0, np.floor(nodes.min(0)[::-1]).astype(int)-24)
    y1, x1 = np.minimum(shape, np.ceil(nodes.max(0)[::-1]).astype(int)+25)
    y, x = np.indices((y1-y0, x1-x0))
    points = np.column_stack(((x+x0).ravel(), (y+y0).ravel()))
    reach, index = cKDTree(nodes).query(points)
    lateral = np.sum((points-nodes[index])*normal[index], axis=1)
    return np.s_[y0:y1, x0:x1], lateral.reshape(x.shape), step[index].reshape(x.shape), reach.reshape(x.shape), step[-1]


def fitted_screen(gray, bank, frequencies):
    by, bx = np.where(bank)
    if len(bx) < 100:
        return
    y, x = np.indices(gray.shape)
    u, v = (x-bx.mean())/20, (y-by.mean())/20
    polynomial = np.stack((np.ones_like(u), u, v, u*u, u*v, v*v), axis=-1)
    observed = gray[bank]
    def solve(design, values, penalty):
        return np.linalg.solve(design.T@design+np.diag(penalty), design.T@values)
    damping = [.01, 2, 2, 17, 17, 17]
    field = polynomial@solve(polynomial[bank], observed, damping)
    axes = frequencies(np.column_stack((bx, by)), (gray-field)[bank], gray.shape)
    if len(axes) < 2:
        return
    waves = []
    for fx, fy in axes[:5]:
        phase = 2*np.pi*(x*fx+y*fy)
        waves.extend((np.cos(phase), np.sin(phase)))
    design = np.concatenate((polynomial, np.stack(waves, -1)), axis=-1)
    weights = damping + [3.]*len(waves)
    held = (bx//5+2*(by//4)) % 4 == 1
    if min(held.sum(), (~held).sum()) < 24:
        return
    projected = design[bank][held]@solve(design[bank][~held], observed[~held], weights)
    truth = observed[held]
    if min(truth.std(), projected.std()) < 3 or np.corrcoef(projected, truth)[0, 1] < .6:
        return
    if abs(projected-truth).mean() > .81*abs(np.median(truth)-truth).mean():
        return
    return np.clip(design@solve(design[bank], observed, weights), max(120, np.quantile(observed, .012)-7), 255)


def measured_form(gray, clearance, candidate, frequencies):
    box, lateral, arc, reach, length = contour_window(gray.shape, *candidate)
    original, dist = gray[box], clearance[box]
    bank = (dist > 4.8) & (lateral > 2.8) & (lateral < 17) & (reach < 18) & (arc > 1) & (arc < length-1)
    pen = (gaussian_filter(original, .65) < 133) & (dist > 4.2)
    tissue = fitted_screen(original, bank & (distance(~pen) > 1.7), frequencies)
    if tissue is None:
        return
    taper = np.clip((arc-1)/5, 0, 1)*np.clip((length-arc-1)/5, 0, 1)
    width = np.clip((22-lateral)/6, 0, 1)*np.clip((lateral+2)/1.35, 0, 1)*taper
    weight = width*np.clip((5.45-dist)/1.35, 0, 1)*np.clip((24-reach)/6, 0, 1)
    exposed = np.clip((dist-4.4)/1.2, 0, 1)*np.clip((22-reach)/4, 0, 1)
    exposed[(dist > 2.4) & (original < 193) & (reach < 20)] = 1
    return box, tissue, weight, exposed


def restore_screened_contours(source, mask, output, opaque, frequencies):
    if not mask.any() or mask.size > 1_500_000:
        return False
    y, x = np.where(mask)
    if np.ptp(x) < max(105, 1.7*np.ptp(y)) or len(x) < 2300:
        return False
    box = np.s_[max(0, y.min()-32):y.max()+33, max(0, x.min()-32):x.max()+33]
    source, mask, output, opaque = source[box], mask[box], output[box], opaque[box]
    if not opaque.all() or (np.ptp(source, axis=2) > 6).mean() > .01:
        return False
    gray = source.mean(2)
    clearance = brush_distance(gray, mask)
    if clearance is None:
        return False
    tracing = run_path(str(Path(__file__).with_name("qwen-reconnect-balloon.py")))
    pairs = contour_pairs(gray, clearance, tracing)
    groups = []
    for i, item in enumerate(pairs):
        tips = np.stack([item[0][0], item[1][0]])
        # Two distinct sides of a screened form must meet. A solitary dark
        # pen ending near print may instead be a detached motion mark.
        for other in pairs[i+1:]:
            peer = np.stack([other[0][0], other[1][0]])
            gap = np.linalg.norm(tips[:, None]-peer, axis=2).min()
            if not 3 < gap < 29 or abs(item[0][1]@other[0][1]) > .83:
                continue
            yes, also = (measured_form(gray, clearance, pair, frequencies) for pair in (item, other))
            if yes is not None and also is not None:
                groups.extend(((item, yes), (other, also)))
    if not groups:
        return False
    before = output.copy()
    for _, (area, field, weight, _) in groups:
        old = output[area].astype(float)
        output[area] = np.rint(old+(field[:, :, None]-old)*weight[:, :, None]).astype("u1")
    for (first, second, path, _), _ in groups:
        tracing["draw_measured_pen"](source, output, path, first, second, clearance < 7.7)
    for _, (area, _, _, amount) in groups:
        old = output[area].astype(float)
        output[area] = np.rint(old+(source[area]-old)*amount[:, :, None]).astype("u1")
    return bool(np.any(before != output))
