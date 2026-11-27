"""Recover scan-white paper from independent samples around erased lettering."""
import numpy as np
from scipy.ndimage import binary_fill_holes, distance_transform_edt, find_objects, gaussian_filter, label, maximum_filter, minimum_filter


def facing_caption_paper(y, x, paper, opposing, edges):
    h, w = paper.shape
    directions = []
    for angle in np.arange(12) * np.pi/6:
        hits = np.zeros(len(x), bool)
        blocked = np.zeros(len(x), bool)
        for step in range(3, 65, 2):
            row = y + round(step*np.sin(angle))
            col = x + round(step*np.cos(angle))
            inside = (row >= 0) & (row < h) & (col >= 0) & (col < w)
            row, col = row.clip(0, h-1), col.clip(0, w-1)
            blocked |= ~hits & (~inside | (edges[row, col] < 1.4) | opposing[row, col])
            hits |= ~blocked & paper[row, col]
        directions.append(hits)
    votes = np.stack(directions)
    paired = (votes[:6] & votes[6:]).sum(0)
    return np.clip((votes.sum(0)-4)/3, 0, 1) * (paired > 0)


def restore_separate_sound_on_white(source, mask, result, opaque):
    """Use exposed scan paper where the edit removed independently bounded ink.

    The selected dark components must account for the entire word. If the
    antialiased face runs into another stroke, keep the registered Qwen edit.
    """
    y, x = np.where(mask)
    if not 80 <= x.size <= 11000 or np.ptp(x) > 260 or np.ptp(y) > 280:
        return False
    region = np.s_[max(0, y.min()-24):y.max()+25, max(0, x.min()-24):x.max()+25]
    mask, source, result = mask[region], source[region], result[region]
    if not opaque[region].all():
        return False
    native, estimate = source.mean(2), result.mean(2)
    distance = distance_transform_edt(~mask)
    bank = (distance > 2) & (distance <= 9)
    if (bank.sum() < 80 or (native[bank] > 247).mean() < .83 or np.median(native[bank]) < 252
            or np.percentile(np.ptp(source[bank], axis=1), 98) > 5):
        return False
    groups, count = label(native < 105, np.ones((3, 3)))
    mass = np.bincount(groups.ravel(), minlength=count+1)
    covered = np.bincount(groups[mask], minlength=count+1)
    selected = (mass >= 5) & (mass <= 3500) & (covered >= .82*mass)
    selected[0] = False
    if not 3 <= selected.sum() <= 20:
        return False
    core = selected[groups]
    to_core = distance_transform_edt(~core)
    core_levels = estimate[core]
    original_white = np.median(native[bank])
    if ((to_core[mask] <= 2.6).mean() < .92 or (mask & (native < 129) & (to_core > 2)).sum() > .02*mask.sum()
            or np.percentile(core_levels, 1) < 234 or (np.ptp(result[core], axis=1) > 8).mean() > .01
            or (core_levels <= original_white-6).sum() < max(16, .12*core_levels.size)):
        return False
    faces, _ = label(native < 235, np.ones((3, 3)))
    selected_faces = np.unique(faces[core])
    letters = np.isin(faces, selected_faces)
    if np.any(letters & (to_core > 3.65)):
        return False
    boxes = find_objects(faces)
    for index in selected_faces:
        sy, sx = boxes[index-1]
        box = np.s_[max(0, sy.start-9):sy.stop+9, max(0, sx.start-9):sx.stop+9]
        span = distance_transform_edt(faces[box] != index)
        rim = (span >= 2) & (span <= 5) & ~letters[box]
        if rim.sum() < 15 or (native[box][rim] > 246).mean() < .78:
            return False
    donors = (distance > 3) & (distance < 12) & (native > 249)
    if not donors.any():
        return False
    stock = np.median(source[donors], axis=0)
    to_face = distance_transform_edt(~letters)
    to_drawing = distance_transform_edt(letters | (native >= 236))
    fringe = (to_face < 2.6) & ((to_face < to_drawing) | letters)
    write = distance < 10.65
    result[write] = source[write]
    result[write & fringe] = stock
    return True


