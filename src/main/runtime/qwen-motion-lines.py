"""Reconnect converging ink lines through a white-keylined brush effect at scan resolution."""
import itertools
import sys

import numpy as np
from PIL import Image
from scipy.ndimage import binary_dilation, distance_transform_edt, find_objects, label, map_coordinates


def brush_holes(gray, stencil):
    ink = gray < 142
    labels, _ = label(ink, np.ones((3, 3), bool))
    radius = distance_transform_edt(ink)
    glyphs = np.zeros_like(ink)
    count = 0
    for index, box in enumerate(find_objects(labels), 1):
        component = labels[box] == index
        if (component.sum() >= 75 and stencil[box][component].mean() >= .97
                and radius[box][component].max() > 4.2):
            glyphs[box] |= component
            count += 1
    if 2 <= count <= 16:
        return (distance_transform_edt(~glyphs) < 7.5) & stencil


def dark_runs(column, excluded):
    transitions = np.flatnonzero(np.diff(np.r_[False, (column < 135) & ~excluded, False]))
    for top, bottom in transitions.reshape(-1, 2):
        if not top or bottom >= len(column) or bottom-top > 18 or excluded[top-1:bottom+1].any():
            continue
        high = top-1 + (column[top-1]-127) / max(1., column[top-1]-column[top])
        low = bottom-1 + (127-column[bottom-1]) / max(1., column[bottom]-column[bottom-1])
        yield (high+low)/2, low-high


def trace_strokes(gray, holes):
    blocked = binary_dilation(holes, np.ones((5, 5), bool))
    active, finished = [], []
    for x in range(gray.shape[1]):
        following = []
        for y, width in dark_runs(gray[:, x], blocked[:, x]):
            matches = [i for i, group in enumerate(active)
                       if abs(group[-1][1]-y) <= 1.8 and abs(group[-1][2]-width) <= 2.2]
            group = active.pop(matches[0]) if len(matches) == 1 else []
            group.append((x, y, width))
            following.append(group)
        finished.extend(active)
        active = following
    finished.extend(active)
    tracks = []
    for group in finished:
        if len(group) < 14:
            continue
        x, y, widths = np.asarray(group).T
        slope, offset = np.polyfit(x, y, 1)
        if .29 < abs(slope) < .9 and np.max(np.abs(slope*x+offset-y)) < 1.8:
            tracks.append((x.mean(), y.mean(), slope, len(group), np.median(widths), x[0], x[-1]))
    return np.asarray(tracks)


def measured_field(tracks):
    if len(tracks) < 8:
        return
    # Fit dy/dx = a + bx + cy. Parallel strokes are locally straight, while
    # their inclination changes smoothly through a fan. Reject unrelated edges.
    weights = np.sqrt(tracks[:, 3])
    basis = np.column_stack((np.ones(len(tracks)), tracks[:, :2]/300))
    slopes = tracks[:, 2]
    seeds = np.argsort(-weights)[:32]
    best, coefficients = 0, None
    for sample in itertools.combinations(seeds, 3):
        idx = list(sample)
        try:
            fit = np.linalg.solve(basis[idx], slopes[idx])
        except np.linalg.LinAlgError:
            continue
        if np.max(np.abs(fit[1:])) > 1.5:
            continue
        error = np.abs(basis @ fit-slopes)
        support = weights @ np.maximum(0, 1-(error/.035)**2)
        if support > best:
            best, coefficients = support, fit
    if coefficients is None:
        return
    for _ in range(4):
        close = np.abs(basis @ coefficients-slopes) < .045
        if close.sum() < 8:
            return
        coefficients = np.linalg.lstsq(basis[close]*weights[close, None],
                                        slopes[close]*weights[close], rcond=None)[0]
    if np.ptp(slopes[close]) < .10 or np.ptp(tracks[close, 0]) < 48:
        return
    return coefficients / [1., 300., 300.], tracks[close]


def follow(field, x, y, dx):
    a, b, c = field
    slope = a+b*x+c*y
    if abs(c) < 1e-7:
        return y+dx*slope+.5*b*dx*dx
    curve = np.expm1(c*dx)
    return y+slope*curve/c+b*(curve-c*dx)/(c*c)


def supported_band(x, y, field, tracks):
    left = np.zeros(len(x), bool)
    right = np.zeros(len(x), bool)
    for cx, cy, _, _, width, start, end in tracks:
        nearby = np.abs(y-follow(field, cx, cy, x-cx)) < width/2+15
        left |= nearby & (x > start)
        right |= nearby & (x < end)
    return left & right


