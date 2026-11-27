"""Continue a printed panel gutter through a wide, measured sound-effect outline."""
import numpy as np
from scipy.ndimage import binary_opening, distance_transform_edt
from scipy.signal import find_peaks


def thin_pen_centres(gray, exposed):
    # Work column-major so the two transitions enclosing each stripe are paired.
    dark = np.pad((gray < 121).T, ((0, 0), (1, 1)))
    columns, starts = np.where(~dark[:, :-1] & dark[:, 1:])
    _, stops = np.where(dark[:, :-1] & ~dark[:, 1:])
    good = (stops-starts >= 2) & (stops-starts <= 7) & (starts >= 4) & (stops+4 <= len(gray))
    x, a, b = columns[good], starts[good], stops[good]
    left = np.median(gray[a[:, None]-np.arange(2, 5), x[:, None]], axis=1)
    right = np.median(gray[b[:, None]+np.arange(1, 4), x[:, None]], axis=1)
    good = exposed[(a+b)//2, x] & (np.minimum(left, right) >= 231)
    x, a, b = x[good], a[good], b[good]
    rows = np.minimum(len(gray)-1, a[:, None]+np.arange(-1, 8))
    ink = np.maximum(0, 249-gray[rows, x[:, None]])*(rows <= b[:, None])
    mass = ink.sum(1)
    return (rows*ink).sum(1)/np.maximum(1, mass), x, mass


def measured_profile(gray, columns, slope, intercept):
    line = columns*slope+intercept
    rows = np.rint(line).astype(int)+np.arange(-6, 7)[:, None]
    if rows.min() < 0 or rows.max() >= len(gray):
        return
    phase = (rows-line).ravel()
    native = gray[rows, columns].ravel()
    held = np.broadcast_to(columns//5 % 4 == 1, rows.shape).ravel()
    if min(held.sum(), (~held).sum()) < 40:
        return
    grid = np.linspace(-6, 6, 97)
    weight = np.exp(-.5*((phase-grid[:, None])/.21)**2)
    def density(weights, values):
        return (weights @ values)/np.maximum(1e-8, weights.sum(1))
    predicted = np.interp(phase[held], grid, density(weight[:, ~held], native[~held]))
    if np.quantile(abs(native[held]-predicted), .90) < 26:
        return grid, density(weight, native)


def original_rules(gray, exposed, axis):
    y, x, ink = thin_pen_centres(gray, exposed)
    if len(x) < 80:
        return []
    width = gray.shape[1]
    center = (width-1)/2
    seeds = []
    for slope in np.arange(-.34, .341, .004):
        offsets = np.rint(y-slope*(x-center)).astype(int)
        low = offsets.min()
        votes = np.bincount(offsets-low)
        peaks = find_peaks(np.r_[0, votes, 0], height=max(48, .125*width), distance=3)[0]-1
        seeds.extend((votes[k], slope, k+low) for k in peaks)
    rules = []
    for _, slope, middle in sorted(seeds, reverse=True):
        if any(abs(slope-p["slope"]) < .012 and abs(middle-p["middle"]) < 2.8 for p in rules):
            continue
        near = abs(y-(slope*(x-center)+middle)) <= 1.5
        for _ in range(3):
            if near.sum() < 55:
                break
            slope, middle = np.polyfit(x[near]-center, y[near], 1)
            near = abs(y-(slope*(x-center)+middle)) <= .82
        columns = np.unique(x[near])
        if len(columns) < max(55, .15*width) or np.ptp(columns) < 80 or np.median(ink[near]) < 345:
            continue
        groups = [v for v in np.split(columns, np.flatnonzero(np.diff(columns) > 3)+1) if len(v) >= 8]
        if (not groups or max(map(len, groups)) < 38
                or np.quantile(abs(y[near]-slope*(x[near]-center)-middle), .88) > .67
                or any(abs(slope-p["slope"]) < .004 and abs(middle-p["middle"]) < 2 for p in rules)):
            continue
        offset = middle-slope*center
        profile = measured_profile(gray, columns, slope, offset)
        if profile is not None:
            rules.append(dict(axis=axis, slope=slope, middle=middle, offset=offset, columns=columns,
                              profile=profile, first=groups[0][0], last=groups[-1][-1], ink=np.median(ink[near])))
    return rules


def ruled_corner(pair, cross, mask):
    corners = []
    for rule in pair:
        y = (cross["slope"]*rule["offset"]+cross["offset"])/(1-cross["slope"]*rule["slope"])
        x = rule["slope"]*y+rule["offset"]
        edge = min(("first", "last"), key=lambda end: abs(cross[end]-x))
        gap = (x-cross[edge])*(1 if edge == "last" else -1)
        if 2 < gap < 70 and np.min(abs(rule["columns"]-y)) <= 110:
            corners.append((gap, x, y, rule, edge))
    if not corners:
        return
    _, x, y, rule, edge = min(corners, key=lambda c: c[0])
    span = np.arange(round(min(cross[edge], x)), round(max(cross[edge], x))+1)
    rows = np.rint(cross["slope"]*span+cross["offset"]).astype(int)
    if rows.min() < 0 or rows.max() >= len(mask) or span.min() < 0 or span.max() >= mask.shape[1]:
        return
    if mask[rows, span].mean() < .47:
        return
    cross["active"] = True
    cross[edge] = x+(1.6 if edge == "last" else -1.6)
    rule["first"], rule["last"] = min(rule["first"], y-1.6), max(rule["last"], y+1.6)


def match_gutters(rules, gray, mask):
    for axis in (0, 1):
        primary = [p for p in rules if p["axis"] == axis]
        tone = gray.T if axis else gray
        for index, first in enumerate(primary):
            for second in primary[index+1:]:
                if (abs(first["slope"]-second["slope"]) > .003 or abs(first["ink"]-second["ink"]) > 100
                        or not 9 < abs(first["middle"]-second["middle"]) < 36):
                    continue
                x = np.intersect1d(first["columns"], second["columns"])
                if len(x) < 48:
                    continue
                a, b = [q["slope"]*x+q["offset"] for q in (first, second)]
                paper = tone[np.rint(a+np.array([.25, .5, .75])[:, None]*(b-a)).astype(int), x]
                if (paper >= 245).mean() < .94:
                    continue
                first["active"] = second["active"] = True
                for cross in rules:
                    if cross["axis"] != axis:
                        ruled_corner((first, second), cross, mask if axis else mask.T)


def restore_gutter_rules(source, mask, result, allowed, opaque):
    y, x = np.where(mask)
    if not 3200 <= x.size <= 105000 or min(np.ptp(x), np.ptp(y)) < 110:
        return False
    region = np.s_[max(0, y.min()-190):y.max()+191, max(0, x.min()-190):x.max()+191]
    source, mask, result = source[region], mask[region], result[region]
    if mask.size > 980000 or np.mean(np.ptp(source[:, :, :3], axis=2) > 7) > .015:
        return False
    gray = source[:, :, 1].astype("f")
    distance = distance_transform_edt(~mask)
    known = (distance > 2) & opaque[region]
    rules = original_rules(gray, known, 0)+original_rules(gray.T, known.T, 1)
    match_gutters(rules, gray, mask)
    # At a corner the two ruling profiles overlap. Use the darker ink once.
    pen = np.full(mask.shape, np.inf, dtype="f")
    changed = np.any(result[:, :, :3] != source[:, :, :3], axis=2)
    writable = allowed[region] & opaque[region] & (distance <= 2.5) & (mask | changed)
    for rule in rules:
        if not rule.get("active"):
            continue
        field, selected = (pen.T, writable.T) if rule["axis"] else (pen, writable)
        columns = np.arange(max(0, int(np.ceil(rule["first"]))), min(field.shape[1], int(rule["last"])+1))
        line = rule["slope"]*columns+rule["offset"]
        rows = np.rint(line).astype(int)+np.arange(-5, 6)[:, None]
        within = (rows >= 0) & (rows < len(field))
        rows = rows.clip(0, len(field)-1)
        phase = rows-line
        native, clear = (gray.T, known.T) if rule["axis"] else (gray, known)
        through_paper = (native[rows[5], columns] >= 231) & clear[rows[5], columns]
        interval = binary_opening(through_paper, structure=np.ones(4, dtype=bool))
        use = within & selected[rows, columns] & (abs(phase) <= 5) & ~interval
        sy, sx = rows[use], np.broadcast_to(columns, rows.shape)[use]
        field[sy, sx] = np.minimum(field[sy, sx], np.interp(phase[use], *rule["profile"]))
    write = np.isfinite(pen)
    result[write, :3] = np.rint(pen[write, None]).clip(0, 255).astype("u1")
    return bool(write.any())