def restore_small_outlined_paper(source, mask, result, opaque):
    """Correct a pale Qwen shadow only under a tightly selected hollow sound."""
    y, x = np.where(mask)
    if not 150 <= len(x) <= 3500 or max(np.ptp(x), np.ptp(y)) > 82:
        return False
    box = np.s_[max(0, y.min()-22):y.max()+23, max(0, x.min()-22):x.max()+23]
    src, marked, out = source[box], mask[box], result[box]
    tone, edited = src.mean(2), out.mean(2)
    around = distance_transform_edt(~marked)
    bank = (around >= 4) & (around < 12)
    if (bank.sum() < 80 or (tone[bank] > 246).mean() < 2/3 or np.quantile(edited[marked], .05) < 238
            or np.median(edited[marked]) > 253 or np.quantile(np.ptp(src[bank], axis=1), .95) > 7):
        return False
    labels, _ = label(tone < 157, np.ones((3, 3)))
    ink = np.zeros_like(marked)
    count = 0
    for index, rect in enumerate(find_objects(labels), 1):
        if rect is None:
            continue
        stroke = labels[rect] == index
        if min(stroke.shape) < 5 or marked[rect][stroke].mean() < .98:
            continue
        filled = binary_fill_holes(stroke)
        hole = filled & ~stroke
        if hole.sum() < max(6, .07*stroke.sum()) or (tone[rect][hole] > 210).mean() < .5:
            continue
        ink[rect] |= filled
        count += 1
    if not 2 <= count <= 4:
        return False
    inferred = distance_transform_edt(~ink) <= 3.5
    if np.count_nonzero(inferred & marked) < .91*np.count_nonzero(inferred | marked):
        return False
    return restore_native_white(source, mask, result, opaque)


def restore_hollow_print_stock(source, mask, result, opaque):
    """Reinstate bare scan stock inside and around fully selected hollow lettering."""
    y, x = np.where(mask)
    if not 600 <= len(x) <= 14000 or max(np.ptp(x), np.ptp(y)) > 240:
        return False
    box = np.s_[max(0, y.min()-24):y.max()+25, max(0, x.min()-24):x.max()+25]
    source, mask, result = source[box], mask[box], result[box]
    valid = np.ones_like(mask) if opaque is None else opaque[box]
    tone, decoded = source.mean(2), result.mean(2)
    if np.quantile(np.ptp(source[mask], axis=1), .99) > 5:
        return False
    labels, _ = label(tone < 158, np.ones((3, 3)))
    faces, strokes = np.zeros_like(mask), np.zeros_like(mask)
    hollows, count = 0, 0
    for index, bounds in enumerate(find_objects(labels), 1):
        if bounds is None:
            continue
        ink = labels[bounds] == index
        if ink.sum() < 10 or mask[bounds][ink].mean() < .94:
            continue
        rows, cols = bounds
        if min(rows.start, cols.start, len(mask)-rows.stop, mask.shape[1]-cols.stop) < 2:
            return False
        filled = binary_fill_holes(ink)
        hole = filled & ~ink
        if hole.sum() >= max(12, .10*ink.sum()) and (tone[bounds][hole] > 248).mean() > .66:
            hollows += 1
        faces[bounds] |= filled
        strokes[bounds] |= ink
        count += 1
    if not 2 <= hollows <= 12 or not 2 <= count <= 20:
        return False
    distance = distance_transform_edt(~faces)
    if (distance[mask] < 6).mean() < .95 or mask[faces].mean() < .85:
        return False
    bank = (distance >= 5) & (distance < 9) & valid
    if (bank.sum() < 100 or np.quantile(tone[bank], .025) < 246 or np.median(tone[bank]) < 252
            or (np.ptp(source[bank], axis=1) > 4).mean() > .01 or ((distance < 9) & ~valid).any()
            or np.quantile(decoded[mask], .004) < 234 or ((tone < 157) & mask & ~strokes).sum() > 4):
        return False
    clearance = distance_transform_edt(~((tone < 158) & ~faces))
    stock = np.median(source[bank], axis=0)
    if (clearance[strokes] < 4).any() or ((decoded < stock.mean()-1) & faces).sum() < 50:
        return False
    # Recover the scan beyond the actual outline. The white centers and the
    # exposed paper between letters can retain their original native pixels.
    shoulder = np.clip((8-distance_transform_edt(~strokes))/3, 0, 1)[:, :, None]
    target = (1-shoulder)*source+shoulder*stock
    alpha = (np.clip((12-distance)/3, 0, 1)*np.clip((clearance-1.5)/3, 0, 1)*valid)[:, :, None]
    result[:] = np.rint(result*(1-alpha)+target*alpha).clip(0, 255).astype('u1')
    return True