def remaining_ink_follows_lines(gray, stencil, holes, field):
    labels, _ = label(gray < 142, np.ones((3, 3), bool))
    for index, box in enumerate(find_objects(labels), 1):
        component = labels[box] == index
        if (component.sum() < 6 or stencil[box][component].mean() < .94
                or holes[box][component].mean() > .98):
            continue
        y, x = np.nonzero(component & ~holes[box])
        if len(x) < 6:
            continue
        x, y = x+box[1].start, y+box[0].start
        if np.ptp(x) < 7 or np.mean(np.abs(y-follow(field, x.mean(), y.mean(), x-x.mean()))) > 2.2:
            return False
    return True


def read_bank(gray, safe, field, x, y, sign):
    height, width = gray.shape
    distance = np.zeros(len(x))
    for step in range(1, min(196, width)):
        missing = np.flatnonzero(distance == 0)
        if not len(missing):
            break
        xx = x[missing]+sign*step
        yy = np.rint(follow(field, x[missing], y[missing], sign*step)).astype(int)
        inside = (xx > 2) & (xx < width-3) & (yy > 2) & (yy < height-3)
        idx = missing[inside]
        distance[idx[safe[yy[inside], xx[inside]]]] = step
    dx = sign*(distance+1.2)
    samples = np.stack([map_coordinates(gray, [follow(field, x, y+offset, dx), x+dx],
                                        order=1, mode="nearest") for offset in range(-8, 9)])
    return distance, samples


def interpolate(samples, shift):
    index = shift+8
    lo = np.floor(index).astype(int)
    columns = np.arange(len(index))
    weight = index-lo
    return (1-weight)*samples[lo, columns]+weight*samples[lo+1, columns]


def join_banks(left, right, dl, dr):
    shifts = np.arange(-3, 3.01, .25)
    scores = []
    for shift in shifts:
        indices = np.arange(4, 13)+shift
        lo = np.floor(indices).astype(int)
        w = (indices-lo)[:, None]
        shifted = (1-w)*left[lo]+w*left[lo+1]
        scores.append(np.abs(shifted-right[4:13]).mean(axis=0)+3*abs(shift))
    phase = shifts[np.argmin(scores, axis=0)]
    t = dl/np.maximum(1, dl+dr)
    a, b = interpolate(left, t*phase), interpolate(right, -(1-t)*phase)
    mismatch = .7*np.minimum(1, np.abs(a-b)/80)
    return (1-mismatch)*((1-t)*a+t*b)+mismatch*np.where(dl < dr, a, b)


def repair(source, mask, prediction):
    if (source.shape != prediction.shape or source.shape[:2] != mask.shape
            or max(mask.shape) > 1024 or mask.sum() < 300):
        return
    if np.ptp(source, axis=2).max() > 8:
        return
    gray = source.mean(axis=2, dtype=np.float32)
    holes = brush_holes(gray, mask)
    if holes is None or holes.sum() > 100000:
        return
    fit = measured_field(trace_strokes(gray, holes))
    if fit is None:
        return
    field, tracks = fit
    if not remaining_ink_follows_lines(gray, mask, holes, field):
        return
    y, x = np.nonzero(mask)
    band = supported_band(x, y, field, tracks)
    y, x = y[band], x[band]
    within = holes[y, x]
    yy, xx = y[within], x[within]
    if len(xx) < 100:
        return
    safe = ~binary_dilation(holes, np.ones((3, 3), bool))
    dl, left = read_bank(gray, safe, field, xx, yy, -1)
    dr, right = read_bank(gray, safe, field, xx, yy, 1)
    valid = (dl > 0) & (dr > 0)
    tone = join_banks(left[:, valid], right[:, valid], dl[valid], dr[valid])
    yy, xx = yy[valid], xx[valid]
    ink = tone < 115
    # Leave complete artwork alone. Repair only where multiple visible banks
    # predict substantial ink that is missing from the decoded crop.
    if ink.sum() < 96 or (prediction[yy[ink], xx[ink]].mean(axis=1) > 175).mean() < .43:
        return
    # The compositor feathers outside the stencil. Feed it the native scan
    # there and between isolated glyphs, including the original pen endpoints.
    out = source.copy()
    out[holes] = prediction[holes]
    out[yy, xx] = np.rint(tone).clip(0, 255).astype('uint8')[:, None]
    return out


if __name__ == "__main__":
    src, mask, decoded, output = sys.argv[1:5]
    original, prediction = (np.array(Image.open(path).convert("RGB")) for path in (src, decoded))
    result = repair(original, np.array(Image.open(mask).convert("L")) > 0, prediction)
    if result is None:
        print("unchanged")
    else:
        Image.fromarray(result).save(output)
        print("applied")
