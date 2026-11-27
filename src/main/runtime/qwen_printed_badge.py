"""Continue concentric printed outlines and corroborated symmetric details across a sound effect."""
import numpy as np
from scipy.ndimage import (binary_closing, binary_fill_holes, convolve, distance_transform_edt,
                           find_objects, gaussian_filter, label, map_coordinates, maximum_filter)
from scipy.optimize import least_squares, minimize
from scipy.spatial import ConvexHull


def ellipse_distance(parameters, x, y):
    cx, cy, major, minor, angle = parameters
    c, s = np.cos(angle), np.sin(angle)
    u = ((x - cx) * c + (y - cy) * s) / major
    v = ((y - cy) * c - (x - cx) * s) / minor
    distance = (u*u + v*v - 1) / np.maximum(.0001, 2*np.hypot(u/major, v/minor))
    return distance, np.arctan2(v, u)


def restore_balloon_rims(source, ink, edited):
    """Recover the original boundary of a closed pale balloon crossed by small print."""
    y, x = np.where(ink)
    if not 100 <= len(x) <= 5500 or max(np.ptp(x), np.ptp(y)) > 162:
        return
    bounds = np.s_[max(0, y.min()-130):y.max()+131, max(0, x.min()-130):x.max()+131]
    src, result = source[bounds], edited[bounds]
    gray = src[:, :, :3].mean(2)
    if np.mean(np.ptp(src[:, :, :3], axis=2) > 22) > .015:
        return
    opaque = src[:, :, 3] == 255
    distance = distance_transform_edt(~ink[bounds])
    strong = distance_transform_edt(~((gray < 109) & (distance < 2.5)))
    fields, _ = label((gray >= 226) & opaque)
    for index, box in enumerate(find_objects(fields), 1):
        rows, cols = box
        w, h = cols.stop-cols.start, rows.stop-rows.start
        if (min(w, h) < 20 or max(w, h) > 240 or not rows.start or not cols.start
                or rows.stop == gray.shape[0] or cols.stop == gray.shape[1]):
            continue
        box = np.s_[max(0, rows.start-10):rows.stop+10, max(0, cols.start-10):cols.stop+10]
        paper = binary_fill_holes(fields[box] == index)
        recover_balloon_field(src[box], result[box], paper, distance[box], strong[box], opaque[box])


def restore_overlapping_pen_tip(source, ink, edited):
    """Preserve a pen line entering narrow sound lettering from unselected artwork."""
    y, x = np.where(ink)
    if not 96 <= len(x) <= 5500 or not 16 <= min(np.ptp(x), np.ptp(y)) or max(np.ptp(x), np.ptp(y)) > 112:
        return
    top = y.min()
    if top < 5:
        return
    left, right = max(0, x.min()-12), min(ink.shape[1], x.max()+13)
    area = np.s_[top-5:min(ink.shape[0], top+30), left:right]
    mask = ink[area]
    widths = mask.sum(1)
    thin = widths[5:11].max()
    if not 2 <= thin <= 7:
        return
    wider = np.flatnonzero(widths > max(7, 1.6*thin))
    if not len(wider) or not 12 <= wider[0] <= 24:
        return
    cut = wider[0]-1
    stem_y, stem_x = np.where(mask[5:cut])
    if not len(stem_x) or np.ptp(stem_x) > 1.8*thin or len(np.unique(stem_y)) != cut-5:
        return
    src = source[area]
    gray = src[:, :, :3].mean(2)
    if np.mean(np.ptp(src[:, :, :3], axis=2) > 15) > .015:
        return
    # Require an actual pen stroke continuing into the mask on each of five
    # unselected rows. A detached accent at the top of a glyph has no such bank.
    col = int(np.median(stem_x))
    strip = gray[:5, max(0, col-thin):col+thin+1]
    if np.any(strip.min(1) > 180) or np.median(gray[5:cut][mask[5:cut]]) > 137:
        return
    row, column = np.indices(gray.shape)
    inside = (src[:, :, 3] == 255) & (abs(column-col) <= 2*thin)
    near = distance_transform_edt(~mask)
    result = edited[area][:, :, :3]
    weight = np.clip((10-near)/2, 0, 1)*np.clip((2*thin-abs(column-col))/2, 0, 1)
    keep = inside & (row <= cut)
    blend = weight[:, :, None]*(src[:, :, :3].astype(float)-result)
    result[keep] = np.rint(result+blend)[keep].astype('u1')
    # The first transverse print stroke hides the end. Round the last measured
    # native cross-section on the subpixel grid instead of leaving a flat cut.
    radius = distance_transform_edt(gray[cut] < 162)
    for dy in range(1, min(5, len(mask)-cut)):
        yi = cut+dy
        opacity = np.clip(radius+.35-.72*dy, 0, 1)*weight[yi]*inside[yi]
        diff = np.minimum(0, src[cut, :, :3].astype(float)-result[yi])
        result[yi] = np.rint(result[yi]+opacity[:, None]*diff).astype('u1')


