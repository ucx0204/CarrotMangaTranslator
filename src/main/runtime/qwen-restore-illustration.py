"""Register a reference edit on exposed artwork and join it to the original scan."""
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import distance_transform_edt, find_objects, gaussian_filter, label, map_coordinates, maximum_filter, uniform_filter
from scipy.signal import correlate
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import maximum_flow, breadth_first_order
from scipy.spatial import cKDTree


def exposed_matches(original, edit, known):
    step = max(1, round(max(original.shape)/760))
    source, target = (gaussian_filter(im, .65*step)[::step, ::step] for im in (original, edit))
    y_gradient, x_gradient = np.gradient(source)
    xx, yy, xy = (gaussian_filter(v, 1.7) for v in
                  (x_gradient*x_gradient, y_gradient*y_gradient, x_gradient*y_gradient))
    corners = .5*(xx+yy-np.hypot(xx-yy, 2*xy))
    radius = 6
    safe = distance_transform_edt(known[::step, ::step]) > radius+1
    safe[:radius+2] = safe[-radius-2:] = False
    safe[:, :radius+2] = safe[:, -radius-2:] = False
    y, x = np.where(safe & (corners > 2) & (maximum_filter(corners, 7) == corners))
    if len(x) > 1250:
        order = np.argsort(corners[y, x])[-1250:]
        y, x = y[order], x[order]
    side = 2*radius+1
    mean = uniform_filter(target, side)
    variance = np.maximum(1., uniform_filter(target*target, side)-mean**2)
    reach = max(7, round(min(32, max(12, max(original.shape)*.034))/step))
    height, width = source.shape
    points, shifts, scores = [], [], []
    for cy, cx in zip(y, x):
        top, bottom = max(radius, cy-reach), min(height-radius, cy+reach+1)
        left, right = max(radius, cx-reach), min(width-radius, cx+reach+1)
        ref = source[cy-radius:cy+radius+1, cx-radius:cx+radius+1]
        ref = ref-ref.mean()
        patch = target[top-radius:bottom+radius, left-radius:right+radius]
        corr = correlate(patch, ref, 'valid', method='fft')
        corr /= side**2*max(1., ref.std())*np.sqrt(variance[top:bottom, left:right])
        iy, ix = np.unravel_index(np.argmax(corr), corr.shape)
        peak = corr[iy, ix]
        if peak < .76:
            continue
        other = corr.copy()
        other[max(0, iy-3):iy+4, max(0, ix-3):ix+4] = -1
        if other.max() > .97*peak and peak < .97:
            continue
        subpixel = []
        for line, i in ((corr[iy], ix), (corr[:, ix], iy)):
            curvature = line[i-1]+line[i+1]-2*line[i] if 0 < i < len(line)-1 else 0.
            delta = .5*(line[i-1]-line[i+1])/curvature if curvature < -.00001 else 0.
            subpixel.append(np.clip(delta, -.55, .55))
        points.append((cx*step, cy*step))
        shifts.append(((ix+left+subpixel[0]-cx)*step, (iy+top+subpixel[1]-cy)*step))
        scores.append(peak)
    return np.asarray(points), np.asarray(shifts), np.asarray(scores)


def global_displacement(points, shifts, score, width, height):
    design = np.column_stack([np.ones(len(points)), points[:, 0]/width, points[:, 1]/height])
    rng = np.random.default_rng(379)
    best, support = None, 0.
    for _ in range(100):
        sample = rng.choice(len(points), 3, replace=False)
        coef = np.linalg.lstsq(design[sample], shifts[sample], rcond=None)[0]
        if np.linalg.norm(coef[1:]/np.array([[width], [height]])) > .14:
            continue
        good = np.linalg.norm(design@coef-shifts, axis=1) < 2.8
        mass = (score[good]**3).sum()
        if mass > support:
            best, support = good, mass
    if best is None or best.sum() < 12:
        return
    for _ in range(3):
        coef = np.linalg.lstsq(design[best]*score[best, None], shifts[best]*score[best, None], rcond=None)[0]
        best = np.linalg.norm(design@coef-shifts, axis=1) < 2.8
        if best.sum() < 12:
            return
    return coef, shifts-design@coef


