"""Keep independently visible pen strokes and panel rules under printed sound effects."""
from pathlib import Path
from runpy import run_path

import numpy as np
from scipy.ndimage import (convolve, distance_transform_edt, find_objects, gaussian_filter, label,
                           map_coordinates, maximum_filter, median_filter, minimum_filter, uniform_filter)
from scipy.spatial import cKDTree


def separated_printed_ink(gray, selected):
    """Solid original brushstrokes supported by both the instance and its white outline."""
    groups, _ = label(gray < 98, np.ones((3, 3)))
    ink = np.zeros_like(selected)
    witnesses = 0
    for index, box in enumerate(find_objects(groups), 1):
        local = groups[box] == index
        if not 17 <= local.sum() <= 10_000 or selected[box][local].mean() < .84:
            continue
        y, x = box
        bank = np.s_[max(0, y.start-5):y.stop+5, max(0, x.start-5):x.stop+5]
        distance = distance_transform_edt(groups[bank] != index)
        near = (distance >= 1.7) & (distance < 3.55)
        if near.sum() < 25 or np.quantile(gray[bank][near], .15) < 228 or np.median(gray[box][local]) > 45:
            continue
        ink[box] |= local
        witnesses += 1
    if 3 <= witnesses <= 24:
        return ink


def measured_print_shoulder(gray, distance):
    rings = []
    for radius in range(1, 15):
        sample = gray[(distance >= radius-.5) & (distance < radius+.5)]
        if len(sample) < 30:
            return
        rings.append(np.quantile(sample, .16))
    rings = np.asarray(rings)
    base = np.median(rings[9:])
    contrast = np.median(rings[1:4])-base
    if rings[1:4].min() < 238 or contrast < 42 or np.ptp(rings[9:]) > 28:
        return
    for j in range(4, 10):
        if (rings[j:j+3] <= base+max(9, .13*contrast)).all() and rings[j-2:j].max() > base+.47*contrast:
            return j+1.3


