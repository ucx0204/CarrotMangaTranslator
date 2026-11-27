"""Recover an occluded outline from the two original pen ends at a dialogue column."""
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import convolve, distance_transform_edt, find_objects, gaussian_filter, label, map_coordinates, maximum_filter1d, minimum_filter
from scipy.spatial import cKDTree


NEIGHBOURS = ((-1, 0), (-1, 1), (0, 1), (1, 1), (1, 0), (1, -1), (0, -1), (-1, -1))


def centre_lines(original):
    # Zhang–Suen thinning. Remove only simple boundary points and preserve endpoints.
    field = original.astype(np.uint8)
    field[[0, -1], :] = 0
    field[:, [0, -1]] = 0
    while True:
        changed = False
        for phase in (0, 1):
            n = [np.roll(field, (-y, -x), (0, 1)) for y, x in NEIGHBOURS]
            count = sum(n)
            transitions = sum((n[i] == 0) & (n[(i+1) % 8] != 0) for i in range(8))
            simple = (field != 0) & (count >= 2) & (count <= 6) & (transitions == 1)
            for triple in (((0, 2, 4), (2, 4, 6)) if phase == 0 else ((0, 2, 6), (0, 4, 6))):
                simple &= (n[triple[0]] * n[triple[1]] * n[triple[2]]) == 0
            if simple.any():
                field[simple] = 0
                changed = True
        if not changed:
            return field


def follow_branch(field, row, col):
    trail = [(row, col)]
    previous = None
    while len(trail) < 28:
        y, x = trail[-1]
        steps = [(dy, dx) for dy, dx in NEIGHBOURS if field[y+dy, x+dx] and (y+dy, x+dx) not in trail]
        if not steps:
            break
        if len(steps) > 1:
            if previous is None:
                break
            scores = [sy*previous[0]+sx*previous[1] for sy, sx in steps]
            if max(scores) <= 0:
                break
            step = steps[int(np.argmax(scores))]
        else:
            step = steps[0]
        trail.append((y+step[0], x+step[1]))
        previous = step
    return np.asarray(trail)


def visible_ends(gray, distance):
    native = (gray < 137) & (distance > 2)
    field = centre_lines(native)
    degree = convolve(field, np.ones((3, 3), np.uint8), mode="constant")
    radius = distance_transform_edt(native)
    ends = []
    for y, x in zip(*np.where((field > 0) & (degree == 2) & (distance < 21))):
        trail = follow_branch(field, y, x)
        if len(trail) < 10:
            continue
        vector = trail[0] - trail[min(10, len(trail)-1)]
        direction = vector / np.linalg.norm(vector)
        long = trail[0] - trail[-1]
        width = np.median(radius[tuple(trail[2:].T)])
        ink = np.mean(gray[tuple(trail[:3].T)])
        if width <= 5 and direction @ long >= .88*np.linalg.norm(long) and ink < 105:
            ends.append((np.array([x, y]), direction[::-1], width, len(trail), distance[y, x]))
    return ends