def register(source, prediction, known):
    height, width = known.shape
    luma = np.array([.299, .587, .114], dtype='f')
    points, shifts, score = exposed_matches(source@luma, prediction@luma, known)
    if len(score) < 14:
        return prediction
    fit = global_displacement(points, shifts, score, width, height)
    if fit is None:
        return prediction
    coef, remainder = fit
    eligible = np.linalg.norm(remainder, axis=1) < min(21, max(height, width)*.03)
    points, remainder, score = points[eligible], remainder[eligible], score[eligible]
    if len(points) < 4:
        return prediction
    tree = cKDTree(points)
    y, x = np.indices(known.shape, dtype='f')
    fx = coef[0, 0]+coef[1, 0]*x/width+coef[2, 0]*y/height
    fy = coef[0, 1]+coef[1, 1]*x/width+coef[2, 1]*y/height
    for top in range(0, height, 40):
        band = np.s_[top:top+40]
        grid = np.column_stack([x[band].ravel(), y[band].ravel()])
        distance, indices = tree.query(grid, k=min(12, len(score)))
        wt = np.exp(-.5*((distance-distance[:, :1])/16)**2)*score[indices]**6/(distance+3)**1.5
        delta = np.sum(wt[:, :, None]*remainder[indices], axis=1)/wt.sum(axis=1)[:, None]
        delta *= np.exp(-.5*(distance[:, :1]/60)**2)
        fx[band] += delta[:, 0].reshape(x[band].shape)
        fy[band] += delta[:, 1].reshape(y[band].shape)
    positions = [y+fy, x+fx]
    aligned = np.stack([map_coordinates(band, positions, order=3, mode='nearest')
                        for band in prediction.transpose(2, 0, 1)], axis=2)
    distance = distance_transform_edt(known)
    bank = (distance > 4) & (distance < 64)
    if bank.sum() < 256:
        return prediction
    def disagreement(image):
        residual = gaussian_filter(source.astype('f')-image, (.8, .8, 0))
        return np.minimum(80, abs(residual[bank])).mean()
    before = disagreement(prediction)
    return aligned if disagreement(aligned) < before-max(.14, .01*before) else prediction


def restore_crossed_rule(source, ink, decoded, rule_row, radius):
    """Register the two-reference edit against the visible panel. Recover the
    horizontal edge from both banks at the original scan resolution."""
    ys, xs = np.nonzero(ink)
    if not len(xs) or not (0 <= rule_row < ink.shape[0] and 1 <= radius <= 12):
        raise ValueError("Invalid native panel rule")
    height, width = ink.shape
    margin = min(220, max(64, int(.66 * max(np.ptp(xs), np.ptp(ys)))))
    top, left = max(0, ys.min()-margin), max(0, xs.min()-margin)
    rect = np.s_[top:min(height, ys.max()+margin+1), left:min(width, xs.max()+margin+1)]
    rgb = source[rect][:, :, :3]
    opaque = source[rect][:, :, 3] == 255
    distance = distance_transform_edt(~ink[rect])
    blend_radius = min(10, radius+2)
    support = opaque & (distance <= blend_radius+1)
    edit = register(rgb, decoded[rect], opaque & (distance > radius+2)).astype('f')
    yedge = rule_row-top
    below = np.arange(rgb.shape[0])[:, None] > yedge+2
    known = opaque & below & (distance > blend_radius+1)
    residual = np.clip(rgb-edit, -62, 62)
    offset = np.zeros_like(edit)
    for sigma in (12., 6., 3., 1.45):
        coverage = gaussian_filter(known.astype('f'), sigma)
        local = gaussian_filter(residual*known[:, :, None], (sigma, sigma, 0))
        local /= np.maximum(coverage[:, :, None], .004)
        confidence = np.clip((coverage-.1)/.22, 0, 1)[:, :, None]
        offset += confidence*(local-offset)
    edit += offset*below[:, :, None]
    for y in np.flatnonzero(support.any(axis=1)):
        if y > yedge+5:
            break
        targets = np.flatnonzero(support[y])
        line = rgb[y]
        x = np.arange(len(line))
        banks = np.flatnonzero(opaque[y] & (distance[y] > radius+1) &
                               (x >= targets[0]-18) & (x <= targets[-1]+18))
        if len(banks) < 12 or banks[0] >= targets[0] or banks[-1] <= targets[-1]:
            continue
        low, high = np.percentile(line[banks], [10, 90], axis=0)
        # The first dark row and its antialiasing belong to the rule. Let
        # Qwen reconstruct the heterogeneous screen and shadows beneath it.
        if (y < yedge-1 and low.min() < 245) or (y >= yedge and high.max() > 100):
            continue
        if np.max(high-low) > 55:
            continue
        for channel in range(3):
            edit[y, targets, channel] = np.interp(targets, banks, line[banks, channel])
    weight = np.clip((blend_radius+1-distance)/2, 0, 1)[..., None]
    out = source.copy()
    out[rect][support, :3] = np.rint(np.clip(
        (rgb*(1-weight)+edit*weight)[support], 0, 255)).astype('u1')
    return out


