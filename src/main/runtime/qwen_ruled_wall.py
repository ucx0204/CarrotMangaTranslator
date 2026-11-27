"""Register thin, nearly vertical architectural lines on both sides of printed dialogue."""
import numpy as np
from scipy.ndimage import (distance_transform_edt, find_objects, gaussian_filter, label,
                           maximum_filter1d, median_filter, minimum_filter1d, uniform_filter1d)


def typeset_components(gray, stencil):
    parts, count = label(gray < 153, np.ones((3, 3), bool))
    ink = np.zeros_like(stencil)
    specks = np.zeros_like(stencil)
    owned = np.bincount(parts[stencil], minlength=count+1)
    sizes = np.bincount(parts.ravel(), minlength=count+1)
    strokes = 0
    for index, box in enumerate(find_objects(parts), 1):
        if box is None or owned[index] < .76*sizes[index]:
            continue
        sy, sx = box
        if max(sy.stop-sy.start, sx.stop-sx.start) > 40:
            continue
        part = parts[box] == index
        if sizes[index] < 5 or min(part.shape) < 2:
            specks[box] |= part
            continue
        outer = np.s_[max(0, sy.start-4):sy.stop+4, max(0, sx.start-4):sx.stop+4]
        distance = distance_transform_edt(parts[outer] != index)
        rim = gray[outer][(distance >= 1.8) & (distance <= 3.5)]
        if len(rim) and np.mean(rim > 222) >= .63:
            ink[box] |= part
            strokes += 1
    if strokes >= 4:
        return ink | (specks & (distance_transform_edt(~ink) < 7))


def nib_contrast(image):
    before = .5*(np.roll(image, 3, axis=1)+np.roll(image, 5, axis=1))
    after = .5*(np.roll(image, -3, axis=1)+np.roll(image, -5, axis=1))
    return np.minimum(before, after)-image


def measured_track(original, nib, eligible, x, rows):
    offsets = np.arange(-2, 3)
    columns = x+offsets[np.argmax(nib[rows[:, None], x+offsets], axis=1)]
    reliable = eligible[rows, columns]
    ys, xs = rows[reliable], columns[reliable]
    for _ in range(3):
        if len(ys) < 30:
            return
        fit = np.polyfit(ys, xs, 1)
        keep = abs(xs-np.polyval(fit, ys)) < 1.1
        ys, xs = ys[keep], xs[keep]
    if len(ys) < 30 or np.ptp(ys) < 68 or abs(fit[0]) > .047:
        return
    rows = np.arange(ys.min(), ys.max()+1)
    cx = np.rint(np.polyval(fit, rows)).astype(int)
    anchor = ((nib[rows, cx] > 11) & (original[rows, cx] > 90)
              & ((original[rows, cx-4]+original[rows, cx+4])*.5 > 168)
              & (abs(original[rows, cx-2]-original[rows, cx+2]) < 78))
    if sum(s.sum() >= 6 for s in np.array_split(anchor, 4)) < 3:
        return
    score = anchor.sum()+.18*np.ptp(rows)+.3*np.mean(nib[rows[anchor], cx[anchor]])
    return score, fit, rows, anchor


def find_tracks(gray, decoded, stencil, distance):
    original = gaussian_filter(gray, (1.1, .65))
    nib = nib_contrast(original)
    reference = maximum_filter1d(nib_contrast(gaussian_filter(decoded, (1.1, .65))), 11, axis=1)
    eligible = ((distance < 100) & (original > 87) & (original < 232) & (nib > 9.5)
                & (np.minimum(np.roll(original, 4, axis=1), np.roll(original, -4, axis=1)) > 162))
    consistent = uniform_filter1d(eligible.astype(float), 21, axis=0) > .55
    spans = maximum_filter1d(consistent.astype(np.uint8), 59, axis=0) > 0
    xs = np.where(stencil)[1]
    options = []
    for x in range(max(10, xs.min()-45), min(gray.shape[1]-10, xs.max()+45)):
        for box in find_objects(label(spans[:, x])[0]):
            if box is None:
                continue
            known = np.flatnonzero(eligible[box[0], x])+box[0].start
            if (len(known) < 35 or np.ptp(known) < 68 or np.min(distance[known, x]) > 38
                    or np.mean(reference[known, x] > 8) < .73):
                continue
            track = measured_track(original, nib, eligible, x, np.arange(known[0], known[-1]+1))
            if track is not None:
                options.append(track)
    unique = []
    for candidate in sorted(options, key=lambda v: -v[0]):
        _, fit, rows, _ = candidate
        mid = .5*(rows[0]+rows[-1])
        if any(abs(np.polyval(other, mid)-np.polyval(fit, mid)) < 4.6 and
               min(other_rows[-1], rows[-1])-max(other_rows[0], rows[0]) > .38*min(np.ptp(rows), np.ptp(other_rows))
               for _, other, other_rows, _ in unique):
            continue
        unique.append(candidate)
    return unique


