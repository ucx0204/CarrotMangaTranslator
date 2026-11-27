"""Register a displaced Qwen pen to an original stroke visible between letters."""
import numpy as np
from scipy.interpolate import CubicHermiteSpline
from scipy.ndimage import find_objects, gaussian_filter1d, label, map_coordinates


def read_grid(field, positions):
    return map_coordinates(field, positions.reshape(-1, 2).T[::-1], order=1,
                           mode="nearest").reshape(positions.shape[:-1])


def trace_line(samples, offsets, middle, radius, initial, cutoff):
    centers = np.empty(len(samples))
    mass = np.zeros(len(samples))
    for direction in (-1, 1):
        estimate, speed = initial, 0.
        for i in range(middle, len(samples) if direction > 0 else -1, direction):
            weight = np.maximum(0, cutoff-samples[i])*(abs(offsets-estimate) <= radius)
            mass[i] = weight.sum()
            point = weight@offsets/mass[i] if mass[i] > 35 else estimate
            speed = np.clip(.65*speed+.35*(point-estimate+speed), -1.65, 1.65)
            centers[i], estimate = point, point+speed
    return centers, mass


def original_nib(gray, clear, points, axis, normal, radius):
    y, x = np.indices(gray.shape)
    dx, dy = x-points[0], y-points[1]
    along, depth = dx*axis[0]+dy*axis[1], dx*normal[0]+dy*normal[1]
    visible = (abs(along) < radius) & (abs(depth) < 5) & (clear > 1.55)
    nib = np.arange(-4.5, 4.51, .125)
    fit = np.exp(-.5*((depth[visible]-nib[:, None])/.34)**2)
    if np.min(fit.sum(1)[abs(nib) < 2]) < 1.4:
        return
    profile = (fit@gray[visible])/np.maximum(.001, fit.sum(1))
    if min(np.median(profile[:11]), np.median(profile[-11:])) < 228:
        return
    return nib, profile


def interrupted_model_pen(samples, offsets, middle, half):
    """Track both visible shoulders when the edit broke the pen over an
    exposed island. Only interpolate between mutually aligned dark tips."""
    if np.min(samples[middle, abs(offsets) < 16]) < 218:
        return
    tips = []
    for direction in (-1, 1):
        for step in range(max(4, int(half)), 28):
            i = middle+direction*step
            inner = abs(offsets) < 17
            j = np.argmin(np.where(inner, samples[i]+.6*abs(offsets), 1000))
            pos = offsets[j]
            if samples[i, j] > 115 or not 3 < abs(pos) < 16:
                continue
            tracked, strength = trace_line(samples, offsets, i, 2.8, pos, 213)
            rows = i+direction*np.arange(1, 9)
            profile = abs(offsets-tracked[rows, None])
            if (np.min(strength[rows]) < 190 or np.ptp(tracked[rows]) > 4
                    or np.median(samples[rows][(profile > 3.4) & (profile < 6)]) < 233):
                continue
            tips.append((i, tracked))
            break
    if len(tips) != 2:
        return
    (left, before), (right, after) = tips
    span = right-left
    first, last = before[left], after[right]
    if first*last <= 0 or abs(last-first) > .38*span:
        return
    slope = (last-first)/span
    if max(abs((before[left]-before[left-7])/7-slope), abs((after[right+7]-after[right])/7-slope)) > .42:
        return
    return ((left-middle, first), (right-middle, last))


def trace_to_original_bank(gray, guide, clear, start, slope, direction, center):
    """Trace in native columns so an intersecting vertical hair cannot take
    over the search for the primary pen."""
    offsets = np.arange(-5., 5.1, .25)
    x0 = round(start[0])
    y = start[1]+slope*(x0-start[0])
    records = []
    for x in range(x0, x0+direction*91, direction):
        if x < 0 or x >= gray.shape[1] or y < 5 or y >= gray.shape[0]-5:
            break
        predicted = y+direction*slope if records else y
        def sample(field, row):
            return map_coordinates(field, [row+offsets, np.full(len(offsets), x)], order=1, mode="nearest")
        tones = sample(guide, predicted)
        mass = np.maximum(0, 185-tones)*(abs(offsets) <= 3.8)
        if mass.sum() < 180:
            break
        new = predicted+mass@offsets/mass.sum() if max(tones[:3].min(), tones[-3:].min()) > 100 else predicted
        slope = np.clip(.83*slope+.17*direction*(new-y), -2, 1.7)
        y = new
        source, distance = sample(gray, y), sample(clear, y)
        nib = (distance > 1.65)*(abs(offsets) <= 2.5)*np.maximum(0, 190-source)*(source < 174)
        native = nib@offsets/nib.sum() if nib.sum() > 50 else np.inf
        shoulder = (abs(offsets) > 2.8) & (distance > 1.5)
        white = shoulder.sum() > 3 and np.quantile(source[shoulder], .6) > 205
        records.append((x, y, abs(native) < 1.7 and white, native))
    track = np.array(records)
    if len(track) < 9:
        return
    for i in range(3, len(track)-3):
        if abs(track[i, 0]-center[0]) < 12 or abs(track[i, 3]) >= 1.5:
            continue
        stable = track[i, 2] and track[i-3:i+4, 2].sum() >= 5
        junction = np.all(abs(track[i:i+3, 3]) < 1.7) and track[i:i+6, 2].sum() >= 2
        if stable or junction:
            return track[:i+1]