def restore_brush(source, decoded, ink, solid=False):
    """Join the aligned drawing across the white paper enclosed by brush prongs."""
    opaque = source[:, :, 3] == 255
    selected = ink & opaque
    if not selected.any():
        return source.copy()
    rgb = source[:, :, :3]
    expanded = distance_transform_edt(~selected) <= 19
    closed = selected | (distance_transform_edt(expanded) > 19)
    footprint = distance_transform_edt(~closed) <= 8
    allowed = footprint & opaque
    bank = opaque & ~allowed
    aligned = register(rgb, decoded[:, :, :3], bank)
    aligned = match_brush_paper(rgb, aligned, bank)
    alpha = (np.clip(distance_transform_edt(footprint)/4, 0, 1)*opaque)[:, :, None]
    result = source.copy()
    result[:, :, :3] = np.rint(rgb*(1-alpha)+aligned*alpha).astype('u1')
    from runpy import run_path
    ruled = run_path(str(Path(__file__).with_name("qwen_perspective_ink.py")))
    ruled["restore_brush_motion"](rgb, selected, result[:, :, :3], allowed, opaque)
    restore_brush_panel_edges(rgb, selected, allowed, result[:, :, :3])
    gutters = run_path(str(Path(__file__).with_name("qwen_panel_gutters.py")))
    gutters["restore_gutter_rules"](rgb, selected, result[:, :, :3], allowed, opaque)
    if solid:
        rays = run_path(str(Path(__file__).with_name("qwen_white_rays.py")))
        rays["restore_white_rays"](rgb, selected, result[:, :, :3], allowed, opaque)
        screen = run_path(str(Path(__file__).with_name("qwen_crossed_screen.py")))
        frequencies = run_path(str(Path(__file__).with_name("qwen-screen-detail.py")))["screen_frequencies"]
        screen["restore_impact_screen"](rgb, selected, result[:, :, :3], opaque, allowed, frequencies)
    return result


def match_brush_paper(original, aligned, bank):
    """Measure the decoder's paper white on exposed, flat parts of this scan."""
    gray = original[:, :, 1].astype(float)
    white = bank & (gray >= 252) & (maximum_filter(255-gray, 5) <= 3)
    sample = aligned[:, :, 1][white]
    if sample.size < max(100, .004*gray.size):
        return aligned
    low, high = np.percentile(sample, [16, 84])
    paper = np.median(gray[white])
    if low < 238 or high-low > 5 or low >= paper:
        return aligned
    # Keep the darker stock fixed. The top of the measured decoder range is
    # the same white ink-free paper as the originals at these locations.
    base = max(228, low-19)
    return np.interp(aligned, [0, base, low, 255], [0, base, paper, 255])


def restore_brush_panel_edges(rgb, ink, allowed, result):
    # Inside a narrow break in a long divider the exposed printed row on both
    # sides fixes its true shade, its antialiasing and the paper just beyond it.
    for transpose in (False, True):
        native, output = (v.swapaxes(0, 1) if transpose else v for v in (rgb, result))
        marked, permitted = (v.T if transpose else v for v in (ink, allowed))
        ys = np.flatnonzero(marked.any(1))
        for end, sign in ((ys[0], -1), (ys[-1], 1)):
            nearby = np.arange(max(0, end-11), min(len(native), end+12))
            dense = (native[nearby, :, 1] < 70).mean(1) >= .70
            thick = np.flatnonzero(dense[:-1] & dense[1:])
            if not len(thick):
                continue
            stop = nearby[thick[-1]+1 if sign < 0 else thick[0]]
            for y in np.flatnonzero(permitted.any(1) & ((np.arange(len(native))-stop)*sign >= 0)):
                active = np.flatnonzero(permitted[y])
                first, last = active[0], active[-1]
                banks = np.r_[max(0, first-30):first, last+1:min(native.shape[1], last+31)]
                if first < 6 or last+6 >= native.shape[1] or len(banks) < 18:
                    continue
                values = native[y, banks].astype(float)
                if np.max(np.ptp(np.quantile(values, [.08, .92], axis=0), axis=0)) > 12:
                    continue
                output[y, active] = np.rint(np.median(values, axis=0)).astype('u1')