def recover_balloon_field(source, edited, paper, distance, strong, opaque):
    from scipy.ndimage import binary_erosion
    gray = source[:, :, :3].mean(2)
    inward = distance_transform_edt(paper)
    core = gray[inward > 5]
    if len(core) < 160 or np.quantile(core, .4) < 250 or np.median(core) < 251:
        return
    rim = paper & ~binary_erosion(paper)
    if distance[rim].min() > 8:
        return
    y, x = np.where(rim)
    hull = ConvexHull(np.column_stack([x, y]))
    if paper.sum() < .885*(hull.volume + hull.area/2 + 1):
        return
    outward = distance_transform_edt(~paper)
    shell = ~paper & (outward < 5.3) & opaque
    lost = shell & (strong > 3.5) & (distance < 15) & (gray < 240)
    lost &= edited[:, :, :3].mean(2) > gray + 5
    missing = lost & (gray < 206) & (edited[:, :, :3].mean(2) > gray + 28)
    if missing.sum() < 6:
        return
    # Only a consistent darker line outside the white interior establishes a rim.
    signed = gaussian_filter(np.where(paper, .5-inward, outward-.5), .75)
    bank = (distance > 6) & (strong > 5) & opaque
    profile = pale_pen_profile(gray, signed, bank, np.arange(-3, 5.1, .25))
    if profile is None:
        return
    known = distance[y, x] > 7
    if known.sum() < 20:
        return
    fit = measured_ellipse(x[known].astype(float), y[known].astype(float))
    if fit is not None:
        yy, xx = np.indices(paper.shape)
        offset, _ = ellipse_distance(fit, xx, yy)
        exposed = (distance > 8) & (distance_transform_edt(~rim) < 11) & opaque
        ellipse_profile = pale_pen_profile(gray, offset, exposed, np.arange(-4, 8, .25))
        if ellipse_profile is not None:
            signed, profile = offset, ellipse_profile
    axis, levels, peak = profile
    rgb = edited[:, :, :3]
    weight = (np.clip((strong-2.7)/2, 0, 1) * np.clip((6-outward)/2, 0, 1))[:, :, None]
    paste = shell & (distance < 15)
    restored = rgb + (source[:, :, :3].astype(float)-rgb)*weight
    rgb[paste] = np.rint(restored[paste]).astype('u1')
    uncertain = (abs(signed-peak) < 4) & (strong < 7) & (distance < 12) & opaque
    prediction = np.interp(signed, axis, levels)
    if fit is None:
        # The measured interior follows a sharp corner. Its sides can have
        # different pen widths. Preserve original light pixels on their outside.
        prediction = np.maximum(gray, prediction)
    blend = np.clip((7-strong)/3, 0, 1) * np.clip((4-abs(signed-peak))/1.4, 0, 1)
    target = rgb + blend[:, :, None]*(prediction[:, :, None]-rgb)
    rgb[uncertain] = np.rint(np.minimum(target, rgb)[uncertain]).astype('u1')


def pale_pen_profile(gray, signed, bank, axis):
    samples = [gray[bank & (abs(signed-t) < .32)] for t in axis]
    supported = np.array([len(s) >= 4 for s in samples])
    if supported.sum() < .78*len(axis):
        return
    levels = np.array([np.median(s) for s, ok in zip(samples, supported) if ok])
    axis = axis[supported]
    peak = axis[np.argmin(levels)]
    if (0 < peak < 3.6 and 105 < levels.min() < 200
            and levels[0]-levels.min() > 43 and levels[-1]-levels.min() > 20):
        return axis, levels, peak


def exposed_pigment_edge(gray, pigment, clear):
    ny, nx = np.gradient(gaussian_filter(gray, 1.45))
    norm = np.maximum(.001, np.hypot(nx, ny))
    dark_distance = distance_transform_edt(gray >= 180)
    rim = pigment & (distance_transform_edt(pigment) < 1.7) & (dark_distance < 3.5) & (clear > 2.3)
    y, x = np.where(rim)
    if len(x) < 27:
        return
    nx, ny = nx[rim] / norm[rim], ny[rim] / norm[rim]
    offset = np.arange(-4.5, 2, .15)
    profile = map_coordinates(gray, [y[:, None]+ny[:, None]*offset, x[:, None]+nx[:, None]*offset],
                              order=1, mode="nearest")
    inside, outside = np.median(profile[:, -5:], axis=1), np.median(profile[:, :7], axis=1)
    held = (inside > 225) & (outside < 195)
    if held.sum() < 27:
        return
    half = (inside+outside)/2
    step = offset[np.argmin(abs(profile-half[:, None]), axis=1)]
    return (x+nx*step)[held], (y+ny*step)[held]