def fit_bank(values, available, rows):
    indices = np.flatnonzero(available)
    if len(indices) < 12:
        return
    relative = np.linspace(-1., 1., len(rows))
    basis = np.column_stack([np.ones(len(rows)), relative, relative**2])
    known, levels = basis[indices], values[indices]
    coeff = np.linalg.lstsq(known, levels, rcond=None)[0]
    for _ in range(4):
        error = levels - known @ coeff
        sigma = np.clip(np.median(abs(error))*1.48, 3.5, 17)
        weight = 1/(1+(error/(1.6*sigma))**2)**2
        coeff = np.linalg.lstsq(known*weight[:, None], levels*weight, rcond=None)[0]
    residual = levels - known @ coeff
    valid = abs(residual) < max(5, 2*sigma)
    donors = indices[valid]
    if len(donors) < 11 or np.ptp(donors) < .44*np.ptp(rows):
        return
    distance = abs(rows[:, None]-rows[donors])
    local = np.exp(-.5*(distance/12.)**2)
    predicted = basis @ coeff + (local @ residual[valid])/np.maximum(.04, local.sum(1))
    support = np.clip((70-distance.min(1))/23, 0, 1)
    return predicted, support


def reconnect_track(gray, decoded, output, clearance, distance, track, opaque):
    _, fit, rows, anchors = track
    center = np.rint(np.polyval(fit, rows)).astype(int)
    if center.min() < 11 or center.max() >= gray.shape[1]-11:
        return False
    offsets = np.arange(-10, 11)
    indices = rows[:, None], center[:, None]+offsets
    source, candidate = gray[indices], decoded[indices]
    smoothed = gaussian_filter(source, (.85, .55))
    banks = np.minimum(np.median(smoothed[:, 2:6], axis=1), np.median(smoothed[:, 15:19], axis=1))
    contrast = banks-smoothed[:, 9:12].min(1)
    anchors = anchors & (contrast > 15) & (contrast < 145) & (smoothed[:, 4:17].min(1) > 79)
    if anchors.sum() < 33:
        return False
    mass = np.exp(-.5*((rows[:, None]-rows[anchors])/13.)**2).sum(1)
    expected = candidate.copy()
    support = np.zeros_like(expected)
    clean = (clearance[indices] > 4.75) & (source > 86)
    for i in range(len(offsets)):
        bank = fit_bank(source[:, i], clean[:, i], rows)
        if bank is not None:
            expected[:, i], support[:, i] = bank
    confirmed = np.median(candidate[:, [2, 3, 17, 18]], axis=1)-candidate[:, 5:16].min(1)
    error = uniform_filter1d(abs(candidate-expected)[:, 4:17].mean(1), 7)
    row_weight = (np.clip((mass-1.8)/3, 0, 1)*np.clip(np.minimum(rows-rows[0], rows[-1]-rows)/6, 0, 1)
                  *np.clip((confirmed-8)/17, 0, 1)*np.clip((error-2.6)/3, 0, 1))
    weight = (support*row_weight[:, None]*np.clip((16-distance[indices])/4, 0, 1)
              * np.clip((10-abs(offsets))/3, 0, 1)*opaque[indices])
    if np.count_nonzero(weight > .35) < 12:
        return False
    same = np.clip((6.5-abs(source-expected))/4, 0, 1)
    target = expected + (source-expected)*same
    witnessed = clean & (abs(source-expected) < 12) & (support > .8)
    target[witnessed] = source[witnessed]
    weight[witnessed] = np.maximum(weight[witnessed], opaque[indices][witnessed]
                                   * np.clip((18-distance[indices][witnessed])/4, 0, 1))
    output[indices] += weight*(target-output[indices])
    return True