def registered_dark_screen(gray, distance, radius):
    """Confirm the dark screen repeats in both axes on separate exposed banks."""
    bank = (distance > radius+3) & (distance < radius+22)
    low = gaussian_filter(gray, 1.45)
    valid = bank & (low > 19) & (low < 149)
    if valid.sum() < max(380, .26*bank.sum()):
        return False
    residual = gray-low
    if np.quantile(abs(residual[valid]), .55) < 19:
        return False
    y, x = np.indices(gray.shape)
    held = (x//9+y//11) % 2 == 0
    for dimension in (0, 1):
        field = np.moveaxis(residual, dimension, 0)
        known = np.moveaxis(valid, dimension, 0)
        check = np.moveaxis(held, dimension, 0)
        for period in range(2, 7):
            pairs = known[:-period] & known[period:]
            if pairs.sum() < 200:
                continue
            first, other = field[:-period][pairs], field[period:][pairs]
            half = check[:-period][pairs]
            if min(half.sum(), (~half).sum()) < 80:
                continue
            if all(min(np.std(first[k]), np.std(other[k])) > 15 and
                   np.corrcoef(first[k], other[k])[0, 1] > .68 for k in (half, ~half)):
                break
        else:
            return False
    return True


def preserve_sound_banks(source, mask, result, opaque=None):
    """Keep native screentone and hatch ends outside a corroborated white knockout."""
    y, x = np.where(mask)
    if not 400 <= len(x) <= 34_000 or max(np.ptp(x), np.ptp(y)) > 520:
        return False
    area = np.s_[max(0, y.min()-16):y.max()+17, max(0, x.min()-16):x.max()+17]
    rgb, selected, output = source[area], mask[area], result[area]
    if (np.ptp(rgb, axis=2) > 5).mean() > .02:
        return False
    gray = rgb.mean(2)
    ink = separated_printed_ink(gray, selected)
    if ink is None:
        return False
    distance = distance_transform_edt(~ink)
    radius = measured_print_shoulder(gray, distance)
    if radius is None or (distance[selected] > radius+3.5).mean() > .022:
        return False
    bank = (distance > radius+1) & (distance < radius+8)
    texture = (maximum_filter(gray, 3)-minimum_filter(gray, 3) > 35) & (gray > 55) & (gray < 232)
    if texture[bank].mean() < .14:
        return False
    if registered_dark_screen(gray, distance, radius):
        # Bright and dark samples form the same printed dot. Selecting just
        # the darker half creates a dark outline in the shape of the word.
        weight = np.clip((distance-radius-.2)/1.8, 0, 1)
        if opaque is not None:
            weight *= opaque[area]
        mixed = np.rint(output+(rgb.astype(float)-output)*weight[:, :, None]).astype('u1')
        if np.array_equal(mixed, output):
            return False
        output[:] = mixed
        return True
    guide = output.mean(2)
    local = uniform_filter(guide, 5)
    keep = (distance > radius) | ((distance > radius-1.1) & (gray < 202) & (gray < local-15))
    # A thin antialiased fringe over a black beam is gray, even though the
    # original backing is black. Brightness relative to the beam distinguishes
    # that fringe from a genuine pen stroke entering a lighter screen.
    keep &= ~((distance < radius+4) & (gray-local > 21) & (gray-guide > 18))
    if opaque is not None:
        keep &= opaque[area]
    if not np.any(output[keep] != rgb[keep]):
        return False
    output[keep] = rgb[keep]
    return True


def paired_voicing_marks(groups, boxes, sizes, selected, decoded):
    """A short, partially selected pen can be the second stroke of a dakuten."""
    selected_marks, partial_marks = [], []
    for k, box in enumerate(boxes, 1):
        if box is None or not 14 <= sizes[k] <= 360 or selected[k] == 0:
            continue
        h, w = (v.stop-v.start for v in box)
        if not 6 <= max(w, h) <= 37:
            continue
        ink = groups[box] == k
        if np.quantile(decoded[box][ink], .10) < 171:
            continue
        points = np.argwhere(ink)
        values, vectors = np.linalg.eigh(np.cov(points.T))
        if values[1] < 5.5*max(.5, values[0]):
            continue
        center = points.mean(0) + [v.start for v in box]
        record = (k, center, vectors[:, 1], np.sqrt(values[1]*12))
        if selected[k] > .78*sizes[k]:
            selected_marks.append(record)
        elif selected[k] < .29*sizes[k]:
            partial_marks.append(record)
    paired = []
    for k, center, axis, length in partial_marks:
        for _, other, direction, span in selected_marks:
            delta = center-other
            side = abs(delta @ [-axis[1], axis[0]])
            if (abs(axis @ direction) > .95 and .66 <= length/span <= 1.5
                    and abs(delta @ axis) < .43*length and .22*length <= side <= .84*length):
                paired.append(k)
                break
    return paired


def preserve_exposed_ink(source, edited, distance, opaque, gray, components):
    groups, sizes, selected = components
    drawn = (selected < .29*sizes) & (sizes-selected > 19) & (sizes >= 26)
    drawn[0] = False
    boxes = find_objects(groups)
    for k, box in enumerate(boxes, 1):
        if drawn[k]:
            span = max(axis.stop-axis.start for axis in box)
            drawn[k] = span >= 14 and np.any(distance[box][groups[box] == k] >= 6)
    for k in paired_voicing_marks(groups, boxes, sizes, selected, edited.mean(2)):
        drawn[k] = False
    if not drawn.any():
        return
    letter = (selected > .64*sizes) & (selected >= 5)
    letter[0] = False
    to_pen = distance_transform_edt(~drawn[groups])
    to_text = distance_transform_edt(~letter[groups])
    # Restore the antialias transition only where the native connected stroke
    # can be traced past the printed region onto exposed pale paper.
    # The lettering's own white keyline can outline a dark dot screen. A
    # cluster of unprinted white samples must corroborate the paper bank.
    paper = uniform_filter(((distance > 2) & opaque & (gray >= 244)).astype('f'), 3) >= 2/3
    if not paper.any():
        return
    keep = ((distance <= 14) & (to_pen <= 1.9) & (to_text > to_pen+1.65) & opaque
            & (gray < 245) & (edited.mean(2)-gray > 5) & (maximum_filter(gray, 13) > 248)
            & (distance_transform_edt(~paper) <= 9))
    edited[keep] = source[keep]


def preserve_registered_small_pen(source, edited, aligned, distance, opaque, gray, components):
    """Keep a small background mark whose independent decoder view agrees
    with its native position, ink density and antialiasing on all sides."""
    if aligned is None:
        return
    groups, sizes, selected = components
    target = (selected > .64*sizes) & (selected >= 5)
    target[0] = False
    if not target.any():
        return
    to_type = distance_transform_edt(~target[groups])
    predicted = aligned.mean(2)
    for k, bounds in enumerate(find_objects(groups), 1):
        if bounds is None or not 14 <= sizes[k] <= 200 or not 0 < selected[k] <= .18*sizes[k]:
            continue
        box = tuple(slice(max(0, v.start-5), v.stop+5) for v in bounds)
        line = groups[box] == k
        if distance[box][line].max() < 4 or np.ptp(gray[box][line]) < 45:
            continue
        to_pen = distance_transform_edt(~line)
        sample = (to_pen <= 3.3) & (to_type[box] > 1.5) & opaque[box]
        original, model = gray[box][sample], predicted[box][sample]
        if (len(model) < 28 or np.std(model) < 35 or np.std(original) < 35
                or np.corrcoef(original, model)[0, 1] < .964
                or np.median(abs(original-model)) > 17
                or np.quantile(abs(original-model), .90) > 34):
            continue
        keep = sample & (to_type[box] >= to_pen) & (distance[box] < 12)
        edited[box][keep] = source[box][keep]


def calibrate_sound_stock(source, result, distance, valid):
    """Measure model-added dot contrast against nearby, uniformly shaded original paper."""
    native = source[:, :, :3].astype('f')
    edited = result[:, :, :3].astype('f')
    gray, decoded = native.mean(2), edited.mean(2)
    level, model_level = (gaussian_filter(v, 2.25) for v in (gray, decoded))
    def energy(v):
        return np.sqrt(gaussian_filter((v-gaussian_filter(v, 1.3))**2, 2))
    def spread(v):
        return maximum_filter(v, 9)-minimum_filter(v, 9)
    grain, model_grain = energy(gray), energy(decoded)
    banks = (valid & (distance > 7) & (distance < 55) & (spread(level) < 7) &
             (level > 55) & (level < 232) & (grain < 20))
    write = (valid & (distance < 11) & np.any(native != edited, axis=2) &
             (spread(model_level) < 50) & (model_grain > 5))
    y, x = np.where(banks)
    y, x = y[::3], x[::3]
    ty, tx = np.where(write)
    if len(y) < 80 or len(ty) < 15:
        return
    def features(y, x, brightness):
        return np.column_stack([y/18, x/18, brightness/4])
    tree = cKDTree(features(y, x, level[y, x]))
    smooth = gaussian_filter(edited, (1.85, 1.85, 0))
    for start in range(0, len(ty), 4096):
        py, px = ty[start:start+4096], tx[start:start+4096]
        model = model_level[py, px]
        _, indices = tree.query(features(py, px, model), k=36)
        sy, sx = y[indices], x[indices]
        tone, noise = level[sy, sx], grain[sy, sx]
        median, amplitude = np.median(tone, axis=1), np.median(noise, axis=1)
        close = np.hypot(sy-py[:, None], sx-px[:, None]).min(axis=1)
        observed = model_grain[py, px]
        accepted = ((close < 47) & (np.ptp(tone, axis=1) < 7.5) & (abs(median-model) < 14) &
                    (np.quantile(noise, .85, axis=1) < 1.9*amplitude+1.5) &
                    (observed > 1.5*amplitude+2))
        ratio = np.clip(amplitude/np.maximum(1, observed), .1, 1)
        base = smooth[py, px]
        estimate = base + (edited[py, px]-base)*ratio[:, None] + (.94*(median-model))[:, None]
        weight = (accepted * np.clip((observed-1.2*amplitude-1.5)/5, 0, 1))[:, None]
        result[py, px, :3] = np.rint(np.clip(edited[py, px]*(1-weight) + estimate*weight, 0, 255))


def restore_light_sound_paper(source, edited, distance, opaque, gray, components):
    groups, sizes, selected = components
    printed = (sizes >= 5) & (selected > .78*sizes)
    printed[0] = False
    if printed.sum() < 3:
        return
    ink = printed[groups]
    radius = distance_transform_edt(~ink)
    known = (radius > 4.5) & opaque
    # Count exposed paper, including the gaps between letters. Correcting
    # the decoder's paper level across the whole word avoids a glyph-shaped
    # shadow while retaining drawn detail such as a fine circle behind it.
    wide = np.maximum(1e-6, gaussian_filter(known.astype(float), 13))
    pale = gaussian_filter(((gray > 247) & known).astype(float), 13) / wide
    if not np.any((pale > .66) & ink):
        return
    bias = gray-edited.mean(2)
    pairs = opaque & (radius > 2.5) & (gray > 246) & (bias > 1.5) & (bias < 19) & (distance < 3)
    coverage = gaussian_filter(pairs.astype(float), 12)
    if coverage.max() < .014:
        return
    offset = gaussian_filter(np.where(pairs, bias, 0), 12) / np.maximum(1e-6, coverage)
    stock = gaussian_filter(np.where(known, gray, 0), 13) / wide
    pen_distance = distance_transform_edt(~(known & (gray < 148)))
    weight = (np.clip((pale-.66)/.19, 0, 1) * np.clip((stock-231)/9, 0, 1)
              * np.clip((pen_distance-.75)/4, 0, 1) * (distance < 11)
              * np.clip(coverage/.014, 0, 1) * opaque * np.any(source != edited, axis=2))
    support = np.maximum(1e-6, gaussian_filter(known.astype(float), 8))
    shoulder = np.clip((4.5-radius)/1.75, 0, 1)
    for c in range(3):
        native = source[:, :, c].astype(float)
        current = edited[:, :, c].astype(float)
        level = gaussian_filter(np.where(known, native, 0), 8) / support
        calibrated = np.minimum(255, current+offset)
        fine = np.minimum(0, calibrated-maximum_filter(calibrated, 5)+1.)
        corrected = shoulder*(level+fine)+(1-shoulder)*native
        edited[:, :, c] = np.rint(np.clip(current+weight*(corrected-current), 0, 255))


def punctuation_stems(gray, distance):
    groups, _ = label((gray < 149) & (distance < 1.7), np.ones((3, 3)))
    parts = []
    for k, box in enumerate(find_objects(groups), 1):
        y, x = np.where(groups[box] == k)
        if not 14 <= len(x) <= 4000:
            continue
        y, x = y+box[0].start, x+box[1].start
        if (distance[y, x] == 0).mean() < .67:
            continue
        points = np.column_stack((x, y))
        center = points.mean(0)
        eigen, axes = np.linalg.eigh(np.cov(points.T))
        axis = axes[:, 1]
        projections = (points-center) @ axes
        width, length = np.ptp(projections, axis=0)
        parts.append((center, axis, points, length, width, np.sqrt(eigen[1]/max(.1, eigen[0]))))
    for center, axis, points, length, width, ratio in parts:
        if not 22 < length < 160 or ratio < 4.2 or width < 3 or len(points)/length < 2.3:
            continue
        normal = np.array([-axis[1], axis[0]])
        for _, _, dot, span, _, aspect in parts:
            if not .055*len(points) < len(dot) < .70*len(points) or span > .51*length or aspect > 3.1:
                continue
            projected = (dot-center) @ axis
            extent = np.quantile(np.sign(np.median(projected))*projected, [.1, .9])
            if (extent[0] > .45*length and extent[1] < 1.35*length
                    and (abs((dot-center) @ normal) < max(5, .55*width)).mean() > .23):
                yield center, axis, normal, length, width, dot
                break


def punctuation_paper_banks(tone, original, distance, y, x, normal, width):
    paper, support = [], []
    for sign in (-1, 1):
        steps = sign * (max(6, .52*width) + np.arange(2, 9))
        coords = [y[:, None]+steps*normal[1], x[:, None]+steps*normal[0]]
        sample = lambda field: map_coordinates(field, coords, order=1, mode="nearest")
        bank, native = sample(tone), sample(original)
        clear = sample(distance) > 2
        paper.append(np.median(bank, axis=1))
        support.append(((bank > 225).mean(1) > .78)
                       & ((((native > 215) & clear).sum(1) >= 2) | ((bank > 244).mean(1) > .88)))
    a, b = paper
    return (a+b)/2, support[0] & support[1] & (abs(a-b) < 12)


def continues_exposed_pen(points, native_pen):
    center = points.mean(0)
    axis = np.linalg.eigh(np.cov(points.T))[1][:, 1]
    along = (points-center) @ axis
    for end, sign in ((along.min(), -1), (along.max(), 1)):
        positions = center + (end + sign*np.arange(2, 37))[:, None]*axis
        visible = map_coordinates(native_pen, positions.T[::-1], order=1, mode="nearest") < 1.3
        if np.convolve(visible.astype(int), np.ones(6), mode="valid").max() >= 6:
            return True
    return False


def retain_crossing_pen_tip(before, edited, changed, writable, stem_axis):
    """Read both sides of a surviving transverse pen at the base of an erased stem."""
    if not changed.any():
        return
    tone = edited.mean(2)
    ink = (tone < 162) & ~changed
    adjacent = (distance_transform_edt(~changed) < 5) & ~changed & writable & (tone < 239)
    for y, x in np.argwhere(adjacent):
        top, left = max(0, y-12), max(0, x-12)
        yy, xx = np.where(ink[top:y+13, left:x+13])
        dy, dx = yy+top-y, xx+left-x
        radius = np.hypot(dx, dy)
        ring = (radius > 5) & (radius < 12)
        if ring.sum() < 9:
            continue
        points = np.column_stack((dx[ring], dy[ring]))
        values, axes = np.linalg.eigh(np.cov(points.T))
        direction = axes[:, 1]
        sides = points @ direction
        if (values[1] < 8*max(.25, values[0]) or abs(stem_axis @ direction) > .73
                or (sides < -4).sum() < 4 or (sides > 4).sum() < 4):
            continue
        levels = []
        for sign in (-1, 1):
            t = sign*np.arange(4, 9, .5)
            levels.append(np.median(map_coordinates(tone, [y+t*direction[1], x+t*direction[0]],
                                                    order=1, mode="nearest")))
        if abs(levels[0]-levels[1]) < 25 and min(levels) > before[y, x]+6:
            edited[y, x] = np.rint(np.mean(levels))


def remove_punctuation_remnants(source, mask, edited, distance, valid):
    gray, tone = source.mean(2), edited.mean(2)
    write = valid & (mask | ((distance < 9) & np.any(edited != source, axis=2)))
    yy, xx = np.indices(mask.shape)
    gradient_y, gradient_x = np.gradient(gaussian_filter(tone, .72))
    native_pen = distance_transform_edt(~((gray < 160) & (distance > 4) & valid))
    stems = list(punctuation_stems(gray, distance))
    for center, axis, normal, length, width, _ in stems:
        along = (xx-center[0])*axis[0] + (yy-center[1])*axis[1]
        across = (xx-center[0])*normal[0] + (yy-center[1])*normal[1]
        shaft = (abs(along) < .58*length) & (abs(across) < max(7, width*.82))
        y, x = np.where(shaft & write)
        if not len(x):
            continue
        paper, supported = punctuation_paper_banks(tone, gray, distance, y, x, normal, width)
        tangent = gaussian_filter((gradient_x*axis[0]+gradient_y*axis[1])**2, 2.1)
        edge = gaussian_filter((gradient_x*normal[0]+gradient_y*normal[1])**2, 2.1)
        supported &= (paper > 236) & (edge[y, x] > 1.8*tangent[y, x]+.05)
        depth = paper-tone[y, x]
        visible = supported & (depth > 3)
        if visible.sum() < 8:
            continue
        ink = np.zeros_like(mask)
        ink[y[visible], x[visible]] = True
        groups, _ = label(distance_transform_edt(~ink) < 1.7, np.ones((3, 3)))
        cleared = np.zeros_like(mask)
        for k, box in enumerate(find_objects(groups), 1):
            sy, sx = np.where((groups[box] == k) & ink[box])
            if len(sx) < 8:
                continue
            sy, sx = sy+box[0].start, sx+box[1].start
            span = np.ptp(along[sy, sx])
            if span < 8 or span < 1.5*np.ptp(across[sy, sx]) or continues_exposed_pen(np.c_[sx, sy], native_pen):
                continue
            use = (groups[y, x] == k) & supported & (depth > 0)
            edited[y[use], x[use]] = np.rint(paper[use, None])
            strong = use & (depth > 12)
            cleared[y[strong], x[strong]] = True
        retain_crossing_pen_tip(tone, edited, cleared, shaft & write & (distance < 2), axis)
    restore_paired_punctuation_paper(source, mask, edited, distance, valid, stems)


def restore_paired_punctuation_paper(source, mask, edited, distance, valid, stems=None):
    if stems is None:
        stems = list(punctuation_stems(source.mean(2), distance))
    terminals = {}
    for i, stem in enumerate(stems):
        center, axis, normal, length, width, dot = stem
        paired = any(i != j and abs(axis @ other[1]) > .945 and .70 < other[3]/length < 1.42
                     and abs((other[0]-center) @ axis) < .30*length
                     and .65*width < abs((other[0]-center) @ normal) < 3.2*width
                     for j, other in enumerate(stems))
        if paired:
            restore_punctuation_surface(source, edited, mask, distance, valid, stem[:5])
            terminals[tuple(dot[0])] = dot
    if terminals:
        pen = run_path(str(Path(__file__).with_name("qwen-reconnect-balloon.py")))
        for dot in terminals.values():
            restore_obscured_pen_tip(source, edited, mask, distance, valid, dot, pen)


def terminal_pen_arms(gray, distance, valid, center, pen):
    field = pen["centre_lines"]((gray < 182) & (distance > 2) & valid)
    degree = convolve(field, np.ones((3, 3), "u1"), mode="constant")
    offsets = np.arange(-2.75, 2.76, .25)
    for y, x in np.argwhere((field != 0) & (degree == 2) & (distance < 7)):
        if np.linalg.norm(center-[x, y]) > 26:
            continue
        trail = pen["follow_branch"](field, y, x)[:16, ::-1].astype(float)
        if len(trail) < 13 or np.linalg.norm(trail[-1]-trail[0]) < 9:
            continue
        axis = trail[-1]-trail[0]
        normal = np.array([-axis[1], axis[0]]) / np.linalg.norm(axis)
        samples = trail[:, None, :] + offsets[:, None]*normal
        levels = map_coordinates(gray, samples.transpose(2, 0, 1)[::-1], order=1, mode="nearest")
        # Subpixel centres of the original scanner's antialiased pen give
        # a stable direction even when the two banks run nearly horizontally.
        weights = np.maximum(0, np.maximum(levels[:, :1], levels[:, -1:])-levels)
        trace = trail + ((weights @ offsets)/np.maximum(1, weights.sum(1)))[:, None]*normal
        axes = np.linalg.eigh(np.cov(trace.T))[1]
        direction = trace[0]-trace[8]
        if (abs((trace-trace[0]) @ axes[:, 0]).max() < 1.2 and np.linalg.norm(direction) > 4
                and np.quantile(levels.min(1), .85) < 177):
            yield trace[0], direction/np.linalg.norm(direction)


def hidden_intersection(first, second, dot, decoded, distance):
    p, v = first
    q, w = second
    cross = abs(v[0]*w[1]-v[1]*w[0])
    if not .22 < cross < .86 or v @ w < .46 or np.linalg.norm(p-q) > 16:
        return
    rays = np.linalg.solve(np.column_stack((v, -w)), q-p)
    if rays.min() < 6 or rays.max() > 32:
        return
    tip = p+v*rays[0]
    # The actual printed bead must hide this point. Two naturally open
    # contours merely pointing in the same direction do not establish a tip.
    if np.min(np.linalg.norm(dot-tip, axis=1)) > 2.4:
        return
    for (start, _), length in zip((first, second), rays):
        line = np.linspace(start, tip, int(np.ceil(length*4))+1).T[::-1]
        tone = map_coordinates(decoded, line, order=1, mode="nearest")
        masked = map_coordinates(distance, line, order=1, mode="nearest")
        if (np.count_nonzero((masked < .1) & (tone < 208)) < 3
                or (tone[3:22] < 208).mean() <= .5 or (tone[-8:] > 221).mean() <= .5
                or (masked[4:] < 3).mean() <= .6):
            return
    return tip


def restore_obscured_pen_tip(source, edited, mask, distance, valid, dot, pen):
    left, top = np.maximum(0, dot.min(0)-42)
    right, bottom = dot.max(0)+43
    box = np.s_[top:bottom, left:right]
    dot = dot-[left, top]
    original, out = source[box], edited[box]
    native = original.mean(2)
    arms = list(terminal_pen_arms(native, distance[box], valid[box], dot.mean(0), pen))
    tips = []
    for i, first in enumerate(arms):
        for second in arms[:i]:
            tip = hidden_intersection(first, second, dot, out.mean(2), distance[box])
            if tip is not None:
                tips.append((first, second, tip))
    if len(tips) != 1:
        return
    first, second, tip = tips[0]
    if exposed_paper(original, distance[box], (first, second)) is None:
        return
    writable = valid[box] & (mask[box] | ((distance[box] < 5) & np.any(original != out, axis=2)))
    y, x = np.indices(native.shape)
    offsets = np.arange(-4, 4.001, .125)
    for start, axis in (first, second):
        profile = pen["pen_profile"](original, start, axis, offsets)
        along = (x-start[0])*axis[0]+(y-start[1])*axis[1]
        across = (y-start[1])*axis[0]-(x-start[0])*axis[1]
        length = np.linalg.norm(start-tip)
        width = 1-.55*np.clip(along/length, 0, 1)
        weight = np.clip((along+1.5)/3, 0, 1)*np.clip(length+.45-along, 0, 1)*writable
        for c in range(3):
            level = np.interp(across/width, offsets, profile[:, c], left=255, right=255)
            current = out[:, :, c]
            current[:] = np.rint(current+weight*np.minimum(0., level-current))


def restore_punctuation_surface(source, edited, mask, distance, opaque, stem):
    """Continue the observed scan stock across adjacent outlined exclamation marks."""
    center, axis, normal, length, width = stem
    border = int(np.ceil(length + 3*width + 18))
    cx, cy = np.rint(center).astype(int)
    box = np.s_[max(0, cy-border):cy+border+1, max(0, cx-border):cx+border+1]
    source, edited = source[box], edited[box]
    distance, mask, opaque = distance[box], mask[box], opaque[box]
    y, x = np.indices(mask.shape)
    dx, dy = x + box[1].start-center[0], y + box[0].start-center[1]
    along, across = abs(dx*axis[0] + dy*axis[1]), abs(dx*normal[0] + dy*normal[1])
    extent = (along < .95*length+10) & (across < 2.8*width+14)
    # The edit may fade just outside the model stencil. Preserve every
    # original pixel there unless it already differs from the decoder.
    writable = mask | ((distance < 14) & np.any(source != edited, axis=2))
    taper = np.clip((.79*length-along)/max(3, .08*length), 0, 1)
    taper *= np.clip((1.05*width+9-across)/max(3, .30*width), 0, 1)
    target = writable & (taper > 0) & opaque & (np.ptp(edited, axis=2) < 7)
    tone = edited.mean(2)
    middle = median_filter(tone, 3)
    native = median_filter(source.mean(2), 3)
    flat = maximum_filter(tone, 3)-minimum_filter(tone, 3) < 12
    regions, _ = label((middle >= 237) & extent & opaque, np.ones((3, 3)))
    for k in np.unique(regions[target]):
        if not k:
            continue
        field = regions == k
        bank = field & (distance > 9) & flat & (abs(tone-native) < 11) & (np.ptp(source, axis=2) < 6)
        if bank.sum() < 60 or (native[bank] >= 252).mean() < .94:
            continue
        paper = bank & (native >= 252)
        reach, donors = distance_transform_edt(~paper, return_indices=True)
        avoid = protected_punctuation_pen(tone, middle, distance, target)
        weight = taper * np.clip((distance_transform_edt(~avoid)-1.25)/2.8, 0, 1)
        shade = bank & (native < 249)
        if shade.any():
            weight *= np.clip((distance_transform_edt(~shade)-7)/10, 0, 1)
        selected = target & field & (reach < 74) & (weight > 0)
        measured = np.median(native[paper])
        level = (measured + native[tuple(donors)]) / 2
        edited[selected] = np.rint(edited[selected] + weight[selected, None] *
                                   (level[selected, None] - edited[selected])).astype("u1")


def protected_punctuation_pen(tone, middle, distance, target):
    dark = tone < 222
    strokes, _ = label(dark, np.ones((3, 3)))
    kept = dark.copy()
    for k, box in enumerate(find_objects(strokes), 1):
        dots = strokes[box] == k
        if (dots.sum() <= 24 and min(dots.shape) <= 5 and max(dots.shape) <= 15
                and np.any(target[box] & dots) and not np.any((distance[box] > 4) & dots)):
            kept[box][dots] = False
    return ((middle < 236) | (dark & (median_filter(tone, 5) < 242))
            | (distance_transform_edt(~kept) < 2.2))


def exposed_paper(source, distance, ends):
    levels = []
    for p, direction, *_ in ends:
        normal = np.array([-direction[1], direction[0]])
        for sign in (-1, 1):
            points = np.stack([p-r*direction+sign*k*normal for r in range(3, 16) for k in range(4, 11)])
            y, x = points.T[::-1].round().astype(int)
            valid = (y >= 0) & (x >= 0) & (y < source.shape[0]) & (x < source.shape[1])
            y, x = y[valid], x[valid]
            visible = distance[y, x] > 1
            if visible.sum() < 20:
                return
            levels.append(np.quantile(source[y[visible], x[visible]], .55, axis=0))
    if np.min(levels) >= 225 and np.ptp(levels, axis=0).max() <= 11:
        return np.median(levels, axis=0)


def measured_gap(first, second, source, marked, distance):
    p, v, radius, length, inset = first
    q, w, radius2, length2, inset2 = second
    span = np.linalg.norm(q-p)
    if not 12 <= span <= 110 or min(length, length2) < 14 or max(inset, inset2) > 8 or abs(radius-radius2) > .65:
        return
    axis = (q-p)/span
    if min(v @ axis, -w @ axis) < .94 or -v @ w < .90:
        return
    t = np.linspace(0, 1, int(2*span+1))[:, None]
    path = ((2*t**3-3*t*t+1)*p+(t**3-2*t*t+t)*span*v
            + (-2*t**3+3*t*t)*q-(t**3-t*t)*span*w)
    y, x = np.rint(path).astype(int).T[::-1]
    if x.min() < 0 or y.min() < 0 or x.max() >= source.shape[1] or y.max() >= source.shape[0]:
        return
    covered = (source[y, x].mean(1) < 145) & marked[y, x]
    if covered.sum() < 3 or np.mean(distance[y, x] <= 3) < .67:
        return
    paper = exposed_paper(source, distance, (first, second))
    if paper is not None:
        return path, paper


def restore_short_keyline_gaps(source, edited, distance, opaque, pen):
    """Continue fine pen where its two visible ends meet the white outline of a letter."""
    gray = source[:, :, :3].mean(2)
    ink = (gray < 186) & (distance > 3.2) & opaque
    field = pen["centre_lines"](ink)
    degree = convolve(field, np.ones((3, 3), 'u1'), mode='constant')
    width = distance_transform_edt(ink)
    ends = []
    for y, x in zip(*np.where((field != 0) & (degree == 2) & (distance < 14))):
        trail = pen["follow_branch"](field, y, x)
        if len(trail) < 11 or np.median(width[tuple(trail[:9].T)]) > 2.3:
            continue
        tip = trail[:2].mean(0)
        direction = tip-trail[5:8].mean(0)
        size = np.linalg.norm(direction)
        if size >= 4.3 and np.median(gray[tuple(trail[2:8].T)]) <= 157:
            ends.append((tip[::-1], direction[::-1]/size))
    if len(ends) < 2:
        return
    pairs = []
    for i, j in cKDTree([p for p, _ in ends]).query_pairs(22):
        p, v = ends[i]
        q, w = ends[j]
        span = np.linalg.norm(q-p)
        if span < 6:
            continue
        direction = (q-p)/span
        if min(v @ direction, -w @ direction) < .89 or -v @ w < .85:
            continue
        path = np.linspace(p, q, max(25, int(span*4)))
        yy, xx = np.rint(path).astype(int).T[::-1]
        middle = slice(len(path)//4, 3*len(path)//4)
        separation = distance[yy, xx]
        closest = separation[middle].min()
        ys, xs = yy[middle], xx[middle]
        if (separation.max() > 14 or closest > 8 or min(separation[0], separation[-1])-closest < .9
                or (gray[ys, xs] > 222).mean() < .75 or np.median(edited[ys, xs, :3].mean(1)) < 216):
            continue
        if exposed_paper(source[:, :, :3], distance, (ends[i], ends[j])) is not None:
            pairs.append((i, j, path))
    uses = np.bincount([k for i, j, _ in pairs for k in (i, j)], minlength=len(ends))
    for i, j, path in pairs:
        if uses[i] == uses[j] == 1:
            pen["draw_measured_pen"](source, edited, path, ends[i], ends[j], opaque & (distance < 14))


def continue_rule(source, edited, first, second, opaque):
    p, q = first[0], second[0]
    vertical = abs(q[1]-p[1]) > abs(q[0]-p[0])
    if abs((q-p)[0 if vertical else 1]) > 1.5 or min(first[2], second[2]) < 1.6:
        return False
    if not vertical:
        source, edited, opaque = source.transpose(1, 0, 2), edited.transpose(1, 0, 2), opaque.T
        p, q = p[::-1], q[::-1]
    top, bottom = sorted((p[1], q[1]))
    axis = int(round((p[0]+q[0])/2))
    if axis < 6 or axis+7 > source.shape[1] or top < 19 or bottom+19 > source.shape[0]:
        return False
    columns = slice(axis-6, axis+7)
    banks = (source[top-19:top-4, columns], source[bottom+4:bottom+19, columns])
    start, end = [np.median(b, axis=0) for b in banks]
    stable = all(np.std(b, axis=0).mean(1).max() <= 26 for b in banks)
    if not stable or np.abs(start-end).mean() > 12:
        return False
    t = np.linspace(0, 1, bottom-top+1)[:, None, None]
    shade = np.rint((1-t)*start+t*end).astype("u1")
    ink = np.maximum(start.mean(1), end.mean(1)) < 210
    valid = ink & opaque[top:bottom+1, columns]
    edited[top:bottom+1, columns][valid] = shade[valid]
    return True


def remove_decoded_fork(source, edited, marked, distance, near, along, span, paper, opaque, aligned):
    """The two measured original pen ends agree on a path. A decoded stroke
    reaching just one of them can leave several disconnected dashes in the paste."""
    native, decoded, current = (im.mean(2) for im in (source, aligned, edited))
    band = (along > -20) & (along < span+20) & (near < min(33, .6*span)) & (distance < 19) & opaque
    lines, _ = label((decoded < 238) & band, np.ones((3, 3)))
    ends = [(near < 3.2) & (abs(along-edge) < 9) & (decoded < 196) for edge in (0, span)]
    changed = False
    for index in np.unique(lines[ends[0] | ends[1]]):
        if index == 0:
            continue
        line = lines == index
        votes = [np.count_nonzero(end & line) for end in ends]
        if max(votes) < 8 or min(votes) >= max(4, .24*max(votes)):
            continue
        diverged = line & (near > 3.1) & (along > 1.5) & (along < span-1.5)
        dark = diverged & (decoded < 205)
        backed = dark & ~marked & (native < 165)
        if (diverged.sum() < 12 or backed.sum() > max(5, .15*diverged.sum())
                or np.count_nonzero(diverged & marked) < .6*diverged.sum()
                or np.count_nonzero(dark & (native > 240)) < 6):
            continue
        toward = along if votes[0] < votes[1] else span-along
        fringe = band & (near > 3) & (toward > -min(22, .4*span)) & (toward < span-1.5)
        fringe &= marked | (native > 235)
        ridges = fringe & ((decoded < 233) | (gaussian_filter(decoded, 3)-decoded > 1.3))
        groups, _ = label((distance_transform_edt(~ridges) < 2.6) & fringe, np.ones((3, 3)))
        seeds = np.unique(groups[diverged])
        ragged = ridges & np.isin(groups, seeds[seeds > 0]) & ((current < 246) | (abs(current-decoded) < 20))
        if not ragged.any():
            continue
        reach = distance_transform_edt(~ragged)
        clean = (distance_transform_edt(~((native < 197) & marked)) > 4.5) & (native > 218)
        target = np.where((marked & ~clean)[:, :, None], paper, source)
        weight = np.clip((3.3-reach)/1.45, 0, 1)*np.clip((near-2.8)/1.6, 0, 1)
        weight *= (reach < 3.1) & band & ((native > 230) | marked)
        edited[:] = np.rint(edited+(target-edited)*weight[:, :, None]).astype("u1")
        changed = True
    return changed


def remove_competing_curve(source, edited, marked, distance, path, paper, opaque, aligned=None):
    p, q = path[0], path[-1]
    span = np.linalg.norm(q-p)
    axis = (q-p)/span
    # Search only around this short curve, with room for a drifting decoded edge.
    x0, y0 = np.maximum(0, np.floor(path.min(0)).astype(int)-35)
    x1, y1 = np.minimum(marked.shape[::-1], np.ceil(path.max(0)).astype(int)+36)
    area = np.s_[y0:y1, x0:x1]
    y, x = np.mgrid[y0:y1, x0:x1]
    points = np.column_stack([x.ravel(), y.ravel()])
    near = cKDTree(path).query(points)[0].reshape(x.shape)
    along = (x-p[0])*axis[0]+(y-p[1])*axis[1]
    band = (along > -2) & (along < span+9) & (near < min(24, .43*span)) & (distance[area] < 17) & opaque[area]
    guide = np.where(marked[area][:, :, None], paper, source[area])
    predicted = edited[area].mean(2)
    alternate = (predicted < 246) & (predicted+3 < guide.mean(2)) & band
    groups, _ = label(alternate, np.ones((3, 3)))
    touched = (near < 4) & ((along < 18) | (along > span-18))
    roots = np.unique(groups[touched])
    if np.any(roots > 0):
        drift = np.isin(groups, roots[roots > 0])
        blend = np.maximum(0, 1-distance_transform_edt(~drift)/2.1)*band
        edited[area] = np.rint(edited[area]+(guide-edited[area])*blend[:, :, None]).astype("u1")
    if aligned is not None:
        return remove_decoded_fork(source[area], edited[area], marked[area], distance[area],
                                   near, along, span, paper, opaque[area], aligned[area])
    return False


def restore_sound_contours(source, marked, edited, aligned=None):
    opaque = source[:, :, 3] == 255
    rows, cols = np.where(marked & opaque)
    if not len(cols):
        return
    area = np.s_[max(0, rows.min()-55):rows.max()+56, max(0, cols.min()-55):cols.max()+56]
    original, result = source[area], edited[area]
    rgb = original[:, :, :3]
    valid = opaque[area]
    mask = marked[area] & valid
    if mask.size > 700_000:
        return
    distance = distance_transform_edt(~mask)
    gray = rgb.mean(2)
    groups, count = label(gray < 148, np.ones((3, 3)))
    components = (groups, np.bincount(groups.ravel(), minlength=count+1),
                  np.bincount(groups[mask], minlength=count+1))
    calibrate_sound_stock(original, result, distance, valid)
    restore_light_sound_paper(rgb, result[:, :, :3], distance, valid, gray, components)
    preserve_exposed_ink(rgb, result[:, :, :3], distance, valid, gray, components)
    preserve_registered_small_pen(rgb, result[:, :, :3], aligned[area] if aligned is not None else None,
                                  distance, valid, gray, components)
    remove_punctuation_remnants(rgb, mask, result[:, :, :3], distance, valid)
    if len(rows) >= 150 and min(np.ptp(rows), np.ptp(cols)) >= 35:
        badge = run_path(str(Path(__file__).with_name("qwen_printed_badge.py")))
        badge["restore_printed_badge"](original, result, distance, valid)
    if max(np.ptp(rows), np.ptp(cols)) < 70:
        return
    pen = run_path(str(Path(__file__).with_name("qwen-reconnect-balloon.py")))
    restore_short_keyline_gaps(original, result, distance, valid, pen)
    ends = pen["visible_ends"](rgb.mean(2), distance)
    pairs = []
    for i, first in enumerate(ends):
        for j, second in enumerate(ends[:i]):
            gap = measured_gap(first, second, rgb, mask, distance)
            if gap is not None:
                pairs.append((i, j, *gap))
    counts = np.bincount([k for i, j, *_ in pairs for k in (i, j)], minlength=len(ends))
    fixed_fork = False
    for i, j, path, paper in pairs:
        first, second = ends[i], ends[j]
        if counts[i] != 1 or counts[j] != 1:
            continue
        if continue_rule(rgb, result[:, :, :3], first, second, valid):
            continue
        fixed_fork |= remove_competing_curve(rgb, result[:, :, :3], mask, distance, path, paper, valid,
                                             aligned[area] if aligned is not None else None)
        pen["draw_measured_pen"](original, result, path, first, second, valid)
    if fixed_fork:
        stock = run_path(str(Path(__file__).with_name("qwen_paper_banks.py")))
        stock["restore_caption_paper"](rgb, mask, result[:, :, :3], valid)
    if aligned is not None:
        crossing = run_path(str(Path(__file__).with_name("qwen_crossing_ink.py")))
        crossing["restore_crossing_ink"](rgb, mask, result[:, :, :3], distance, aligned[area], ends)