def restore_caption_paper(source, mask, result, opaque):
    """Recover the white field between dense printed strokes from the original scan."""
    rows, cols = np.where(mask & opaque)
    if not len(rows):
        return
    box = np.s_[max(0,rows.min()-72):rows.max()+73, max(0,cols.min()-72):cols.max()+73]
    source, mask, result, opaque = source[box], mask[box], result[box], opaque[box]
    if mask.size > 650_000:
        return
    gray, tone = source.mean(2), result.mean(2)
    distance = distance_transform_edt(~mask)
    changed = np.any(source != result, axis=2)
    high, low = maximum_filter(gray, 5), minimum_filter(gray, 5)
    flat = (low > 249) & (high-low <= 5) & (tone > 231) & opaque
    groups, count = label(flat, np.ones((3, 3)))
    exterior = np.bincount(groups[flat & (distance > 3)], minlength=count+1)
    paper = flat & (exterior[groups] > 12)
    if not paper.any():
        return
    # Exposed gray or screened areas and drawn edges stop white paper from
    # propagating into the illustration. The gaps between letters can vote.
    exposed = (distance > 3) & (tone > 228) & opaque
    mass = np.maximum(.001, gaussian_filter(exposed.astype(float), 2))
    average = gaussian_filter(np.where(exposed, gray, 0), 2)/mass
    variance = gaussian_filter(np.where(exposed, (gray-average)**2, 0), 2)/mass
    opposing = (minimum_filter(exposed, 5) & (average < 248) & (abs(average-tone) < 22)
                & ((variance < 22) | ((average < 235) & (high < 250))))
    opposing |= (opaque & (distance > 1) & (high < 249) & (low > 207)
                 & (high-low <= 5) & (abs(gray-tone) < 18))
    edges = distance_transform_edt(tone > 216)
    clearance = distance_transform_edt(~opposing) if opposing.any() else np.full(mask.shape, np.inf)
    nearest, donors = distance_transform_edt(~paper, return_indices=True)
    area = changed & opaque & (tone > 231) & (edges > 1.6)
    y, x = np.where(area & (distance < 30) & (tone >= 235) & (np.ptp(result, axis=2) < 8) & (nearest < 42))
    if not 8 <= len(x) <= 100_000:
        return
    votes = facing_caption_paper(y, x, paper, opposing, edges)
    fade = np.clip((edges[y, x]-1.4)/3.5, 0, 1)
    strength = votes * fade * np.clip((clearance[y, x]-2)/9, 0, 1)
    if not (strength > .93).any():
        return
    local = np.zeros_like(gray)
    local[y, x] = strength
    reach = distance_transform_edt(local <= .93)
    density = gaussian_filter(local, 3)/np.maximum(.02, gaussian_filter(area.astype(float), 3))
    interior = (np.clip((17-reach[y, x])/10, 0, 1) * fade * np.clip((clearance[y, x]-1)/5, 0, 1)
                * np.clip((density[y, x]-.12)/.33, 0, 1))
    weight = np.maximum(strength, interior)[:, None]
    stock = high[tuple(donors[:, y, x])][:, None]
    result[y, x] = np.rint(result[y, x] + weight*(stock-result[y, x]))


def edge_profiles(tone, clearance):
    # Sample a subpixel black-to-white crossing with solid stock on each side.
    high = tone >= 127.5
    crossings = (~high[6:-9] & high[7:-8] & (tone[4:-11] < 45)
                 & (tone[9:-6] > 250) & (clearance[6:-9] > 4))
    for step in (4, 6, 8):
        crossings &= tone[6+step:-9+step] > 249
    y, x = np.nonzero(crossings)
    if len(x) < 32:
        return []
    y += 6
    position = y + (127.5-tone[y, x]) / (tone[y+1, x]-tone[y, x])
    profiles = []
    for initial_slope in np.arange(-.95, .951, .035):
        bins = np.floor((position-initial_slope*x)/1.6).astype(int)
        counts = np.bincount(bins-bins.min())
        if counts.max() < 30:
            continue
        selected = bins == counts.argmax()+bins.min()
        for _ in range(3):
            if selected.sum() < 27 or np.ptp(x[selected]) < 36:
                break
            slope, intercept = np.polyfit(x[selected], position[selected], 1)
            selected = np.abs(position-(slope*x+intercept)) < .49
        else:
            residual = np.abs(position[selected]-slope*x[selected]-intercept)
            if len(residual) < 30 or np.quantile(residual, .85) > .34:
                continue
            if any(abs(slope-m)*tone.shape[1]+abs(intercept-b) < 3 for _, m, b, _ in profiles):
                continue
            profiles.append((len(residual), slope, intercept, np.unique(x[selected])))
    return sorted(profiles, key=lambda item: -item[0])[:4]


def restore_edge(source, result, private, ink_distance, art_distance, eligible):
    tone, predicted = source.mean(axis=2), result.mean(axis=2)
    y, x = np.where(eligible & private & (predicted >= 234) & (predicted < 255)
                    & (ink_distance <= 23) & (art_distance > 1.4))
    if not len(x):
        return False
    clearance = distance_transform_edt(~private)
    changed = False
    for _, slope, intercept, bank in edge_profiles(tone, clearance):
        depth = y-(slope*x+intercept)
        index = np.searchsorted(bank, x)
        left = bank[np.maximum(0, index-4)]
        right = bank[np.minimum(len(bank)-1, index+3)]
        supported = ((index > 3) & (index < len(bank)-4) & (x-left < 86) & (right-x < 86)
                     & (depth >= .7) & (depth <= 20))
        if not supported.any():
            continue
        # Register both exposed banks by distance to the line. At the very edge
        # this retains its scan antialiasing instead of flattening it to white.
        rows = np.arange(-2, 22)[:, None] + np.floor(slope*bank+intercept).astype(int)
        cols = np.broadcast_to(bank, rows.shape)
        valid = (rows >= 0) & (rows < tone.shape[0])
        rows = rows.clip(0, tone.shape[0]-1)
        valid &= clearance[rows, cols] > 3
        offsets = (rows-(slope*cols+intercept))[valid]
        samples = tone[rows[valid], cols[valid]]
        for level in np.arange(.5, 20.01, .25):
            take = supported & (np.abs(depth-level) <= .126)
            if not take.any():
                continue
            observed = samples[np.abs(offsets-level) < .31]
            if len(observed) < 14 or np.quantile(observed, .15) < 246:
                continue
            paper = np.median(observed)
            if paper >= 250:
                result[y[take], x[take]] = round(paper)
                changed = True
    return changed