def join_interrupted_model_pen(gray, guide, clear, center, axis, tips):
    if abs(axis[0]) < .45:
        return
    normal = np.array([-axis[1], axis[0]])
    starts = sorted([center+u*axis+v*normal for u, v in tips], key=lambda p: p[0])
    slope = axis[1]/axis[0]
    left = trace_to_original_bank(gray, guide, clear, starts[0], slope, -1, center)
    right = trace_to_original_bank(gray, guide, clear, starts[1], slope, 1, center)
    if left is None or right is None:
        return
    left = left[::-1]
    x = np.arange(left[0, 0], right[-1, 0]+1)
    if not x[0] < center[0] < x[-1]:
        return
    original = [left[0, 1]+left[0, 3], center[1], right[-1, 1]+right[-1, 3]]
    slopes = [np.polyfit(left[:8, 0], left[:8, 1], 1)[0], slope, np.polyfit(right[-8:, 0], right[-8:, 1], 1)[0]]
    curve = CubicHermiteSpline([x[0], center[0], x[-1]], original, slopes)
    decoded = np.interp(x, np.r_[left[:, 0], right[:, 0]], np.r_[left[:, 1], right[:, 1]])
    return np.column_stack((x, curve(x))), np.column_stack((x, decoded))


def fit_main_contour(gray, guide, clear, center, axis, half):
    normal = np.array([-axis[1], axis[0]])
    u, v = np.arange(-83., 84.), np.arange(-58., 58.5, .5)
    points = center + u[:, None, None]*axis + v[None, :, None]*normal
    source, edited, distance = (read_grid(z, points) for z in (gray, guide, clear))
    middle = len(u)//2
    initial = v[np.argmin(np.where(abs(v) < 17, edited[middle]+.9*abs(v), 900))]
    if not 4 < abs(initial) < 16 or edited[middle, abs(v-initial) < 1.1].min() > 115:
        tips = interrupted_model_pen(edited, v, middle, half)
        if tips is not None:
            joined = join_interrupted_model_pen(gray, guide, clear, center, axis, tips)
            if joined is not None:
                return joined[0], joined[1], True
        return
    displaced, _ = trace_line(edited, v, middle, 2.6, initial, 213)
    displaced = gaussian_filter1d(displaced, .8)
    # The model erased the exposed island. Both shoulders and the displaced
    # generated ink must independently match, including held-out rows.
    witness = abs(u) < max(3., half*.75)
    for subset in (np.arange(len(u)) % 2 == 0, np.arange(len(u)) % 2 == 1):
        rows = witness & subset
        delta = abs(v-displaced[rows,None])
        if (np.median(edited[rows][:,abs(v) < .8]) < 218 or
                np.mean(edited[rows][delta < 1.1] < 148) < .6 or
                np.median(edited[rows][(delta > 3.7) & (delta < 6.8)]) < 231):
            return
    near = abs(v-displaced[:, None]) < 2.6
    ink = (source < 155) & (distance >= 1.65) & near
    weight = ink*np.maximum(0, 176-source)
    native = (weight@v)/np.maximum(.01, weight.sum(1))
    known = (ink.sum(1) >= 3) & (abs(native-displaced) < 1.5)
    stable = np.convolve(known.astype(int), np.ones(7), "same") >= 5
    left = np.flatnonzero(known & stable & (u < -half-4))
    right = np.flatnonzero(known & stable & (u > half+4))
    if not len(left) or not len(right):
        return
    a, b = left[-1], right[0]
    if min(abs(u[a]), u[b]) < 13 or max(abs(u[a]), u[b]) > 75:
        return
    slopes = [np.clip((displaced[a+6]-displaced[a+1])/5, -.9, .9), 0.,
              np.clip((displaced[b-1]-displaced[b-6])/5, -.9, .9)]
    steps = u[a:b+1]
    corrected = CubicHermiteSpline([u[a], 0, u[b]], [native[a], 0., native[b]], slopes)(steps)
    path = center+steps[:, None]*axis+corrected[:, None]*normal
    model = center+steps[:, None]*axis+displaced[a:b+1, None]*normal
    return path, model, False