def choose_boundary(source, edit, ink, support):
    # The graph contains only the narrow uncertain rim. Known printed ink and
    # the unselected page are fixed to opposite sides of the cut.
    band = support & ~ink
    y, x = np.where(band)
    count = len(x)
    if not count:
        return ink
    height, width = band.shape
    index = np.full(band.shape, -1, dtype=int)
    index[band] = np.arange(count)
    delta = source.astype('f')-edit
    fine, coarse = (np.max(abs(gaussian_filter(delta, (s, s, 0))), axis=2) for s in (1., 3.1))
    difference = np.maximum(fine, .78*coarse)
    cost = 1.5+np.minimum(200, .23*difference+.055*difference**2)
    into_edit = np.zeros(count)
    into_source = np.minimum(4, .06*distance_transform_edt(~ink)[band])
    row, col, weight = [], [], []
    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        sy, sx = y+dy, x+dx
        valid = (0 <= sy) & (sy < height) & (0 <= sx) & (sx < width)
        cy, cx, sy, sx = y[valid], x[valid], sy[valid], sx[valid]
        here, peer = index[cy, cx], index[sy, sx]
        prices = .5*(cost[cy, cx]+cost[sy, sx])
        between = peer >= 0
        row.append(here[between])
        col.append(peer[between])
        weight.append(prices[between])
        for terminal, nodes in ((into_edit, ink[sy, sx]), (into_source, ~support[sy, sx])):
            terminal[here[nodes]] += prices[nodes]
    row.extend((np.full(count, count), np.arange(count)))
    col.extend((np.arange(count), np.full(count, count+1)))
    weight.extend((into_edit, into_source))
    capacities = coo_matrix((np.rint(np.concatenate(weight)*20).astype('i4'),
                             (np.concatenate(row), np.concatenate(col))), shape=(count+2, count+2)).tocsr()
    residual = capacities-maximum_flow(capacities, count, count+1).flow
    residual.eliminate_zeros()
    nodes = breadth_first_order(residual, count, return_predecessors=False)
    active = np.zeros(count, dtype=bool)
    active[nodes[nodes < count]] = True
    result = ink.copy()
    result[band] = active
    return result