def scan_ray(y, x, direction, length, known, clearance, source, prediction):
    dy, dx = np.sin(direction), np.cos(direction)
    blocked = np.zeros(len(y), bool)
    confirmed = np.zeros(len(y), bool)
    consecutive = np.zeros(len(y), np.uint8)
    values = np.zeros(len(y), np.uint8)
    h, w = known.shape
    for step in range(2, length+1, 2):
        row, col = y+round(step*dy), x+round(step*dx)
        inside = (row >= 0) & (row < h) & (col >= 0) & (col < w)
        row, col = row.clip(0, h-1), col.clip(0, w-1)
        blocked |= ~confirmed & (~inside | (prediction[row,col] < 234)
                                 | ((clearance[row,col] > 2) & (source[row,col] < 247)))
        consecutive = np.where(known[row,col], consecutive+1, 0)
        first = (consecutive >= 4) & ~confirmed & ~blocked
        values[first] = np.rint(source[row[first],col[first]]).astype(np.uint8)
        confirmed |= first
    return confirmed, values


def restore_surrounded_paper(source, result, private, ink_distance, art_distance, eligible):
    tone, predicted = source.mean(axis=2), result.mean(axis=2)
    y, x = np.where(eligible & private & (ink_distance <= 22) & (predicted >= 236)
                    & (predicted < 255) & (art_distance > 2.4))
    if not 0 < len(y) <= 36_000:
        return False
    clearance = distance_transform_edt(~private)
    known = (clearance > 3) & (minimum_filter(source.min(axis=2), size=3) > 248)
    length = min(93, max(42, int(distance_transform_edt(private)[y,x].max())+24))
    rays = [scan_ray(y, x, i*np.pi/8, length, known, clearance, tone, predicted) for i in range(16)]
    votes, values = (np.stack(group) for group in zip(*rays))
    level = np.ma.median(np.ma.masked_array(values, mask=~votes), axis=0).filled(0)
    take = (votes.sum(axis=0) >= 7) & ((votes[:8] & votes[8:]).sum(axis=0) >= 2) & (level >= 253)
    if take.sum() < 4:
        return False
    result[y[take], x[take]] = np.rint(level[take,None]).astype(np.uint8)
    return True


def connected_paper_ray(y, x, angle, predicted, source, clearance, paper, exterior):
    dy, dx = np.sin(angle), np.cos(angle)
    h, w = paper.shape
    reached = np.zeros(len(y), bool)
    exposed = np.zeros(len(y), bool)
    blocked = np.zeros(len(y), bool)
    consecutive = np.zeros(len(y), np.uint8)
    levels = np.zeros(len(y), np.uint8)
    for step in (2, 4, 6, 8, 10, 12, 15, 18, 22, 26, 31, 37, 44, 53, 64, 78, 95, 116):
        row, col = y + round(step * dy), x + round(step * dx)
        blocked |= (row < 0) | (row >= h) | (col < 0) | (col >= w)
        row, col = row.clip(0, h - 1), col.clip(0, w - 1)
        blocked |= (predicted[row, col] < 238) | ((clearance[row, col] > 2) & (source[row, col] < 247))
        confirmed = paper[row, col] & ~blocked
        consecutive = np.where(confirmed, consecutive + 1, 0)
        first = (consecutive >= 2) & ~reached
        levels[first] = source[row[first], col[first]]
        reached |= first
        exposed |= exterior[row, col] & confirmed
    return reached, exposed, levels