def register_transverse_pen(gray, guide, clear, result, point, axis, boundary):
    normal = np.array([-axis[1], axis[0]])
    u, v = np.arange(-18., 84.), np.arange(-21., 21.25, .25)
    ray = point+u[:, None]*axis
    side = np.sign(axis[1])
    crossing = (ray[:, 1]-np.interp(ray[:, 0], np.arange(gray.shape[1]), boundary))*side
    hits = np.flatnonzero(crossing >= 0)
    if not len(hits) or not 9 < u[hits[0]] < 62:
        return
    reach = u[hits[0]]
    grid = ray[:, None, :]+v[None, :, None]*normal
    source, edited, distance = (read_grid(z, grid) for z in (gray, guide, clear))
    model, strength = trace_line(edited, v, 18, 3.55, 0., 204)
    near = abs(v-model[:, None])
    ink = (near < 2.6) & (source < 170) & (distance > 1.5)
    shoulders = (near > 2.9) & (near < 6.3) & (distance > 1.5)
    mass = ink*np.maximum(0, 195-source)
    native = (mass@v)/np.maximum(.001, mass.sum(1))
    seen = ((u < reach-3) & (ink.sum(1) >= 3) & (shoulders.sum(1) >= 5)
            & ((shoulders & (source > 238)).sum(1) >= .6*shoulders.sum(1)))
    trained = (u >= -14) & (u < reach-3) & (strength > 105) & (abs(model) < 17)
    if seen.sum() < 7 or trained.sum() < .59*(reach+11):
        return
    design = np.column_stack((u*u/(reach+14), u, np.ones(len(u))))
    weight = .6*trained+4.5*seen
    coeff = np.linalg.solve(design.T@(weight[:, None]*design)+np.diag([1., .75, .02]),
                            design.T@(weight*np.where(seen, native, model)))
    offset = design@coeff
    if (np.quantile(abs(offset[seen]-native[seen]), .8) > 1.05 or abs(coeff[0]) > .65
            or max(abs(offset[u <= reach])) > 17):
        return
    line = ray+offset[:, None]*normal
    hits = np.flatnonzero((line[:, 1]-np.interp(line[:, 0], np.arange(gray.shape[1]), boundary))*side >= 0)
    if not len(hits):
        return
    end = u[hits[0]]
    y, x = np.indices(gray.shape)
    longitudinal = (x-point[0])*axis[0]+(y-point[1])*axis[1]
    across = (x-point[0])*normal[0]+(y-point[1])*normal[1]-np.interp(longitudinal, u, offset)
    relative = (y-boundary)*side
    sample = (longitudinal >= -16) & (longitudinal <= 0) & (abs(across) < 4.1) & (clear > 1.6)
    nib = np.linspace(-4, 4, 65)
    weight = np.exp(-.5*((across[sample]-nib[:, None])/.38)**2)
    if np.min(weight.sum(1)[abs(nib) < 2]) < 1:
        return
    paper = np.median(gray[sample & (abs(across) > 2.6)])
    if not np.isfinite(paper) or paper < 235:
        return
    profile = (weight@gray[sample])/np.maximum(.001, weight.sum(1))
    profile[weight.sum(1) <= .15] = paper
    tone = np.interp(across, nib, profile, left=paper, right=paper)
    tone = paper+np.clip((.3-relative)/1.2, 0, 1)*(tone-paper)
    start = max(-2, end-16)
    use = ((longitudinal >= start) & (longitudinal <= end+15) & (abs(across) < 5.1)
           & (clear < 2.9) & (relative <= 14))
    fade = np.clip((longitudinal-start)/4, 0, 1)*np.clip((5.1-abs(across))/1.2, 0, 1)
    fade *= np.clip((14-relative)/3, 0, 1)
    alpha = fade*np.clip((abs(relative)-1.65)/1.7, 0, 1)
    result[use] += alpha[use]*(tone[use]-result[use])
    above = use & (relative < .25)
    result[above] += np.minimum(0, fade[above]*(tone[above]-result[above]))