def partly_printed_ellipse(gray, pigment, clear, edge):
    px, py = edge
    span = max(np.ptp(px), np.ptp(py))
    if not 17 < span < 75:
        return
    initial = [np.mean(px), np.mean(py), .67*span, .51*span, 0]
    limits = ([px.min()-.45*span, py.min()-.45*span, .26*span, .26*span, -np.pi],
              [px.max()+.45*span, py.max()+.45*span, 1.15*span, 1.15*span, np.pi])
    fit = least_squares(lambda p: ellipse_distance(p, px, py)[0], initial, bounds=limits,
                        loss="soft_l1", f_scale=.5, max_nfev=100).x
    y, x = np.indices(gray.shape)
    distance, _ = ellipse_distance(fit, x, y)
    # An arc can admit several ellipses. Unprinted negative space and the
    # surviving matt pigment independently bound its hidden side.
    to_face = distance_transform_edt(~pigment)
    by, bx = np.where((clear > 2.6) & (to_face > 2) & (gray < 205) & (distance < 7) & (distance > -16))
    sy, sx = np.where(pigment & (clear > 1.5))
    if len(sx) < 75 or len(bx) < 30:
        return

    def fit_part(held):
        def residual(p):
            positive = ellipse_distance(p, sx, sy)[0]
            negative = ellipse_distance(p, bx, by)[0]
            return np.r_[ellipse_distance(p, px[held], py[held])[0],
                         .8*np.maximum(positive+.1, 0), 1.4*np.minimum(negative-.65, 0)]
        return least_squares(residual, fit, bounds=limits, loss="soft_l1", f_scale=.5, max_nfev=70).x

    fit = fit_part(np.ones(len(px), bool))
    offsets, angles = ellipse_distance(fit, px, py)
    sorted_angles = np.sort(angles)
    span = 2*np.pi-np.diff(np.r_[sorted_angles, sorted_angles[0]+2*np.pi]).max()
    if span < 2.50 or np.quantile(abs(offsets), .93) > 1.35:
        return
    field, theta = ellipse_distance(fit, x, y)
    if ((field < -2) & (clear > 2.6) & (to_face > 2) & (gray < 205)).sum() > 2:
        return
    held = (np.floor(px/3) + np.floor(py/4)) % 2 == 0
    if min(held.sum(), (~held).sum()) < 11:
        return
    for partition in (held, ~held):
        peer = fit_part(partition)
        if np.quantile(abs(ellipse_distance(peer, px[~partition], py[~partition])[0]), .89) > 1.65:
            return
        if np.max(abs(ellipse_distance(peer, x[abs(field)<1], y[abs(field)<1])[0])) > 3.8:
            return
    direction = np.min(abs(np.angle(np.exp(1j*(theta[:, :, None]-angles)))), axis=2)
    return fit, field, direction


def recover_neutral_face(source, mask, result, pigment, clear):
    gray = source[:, :, 1].astype(float)
    if (mask & pigment).sum() < .55*pigment.sum() or np.ptp(source[pigment], axis=1).max() > 5:
        return False
    level = np.median(gray[pigment])
    if np.quantile(abs(gray[pigment]-level), .75) > 4 or np.median(result[pigment, 1]) > level-55:
        return False
    edge = exposed_pigment_edge(gray, pigment, clear)
    measured = partly_printed_ellipse(gray, pigment, clear, edge) if edge is not None else None
    if measured is None:
        return False
    fit, distance, direction = measured
    interior = distance < -2
    printed = interior & (clear < 1.6)
    if not .12*interior.sum() < printed.sum() < .70*interior.sum():
        return False
    to_face = distance_transform_edt(~pigment)
    reach = max(fit[2:4])
    exposed = (direction < .35) & (distance >= -2.3) & (to_face < .92*reach)
    exterior = (gray < 205) & (distance < 7) & (distance > -16) & (to_face < 7)
    known = (clear >= 1.6) & (pigment | exposed | (exterior & (clear > 2.6)))
    # Antialiasing from a different white letter is visible even two pixels
    # into a black field. It is separate from the estimated edge of the face.
    neighboring_print = (distance > 3) & (clear < 5.5) & (maximum_filter(result[:, :, 1], 7) < 32)
    known &= ~neighboring_print
    weight = np.clip(.5-distance, 0, 1)
    paint = (weight > 0) & ~known & (mask | np.any(result != source, axis=2))
    result[paint] = np.rint(result[paint]*(1-weight[paint, None]) + level*weight[paint, None])
    result[known] = source[known]
    return True


def recover_covered_pale_details(source, mask, result, opaque=None):
    """Preserve isolated matt highlights a white publisher keyline passes over."""
    if mask.sum() < 7500 or mask.size > 950_000:
        return False
    gray = source[:, :, 1].astype(float)
    if (gray[mask] < 65).mean() < .16 or (gray[mask] > 244).mean() < .15:
        return False
    structure = np.ones((3, 3))
    labels, _ = label(gray >= 243, structure)
    counts = np.bincount(labels.ravel())
    printed = (labels != 0) & (counts[labels] >= 45)
    clear = distance_transform_edt(~binary_fill_holes(binary_closing(printed, structure)))
    labels, _ = label(binary_closing((gray >= 229) & (gray < 243), structure), structure)
    applied = False
    for i, box in enumerate(find_objects(labels), 1):
        heights = [s.stop-s.start for s in box]
        if min(heights) < 15 or max(heights) > 78:
            continue
        area = tuple(slice(max(0, s.start-34), s.stop+34) for s in box)
        if opaque is not None and not opaque[area].all():
            continue
        pigment = labels[area] == i
        if 155 <= pigment.sum() < 3100:
            applied |= recover_neutral_face(source[area], mask[area], result[area], pigment, clear[area])
    return applied