def restore_connected_paper(source, result, private, eligible):
    # White between original letter strokes can provide additional samples
    # only when a three-pixel-wide paper path leads outside the erased region.
    tone, predicted = source.min(axis=2), result.min(axis=2)
    y, x = np.where(private & eligible & (np.ptp(result, axis=2) <= 6)
                    & (predicted >= 245) & (predicted < 255))
    if not 64 <= len(y) <= 100_000:
        return False
    clearance = distance_transform_edt(~private)
    flat = ((minimum_filter(tone, size=3) >= 252) & (minimum_filter(predicted, size=3) >= 240)
            & (np.ptp(source, axis=2) < 5))
    connected, count = label(flat, structure=np.ones((3, 3), bool))
    exterior = flat & (clearance > 4)
    sizes = np.bincount(connected[exterior], minlength=count + 1)
    paper = flat & (sizes[connected] >= 135)
    if not paper.any():
        return False
    rays = [connected_paper_ray(y, x, angle * np.pi / 8, predicted, tone, clearance, paper, exterior)
            for angle in range(16)]
    hits, exposed, samples = (np.stack(items) for items in zip(*rays))
    stock = np.ma.median(np.ma.masked_array(samples, mask=~hits), axis=0).filled(0)
    supported = ((hits.sum(axis=0) >= 7) & ((hits[:8] & hits[8:]).sum(axis=0) >= 2)
                 & (exposed.sum(axis=0) >= 3) & (distance_transform_edt(~paper)[y, x] <= 15)
                 & (stock >= 254) & (minimum_filter(predicted, size=3)[y, x] >= 242))
    if not supported.any():
        return False
    levels = np.zeros(private.shape, np.uint8)
    levels[y[supported], x[supported]] = np.rint(stock[supported]).astype(np.uint8)
    offset = np.maximum(0, levels.astype(np.float32) - result.mean(axis=2))
    marked = (levels > 0) & np.any(result != levels[:, :, None], axis=2)
    components, count = label(marked, structure=np.ones((3, 3), bool))
    sizes = np.bincount(components.ravel(), minlength=count + 1)
    means = np.bincount(components.ravel(), weights=offset.ravel(), minlength=count + 1) / sizes.clip(1)
    # Correct a continuous gray cast. Isolated JPEG differences carry too
    # little evidence to change a pale piece of the drawing.
    anchors = marked & (sizes[components] >= 64) & (means[components] >= 1.8)
    if not anchors.any():
        return False
    distance, nearest = distance_transform_edt(~anchors, return_indices=True)
    target = levels[tuple(nearest)].astype(np.float32)
    to_art = distance_transform_edt(~(~private & (tone < 242)))
    weight = (np.clip((23 - distance) / 16, 0, 1) * np.clip((predicted.astype(np.float32) - 241) / 7, 0, 1)
              * np.clip((to_art - 1.5) / 4, 0, 1))
    write = private & eligible & (weight > 0) & (np.ptp(result, axis=2) <= 7)
    delta = np.maximum(0, target[write, None] - result[write])
    result[write] = np.rint(result[write] + weight[write, None] * delta).astype(np.uint8)
    return True


def paper_around_stroke(row, col, source, decoded, to_ink, to_drawing):
    """Seek five consecutive scan-white pixels before the first obstruction on each ray."""
    directions = np.arange(16) * np.pi / 8
    radii = np.arange(2, 51)
    y = np.rint(row + np.outer(np.sin(directions), radii)).astype(int)
    x = np.rint(col + np.outer(np.cos(directions), radii)).astype(int)
    valid = (y >= 0) & (y < source.shape[0]) & (x >= 0) & (x < source.shape[1])
    y, x = y.clip(0, source.shape[0]-1), x.clip(0, source.shape[1]-1)
    blocked = ~valid | ((to_ink[y,x] > 3) & (source[y,x] < 230)) | (to_drawing[y,x] < 2)
    visible = (~np.maximum.accumulate(blocked, axis=1) & (to_ink[y,x] > 3)
               & (to_drawing[y,x] > 3) & (source[y,x] >= 249) & (decoded[y,x] >= 240))
    windows = np.lib.stride_tricks.sliding_window_view(visible, 5, axis=1).all(axis=2)
    hit = windows.any(axis=1)
    if hit.sum() < 10 or (hit[:8] & hit[8:]).sum() < 3:
        return
    ray = np.where(hit)[0][:, None]
    steps = windows[hit].argmax(axis=1)[:, None] + np.arange(5)
    samples = source[y[ray, steps], x[ray, steps]]
    if np.quantile(samples, .15) >= 251:
        return round(np.median(samples))