def bridge(first, second, ends, distance, letters, paper):
    p, v, width, length, inset = first
    q, w, other_width, other_length, other_inset = second
    span = np.linalg.norm(q-p)
    if not 20 < span < 165 or min(length, other_length) < 20:
        return
    if abs(width-other_width) > 1 or abs(inset-other_inset) > 6:
        return
    axis = (q-p)/span
    if min(v @ axis, -w @ axis) < .87 or -v @ w < .6:
        return
    # Additional independent cuts along the same printed column distinguish an
    # opaque text backing from a deliberately open balloon or two loose hair tips.
    mid = (p+q)/2
    normal = np.array([-axis[1], axis[0]])
    witness = sum(1 for end in ends if end is not first and end is not second and end[4] < 17
                  and abs((end[0]-mid) @ axis) < 1.35*span and abs((end[0]-mid) @ normal) < 38)
    if witness < 2:
        return
    t = np.linspace(0, 1, int(2*span+1))[:, None]
    points = ((2*t**3-3*t*t+1)*p + (t**3-2*t*t+t)*span*v
              + (-2*t**3+3*t*t)*q - (t**3-t*t)*span*w)
    yy, xx = np.rint(points).astype(int).T[::-1]
    if yy.min() < 0 or yy.max() >= paper.shape[0] or xx.min() < 0 or xx.max() >= paper.shape[1]:
        return
    nearby = distance[yy, xx]
    interior = slice(len(t)//8, -len(t)//8)
    hit = np.unique(letters[yy, xx])
    if (np.mean(nearby <= 13) >= .83 and np.mean(nearby < 2) >= .09 and np.count_nonzero(hit) >= 2
            and np.mean(paper[yy, xx][interior] >= 225) >= .92):
        return points


def pen_profile(source, p, direction, offsets):
    normal = np.array([-direction[1], direction[0]])
    samples = []
    for step in range(2, 10):
        points = p-step*direction+offsets[:, None]*normal
        samples.append(np.stack([map_coordinates(ch, points.T[::-1], order=1)
                                 for ch in source[:, :, :3].astype("f").transpose(2, 0, 1)], 1))
    profile = np.median(samples, axis=0)
    center = offsets[np.argmin(profile.mean(1))]
    return np.stack([np.interp(offsets+center, offsets, ch, left=255, right=255) for ch in profile.T], 1)


def draw_measured_pen(source, edited, path, first, second, opaque):
    offsets = np.arange(-4, 4.001, .125)
    ends = [pen_profile(source, p, d, offsets) for p, d, *_ in (first, second)]
    tangent = np.gradient(path, axis=0)
    tangent /= np.linalg.norm(tangent, axis=1)[:, None]
    left, top = np.maximum(0, np.floor(path.min(0)).astype(int)-4)
    right, bottom = np.minimum(opaque.shape[::-1], np.ceil(path.max(0)).astype(int)+5)
    points = np.stack(np.meshgrid(np.arange(left, right), np.arange(top, bottom)), 2).reshape(-1, 2)
    distance, index = cKDTree(path).query(points)
    select = (distance <= 3.5) & opaque[tuple(points.T[::-1])]
    points, index = points[select], index[select]
    normal = np.stack([-tangent[:, 1], tangent[:, 0]], 1)
    signed = ((points-path[index])*normal[index]).sum(1)
    fraction = index/(len(path)-1)
    weight = np.clip(index/7, 0, 1)*np.clip((len(path)-1-index)/7, 0, 1)
    yy, xx = points.T[::-1]
    for ch in range(3):
        tone = ((1-fraction)*np.interp(signed, offsets, ends[0][:, ch])
                + fraction*np.interp(-signed, offsets, ends[1][:, ch]))
        before = edited[yy, xx, ch]
        edited[yy, xx, ch] = np.rint(np.minimum(before, before*(1-weight)+tone*weight)).astype("u1")


def covered_arc(first, second, gray, distance, letters):
    p, v, width, size, _ = first
    q, w, other_width, other_size, _ = second
    span = np.linalg.norm(q-p)
    if not 63 < span < 230 or min(size, other_size) < 15 or abs(width-other_width) > .65:
        return
    axis = (q-p)/span
    normal = np.array([-axis[1], axis[0]])
    lateral = np.array([v @ normal, w @ normal])
    if (min(v @ axis, -w @ axis) < .76 or lateral.prod() < .065
            or abs(lateral[0]-lateral[1]) > .35):
        return
    t = np.linspace(0, 1, int(2*span)+1)[:, None]
    path = ((2*t**3-3*t*t+1)*p+(t**3-2*t*t+t)*span*v
            +(-2*t**3+3*t*t)*q-(t**3-t*t)*span*w)
    x, y = np.rint(path).astype(int).T
    if min(x.min(), y.min()) < 16 or x.max()+16 >= gray.shape[1] or y.max()+16 >= gray.shape[0]:
        return
    middle = (t[:, 0] > .12) & (t[:, 0] < .88)
    if len(np.unique(letters[y[middle], x[middle]])) < 5 or np.mean(distance[y[middle], x[middle]] < 2) < .25:
        return
    # An actual sliver of exposed pen between the letters must follow this
    # curve, with original unprinted paper on both sides of the sliver.
    trace = middle & (distance[y, x] > 3.2)
    ink = np.full(len(x), 255.)
    for offset in (-1, 0, 1):
        u, z = np.rint(path + offset*normal).astype(int).T
        ink = np.minimum(ink, np.where(distance[z, u] > 3.2, gray[z, u], 255))
    for sign in (-1, 1):
        u, z = np.rint(path + 4*sign*normal).astype(int).T
        trace &= gray[z, u] > 234
        u, z = np.rint(path + 14*sign*normal).astype(int).T
        bank = middle & (distance[z, u] > 3.5)
        if bank.sum() < .11*len(x) or np.quantile(gray[z[bank], u[bank]], .08) < 239:
            return
    if len(np.unique(np.column_stack((x, y))[trace & (ink < 140)], axis=0)) >= 2:
        return path


def paired_terminal_dots(gray, mask, distance):
    ids, _ = label(gray < 185, np.ones((3, 3)))
    stems, dots = [], []
    for k, box in enumerate(find_objects(ids), 1):
        h, w = (s.stop-s.start for s in box)
        if max(h, w) > 31 or not (distance[box] < 5).any():
            continue
        cells = ids[box] == k
        cx = (box[1].start+box[1].stop-1)/2
        if 8 <= h <= 30 and 2 <= w <= .48*h and mask[box][cells].mean() > .50:
            stems.append((cx, box[0].stop, w, h))
        elif max(h, w) <= 6 and 3 <= cells.sum() <= 30:
            dots.append((cx, box[0].start, k, np.any(mask[box] & cells)))
    paired = []
    for x, y, width, length in stems:
        matches = [dot for dot in dots if abs(x-dot[0]) <= max(2.2, .72*width)
                   and 1 <= dot[1]-y <= .62*length]
        if len(matches) == 1:
            paired.append((x, y, width, length, matches[0]))
    keep = []
    for x, y, width, length, dot in paired:
        if any(other[4][3] and .75 < other[3]/length < 1.34 and abs(y-other[1]) < .28*length
               and 1.15*width < abs(x-other[0]) < 3.5*width for other in paired):
            keep.append(dot[2])
    return np.isin(ids, keep)


def restore_arc_stock(source, mask, edited, distance, path, first, second):
    gray = source.mean(2)
    ids, _ = label(gray < 235, np.ones((3, 3)))
    sizes = np.bincount(ids.ravel())
    owned = np.bincount(ids[mask], minlength=len(sizes)) > .38*sizes
    owned &= sizes < 3200
    owned[0] = False
    ink = owned[ids] | (mask & (gray < 235)) | paired_terminal_dots(gray, mask, distance)
    reach = distance_transform_edt(~ink)
    art = distance_transform_edt(~((gray < 235) & ~ink))
    write = (reach < 3.5) & ((art > 1.5) | ink)
    bank = (reach > 3.4) & (gray >= 239) & (art > 1)
    shoulder = (reach > 3.5) & (reach < 8)
    if not bank.any() or not shoulder.any() or bank[shoulder].mean() < .92:
        return False
    mass = gaussian_filter(bank.astype(float), 5)
    mean = np.stack([gaussian_filter(ch*bank.astype(float), 5)/np.maximum(mass, 1e-6)
                     for ch in source.transpose(2, 0, 1)], axis=2)
    wide = mass < .045
    if np.any(wide & write):
        support = gaussian_filter(bank.astype(float), 10)
        if support[wide & write].min() < .05:
            return False
        for c, ch in enumerate(source.transpose(2, 0, 1)):
            extended = gaussian_filter(ch*bank.astype(float), 10)/np.maximum(support, 1e-6)
            mean[:, :, c][wide] = extended[wide]
    # Transplant the fine grain of a real nearby clean patch onto the measured
    # local stock. Prefer the nearest patch on the same scanline or column.
    stock = np.rint(mean).clip(0, 255)
    need = write.copy()
    safe = minimum_filter(bank, 3)
    for step in range(5, 44, 4):
        for dy, dx in [(0, step), (0, -step), (step, 0), (-step, 0)]:
            y, x = np.where(need)
            if not len(x):
                break
            v, u = y+dy, x+dx
            inside = (u >= 0) & (v >= 0) & (u < gray.shape[1]) & (v < gray.shape[0])
            y, x, v, u = y[inside], x[inside], v[inside], u[inside]
            take = safe[v, u] & (np.abs(mean[y, x, 1]-mean[v, u, 1]) < 3)
            y, x, v, u = y[take], x[take], v[take], u[take]
            stock[y, x] = np.clip(np.rint(mean[y, x]+source[v, u]-mean[v, u]), 0, 255)
            need[y, x] = False
    native = source.copy()
    native[write] = stock[write]
    draw_measured_pen(source, native, path, first, second, np.ones(mask.shape, bool))
    # Only the narrow selected text and the independently established pen can
    # restore original pixels over the decoder. Other windows retain their edit.
    influence = (distance < 19) | np.any(native != source, axis=2)
    edited[influence] = native[influence]
    return True


def restore_printed_balloon_arc(source, mask, edited, opaque=None):
    y, x = np.where(mask)
    if not len(x) or not 63 < max(np.ptp(x), np.ptp(y)) < 420:
        return False
    area = np.s_[max(0, y.min()-48):y.max()+49, max(0, x.min()-48):x.max()+49]
    rgb, marked = source[area], mask[area]
    if marked.size > 160_000 or (opaque is not None and not opaque[area].all()):
        return False
    gray = rgb.mean(2)
    dist = distance_transform_edt(~marked)
    shoulder = (dist > 3) & (dist < 11)
    if not shoulder.any() or np.quantile(gray[shoulder], .1) < 235 or np.quantile(np.ptp(rgb[shoulder], axis=1), .9) > 5:
        return False
    ends = visible_ends(gray, dist)
    if not 2 <= len(ends) <= 14:
        return False
    letters, _ = label(marked & (gray < 145), np.ones((3, 3)))
    hits = []
    for i, first in enumerate(ends):
        for second in ends[i+1:]:
            path = covered_arc(first, second, gray, dist, letters)
            if path is not None:
                hits.append((path, first, second))
    return len(hits) == 1 and restore_arc_stock(rgb, marked, edited[area], dist, *hits[0])


def column_stock(marked, path, inset):
    # Group ink on the same typeset axis as the independently interrupted pen.
    horizontal = np.ptp(path[:, 0]) > np.ptp(path[:, 1])
    if horizontal:
        marked = marked.T
        path = path[:, ::-1]
    groups, _ = label(marked, np.ones((3, 3)))
    yy, xx = np.rint(path).astype(int).T[::-1]
    touched = np.unique(groups[yy, xx])
    boxes = find_objects(groups)
    cuts = [boxes[k-1] for k in touched if k]
    if len(cuts) < 2:
        return
    axis = np.median([(xs.stop+xs.start-1)/2 for _, xs in cuts])
    width = np.median([xs.stop-xs.start for _, xs in cuts])
    near = []
    for k, box in enumerate(boxes, 1):
        ys, xs = box
        if abs((xs.stop+xs.start-1)/2-axis) < max(7, .64*width) and xs.stop-xs.start <= max(16, 2.2*width):
            near.append((ys.start,ys.stop,k))
    near.sort()
    runs = []
    for start, stop, k in near:
        if not runs or start-runs[-1][0] > max(18, 1.65*width):
            runs.append([stop, []])
        runs[-1][0] = max(runs[-1][0], stop)
        runs[-1][1].append(k)
    members = [ids for _, ids in runs if sum(k in ids for k in touched if k) >= 2]
    if len(members) != 1:
        return
    ink = np.isin(groups, members[0])
    rows, cols = np.where(ink)
    heights = np.unique(rows)
    left = [cols[rows == y].min() for y in heights]
    right = [cols[rows == y].max() for y in heights]
    axis_y = np.arange(marked.shape[0])
    size = max(5, int(1.3*width) | 1)
    low = -maximum_filter1d(-np.interp(axis_y, heights, left), size)
    high = maximum_filter1d(np.interp(axis_y, heights, right), size)
    y, x = np.ogrid[:marked.shape[0], :marked.shape[1]]
    paper = (x >= low[:, None]) & (x <= high[:, None]) & (y >= rows.min()) & (y <= rows.max())
    radius = np.clip(inset+1, 7, 15)
    weight = np.clip((radius+2-distance_transform_edt(~paper))/3, 0, 1)
    return weight.T if horizontal else weight


def complete_caption_contours(source, stencil, edited, aligned):
    """Keep a continuous decoded pen where the paste cut it at the print edge."""
    from scipy.ndimage import find_objects
    opaque = source[:, :, 3] == 255
    ys, xs = np.where(stencil & opaque)
    if not len(ys):
        return
    area = np.s_[max(0, ys.min()-55):ys.max()+56, max(0, xs.min()-55):xs.max()+56]
    mask = stencil[area]
    if mask.size > 650_000:
        return
    original, prediction, current = (im[area][:, :, :3].mean(2) for im in (source, aligned, edited))
    distance = distance_transform_edt(~mask)
    proposed = prediction < 185
    drawn, _ = label(proposed, np.ones((3, 3)))
    missing = proposed & (current > 162) & (current-prediction > 38) & (distance < 24)
    patches, _ = label(distance_transform_edt(~missing) < 1.6, np.ones((3, 3)))
    retained = distance_transform_edt(current >= 175) < 1.5
    native = (distance_transform_edt(original >= 144) < 1.5) & (distance > 3)
    blend = np.zeros_like(current)
    for index, section in enumerate(find_objects(patches), 1):
        if section is None or max(v.stop-v.start for v in section) > 65:
            continue
        cut = (patches[section] == index) & missing[section]
        if cut.sum() < 4:
            continue
        window = tuple(slice(max(0, v.start-35), v.stop+35) for v in section)
        local = (patches[window] == index) & missing[window]
        reach = distance_transform_edt(~local)
        same = np.isin(drawn[window], np.unique(drawn[section][cut]))
        ends = same & (reach > 3) & (reach < 24) & retained[window]
        original_ends = ends & native[window]
        if original_ends.sum() < 6:
            continue
        center = np.mean(np.argwhere(local), axis=0)
        def directions(points):
            y, x = (np.argwhere(points)-center).T
            return np.arctan2(y, x)
        first, second = directions(original_ends), directions(ends)
        # The confirmed pen must approach the erased patch from opposing ends.
        if any((np.cos(first-angle) > .79).mean() > .07 and (np.cos(second-angle) < -.7).sum() >= 5
               for angle in np.arange(0, 2*np.pi, np.pi/8)):
            weight = np.clip((8-reach)/5.5, 0, 1)*(distance[window] < 26)
            blend[window] = np.maximum(blend[window], weight)
    # An isolated remnant of a selected letter can outlive the surrounding
    # pen. The original connected ink and the clean model must both agree.
    original_ids, count = label(original < 156, np.ones((3, 3)))
    sizes = np.bincount(original_ids.ravel(), minlength=count+1)
    owned = np.bincount(original_ids[mask], minlength=count+1)/np.maximum(1, sizes)
    owned[0] = 0
    isolated, _ = label(current < 158, np.ones((3, 3)))
    to_pen = distance_transform_edt(prediction > 155)
    for index, section in enumerate(find_objects(isolated), 1):
        if section is None or max(v.stop-v.start for v in section) > 34:
            continue
        fragment = isolated[section] == index
        if (fragment.sum() < 3 or distance[section][fragment].mean() >= 21
                or to_pen[section][fragment].min() <= 2 or np.quantile(prediction[section][fragment], .1) <= 185
                or np.max(owned[original_ids[section][fragment]]) <= .38):
            continue
        window = tuple(slice(max(0, v.start-6), v.stop+6) for v in section)
        reach = distance_transform_edt(isolated[window] != index)
        blend[window] = np.maximum(blend[window], np.clip((4-reach)/2, 0, 1)*(distance[window] < 26))
    weight = (blend*opaque[area])[:, :, None]
    patch = edited[area][:, :, :3]
    patch[:] = np.rint(patch+(aligned[area].astype(float)-patch)*weight).astype('u1')


def reconnect(source, stencil, edited, reference=None):
    opaque = source[:, :, 3] == 255
    y, x = np.where(stencil & opaque)
    if not len(x) or max(np.ptp(x), np.ptp(y)) < 70:
        return False
    area = np.s_[max(0, y.min()-58):y.max()+59, max(0, x.min()-58):x.max()+59]
    marked = stencil[area] & opaque[area]
    if marked.size > 700_000:
        return False
    rgb = source[area]
    original = rgb[:, :, :3] @ np.array([.299, .587, .114])
    distance = distance_transform_edt(~marked)
    if np.count_nonzero((original < 105) & (distance > 3) & (distance < 18)) < 42:
        return False
    origins = visible_ends(original, distance)
    if len(origins) < 4:
        return False
    letters, _ = label((distance < 2) & (original < 137), structure=np.ones((3, 3)))
    native = edited[area]
    paper = native[:, :, :3] @ np.array([.299, .587, .114])
    pairs = []
    for i, first in enumerate(origins):
        for j, second in enumerate(origins[:i]):
            path = bridge(first, second, origins, distance, letters, paper)
            if path is not None:
                pairs.append((i, j, path))
    # Ambiguous pairs cannot identify a single original contour.
    counts = np.bincount([k for i, j, _ in pairs for k in (i, j)], minlength=len(origins))
    applied = False
    for i, j, path in pairs:
        if counts[i] == counts[j] == 1:
            stock = column_stock(marked, path, (origins[i][4]+origins[j][4])/2)
            if stock is None:
                continue
            if reference is None:
                draw_measured_pen(rgb, native, path, origins[i], origins[j], opaque[area])
            else:
                # Register the new source-only diffusion against the unprinted
                # scan before revealing the sleeve, border or receding floor lines.
                from runpy import run_path
                register = run_path(str(Path(__file__).with_name("qwen-restore-illustration.py")))["register"]
                reference_rgb = register(source[:, :, :3], reference[:, :, :3], opaque & ~stencil)[area]
                delta = native[:, :, :3].mean(2)-reference_rgb.mean(2)
                weight = stock*opaque[area]*np.clip((delta-3)/8, 0, 1)
                detail = np.minimum(native[:, :, :3], reference_rgb)
                native[:, :, :3] = np.rint(native[:, :, :3]+(detail.astype("f")-native[:, :, :3])*weight[:, :, None]).astype("u1")
            applied = True
    return applied


if __name__ == "__main__":
    src, mask, result, dest = map(Path, sys.argv[1:5])
    with Image.open(src) as im:
        source = np.array(im.convert("RGBA"))
    with Image.open(mask) as im:
        stencil = np.array(im.convert("L")) > 127
    with Image.open(result) as im:
        output = np.array(im.convert("RGBA"))
    if source.shape != output.shape or stencil.shape != source.shape[:2]:
        raise ValueError("Dialogue evidence and output must share the original pixel grid")
    reference = None
    if len(sys.argv) == 6:
        reference = output
        with Image.open(sys.argv[5]) as im:
            output = np.array(im.convert("RGBA"))
        if output.shape != source.shape:
            raise ValueError("Measured dialogue paper must share the original pixel grid")
    if reconnect(source, stencil, output, reference):
        Image.fromarray(output).save(dest)
        print("applied")
    else:
        print("unchanged")