def wall_banks(shape, tracks):
    height, width = shape
    rows, columns = np.arange(height), np.arange(width)
    centers = np.stack([np.polyval(fit, rows) for _, fit, _, _ in tracks])
    active = np.stack([(rows > span[0]+1) & (rows < span[-1]-1) for _, _, span, _ in tracks])
    distance = np.full(shape, np.inf)
    wall = np.zeros(shape, bool)
    for i, (_, _, span, _) in enumerate(tracks):
        mid = int((span[0]+span[-1])//2)
        neighbors = [j for j, (_, _, other, _) in enumerate(tracks)
                     if abs(centers[j, mid]-centers[i, mid]) < 112
                     and min(span[-1], other[-1])-max(span[0], other[0]) > 65]
        distance[span] = np.minimum(distance[span], abs(columns-centers[i, span, None]))
        if len(neighbors) < 3:
            continue
        lines, supported = centers[neighbors], active[neighbors]
        left = np.where(supported, lines, np.inf).min(0)
        right = np.where(supported, lines, -np.inf).max(0)
        wall |= ((supported.sum(0) >= 3)[:, None] & (columns >= left[:, None]-5)
                 & (columns <= right[:, None]+5))
    return wall, distance


def resume_wall_tone(gray, result, distance, clear, tracks, opaque):
    """The exposed screen on each row sets illumination. Remove short generated
    patches only inside the same wall, preserving its rails and transverse ink."""
    wall, rail_distance = wall_banks(gray.shape, tracks)
    donors = wall & (rail_distance > 4) & (clear > 6) & (gray > 165) & (abs(gray-result) < 10)
    measured = np.full((len(gray), 2), np.nan)
    for side in (0, 1):
        known = donors & ((np.arange(gray.shape[1])//5)%2 == side)
        for y in np.flatnonzero(known.sum(1) >= 6):
            levels = np.sort(gray[y, known[y]])
            trim = len(levels)//8
            measured[y, side] = levels[trim:len(levels)-trim].mean()
    agreement = abs(measured[:, 0]-measured[:, 1])
    rows = np.flatnonzero(agreement < 7)
    if len(rows) < 55:
        return
    y = np.arange(len(gray))
    tone = gaussian_filter(np.interp(y, rows, measured[rows].mean(1)), 2)
    smooth = gaussian_filter(result, (1.3, .6))
    residual = smooth-tone[:, None]
    correction = gaussian_filter(median_filter(residual, size=(39, 1), mode="nearest")-residual, (.6, .45))
    cross = gaussian_filter(result, (.7, 4))
    pen = np.minimum(np.roll(cross, 3, axis=0), np.roll(cross, -3, axis=0))-cross
    crossing = maximum_filter1d(pen, 5, axis=0) > 6
    weight = (opaque * np.clip((7-distance)/3, 0, 1) * np.clip((distance_transform_edt(wall)-1)/3, 0, 1)
              * np.clip((6.5-np.interp(y, rows, agreement[rows]))/2, 0, 1)[:, None]
              * np.clip((distance_transform_edt(~crossing)-.25)/2, 0, 1)
              * np.clip((minimum_filter1d(result, 7, axis=0)-97)/35, 0, 1))
    result += weight*correction


def restore_ruled_wall(source, mask, output, opaque):
    yy, xx = np.where(mask)
    if (len(yy) < 500 or np.ptp(yy) < 90 or np.ptp(yy) < 1.15*np.ptp(xx)
            or np.ptp(yy) > 570 or np.ptp(xx) > 360):
        return False
    box = np.s_[max(0, yy.min()-100):yy.max()+101, max(0, xx.min()-110):xx.max()+111]
    rgb, ink, edited = source[box][:, :, :3], mask[box], output[box][:, :, :3]
    if np.mean(np.ptp(rgb, axis=2) > 5) > .01:
        return False
    gray, decoded = rgb.mean(2), edited.mean(2)
    print_ink = typeset_components(gray, ink)
    if print_ink is None:
        return False
    distance = distance_transform_edt(~ink)
    tracks = find_tracks(gray, decoded, ink, distance)
    if len(tracks) < 3:
        return False
    clear = distance_transform_edt(~print_ink)
    result = decoded.copy()
    applied = False
    for track in tracks:
        _, fit, rows, _ = track
        mid = .5*(rows[0]+rows[-1])
        neighbours = sum(abs(np.polyval(other, mid)-np.polyval(fit, mid)) < 110 and
                         min(other_rows[-1], rows[-1])-max(other_rows[0], rows[0]) > 57
                         for _, other, other_rows, _ in tracks)
        if neighbours >= 3:
            applied |= reconnect_track(gray, decoded, result, clear, distance, track, opaque[box])
    if applied:
        resume_wall_tone(gray, result, distance, clear, tracks, opaque[box])
        change = np.rint(result-decoded)
        edit = change != 0
        edited[edit] = np.rint(edited[edit]+change[edit, None]).clip(0, 255).astype(np.uint8)
    return applied