def measured_ellipse(x, y):
    span = max(np.ptp(x), np.ptp(y))
    if span < 23:
        return
    u, v = (x - x.mean())/span, (y - y.mean())/span
    design = np.column_stack([u*u, 2*u*v, v*v, u, v])
    coefficients = np.linalg.lstsq(design, np.ones(len(u)), rcond=None)[0]
    matrix = np.array([[coefficients[0], coefficients[1]], [coefficients[1], coefficients[2]]])
    try:
        center = np.linalg.solve(matrix, -.5 * coefficients[3:])
        values, vectors = np.linalg.eigh(matrix)
    except np.linalg.LinAlgError:
        return
    if np.min(abs(values)) < .0001:
        return
    squared = (1 + center @ matrix @ center) / values
    if np.min(squared) <= 0 or np.max(squared) > 5:
        return
    major, minor = np.sqrt(squared) * span
    if not 10 < minor <= major < 145 or minor < .42 * major:
        return
    initial = [x.mean() + center[0]*span, y.mean() + center[1]*span,
               major, minor, np.arctan2(vectors[1, 0], vectors[0, 0])]
    fit = least_squares(lambda p: ellipse_distance(p, x, y)[0], initial,
                        loss="soft_l1", f_scale=.8, max_nfev=27).x
    distance, angle = ellipse_distance(fit, x, y)
    ordered = np.sort(angle)
    coverage = 2*np.pi - max(np.diff(np.r_[ordered, ordered[0] + 2*np.pi]))
    if coverage >= 3.9 and np.quantile(abs(distance), .86) <= 1.65:
        return fit


def concentric(large, small):
    ratios = small[2:4] / large[2:4]
    return (np.hypot(*(large[:2] - small[:2])) < 3.6 and
            .76 < min(ratios) <= max(ratios) < .96 and np.ptp(ratios) < .08 and
            (large[3] > .92*large[2] or abs(np.sin(large[4]-small[4])) < .15))


def paint_rim(source, result, valid, ids, index, fit, distance):
    y, x = np.indices(ids.shape)
    offset, _ = ellipse_distance(fit, x, y)
    bank = valid & (distance > 3) & (abs(offset) < 4.5) & (distance_transform_edt(ids != index) < 3.5)
    write = valid & (distance < 3.5) & (abs(offset) < 3.6)
    if not write.any() or np.count_nonzero(bank) < 70:
        return
    steps = np.arange(-4, 4.25, .25)
    samples = [source[bank & (abs(offset-t) < .23), :3] for t in steps]
    supported = np.array([len(v) >= 3 for v in samples])
    if supported.sum() < 20:
        return
    strength = np.clip((3.6-abs(offset[write]))/1.9, 0, 1)
    sampled = np.array([np.median(v, axis=0) for v, ok in zip(samples, supported) if ok])
    for channel in range(3):
        estimate = np.interp(offset[write], steps[supported], sampled[:, channel])
        old = result[:, :, channel][write]
        result[:, :, channel][write] = np.rint((1-strength)*old + strength*estimate)


def symmetric_point(parameters, x, y, axes, reflected):
    cx, cy, major, minor, theta = axes
    c, s = np.cos(theta), np.sin(theta)
    u = ((x-cx)*c + (y-cy)*s) / major
    v = ((y-cy)*c - (x-cx)*s) / minor
    if reflected:
        v = -v
    dx, dy, angle = parameters
    ct, st = np.cos(np.deg2rad(angle)), np.sin(np.deg2rad(angle))
    X, Y = major*(u*ct-v*st), minor*(u*st+v*ct)
    return cx + dx + c*X - s*Y, cy + dy + s*X + c*Y