def selected_spot(rgb, ink, opaque):
    color = rgb.astype('f')
    vivid = (color.max(2) > 195) & (np.ptp(color, axis=2) > 96)
    if np.count_nonzero(ink & vivid) < 120:
        return
    bins = rgb[ink & vivid].astype('i4')//8
    codes = bins[:, 0]*1024+bins[:, 1]*32+bins[:, 2]
    common = np.bincount(codes).argmax()
    pigment = 8*np.array([common//1024, (common//32)%32, common%32])+3
    labels, count = label(opaque & (np.linalg.norm(color-pigment, axis=2) < 35), np.ones((3, 3)))
    areas = np.bincount(labels.ravel(), minlength=count+1)
    owned = np.bincount(labels[ink], minlength=count+1)
    selected = (areas >= 9) & (owned > .12*areas) & ((areas > 100) | (owned > .70*areas))
    selected[0] = False
    if selected.sum() < 3:
        return
    unselected = ~selected & (areas >= 3)
    unselected[0] = False
    return selected[labels], unselected[labels]


def restore_spot_colour(source, decoded, ink, opaque):
    rgb = source[:, :, :3]
    spot = selected_spot(rgb, ink, opaque)
    if spot is None:
        return
    body, other_ink = spot
    distance = distance_transform_edt(~body)
    exposed = opaque & (distance > 33)
    if exposed.sum() < 250:
        return
    original = rgb.astype('f')
    aligned = register(rgb, decoded[:, :, :3], exposed).astype('f')
    # The neighbouring unprinted scan fixes the brightness of the edit.
    # Reject separate imprints when estimating this low-frequency correction.
    bank = exposed & ~other_ink
    mass = gaussian_filter(bank.astype('f'), 19)
    bias = gaussian_filter(np.clip(original-aligned, -35, 35)*bank[:, :, None], (19, 19, 0))
    clean = np.clip(aligned+bias/np.maximum(.045, mass[:, :, None]), 0, 255)
    white = 255-clean
    difference = original-clean
    alpha = (difference*white).sum(2)/np.maximum(144, (white*white).sum(2))
    error = np.linalg.norm(difference-alpha[:, :, None]*white, axis=2)
    witnesses = (opaque & ~body & (distance < 35) & (np.ptp(original, axis=2) > 30)
                 & (clean @ np.array([.299, .587, .114], dtype='f') < 155)
                 & (error < 15) & (alpha > -.05) & (alpha <= 1.05))
    profile = []
    for radius in range(3, 35):
        observed = alpha[witnesses & (distance >= radius) & (distance < radius+1)]
        profile.append(np.quantile(observed, .68) if observed.size >= 9 else np.nan)
    curve = np.asarray(profile)
    if np.isfinite(curve).sum() < 9 or not np.any(curve[:7] > .20):
        return
    visible = np.flatnonzero(curve > .05)
    inner = min(34, max(10, int(visible[-1])+5))
    outer = min(54, inner+max(10, round(.62*inner)))
    blend = np.clip((outer-distance)/(outer-inner), 0, 1)
    blend *= blend*(3-2*blend)
    if other_ink.any():
        # Dates, straplines and Roman type may be printed in the same ink.
        blend *= np.clip((distance_transform_edt(~other_ink)-4)/4, 0, 1)
    blend *= opaque & (distance_transform_edt(~ink) < 55)
    result = source.copy()
    result[:, :, :3] = np.rint(original+(clean-original)*blend[:, :, None]).astype('u1')
    return result


def drawn_edges(rgb):
    luminance = rgb @ np.array([.299, .587, .114], dtype='f')
    dy, dx = np.gradient(gaussian_filter(luminance, 1.05))
    magnitude = np.hypot(dx, dy)
    # Compare across the normal of the pen, so the centre of a broad stroke
    # cannot stand in for its boundary.
    along_x = np.abs(dx) >= np.abs(dy)
    return (magnitude > 10) & np.where(
        along_x, magnitude >= maximum_filter(magnitude, (1, 3)),
        magnitude >= maximum_filter(magnitude, (3, 1)))


def exposed_edge_error(source, decoded, ink):
    opaque = source[:, :, 3] == 255
    known = opaque & ~ink
    distance = distance_transform_edt(~ink)
    native_edges = known & drawn_edges(source[:, :, :3]) & (distance >= 4) & (distance < 14)
    if np.count_nonzero(native_edges) < 95:
        return -1.
    aligned = register(source[:, :, :3], decoded[:, :, :3], known)
    edit_distance = distance_transform_edt(~drawn_edges(aligned))
    return np.mean(edit_distance[native_edges] > 2.6)


def reconcile_cover_views(source, ink, preferred, peer):
    """Resolve a local silhouette disagreement against ink still visible outside the lettering."""
    opaque = source[:, :, 3] == 255
    known = opaque & ~ink
    rgb = source[:, :, :3]
    luminance = np.array([.299, .587, .114], dtype='f')
    native = gaussian_filter(rgb @ luminance, 2)
    aligned = [gaussian_filter(register(rgb, view, known) @ luminance, 2)
               for view in (preferred, peer)]
    distance = distance_transform_edt(~ink)
    unprinted = known & (native < 64) & (distance > 4) & (distance < 22)
    if np.count_nonzero(unprinted) < 38:
        return
    disagreement = abs(aligned[0] - aligned[1]) > 34
    if not disagreement.any():
        return
    nearby = (distance_transform_edt(~disagreement) < 8) & (distance < 45)
    regions, _ = label(nearby, np.ones((3, 3)))
    replace = np.zeros_like(ink)
    for index, bounds in enumerate(find_objects(regions), 1):
        region = regions[bounds] == index
        bank = unprinted[bounds] & region
        pixels = np.count_nonzero(bank)
        if pixels < 38 or np.count_nonzero(ink[bounds] & region) < 100:
            continue
        first, second = [abs(view[bounds] - native[bounds])[bank] for view in aligned]
        recovered = np.count_nonzero(first > 55) - np.count_nonzero(second > 55)
        if recovered >= max(28, .23 * pixels) and first.mean() - second.mean() >= 32:
            replace[bounds] |= region
    if not replace.any():
        return
    weight = np.clip((15 - distance_transform_edt(~replace)) / 8, 0, 1)[:, :, None]
    return np.rint((1 - weight) * preferred + weight * peer).astype('u1')


def restore_screen_phase(source, ink, result, aligned=None, sound=False):
    import runpy
    directory = Path(__file__).resolve().parent
    sys.path.insert(0, str(directory))
    try:
        from qwen_crossed_screen import restore_crossed_screen, restore_gradual_screen
        frequencies = runpy.run_path(str(directory / "qwen-screen-detail.py"))["screen_frequencies"]
        opaque = source[:, :, 3] == 255
        args = (source[:, :, :3], ink & opaque, result[:, :, :3], opaque, frequencies)
        if sound:
            restore_gradual_screen(*args, darkened_only=True)
            from qwen_screen_outline import restore_screen_outline
            restore_screen_outline(*args)
            from qwen_woven_screen import restore_woven_screen
            restore_woven_screen(*args)
            return
        if not restore_crossed_screen(*args, aligned=aligned):
            if not restore_gradual_screen(*args) and aligned is not None:
                from qwen_light_screen import restore_light_paper_grain
                restore_light_paper_grain(source[:, :, :3], ink, result[:, :, :3], aligned, opaque)
        from qwen_screen_contours import restore_screened_contours
        restore_screened_contours(*args)
    finally:
        sys.path.pop(0)


def match_native_sharpness(source, decoded, ink, opaque):
    """Measure the relative scan blur on registered unprinted ink and screen.
    Confirm it on disjoint spatial tiles before changing the model crop."""
    y, x = np.where(ink)
    if not len(x):
        return decoded
    area = np.s_[max(0, y.min()-132):y.max()+133, max(0, x.min()-132):x.max()+133]
    mask = ink[area]
    if mask.size > 750_000 or min(mask.shape) < 40:
        return decoded
    distance = distance_transform_edt(~mask & opaque[area])
    original, prediction = (im[area][:, :, :3].mean(2) for im in (source, decoded))
    paper, model = (gaussian_filter(im, 1.8) for im in (original, prediction))
    avg = lambda v: uniform_filter(v, 15)
    first, second = avg(paper), avg(model)
    spread = [np.sqrt(np.maximum(0, avg(v*v)-mean*mean)) for v, mean in ((paper, first), (model, second))]
    corr = (avg(paper*model)-first*second)/np.maximum(1, spread[0]*spread[1])
    bank = ((distance > 12) & (distance < 120) & (corr > .84) & (spread[0] > 5) & (spread[1] > 5)
            & (abs(first-second) < 35) & (abs(np.log((spread[0]+1)/(spread[1]+1))) < .46))
    y, x = np.indices(mask.shape)
    bank &= ((x % 9 == 2) & (y % 9 == 3) & (x >= 8) & (y >= 8)
             & (x < mask.shape[1]-8) & (y < mask.shape[0]-8))
    if bank.sum() < 60:
        return decoded
    def energy(im, scale):
        return np.sqrt(np.maximum(0, avg((im-gaussian_filter(im, scale))**2)))
    fine, broad = energy(original, .85), energy(original, 2.5)
    bank &= (broad > 5) & (fine > 1.05)
    tiles = [bank & ((y//24+2*(x//31)) % 4 == j) for j in range(4)]
    if min(t.sum() for t in tiles) < 12:
        return decoded
    widths = np.array([0., .35, .5, .65, .8, .95, 1.1, 1.3, 1.55, 1.8, 2.1])
    scores = []
    for width in widths:
        im = gaussian_filter(prediction, width) if width else prediction
        high = np.log((energy(im, .85)+.4)/(fine+.4))
        low = np.log((energy(im, 2.5)+.5)/(broad+.5))
        error = abs(high-.55*low)+.32*abs(low)
        scores.append([np.median(error[t]) for t in tiles])
    scores = np.array(scores)
    estimate = widths[scores.argmin(0)]
    best = scores.mean(1).argmin()
    if (widths[best] < .5 or np.ptp(estimate) > .31 or scores[best].max() > .24
            or np.min(scores[0]-scores[best]) < .11 or np.max(scores[best]/np.maximum(.01, scores[0])) > .75):
        return decoded
    return gaussian_filter(decoded.astype("f"), (widths[best], widths[best], 0))


def restore(source, decoded, ink, radius, masthead=False, screen=False, caption=False, sound=False):
    opaque = source[:, :, 3] == 255
    ink = ink & opaque
    if not ink.any():
        return source.copy()
    if masthead:
        spot = restore_spot_colour(source, decoded, ink, opaque)
        if spot is not None:
            return spot
    rgb = source[:, :, :3]
    edit = register(rgb, decoded[:, :, :3], opaque & ~ink).astype('f')
    if sound:
        edit = match_native_sharpness(rgb, edit, ink, opaque)
    support = (distance_transform_edt(~ink) < radius) & opaque
    mask = choose_boundary(rgb, edit, ink, support)
    # Extend the measured colour difference just inside the chosen boundary.
    # This prevents a visible step in otherwise aligned grey folds and skies.
    inner = mask & (distance_transform_edt(mask) < 18)
    offset = np.zeros_like(edit)
    offset[~mask] = np.clip(rgb[~mask]-edit[~mask], -70, 70)
    for _ in range(130):
        offset[inner] = .98*uniform_filter(offset, (3, 3, 1), mode='nearest')[inner]
    out = source.copy()
    out[mask, :3] = np.rint(np.clip(edit[mask]+offset[mask], 0, 255)).astype('u1')
    if screen:
        restore_screen_phase(source, ink, out, edit)
    if caption:
        from runpy import run_path
        pen = run_path(str(Path(__file__).with_name("qwen-reconnect-balloon.py")))
        pen["complete_caption_contours"](source, ink, out, edit)
        stock = run_path(str(Path(__file__).with_name("qwen_paper_banks.py")))
        stock["restore_caption_paper"](rgb, ink, out[:, :, :3], opaque)
    if sound:
        from runpy import run_path
        contours = run_path(str(Path(__file__).with_name("qwen_sound_contours.py")))
        contours["restore_sound_contours"](source, ink, out, edit)
        contours["preserve_sound_banks"](rgb, ink, out[:, :, :3], opaque)
        screen_rows = run_path(str(Path(__file__).with_name("qwen_screen_edge.py")))
        screen_rows["restore_sound_screen_rows"](rgb, ink, out[:, :, :3], opaque)
        ruled = run_path(str(Path(__file__).with_name("qwen_perspective_ink.py")))
        ruled["restore_perspective_ink"](rgb, ink, out[:, :, :3], opaque)
        grain = run_path(str(Path(__file__).with_name("qwen_print_grain.py")))
        grain["restore_stipple"](rgb, ink, out[:, :, :3], opaque)
        dots = run_path(str(Path(__file__).with_name("qwen_dot_stock.py")))
        dots["restore_dot_stock"](rgb, ink, out[:, :, :3], opaque)
        restore_screen_phase(source, ink, out, sound=True)
        paper = run_path(str(Path(__file__).with_name("qwen_paper_banks.py")))
        if not paper["restore_separate_sound_on_white"](rgb, ink, out[:, :, :3], opaque):
            paper["restore_small_outlined_paper"](rgb, ink, out[:, :, :3], opaque)
        transfer = run_path(str(Path(__file__).with_name("qwen_screen_transfer.py")))
        transfer["restore_printed_screen_rows"](rgb, ink, out[:, :, :3], opaque)
    elif screen and not caption:
        from runpy import run_path
        crossing = run_path(str(Path(__file__).with_name("qwen_crossing_ink.py")))
        crossing["restore_lettering_crossings"](source, ink, out, edit)
    return out


if __name__ == '__main__':
    source_path, mask_path, decoded_path, output_path = sys.argv[1:5]
    with Image.open(source_path) as im:
        source = np.array(im.convert("RGBA"))
    with Image.open(mask_path) as im:
        ink = np.array(im.convert("L")) > 127
    with Image.open(decoded_path) as im:
        decoded = np.array(im.convert("RGB"))
    if source.shape[:2] != ink.shape or decoded.shape[:2] != ink.shape:
        raise ValueError("The reference, decoded crop and original print must share a pixel grid")
    if len(sys.argv) == 6 and sys.argv[5].startswith("--cover-peer="):
        with Image.open(sys.argv[5].split("=", 1)[1]) as im:
            peer = np.array(im.convert("RGB"))
        if peer.shape != decoded.shape:
            raise ValueError("Both cover references must share the original pixel grid")
        replacement = reconcile_cover_views(source, ink, decoded, peer)
        if replacement is not None:
            Image.fromarray(replacement).save(output_path)
        print("unchanged" if replacement is None else "applied")
    elif len(sys.argv) == 6 and sys.argv[5].startswith("--washed-title="):
        from runpy import run_path
        layered = run_path(str(Path(__file__).with_name("qwen_layered_ink.py")))
        with Image.open(sys.argv[5].split("=", 1)[1]) as im:
            prior = np.array(im.convert("RGB"))
        if prior.shape != decoded.shape:
            raise ValueError("The substrate must share the title's original pixel grid")
        result = layered["restore_washed_title"](source, ink, decoded, prior, register, choose_boundary)
        paper = run_path(str(Path(__file__).with_name("qwen_light_screen.py")))
        paper["restore_washed_title_paper"](source, ink, result, source[:, :, 3] == 255)
        Image.fromarray(result).save(output_path)
        print("applied")
    elif "--credit-paint" in sys.argv[5:]:
        from runpy import run_path
        jacket = run_path(str(Path(__file__).with_name("qwen_jacket_stock.py")))
        corrected = jacket["restore_credit_paints"](source, ink, decoded)
        if corrected is not None:
            Image.fromarray(corrected).save(output_path)
        print("unchanged" if corrected is None else "applied")
    elif len(sys.argv) == 6 and sys.argv[5].startswith("--crossed-rule="):
        row, radius = map(int, sys.argv[5].split("=", 1)[1].split(","))
        Image.fromarray(restore_crossed_rule(source, ink, decoded, row, radius)).save(output_path)
        print("applied")
    elif "--brush" in sys.argv[5:] or "--solid-impact" in sys.argv[5:]:
        repaired = restore_brush(source, decoded, ink, "--solid-impact" in sys.argv[5:])
        Image.fromarray(repaired).save(output_path)
        print("applied")
    elif output_path == "--edge-score":
        print(float(exposed_edge_error(source, decoded, ink)))
    else:
        masthead = "--masthead" in sys.argv[5:]
        caption = "--caption" in sys.argv[5:]
        coloured = "--pigment" in sys.argv[5:]
        radius = 55 if coloured or "--glowing-print" in sys.argv[5:] else 17 if masthead else 11
        repaired = restore(source, decoded, ink, radius, masthead,
                           caption or "--lettering" in sys.argv[5:], caption, "--sound" in sys.argv[5:])
        if "--colour-strap" in sys.argv[5:]:
            from runpy import run_path
            stock = run_path(str(Path(__file__).with_name("qwen_typeset_stock.py")))
            stock["restore_colour_strap"](source, ink, repaired, source[:, :, 3] == 255)
        if "--jacket" in sys.argv[5:]:
            from runpy import run_path
            jacket = run_path(str(Path(__file__).with_name("qwen_jacket_stock.py")))
            jacket["restore_jacket_stock"](source, ink, repaired, source[:, :, 3] == 255)
        if caption or "--sound" in sys.argv[5:] or "--lettering" in sys.argv[5:]:
            from runpy import run_path
            rules = run_path(str(Path(__file__).with_name("qwen_paper_banks.py")))
            rules["restore_interrupted_rules"](source, ink, repaired, source[:, :, 3] == 255)
        if "--lettering" in sys.argv[5:] and ink.any():
            contours = run_path(str(Path(__file__).with_name("qwen_sound_contours.py")))
            contours["restore_paired_punctuation_paper"](source[:, :, :3], ink, repaired[:, :, :3],
                                                        distance_transform_edt(~ink), source[:, :, 3] == 255)
            badge = run_path(str(Path(__file__).with_name("qwen_printed_badge.py")))
            badge["recover_covered_pale_details"](source[:, :, :3], ink, repaired[:, :, :3],
                                                 source[:, :, 3] == 255)
            ribbon = run_path(str(Path(__file__).with_name("qwen_ribbon_stock.py")))
            ribbon["restore_ribbon_stock"](source[:, :, :3], ink, repaired[:, :, :3],
                                          source[:, :, 3] == 255)
            sys.path.insert(0, str(Path(__file__).resolve().parent))
            from qwen_burst_stock import restore_burst_stock
            screen = run_path(str(Path(__file__).with_name("qwen-screen-detail.py")))
            restore_burst_stock(source, ink, repaired, source[:, :, 3] == 255, screen["screen_frequencies"])
        if "--sound" in sys.argv[5:]:
            ribs = run_path(str(Path(__file__).with_name("qwen_glass_ribs.py")))
            ribs["restore_glass_ribs"](source[:, :, :3], ink, repaired[:, :, :3], source[:, :, 3] == 255)
        if "--sound" in sys.argv[5:] or "--lettering" in sys.argv[5:]:
            rules["match_ruled_paper"](source, ink, repaired, source[:, :, 3] == 255)
        if "--sound" in sys.argv[5:]:
            from runpy import run_path
            badge = run_path(str(Path(__file__).with_name("qwen_printed_badge.py")))
            badge["restore_balloon_rims"](source, ink, repaired)
            badge["restore_overlapping_pen_tip"](source, ink, repaired)
        if caption or "--lettering" in sys.argv[5:]:
            printed = run_path(str(Path(__file__).with_name("qwen_parallel_rules.py")))
            printed["restore_parallel_rules"](source, ink, repaired, source[:, :, 3] == 255)
            wall = run_path(str(Path(__file__).with_name("qwen_ruled_wall.py")))
            wall["restore_ruled_wall"](source, ink, repaired, source[:, :, 3] == 255)
        if caption:
            stock = run_path(str(Path(__file__).with_name("qwen_typeset_stock.py")))
            stock["restore_unenclosed_readings_and_pen"](
                source[:, :, :3], ink, repaired[:, :, :3], source[:, :, 3] == 255)
            contour = run_path(str(Path(__file__).with_name("qwen_caption_contour.py")))
            contour["restore_open_caption_edge"](source[:, :, :3], ink, repaired[:, :, :3],
                                                 source[:, :, 3] == 255)
        if "--sound" in sys.argv[5:]:
            rules["restore_hollow_print_stock"](
                source[:, :, :3], ink, repaired[:, :, :3], source[:, :, 3] == 255)
            pencil = run_path(str(Path(__file__).with_name("qwen_perspective_ink.py")))
            pencil["restore_pencil_stock"](source[:, :, :3], ink, repaired[:, :, :3], source[:, :, 3] == 255)
        if coloured:
            from runpy import run_path
            jacket = run_path(str(Path(__file__).with_name("qwen_jacket_stock.py")))
            jacket["restore_light_caption_stock"](source, ink, repaired)
        Image.fromarray(repaired).save(output_path)
        print("applied")