def restore_pen_and_paper(source, mask, result, eligible):
    tone, decoded = source.mean(axis=2), result.mean(axis=2)
    connected = np.ones((3, 3), bool)
    labels, count = label(tone < 153, connected)
    sizes = np.bincount(labels.ravel(), minlength=count+1)
    selected = np.bincount(labels[mask], minlength=count+1)
    lettering = (selected >= .72*sizes) & (sizes >= 20)
    lettering[0] = False
    if not lettering.any():
        return False
    drawing = (selected < .19*sizes) & (sizes >= 65) & (sizes-selected >= 60)
    drawing[0] = False
    to_ink = distance_transform_edt(~lettering[labels])
    to_drawing = (distance_transform_edt(~drawing[labels]) if drawing.any()
                  else np.full(mask.shape, np.inf))
    allowed = eligible & (mask | ((distance_transform_edt(~mask) <= 7.5)
                                  & np.any(source != result, axis=2)))
    # Colored keylines can connect a letter to an illustrated background.
    # Only recover pen on achromatic stock with independently exposed paper.
    stock = (source.min(axis=2) >= 249) & ~mask
    pen_stock = ((maximum_filter(np.ptp(source, axis=2), 13) <= 6)
                 & (distance_transform_edt(~stock) <= 15))
    # Restore the tip of a thin stroke connected to substantial untouched original ink.
    pen = (allowed & pen_stock & (to_drawing < 3.5) & (to_ink > to_drawing+1.4)
           & (tone < 253) & (decoded-tone > 9) & (distance_transform_edt(mask) < 14)
           & (maximum_filter(distance_transform_edt(tone < 153), 5) < 3.45)
           & (maximum_filter(source.min(axis=2), 15) >= 249))
    result[pen] = source[pen]
    decoded = result.mean(axis=2)
    islands, _ = label(decoded < 238, connected)
    changed = pen.any()
    for index, box in enumerate(find_objects(islands), 1):
        if max(side.stop-side.start for side in box) > 38:
            continue
        y, x = np.where(islands[box] == index)
        if not 3 <= len(x) <= 300:
            continue
        y, x = y+box[0].start, x+box[1].start
        if (allowed[y,x].mean() < .8 or decoded[y,x].min() > 210
                or (to_ink[y,x] <= 4.6).mean() < .76 or (to_drawing[y,x] < 6).mean() > .1
                or (decoded[y,x] > tone[y,x]+22).mean() < .4):
            continue
        level = paper_around_stroke(y.mean(), x.mean(), tone, decoded, to_ink, to_drawing)
        if level is None:
            continue
        pad = tuple(slice(max(0, side.start-3), min(length, side.stop+3))
                    for side, length in zip(box, mask.shape))
        target = ((distance_transform_edt(islands[pad] != index) < 2.8) & allowed[pad]
                  & (to_drawing[pad] > 4) & (to_ink[pad] < 8))
        flecks = target & (to_ink[pad] > 1.8) & (tone[pad] < 248) & ~mask[pad]
        result[pad][flecks] = source[pad][flecks]
        result[pad][target & ~flecks] = level
        changed |= target.any()
    return bool(changed)


def adjacent_panel_rule(tone, mask, clear):
    """The printed selection crosses or ends at an independently exposed panel edge."""
    for gray, selected, distance in ((tone, mask, clear), (tone[::-1], mask[::-1], clear[::-1])):
        for row in np.flatnonzero((distance < 18).any(1)):
            if row < 6 or row+4 >= len(gray):
                continue
            pen = ((np.maximum(gray[row], gray[row+1]) < 120)
                   & (gray[row-3:row-1].min(0) > 229) & (distance[row] > 2))
            horizontal = np.convolve(pen.astype(float), np.ones(11), "same") >= 10
            if (horizontal.sum() >= 13 and (horizontal & (distance[row] < 42)).sum() >= 8
                    and selected[max(0, row-10):row+11].any()):
                return True
    return False


def match_ruled_paper(source, mask, result, opaque):
    """Match a faint decoded cast to native paper on both sides of the selected lettering."""
    rows, cols = np.where(mask)
    if not len(rows) or max(np.ptp(rows), np.ptp(cols)) > 340:
        return False
    section = np.s_[max(0, rows.min()-54):rows.max()+55, max(0, cols.min()-54):cols.max()+55]
    source, mask, result = source[section][:, :, :3], mask[section], result[section][:, :, :3]
    if min(mask.shape) < 12 or (opaque is not None and not opaque[section].all()):
        return False
    tone, predicted = source.mean(2), result.mean(2)
    distance = distance_transform_edt(~mask)
    if (np.ptp(source, axis=2) > 24).mean() > .035 or not adjacent_panel_rule(tone, mask, distance):
        return False
    ink = mask & (tone < 160) & (predicted > 232)
    if ink.sum() < 22:
        return False
    known = (distance > 2) & (minimum_filter(source.min(2), 3) > 248)
    private = ((distance < 10) & (distance_transform_edt(~ink) < 22)
               & (np.ptp(result, axis=2) < 15) & np.any(source != result, axis=2))
    protected = (result.min(2) < 227) | ((distance > 2.1) & (tone < 235))
    to_art = distance_transform_edt(~protected)
    y, x = np.where(private & (result.min(2) >= 240) & (predicted < 254.95) & (to_art > 1.9))
    if len(y) < 20 or not known.any():
        return False
    rays = [scan_ray(y, x, i*np.pi/8, 55, known, distance, tone, predicted) for i in range(16)]
    votes, samples = (np.stack(z) for z in zip(*rays))
    count = votes.sum(0)
    level = np.ma.median(np.ma.masked_array(samples, mask=~votes), axis=0).filled(0)
    valid = ((count >= 5) & (votes[:8] & votes[8:]).any(0) & (level >= 253)
             & ((votes & (samples >= 251)).sum(0) >= .85*count))
    if valid.sum() < 5:
        return False
    stock = np.zeros_like(tone)
    stock[y[valid], x[valid]] = level[valid]
    gap, nearest = distance_transform_edt(stock == 0, return_indices=True)
    weight = (np.clip((17-gap)/9, 0, 1)*np.clip((to_art-1.3)/3, 0, 1)
              * np.clip((result.min(2).astype(float)-235)/9, 0, 1))
    write = private & ((distance < 2) | (tone > 245)) & (weight > 0)
    target = stock[tuple(nearest)]
    delta = np.maximum(0., target[write, None]-result[write])
    replacement = np.rint(result[write]+weight[write,None]*delta).clip(0,255).astype("u1")
    changed = np.any(result[write] != replacement)
    result[write] = replacement
    return bool(changed)