def original_symmetries(gray, known, axes, centered, fine=False):
    ink = (gray < 160) & known
    py, px = np.where(ink)
    if len(px) < 55:
        return []
    # Interleaved spatial strips hold out separate portions of the exposed pen.
    train = ((py + 2*px)//5) % 2 == 0
    evidence = distance_transform_edt(~ink)
    visible = known.astype('f')
    def score(v, reflected, subset):
        x, y = symmetric_point(v, px[subset], py[subset], axes, reflected)
        ok = map_coordinates(visible, [y, x], order=0) > .5
        count = ok.sum()
        if count < max(18, .24 * subset.sum()):
            return 9., 0., 0
        differences = map_coordinates(evidence, [y[ok], x[ok]], order=1)
        return np.minimum(differences, 7).mean(), (differences < 1.85).mean(), count
    candidates = []
    step = 10 if fine else 30
    transforms = [(180, False)] if centered else [(180, False)] + [(i, True) for i in range(0, 360, step)]
    extent = min(18, max(4, int((.46 if fine else .34)*axes[3])))
    coarse = range(-extent, extent+1, max(2, extent//5))
    for angle, reflected in transforms:
        objective = lambda v: score(v, reflected, train)[0]
        seed = min(([dx, dy, angle] for dx in coarse for dy in coarse), key=objective)
        bounds = [(-extent, extent), (-extent, extent), (angle-12, angle+12)]
        best = minimize(objective, seed, method="Nelder-Mead", bounds=bounds,
                        options={"maxiter":45, "xatol":.04}).x
        error, agreement, count = score(best, reflected, ~train)
        if error < 1.15 and agreement >= .86 and count >= (20 if centered else 50):
            candidates.append((error, best, reflected))
    return sorted(candidates, key=lambda t: t[0])


def restore_inner_motif(source, result, distance, valid, axes):
    cx, cy, major, minor, theta = axes
    y, x = np.indices(distance.shape)
    u = ((x-cx)*np.cos(theta) + (y-cy)*np.sin(theta))/major
    v = ((y-cy)*np.cos(theta) - (x-cx)*np.sin(theta))/minor
    rho = np.hypot(u, v)
    gray = source[:, :, :3].mean(2)
    for centered, band in [(True, rho <= .49), (False, (rho > .49) & (rho < .96))]:
        known = valid & (distance > 2.5) & band
        unexplained = band & valid & ((distance < 4) | np.any(result != source, axis=2))
        if not unexplained.any() or not known.any() or np.median(gray[known]) < 217:
            continue
        for _, params, reflected in original_symmetries(gray, known, axes, centered):
            yy, xx = np.where(unexplained)
            if not len(xx):
                break
            tx, ty = symmetric_point(params, xx, yy, axes, reflected)
            ok = map_coordinates(known.astype('f'), [ty, tx], order=0) > .5
            px, py = xx[ok], yy[ok]
            for ch in range(3):
                result[py, px, ch] = map_coordinates(source[:, :, ch], [ty[ok], tx[ok]], order=1)
            unexplained[py, px] = False


def direction(angle):
    return np.array((np.cos(angle), np.sin(angle)))


def frame_candidates(joined, separate, axes):
    # Two opposing strokes and their connecting side can be measured from a
    # single exposed piece. The far corner needs its own original ink witness.
    center = joined.mean(0)
    points = joined-center
    for angle in np.deg2rad(np.arange(0, 180, 4)):
        normal = direction(angle)
        u = points @ normal
        v = points @ np.array([-normal[1], normal[0]])
        lo, hi = np.quantile(u, [.06, .94])
        if not 11 <= hi-lo <= .96*axes[3]:
            continue
        arms = [abs(u-edge) < 2.25 for edge in (lo, hi)]
        middle = points[~(arms[0] | arms[1])]
        if len(middle) < 10 or any(a.sum() < 8 or np.ptp(v[a]) < 5.2 for a in arms):
            continue
        variance, basis = np.linalg.eigh(np.cov(middle.T))
        side = basis[:, 0]
        if variance[1] < 10*max(.1, variance[0]) or abs(normal @ side) > .66:
            continue
        def residual(params):
            first, second, lower, upper, edge = params
            a = points @ direction(first)
            return np.minimum(np.minimum(abs(a-lower), abs(a-upper)), abs(points @ direction(second)-edge))
        initial = [angle, np.arctan2(side[1], side[0]), np.median(u[arms[0]]),
                   np.median(u[arms[1]]), np.median(middle @ side)]
        fit = least_squares(residual, initial, loss="soft_l1", f_scale=.65, max_nfev=35).x
        normal, side = direction(fit[0]), direction(fit[1])
        lower, upper, edge = fit[2:]
        span = upper-lower
        if span < 10 or abs(normal @ side) > .63 or np.quantile(residual(fit), .92) > 1.55:
            continue
        u, v = points @ normal, points @ side
        arms = [(abs(u-t) < 1.7) & (abs(v-edge) > 2.2) for t in (lower, upper)]
        if min(a.sum() for a in arms) < 7:
            continue
        inward = np.sign(np.median(v[arms[0] | arms[1]])-edge)
        if any((inward*(v[a]-edge) > 0).mean() < .95 for a in arms):
            continue
        previous = np.quantile(inward*(v-edge), .98)
        across, along = (separate-center) @ normal, (separate-center) @ side
        reach = inward*(along-edge)
        at_corner = ((np.minimum(abs(across-lower), abs(across-upper)) < 3.1)
                     & (reach > max(10, .65*span, previous-.8)) & (reach < min(2.15*span, previous+.68*span)))
        matrix = np.vstack([normal, side])
        for opposite in np.unique(np.round(2*along[at_corner])/2):
            offsets = [[lower, lower, upper, upper], [edge, opposite, opposite, edge]]
            corners = np.linalg.solve(matrix, offsets).T + center
            if np.linalg.norm(corners.mean(0)-axes[:2]) < .25*axes[2]:
                yield corners


def frame_agreement(corners, gray, known, native_ink):
    errors = []
    for start, end in zip(corners, np.roll(corners, -1, axis=0)):
        points = np.linspace(start, end, 1+int(3*np.linalg.norm(end-start))).T[::-1]
        visible = map_coordinates(known, points, order=0) > .5
        if visible.sum() < 4:
            return
        locations = points[:, visible]
        offset = map_coordinates(native_ink, locations, order=1)
        error = np.minimum(offset, 4).mean()
        if (offset < 1.5).mean() < .77 or error > .77:
            return
        errors.append(error + .002*map_coordinates(gray, locations, order=1).mean())
    return np.mean(errors)


def paint_frame(source, result, marked_distance, valid, corners):
    y, x = np.indices(valid.shape)
    offset = np.full(valid.shape, np.inf)
    for start, end in zip(corners, np.roll(corners, -1, axis=0)):
        length = np.linalg.norm(end-start)
        dx, dy = (end-start)/length
        px, py = x-start[0], y-start[1]
        along = px*dx+py*dy
        offset = np.minimum(offset, np.hypot(-px*dy+py*dx, along-np.clip(along, 0, length)))
    levels = np.arange(0, 4.81, .2)
    samples = [source[valid & (marked_distance > 1.6) & (abs(offset-t) < .24), :3] for t in levels]
    if any(len(group) < 3 for group in samples):
        return
    profile = np.array([np.median(group, axis=0) for group in samples])
    if profile[:4].mean(1).max() > 144 or profile[-4:].mean(1).min() < 210:
        return
    apply = valid & (marked_distance < 3.5) & (offset < 4.2)
    strength = np.clip((4.2-offset[apply])/1.5, 0, 1)
    for channel in range(3):
        estimate = np.interp(offset[apply], levels, profile[:, channel])
        old = result[apply, channel]
        result[apply, channel] = np.rint(old + strength*(estimate-old))
    return offset


def stroke_ends(pen, ink):
    curve = pen["centre_lines"](ink)
    degree = convolve(curve, np.ones((3, 3), "u1"), mode="constant")
    return (curve > 0) & (degree == 2)


def rounded_join(result, writable, frame, tip, direction):
    """Measure the two ink profiles on opposite sides of a subpixel resampling seam."""
    normal = np.array([-direction[1], direction[0]])
    along = np.arange(-8, 8.01, .5)
    cross = np.arange(-4.1, 4.11, .25)
    grid = (tip + along[:, None, None]*direction + cross[None, :, None]*normal).transpose(2, 0, 1)[::-1]
    gray = result[:, :, :3].mean(2)
    shade = map_coordinates(gray, grid, order=1)
    separate = map_coordinates(frame, grid, order=1) > 2.45
    weights = np.clip(235-shade, 0, 210)*separate*np.exp(-.5*(cross/2.75)**2)
    strength = weights.sum(1)
    center = (weights*cross).sum(1)/np.maximum(1, strength)
    good = (strength > 210) & ((shade+210*~separate).min(1) < 160)
    if good.mean() < .80:
        return
    from numpy.polynomial import polynomial as poly
    fit = poly.polyfit(along[good], center[good], 3, w=np.sqrt(np.minimum(720, strength[good])))
    curve = poly.polyval(along, fit)
    if np.median(abs(curve[good]-center[good])) > .65:
        return
    gradient = poly.polyder(fit)
    normal_scale = np.hypot(1, poly.polyval(along, gradient))
    offsets = (cross[None, :]-curve[:, None])/normal_scale[:, None]
    bank = (abs(along) > 3.25) & good
    levels = np.arange(-3.2, 3.21, .2)
    profile = []
    for level in levels:
        samples = shade[(abs(offsets-level) < .26) & separate & bank[:, None]]
        if len(samples) < 4:
            return
        profile.append(np.median(samples))
    if min(profile) > 150 or min(np.mean(profile[:2]), np.mean(profile[-2:])) < 210:
        return
    yy, xx = np.indices(gray.shape)
    delta = np.stack([xx-tip[0], yy-tip[1]], 2)
    t = delta @ direction
    signed = (delta @ normal-poly.polyval(t, fit))/np.hypot(1, poly.polyval(t, gradient))
    apply = writable & (frame > 2.45) & (abs(t) < 7.6) & (abs(signed) < 3.15)
    weight = np.clip((7.6-abs(t[apply]))/2.8, 0, 1)*np.clip((3.15-abs(signed[apply]))/.8, 0, 1)
    estimate = np.interp(signed[apply], levels, profile)
    old = result[apply, :3]
    result[apply, :3] = np.rint(old+(estimate[:, None]-old)*weight[:, None])


def join_exposed_corner(source, result, distance, band, frame, pen):
    """Move a registered arm off the side of a pen to its visible original tip."""
    gray = result[:, :, :3].mean(2)
    native = source[:, :, :3].mean(2)
    skeleton = pen["centre_lines"](gray < 166) != 0
    degree = convolve(skeleton.astype("u1"), np.ones((3, 3), "u1"), mode="constant")
    y, x = np.indices(gray.shape)
    tips = skeleton & (degree == 2) & band & (distance > 0) & (distance < 9) & (frame > 4)
    writable = (distance == 0) | ((distance <= 4) & (abs(gray-native) > 1))
    for py, px in zip(*np.where(tips)):
        radius = np.hypot(x-px, y-py)
        branches = skeleton & (degree >= 4) & band & (radius > 1.3) & (radius < 6.8)
        if not branches.any():
            continue
        junction = np.argwhere(branches & (radius < radius[branches].min()+1.15)).mean(0)[::-1]
        tip = np.array([px, py])
        shift = tip-junction
        length = np.linalg.norm(shift)
        xy = np.stack([x-junction[0], y-junction[1]], 2)
        reach = np.hypot(xy[:, :, 0], xy[:, :, 1])
        outward = shift/length
        across = xy @ np.array([-outward[1], outward[0]])
        arms = skeleton & band & (reach > 4.4) & (reach < 12) & (abs(xy @ outward) < .62*reach)
        for sign in (-1, 1):
            arm = arms & (sign*across > 0)
            if arm.sum() < 5 or writable[arm].mean() <= .61:
                continue
            axis = xy[arm].mean(0)
            axis /= np.linalg.norm(axis)
            normal = np.array([-axis[1], axis[0]])
            u, v = xy @ axis, xy @ normal
            original = (u > .2) & (u < 5.2) & (abs(v) < length+2.9) & (distance > 0) & (native < 147) & (radius < length+2)
            if original.sum() < 4:
                continue
            advance = np.quantile(u[original], .78)
            old = skeleton & (abs(u-advance) < 1.6) & (abs(v) < 2.5)
            if not old.any():
                continue
            offset = np.median(v[original & (u > advance-.72)])-np.median(v[old])
            if not 1.65 <= abs(offset) <= 7 or offset*(shift @ normal) <= 0:
                continue
            finish = max(9.5, 3.45*length)
            region = band & (u > 0) & (u < finish) & (abs(v) < length+4) & (frame > 3.5) & writable
            fraction = np.clip((u[region]-advance)/(finish-advance), 0, 1)
            displacement = offset*(1-fraction**2*(3-2*fraction))
            points = [y[region]-normal[1]*displacement, x[region]-normal[0]*displacement]
            moved = np.stack([map_coordinates(result[:, :, ch].astype("f"), points, order=1)
                              for ch in range(3)], 1)
            visible = (distance[region] > 0) & (u[region] <= advance+.8)
            moved[visible] = source[region, :3][visible]
            test = gray.copy()
            test[region] = moved.mean(1)
            local = (reach < finish+2) & band
            if stroke_ends(pen, test < 166)[local].sum() < np.count_nonzero((degree == 2) & skeleton & local):
                result[region, :3] = np.rint(moved)
                return


def complete_outer_motif(source, result, distance, valid, axes, frame):
    from pathlib import Path
    from runpy import run_path
    pen = run_path(str(Path(__file__).with_name("qwen-reconnect-balloon.py")))
    y, x = np.indices(valid.shape)
    cx, cy, major, minor, angle = axes
    u = ((x-cx)*np.cos(angle)+(y-cy)*np.sin(angle))/major
    v = ((y-cy)*np.cos(angle)-(x-cx)*np.sin(angle))/minor
    rho = np.hypot(u, v)
    band = (rho > .49) & (rho < .96) & valid
    known = (distance > 2.5) & band
    writable = band & ((distance == 0) | np.any(source[:, :, :3] != result[:, :, :3], axis=2))
    if not writable.any():
        return
    gray = result[:, :, :3].mean(2)
    ink = gray < 161
    ends = stroke_ends(pen, ink)
    tips = np.argwhere(ends & band & (distance < 10) & (frame > 2)).astype(float)[:, ::-1]
    gaps = [(p, q, np.linalg.norm(p-q)) for i, p in enumerate(tips) for q in tips[:i]
            if 3 <= np.linalg.norm(p-q) <= 15]
    if not gaps:
        return
    native = source[:, :, :3].mean(2)
    old_distance = distance_transform_edt(~ink)
    best = None
    for _, parameters, reflected in original_symmetries(native, known, axes, False, fine=True):
        tx, ty = symmetric_point(parameters, x, y, axes, reflected)
        verified = map_coordinates(known.astype("f"), [ty, tx], order=0) > .5
        sample = map_coordinates(native, [ty, tx], order=1)
        for p, q, gap in gaps:
            radius = np.hypot(x-(p[0]+q[0])/2, y-(p[1]+q[1])/2)
            for span in np.unique(np.clip(np.array([1.4, 1.8, 2.2, 2.6, 3.1])*gap, 10, 37)):
                apply = (radius < span) & writable & verified & (frame > 2.15)
                trial = np.where(apply, np.where(frame < 4.2, np.minimum(gray, sample), sample), gray)
                delta = np.count_nonzero(abs(trial-gray) > 15)
                added = (trial < 155) & (old_distance > 1) & (radius < gap+4)
                if delta < 4 or added.sum() < 2:
                    continue
                after = stroke_ends(pen, trial < 161)
                inspect = (radius < span+4) & band & (distance < 12) & (frame > 2.15)
                closed = np.count_nonzero(ends & inspect)-np.count_nonzero(after & inspect)
                if closed <= 0 or (after & inspect & (radius < gap*.68)).any():
                    continue
                margin = (abs(radius-span) < 2.5) & band & (frame > 3.4) & verified & ((sample < 161) | ink)
                difference = abs(distance_transform_edt(trial >= 161)-old_distance)
                seam = np.quantile(difference[margin], .9) if margin.any() else 0
                score = 10*closed-1.7*seam-.016*delta-.028*span
                if seam <= 2 and (best is None or score > best[0]):
                    best = (score, trial, apply, radius, span)
    if best is None:
        return
    _, trial, apply, radius, span = best
    result[apply, :3] = np.rint(trial[apply, None])
    curve = pen["centre_lines"](ink)
    for px, py in tips.astype(int):
        if distance[py, px] < 1 or radius[py, px] >= span:
            continue
        branch = pen["follow_branch"](curve, py, px)
        if len(branch) >= 9:
            tip = np.array([px, py], float)
            vec = tip-branch[4:9, ::-1].mean(0)
            if np.linalg.norm(vec) > 3:
                direction = vec/np.linalg.norm(vec)
                rounded_join(result, writable, frame, tip+2*direction, direction)
    join_exposed_corner(source, result, distance, band, frame, pen)


def restore_frame(source, result, distance, valid, axes):
    cx, cy, major, minor, angle = axes
    box = np.s_[max(0, int(cy-major-3)):int(cy+major+4), max(0, int(cx-major-3)):int(cx+major+4)]
    axes = axes.copy()
    axes[:2] -= [box[1].start, box[0].start]
    x0, y0 = axes[:2]
    gray = source[box][:, :, :3].mean(2)
    y, x = np.indices(gray.shape)
    u = ((x-x0)*np.cos(angle) + (y-y0)*np.sin(angle))/major
    v = ((y-y0)*np.cos(angle) - (x-x0)*np.sin(angle))/minor
    known = valid[box] & (distance[box] > 0) & (np.hypot(u, v) < .68)
    ink = known & (gray < 163)
    if ink.sum() < 60 or np.median(gray[known]) < 220:
        return
    original = distance_transform_edt(~ink)
    exposed = known.astype('f')
    labels, _ = label(ink, np.ones((3, 3)))
    uy, ux = np.where(ink)
    measured = []
    for k, part in enumerate(find_objects(labels), 1):
        yy, xx = np.where(labels[part] == k)
        if not 55 <= len(xx) <= 500 or min(np.ptp(xx), np.ptp(yy)) < 13:
            continue
        joined = np.c_[xx+part[1].start, yy+part[0].start]
        other = labels[uy, ux] != k
        for corners in frame_candidates(joined, np.c_[ux[other], uy[other]], axes):
            score = frame_agreement(corners, gray, exposed, original)
            if score is not None:
                measured.append((score, corners))
    if measured:
        score, best = min(measured, key=lambda item: item[0])
        for error, alternative in measured:
            # Competing geometries that explain the same original rule out a repair.
            farthest = np.min(np.linalg.norm(best[:, None]-alternative, axis=2), axis=1).max()
            if error <= score+.06 and farthest > 3:
                return
        offset = paint_frame(source[box], result[box], distance[box], valid[box], best)
        if offset is not None:
            complete_outer_motif(source[box], result[box], distance[box], valid[box], axes, offset)


def restore_printed_badge(source, result, distance, valid):
    gray = source[:, :, :3].mean(2)
    ids, _ = label(valid & (gray < 125) & (distance > 2), np.ones((3, 3)))
    rings = []
    for index, bounds in enumerate(find_objects(ids), 1):
        y, x = np.where(ids[bounds] == index)
        if not 80 <= len(x) <= 1600:
            continue
        x, y = x + bounds[1].start, y + bounds[0].start
        if min(distance[y, x]) > 7:
            continue
        fit = measured_ellipse(x, y)
        if fit is not None:
            rings.append((index, fit))
    for i, outer in rings:
        for j, inner in rings:
            if i == j or not concentric(outer, inner):
                continue
            paint_rim(source, result, valid, ids, i, outer, distance)
            paint_rim(source, result, valid, ids, j, inner, distance)
            restore_inner_motif(source, result, distance, valid, inner)
            restore_frame(source, result, distance, valid, inner)