def restore_faint_banks(gray, guide, clear, result, area, preserve_opening=False):
    # A broken soft pencil line may still be measurable on both sides of an
    # opaque letter. Use the edit only where it corroborates the same gap.
    pieces, _ = label(area & (clear > 1.6) & (gray < 195), np.ones((3, 3)))
    banks = []
    for component, box in enumerate(find_objects(pieces), 1):
        height, width = (s.stop-s.start for s in box)
        if not 6 <= height <= 36 or width > .46*height+1:
            continue
        ink = pieces[box] == component
        if gray[box][ink].min() < 83 or not 1.4 <= ink.sum()/height <= 4.2:
            continue
        mass = ink*(231-gray[box])
        if not mass.sum(1).all():
            continue
        yy = np.arange(box[0].start, box[0].stop)
        xx = box[1].start+(mass@np.arange(width))/mass.sum(1)
        banks.append((yy, xx))
    for uy, ux in banks:
        for ly, lx in banks:
            gap = ly[0]-uy[-1]
            if not 6 <= gap <= 19 or len(ly) < 12:
                continue
            slope = np.polyfit(uy[-6:], ux[-6:], 1)[0]
            end_slope = np.polyfit(ly[:6], lx[:6], 1)[0]
            if abs(slope-end_slope) > .66 or abs(ux[-1]+gap*slope/2-lx[0]+gap*end_slope/2) > 2.5:
                continue
            mid = np.arange(uy[-1]+1, ly[0])
            join = CubicHermiteSpline([uy[-1],ly[0]], [ux[-1],lx[0]], [slope,end_slope])(mid)
            offsets = np.arange(-5, 5.1, .5)
            grid = np.stack(np.broadcast_arrays(join[:,None]+offsets, mid[:,None]), axis=-1)
            sample = read_grid(guide, grid)
            paper = np.median(sample[:, abs(offsets) >= 3.5], axis=1)
            shade = paper-sample[:, abs(offsets) <= 1].min(1)
            # A faint pencil may pass entirely through an exposed opening in
            # the letter. Retain its actual pressure and real blank intervals.
            if preserve_opening and np.min(read_grid(clear, grid[:, abs(offsets) <= 1])) > 4.5:
                for row, center in zip(np.r_[uy, mid, ly], np.r_[ux, join, lx]):
                    xx = np.arange(max(0, int(center)-5), min(gray.shape[1], int(center)+7))
                    alpha = np.clip((5-abs(xx-center))/1.5, 0, 1)*(clear[row, xx] > 2.5)
                    result[row, xx] += alpha*(gray[row, xx]-result[row, xx])
                continue
            if (paper.min() < 228 or (shade > 6).mean() < .68 or np.median(shade) > 68
                    or np.median(abs(offsets[sample.argmin(1)])) > 1.5):
                continue
            # Preserve original exposed pencil samples. In the gap the native
            # model provides the gradual pressure change and subpixel nib.
            ys, xs = np.r_[uy,mid,ly], np.r_[ux,join,lx]
            def measured_shoulder(rows, centers):
                rows_grid = np.stack(np.broadcast_arrays(centers[:,None]+offsets, rows[:,None]), axis=-1)
                ink = read_grid(gray, rows_grid)
                strength = 250-np.min(ink[:, abs(offsets) <= 1], axis=1)
                solid = np.argsort(strength)[-min(len(rows), 3):]
                profile = np.median(ink[solid], axis=0)
                center = int(np.argmin(np.where(abs(offsets) <= 1, profile, 256)))
                profile[:center+1] = np.maximum.accumulate(profile[center::-1])[::-1]
                profile[center:] = np.maximum.accumulate(profile[center:])
                profile = 251+(profile-251)*np.clip((4-abs(offsets))/1.5, 0, 1)
                return float(np.median(rows[solid])), profile

            start, first = measured_shoulder(uy, ux)
            finish, last = measured_shoulder(ly[:9], lx[:9])
            for row, center in zip(ys,xs):
                idx = np.arange(max(0,int(center)-5),min(gray.shape[1],int(center)+7))
                in_gap = uy[-1] < row < ly[0]
                allowed = (area[row,idx] & (clear[row,idx] > 1.65))
                alpha = np.clip((5.3-abs(idx-center))/1.6,0,1)*allowed
                target = guide[row,idx] if in_gap else gray[row,idx]
                if start <= row <= finish:
                    t = (row-start)/(finish-start)
                    nib = (1-t)*first+t*last
                    target = np.minimum(target, np.interp(idx-center, offsets, nib))
                if not in_gap and min(guide[row,idx]) < 83:
                    alpha *= np.clip((result[row,idx]-55)/75,0,1)
                result[row,idx] += alpha*(target-result[row,idx])