def restore_interrupted_rules(source, mask, result, opaque=None):
    """Recover only a demonstrably missing part of a long printed panel rule."""
    yy, xx = np.where(mask)
    if not len(yy) or max(np.ptp(yy), np.ptp(xx)) > 340 or min(np.ptp(yy), np.ptp(xx)) < 9:
        return False
    area = np.s_[max(0, yy.min()-64):yy.max()+65, max(0, xx.min()-64):xx.max()+65]
    rgb, local, edited = source[area][:, :, :3], mask[area], result[area][:, :, :3]
    if (np.ptp(rgb, axis=2) > 9).mean() > .02:
        return False
    valid = np.ones_like(local) if opaque is None else opaque[area]
    distance = distance_transform_edt(~local)
    applied = False
    for original, target, guard, writable in (
            (rgb, edited, distance, valid),
            (rgb.transpose(1, 0, 2), edited.transpose(1, 0, 2), distance.T, valid.T)):
        gray = original.mean(axis=2)
        for x in np.flatnonzero((guard < 14).any(axis=0)):
            if x < 12 or x+12 >= gray.shape[1]:
                continue
            dry = (gray[:, x] < 90) & (guard[:, x] > 3) & writable[:, x]
            breaks = np.r_[0, np.flatnonzero(np.diff(dry))+1, len(dry)]
            runs = [(a, b) for a, b in zip(breaks, breaks[1:]) if dry[a] and b-a >= 12]
            for (start, top), (bottom, end) in zip(runs, runs[1:]):
                if not 3 <= bottom-top <= 73 or min(top-start, end-bottom) < 16 or max(top-start, end-bottom) < 32:
                    continue
                near = guard[top:bottom, x]
                if near.min() > 10 or (near < 14).mean() < .7:
                    continue
                cols = slice(x-12, x+13)
                banks = (original[max(start, top-22):top, cols], original[bottom:min(end, bottom+22), cols])
                section = slice(top-2, bottom+2)
                if fill_rule_notch(banks, original[section, cols], target[section, cols],
                                   guard[section, cols], writable[section, cols]):
                    applied = True
    return applied


def fill_rule_notch(banks, original, edited, distances, opaque):
    first, last = [np.median(bank, axis=0) for bank in banks]
    a, b = first.mean(1), last.mean(1)
    core = slice(5, 20)
    if (abs(a[12]-b[12]) > 16 or abs(a[core]-b[core]).mean() > 16
            or min(a[5:9].max(), b[5:9].max(), a[16:20].max(), b[16:20].max()) < 211
            or not 2 <= ((a[core] < 95) & (b[core] < 95)).sum() <= 10):
        return False
    mass = (255-.5*(a+b)).sum()
    # A line which bends to one side still has the same ink mass across its
    # width. A white lettering keyline interrupts the actual ink.
    lost = (255-original.mean(2)).sum(axis=1) < .72*mass
    if lost.mean() < .25:
        return False
    if (edited[:, 12, 1] > max(a[12], b[12])+12).sum() < 2:
        return False
    fraction = np.arange(len(edited))[:, None, None]/len(edited)
    tone = first*(1-fraction)+last*fraction
    stripe = (np.maximum(a, b) < 232) & (abs(a-b) < 30)
    stripe[:5] = stripe[20:] = False
    write = (distances < 14) & stripe & opaque & (edited[:, :, 1] > tone[:, :, 1]+4)
    # On a straight panel border both outer paper banks also witness the
    # antialias ramp. Reuse it for the faint edge of the overprinted letter.
    flat = np.maximum.reduce([np.std(bank.astype(float), axis=0).max(1) for bank in banks]) < 6
    matched = (abs(a-b) < 7) & flat
    if (matched[3:22].mean() > .83 and min(a[3:6].min(), a[19:22].min()) > 246):
        flank = matched & (np.arange(len(a)) >= 3) & (np.arange(len(a)) < 22)
        # Preserve independent original ink that does not belong to the glyph
        # or to this rule, including a second pen meeting the panel edge.
        exposed = (original.mean(2) < 161) & (distances > 3) & (tone.mean(2) > 231)
        write |= (opaque & flank & ~exposed & (distances < 14)
                  & (np.max(np.abs(edited.astype(float)-tone), axis=2) > 4))
    edited[write] = np.rint(tone[write]).astype('u1')
    return bool(write.any())


def paper_beyond_panel_rule(source, mask, result, opaque):
    """Remove surviving ink on the paper side of a rule sampled on both sides of the print."""
    y, x = np.where(mask)
    top, bottom, left, right = y.min(), y.max(), x.min(), x.max()
    if not (12 <= bottom-top <= 140 and 12 <= right-left <= 155):
        return False
    width = max(17, min(41, (right-left)//2))
    if left < width+4 or right+width+5 >= mask.shape[1]:
        return False
    lo, hi = max(0, top-8), min(len(mask), bottom+9)
    window = np.s_[lo:hi, left-4:right+5]
    shoulders = [source[lo:hi, side] for side in
                 (slice(left-width-3, left-3), slice(right+4, right+width+4))]
    solid = np.minimum(*[(side.max(axis=2) < 65).mean(axis=1) for side in shoulders]) >= .84
    starts = np.flatnonzero(solid & ~np.r_[False, solid[:-1]])
    stops = np.flatnonzero(solid & ~np.r_[solid[1:], False])
    distance = distance_transform_edt(~mask)
    write = mask | ((distance <= 7.1) & np.any(source != result, axis=2))
    if opaque is not None:
        write &= opaque
    local, decoded = source[window], result[window]
    for start, stop in zip(starts, stops):
        if not 2 <= stop-start+1 <= 13:
            continue
        for sign, edge in ((1, stop), (-1, start)):
            depth = (np.arange(hi-lo)-edge)*sign
            paper = (depth >= 4) & (depth <= max(9, bottom-top))
            if paper.sum() < 9:
                continue
            span = max(12, width//2)
            banks = [shoulders[0][paper, -span:], shoulders[1][paper, :span]]
            if any((b.min(axis=2) > 249).mean() < .967 or np.median(b) < 254 for b in banks):
                continue
            exposed = (distance[window] > 4) & paper[:, None]
            if exposed.sum() < 45 or (local[exposed].min(axis=1) > 247).mean() < .976:
                continue
            inside = write[window] & paper[:, None]
            if (inside.sum() < 60 or (local[inside].min(axis=1) < 100).sum() < 16
                    or (decoded[inside].min(axis=1) < 220).sum() < 8):
                continue
            decoded[inside] = np.median(np.concatenate(banks).reshape(-1, 3), axis=0).round()
            return True
    return False


def restore_native_white(source, mask, result, opaque):
    rows, cols = np.where(mask)
    if len(rows) < 5:
        return False
    section = np.s_[max(0, rows.min()-96):rows.max()+97, max(0, cols.min()-96):cols.max()+97]
    source, mask, result = source[section], mask[section], result[section]
    if min(mask.shape) < 32 or mask.size > 700_000:
        return False
    if paper_beyond_panel_rule(source, mask, result, opaque[section] if opaque is not None else None):
        return True
    tone, predicted = source.mean(axis=2), result.mean(axis=2)
    ink = mask & (tone < 149) & (predicted >= 236)
    if ink.sum() < 5:
        return False
    difference = np.any(source != result, axis=2)
    if not difference.any():
        return False
    private = mask | difference
    ink_distance = distance_transform_edt(~ink)
    art_distance = distance_transform_edt(~(~private & (tone < 230)))
    chroma = np.ptp(result, axis=2)
    eligible = chroma <= 8
    stroke_eligible = eligible | ((chroma <= 19) & (maximum_filter(np.ptp(source, axis=2), 9) <= 3))
    if opaque is not None:
        eligible &= opaque[section]
        stroke_eligible &= opaque[section]
    if not (eligible & private & (predicted >= 234) & (predicted < 255) & (ink_distance <= 23)).any():
        return restore_pen_and_paper(source, mask, result, stroke_eligible)
    args = (source, result, private, ink_distance, art_distance, eligible)
    changed = False
    for transpose in (False, True):
        oriented = tuple(np.swapaxes(a, 0, 1) for a in args) if transpose else args
        for flip in (False, True):
            view = tuple(np.flip(a, axis=0) for a in oriented) if flip else oriented
            changed |= restore_edge(*view)
    changed |= restore_surrounded_paper(*args)
    changed |= restore_connected_paper(source, result, private, eligible)
    return restore_pen_and_paper(source, mask, result, stroke_eligible) or changed