def connect_island(gray, guide, mask, clear, output, center, axis, half, ends):
    fit = fit_main_contour(gray, guide, clear, center, axis, half)
    if fit is None:
        return False
    path, model, broken = fit
    # Move the join along the secondary strokes. This retains their sideways
    # position when the long primary contour moves to its native location.
    if abs(path[-1, 0]-path[0, 0]) < abs(path[-1, 1]-path[0, 1])*.75:
        return False
    order, old_order = np.argsort(path[:, 0]), np.argsort(model[:, 0])
    xmin, xmax = path[order][[0, -1], 0]
    pens = [(p, v) for p, v, _, length, _ in ends
            if xmin < p[0] < xmax and abs(v[1]) > .73 and length >= 18]
    if len(pens) < 2:
        return False
    nib = original_nib(gray, clear, center, axis, np.array([-axis[1], axis[0]]), half)
    if nib is None:
        return False
    y, x = np.indices(gray.shape)
    columns = np.arange(gray.shape[1])
    boundary = np.interp(columns, path[order, 0], path[order, 1])
    old = np.interp(columns, model[old_order, 0], model[old_order, 1])
    gap = old-boundary
    depth = y-boundary
    shifted = map_coordinates(guide, [y+gap*np.exp(-.5*(depth/16)**2), x], order=3, mode="nearest").clip(0, 255)
    signed = depth/np.hypot(1, np.gradient(boundary))
    if axis[0] < 0:
        signed *= -1
    native = np.interp(signed, *nib)
    mix = np.clip((abs(gap)-.6)/2, 0, 1)*np.clip((5-abs(signed))/2.1, 0, 1)
    shifted += mix*(native-shifted)
    inside = (x > xmin) & (x < xmax) & (abs(depth) < 27)
    fade = np.clip((27-abs(depth))/6, 0, 1)*np.clip((x-xmin)/3, 0, 1)*np.clip((xmax-x)/3, 0, 1)
    result = output.mean(2)
    write = inside & (clear < 2.9)
    result[write] += fade[write]*(shifted[write]-result[write])
    result[inside & ~write] = gray[inside & ~write]
    for point, direction in pens:
        register_transverse_pen(gray, guide, clear, result, point, direction, boundary)
    core = write & (abs(signed) < 2.1)
    result[core] = np.minimum(result[core], native[core])
    pencil = (x > xmin) & (x < xmax) & (depth > 6) & (depth < 79)
    restore_faint_banks(gray, guide, clear, result, pencil, preserve_opening=broken)
    changed = inside | (pencil & (np.abs(result-output.mean(2)) > .5))
    output[changed] = np.rint(result[changed,None]).clip(0,255).astype("u1")
    return True


def restore_crossing_ink(source, marked, output, clear, aligned, ends):
    if aligned is None or len(ends) < 6 or (np.ptp(source, axis=2) > 8).mean() > .015:
        return False
    gray, guide = source.mean(2), aligned.mean(2)
    changed = False
    for i, (p, axis, width, length, inset) in enumerate(ends):
        if not 8 <= length <= 21 or inset > 7 or width > 2.5:
            continue
        for q, tangent, width2, length2, inset2 in ends[:i]:
            delta = p-q
            span = np.linalg.norm(delta)
            if (length != length2 or inset2 > 7 or abs(width-width2) > .4
                    or not 6 <= span <= 21 or delta@axis < .92*span or axis@tangent > -.95):
                continue
            center = (p+q)/2
            if np.min(np.r_[center, gray.shape[::-1]-center]) < 32:
                continue
            changed |= connect_island(gray, guide, marked, clear, output, center, delta/span, span/2, ends)
    return changed


def restore_lettering_crossings(source, ink, output, decoded):
    from pathlib import Path
    from runpy import run_path
    from scipy.ndimage import distance_transform_edt
    rows, cols = np.nonzero(ink)
    if len(rows) < 150 or min(np.ptp(rows), np.ptp(cols)) < 35:
        return
    region = np.s_[max(0, rows.min()-55):rows.max()+56, max(0, cols.min()-55):cols.max()+56]
    mask = ink[region]
    rgb = source[region][:, :, :3]
    if mask.size > 700_000 or (np.ptp(rgb, axis=2) > 8).mean() > .015:
        return
    clear = distance_transform_edt(~mask)
    ends = run_path(str(Path(__file__).with_name("qwen-reconnect-balloon.py")))["visible_ends"](rgb.mean(2), clear)
    restore_crossing_ink(rgb, mask, output[region][:, :, :3], clear, decoded[region], ends)
