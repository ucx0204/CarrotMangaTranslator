"""Continue a crossed light screen with the dot phase measured on the original print."""
import numpy as np
from scipy.ndimage import distance_transform_edt, find_objects, gaussian_filter, gaussian_filter1d, label, map_coordinates, maximum_filter, minimum_filter
from scipy.signal import find_peaks
from scipy.spatial import cKDTree


def exposed_directions(low, known, mask):
    ridge = low-gaussian_filter(low, 7)
    visible = (known & (distance_transform_edt(low >= 147) > 14)
               & (distance_transform_edt(~mask) < 115) & (low < 251) & (ridge > 2.4))
    y, x = np.where(visible)
    if len(x) < 200:
        return
    if len(x) > 15_000:
        keep = np.random.default_rng(62).choice(len(x), 15_000, replace=False)
        y, x = y[keep], x[keep]
    weights = np.clip(ridge[y, x], 0, 16)
    slopes, angles = [], []
    for sign in (-1, 1):
        scores, peaks = [], []
        for angle in np.arange(30, 60.5, .5):
            slope = sign*np.tan(np.deg2rad(angle))
            normal = y-slope*x
            along = (x+slope*y)/np.hypot(1, slope)
            bins = np.rint(normal-normal.min()).astype(int)
            groups = ((along-along.min())/14).astype(int)
            grid = np.zeros((groups.max()+1, bins.max()+1), np.float32)
            np.add.at(grid, (groups, bins), weights)
            # Count each ray only where separated pieces have the same normal coordinate.
            signal = np.maximum(0, gaussian_filter(grid, (.55, 1.2))-gaussian_filter(grid, (.6, 5)))
            votes = np.minimum(signal[:-2], signal[2:]).sum(axis=0)
            index, _ = find_peaks(votes, distance=10)
            high = np.sort(votes[index])[-8:]
            scores.append(float((high**1.35).sum()))
            peaks.append(int((high > 14).sum()))
        at = int(np.argmax(scores))
        if peaks[at] < 2 or scores[at] < 1.95*max(1, np.median(scores)):
            return
        angle = 30+.5*at
        angles.append(angle)
        slopes.append(sign*np.tan(np.deg2rad(angle)))
    if abs(angles[0]-angles[1]) <= 5:
        return slopes


def directional_light(density, known, y, x, slopes):
    light = np.zeros(len(x))
    bank = known.astype(np.uint8)
    for slope in slopes:
        directions = []
        for sign in (-1, 1):
            total, mass, seen = np.zeros((3, len(x)))
            for radius in range(2, 108, 2):
                points = [y+sign*radius*slope, x+sign*radius]
                sample = map_coordinates(density, points, order=1, mode="nearest")
                valid = map_coordinates(bank, points, order=0, mode="constant") > 0
                if radius > 5:
                    valid &= seen < 15
                weight = valid*np.exp(-radius/64)
                total += weight*sample
                mass += weight
                seen += valid
            directions.append((total/np.maximum(.001, mass), mass))
        (left, a), (right, b) = directions
        both = .85*np.minimum(left, right)+.15*np.maximum(left, right)
        one = np.where(a > b, left, right)*.66
        light = np.maximum(light, np.where(np.minimum(a, b) > 1.2, both, one))
    return light


def local_wash(source, decoded, known, selected, y, x):
    yy, xx = np.indices(known.shape)
    sy, sx = np.where(known & (yy % 3 == 0) & (xx % 3 == 0))
    tree = cKDTree(np.column_stack((sy, sx)))
    source = gaussian_filter(source, 2.4)
    generated = gaussian_filter(gaussian_filter(decoded, 2.4), 29)
    value = generated.copy()
    for cy in range(max(0, y.min()-10), y.max()+10, 7):
        for cx in range(max(0, x.min()-10), x.max()+10, 7):
            tile = np.s_[cy:cy+7, cx:cx+7]
            # The blur at the boundary also needs nearby unselected tiles.
            if not selected[max(0, cy-13):cy+20, max(0, cx-13):cx+20].any():
                continue
            idx = tree.query_ball_point((cy, cx), 112)
            if len(idx) < 130:
                continue
            dy, dx = sy[idx]-cy, sx[idx]-cx
            radius = np.hypot(dx, dy)
            if np.quantile(radius, .05) > 65:
                continue
            observed = source[sy[idx], sx[idx]]
            design = np.column_stack((np.ones(len(idx)), dx/48, dy/48))
            weights = np.exp(-.5*(radius/38)**2)
            fit = weights
            for _ in range(3):
                gram = design.T @ (fit[:, None]*design)+np.diag([.0001, .55, .55])
                coeff = np.linalg.solve(gram, design.T @ (fit*observed))
                residual = observed-design @ coeff
                fit = weights*np.minimum(1, 12/np.maximum(.1, abs(residual)))
            if np.max(abs(coeff[1:])) <= 45:
                value[tile] = coeff[0]+(xx[tile]-cx)*coeff[1]/48+(yy[tile]-cy)*coeff[2]/48
    return gaussian_filter(value, 4)-generated


def phase_features(x, y, density, axes):
    phase = (2*np.pi)*np.column_stack((x, y)) @ axes.T
    return np.column_stack((np.sin(phase), np.cos(phase), x/180, y/100, density/16))


def nearest_detail(tree, query, values):
    distance, index = tree.query(query, k=12)
    weight = (.05+distance)**-2
    return (weight*values[index]).sum(axis=1)/weight.sum(axis=1)


def dot_basis(x, y, axes):
    phase = 2*np.pi*np.column_stack((x, y)) @ axes.T
    return np.column_stack((np.cos(phase), np.sin(phase)))


def local_dot_prediction(bank_points, values, axes, x, y):
    """Register the two dot axes locally to accommodate drift in a scanned page."""
    samples = dot_basis(*bank_points.T, axes)
    target = dot_basis(x, y, axes)
    tree = cKDTree(bank_points)
    total, mass = np.zeros((2, len(x)))
    for cy in range(y.min()//7*7, y.max()+7, 7):
        for cx in range(x.min()//7*7, x.max()+7, 7):
            weight = np.maximum(0, 1-abs(x-cx)/7)*np.maximum(0, 1-abs(y-cy)/7)
            tile = weight > 0
            if not tile.any():
                continue
            distance, index = tree.query((cx, cy), k=min(800, len(values)))
            relative = distance-distance.min()
            influence = np.exp(-.5*(relative/11)**2-.5*(distance/38)**2)
            design = samples[index]
            gram = design.T @ (influence[:, None]*design)
            gram.flat[::len(gram)+1] += .06+.012*influence.sum()
            fit = np.linalg.solve(gram, design.T @ (influence*values[index]))
            total[tile] += weight[tile]*(target[tile] @ fit)
            mass[tile] += weight[tile]
    return total/np.maximum(.001, mass)


def gradual_dot_phase(gray, low, bank, frequencies, y, x):
    sy, sx = np.where(bank)
    indices = np.random.default_rng(123).choice(len(sx), min(14000, len(sx)), replace=False)
    points = np.column_stack((sx, sy))
    high = (gray-low)[sy, sx]
    power = np.sqrt(gaussian_filter((gray-low)**2, 2))
    modes = frequencies(points[indices], high[indices]/np.maximum(2.8, power[sy[indices], sx[indices]]),
                        gray.shape)
    if len(modes) < 2:
        return
    a = modes[0]
    b = next((v for v in modes[1:] if abs(a[0]*v[1]-a[1]*v[0]) > .045), None)
    if b is None:
        return
    axes = np.array([a, b, 2*a, 2*b, a+b, a-b])
    hold = (sx//11+3*(sy//13)) % 7 == 0
    if hold.sum() < 100 or (~hold).sum() < 500:
        return
    expected = high[hold]
    prediction = local_dot_prediction(points[~hold], high[~hold], axes, sx[hold], sy[hold])
    error = abs(prediction-expected).mean()/max(.01, abs(expected).mean())
    if error > .84 or min(np.std(expected), np.std(prediction)) < .1 or np.corrcoef(prediction, expected)[0, 1] < .56:
        return
    return local_dot_prediction(points, high, axes, x, y), expected, prediction


def density_polynomial(y, x, cy, cx):
    a, b = (x-cx)/65, (y-cy)/65
    return np.column_stack((np.ones(len(x)), a, b, a*a, a*b, b*b))


def registered_gradation(low, guide, mask, distance, printed_balloon=False):
    y, x = np.where(mask)
    cy, cx = np.median(y), np.median(x)
    band = (distance >= 4) & (distance < 34)
    sy, sx = np.where(band)
    hold = (sx//13+3*(sy//11)) % 5 == 0
    if hold.sum() < 95 or (~hold).sum() < 500:
        return
    native = low[sy, sx]
    design = density_polynomial(sy, sx, cy, cx)
    seed = density_polynomial(y, x, cy, cx)
    coeff = np.linalg.solve(seed.T @ seed+np.diag([.001, .08, .08, 3., 3., 3.]), seed.T @ guide[y, x])
    weights = (~hold)/(1+(abs(design @ coeff-native)/9)**2)**1.5
    for cutoff in (12, 10, 8, 6, 5, 4, 3, 3):
        gram = design.T @ (weights[:, None]*design)+np.diag([.00001, .004, .004, .03, .03, .03])
        coeff = np.linalg.solve(gram, design.T @ (weights*native))
        residual = abs(design @ coeff-native)
        weights = (~hold)/(1+(residual/cutoff)**2)**1.5
    if (residual[hold] < 5).mean() < .55 or np.median(residual[hold]) > 3.8:
        return
    rows, cols = np.indices(mask.shape)
    field = (density_polynomial(rows.ravel(), cols.ravel(), cy, cx) @ coeff).reshape(mask.shape)
    bank = band & (abs(low-field) < 5) & (distance_transform_edt(abs(low-field) <= 8) > 2)
    if bank.sum() < 900 or distance_transform_edt(~bank)[mask].max() > 38:
        return
    lo, hi = np.quantile(field[mask], [.01, .99])
    if lo < 15 or hi > 242 or np.ptp(field[mask]) < 12:
        return
    drift = abs(guide[mask]-field[mask])
    agrees = np.quantile(drift, .8) <= 20 and np.quantile(drift, .95) <= 40
    # A diffusion edit can copy the printed word into the opening. In a
    # speech balloon the independently held-out print and its optical phase
    # can also establish the substrate. The caller checks both before writing.
    if printed_balloon and np.median(residual[hold]) < 2.8 and (residual[hold] < 5).mean() > .74:
        agrees |= np.median(drift) < 38 and np.quantile(drift, .24) < 14
    if agrees:
        return field, bank


def borrow_scan_residual(field, bank, residual, y, x):
    """Carry complete samples of scanner grain from similar exposed tones."""
    interior = distance_transform_edt(bank) > 6.5
    interior[:6] = interior[-6:] = False
    interior[:, :6] = interior[:, -6:] = False
    donor_y, donor_x = np.where(interior)
    total, squares = np.zeros((2, len(x)))
    if len(donor_x) < 80:
        return total
    density = field[donor_y, donor_x]
    for row in range(y.min()//6*6, y.max()+7, 6):
        for col in range(x.min()//6*6, x.max()+7, 6):
            dy, dx = y-row, x-col
            tile = (abs(dy) < 6) & (abs(dx) < 6)
            if not tile.any():
                continue
            rx, ry = donor_x-col, donor_y-row
            phase = abs((rx+4) % 8-4)+abs((ry+4) % 8-4)
            level = field[min(row, field.shape[0]-1), min(col, field.shape[1]-1)]
            cost = .65*abs(density-level)+np.hypot(rx/8, ry/3)+1.8*phase
            nearby = np.argsort(cost)[:24]
            index = nearby[(17*(col//6)+31*(row//6)) % len(nearby)]
            patch = residual[donor_y[index]+dy[tile], donor_x[index]+dx[tile]]
            weight = (1-abs(dy[tile])/6)*(1-abs(dx[tile])/6)
            total[tile] += weight*patch
            squares[tile] += weight**2
    return total/np.maximum(.65, np.sqrt(squares))


def registered_balloon_dots(gray, low, field, bank, frequencies, y, x):
    sy, sx = np.where(bank)
    points = np.column_stack((sx, sy))
    held = (sx//13+3*(sy//13)) % 6 == 0
    if held.sum() < 110 or (~held).sum() < 600:
        return
    detail = (gray-field)[sy, sx]
    power = np.maximum(3., np.sqrt(gaussian_filter((gray-low)**2, 2.8)))
    axes = frequencies(points[~held], detail[~held]/power[sy[~held], sx[~held]], gray.shape)
    if len(axes) < 2:
        return
    first = axes[0]
    other = next((p for p in axes[1:] if abs(first[0]*p[1]-first[1]*p[0]) > .04), None)
    if other is None:
        return
    axes = np.vstack((axes, 2*first, 2*other, first+other, first-other))
    estimate = local_dot_prediction(points[~held], detail[~held], axes, sx[held], sy[held])
    truth = detail[held]
    if (np.std(truth) < 5 or np.std(estimate) < .75*np.std(truth)
            or np.corrcoef(estimate, truth)[0, 1] < .85
            or abs(estimate-truth).mean() > .57*abs(truth).mean()):
        return
    native = local_dot_prediction(points, detail, axes, x, y)*np.std(truth)/np.std(estimate)
    residual = np.zeros_like(gray)
    residual[sy, sx] = detail-local_dot_prediction(points, detail, axes, sx, sy)
    return native+borrow_scan_residual(field, bank, residual, y, x)


def restore_balloon_screen_column(source, mask, distance, out, opaque, frequencies):
    gray = source.mean(2)
    low = gaussian_filter(gray, 1.7)
    guide = gaussian_filter(out.mean(2), 1.7)
    registration = registered_gradation(low, guide, mask, np.maximum(0., distance-6), printed_balloon=True)
    if registration is None:
        return False
    field, bank = registration
    # A solid white knockout surrounds the ink. Isolated white dots in
    # nearby halftone and genuine unprinted highlights do not define a word.
    solid = gaussian_filter((gray > 238).astype(float), .95) > .72
    rims, _ = label(solid & (distance < 12) & (field < 233), np.ones((3, 3)))
    sizes = np.bincount(rims.ravel())
    attached = np.unique(rims[distance <= 1.75])
    rim = np.isin(rims, attached[attached > 0]) & (sizes[rims] >= 11)
    if (rim.sum() < .08*mask.sum() or np.count_nonzero(mask & (gray < field-36)) < 28
            or np.ptp(source, axis=2)[mask | rim].max() > 7):
        return False
    bank &= opaque & (distance_transform_edt(~(mask | rim)) >= 4)
    if bank.sum() < 900:
        return False
    # A line of the original drawing which continues out of the knockout
    # takes precedence over an extrapolation of its surrounding dot screen.
    foreign = (abs(low-field) > 20) & (distance > 6)
    strokes, _ = label(foreign, np.ones((3, 3)))
    connected = np.unique(strokes[distance >= 16])
    pen = np.isin(strokes, connected[connected > 0])
    contacts = pen & (distance <= 8) & (distance_transform_edt(~rim) < 3)
    permitted = opaque
    if contacts.any():
        # An unselected stroke may meet only the last character in a long
        # column. Leave its local junction to the decoder, including a margin
        # inside the occlusion, while retaining the evidence for the other letters.
        permitted = opaque & (distance_transform_edt(~contacts) > 12)
        if np.count_nonzero(mask & permitted) < .80*mask.sum():
            return False
    reach = max(6., min(11., np.quantile(distance[rim], .995)+.8))
    y, x = np.where((distance < reach+2.5) & permitted)
    estimate = registered_balloon_dots(gray, low, field, bank, frequencies, y, x)
    if estimate is None:
        return False
    # Recover identical native dots where only the decoder's feather reached
    # beyond the complete outline. Then join the fitted screen to that stock.
    exposed = (distance >= reach) & (distance < 26) & (distance_transform_edt(~bank) < 14) & permitted
    out[exposed] = source[exposed]
    blend = np.clip((reach+2.5-distance[y, x])/2, 0, 1)
    level = (field[y, x]+estimate)[:, None]
    out[y, x] = np.rint(np.clip(out[y, x]+blend[:, None]*(level-out[y, x]), 0, 255))
    return True


def restore_balloon_screens(source, mask, out, opaque, frequencies):
    """A single speech crop may contain multiple columns in different balloon lobes."""
    if mask.size > 800_000 or not 300 <= mask.sum() <= 38_000:
        return False
    distance = distance_transform_edt(~mask)
    words, _ = label(distance < 8, np.ones((3, 3)))
    valid = np.ones_like(mask) if opaque is None else opaque
    changed = False
    for k, bounds in enumerate(find_objects(words), 1):
        ys, xs = np.where(mask[bounds] & (words[bounds] == k))
        if len(xs) < 300 or not 24 <= np.ptp(ys) <= 280 or np.ptp(xs) > .93*np.ptp(ys):
            continue
        ys, xs = ys+bounds[0].start, xs+bounds[1].start
        area = np.s_[max(0, ys.min()-42):ys.max()+43, max(0, xs.min()-42):xs.max()+43]
        word = (words[area] == k) & mask[area]
        # Neighbouring columns can be close. Their ink cannot vote as bank
        # material or be changed while restoring this column.
        local_distance = distance_transform_edt(~word)
        owned = valid[area] & (local_distance <= distance[area]+.01)
        changed |= restore_balloon_screen_column(source[area], word, local_distance, out[area], owned, frequencies)
    return changed


def native_grain_variation(gray, field, bank, distance, y, x):
    residual = gaussian_filter(gray, 1.05)-field
    deviation = abs(gaussian_filter(gray, 1.4)-field)
    support = ((distance > 8) & (distance < 41) & (abs(gaussian_filter(gray, 1.7)-field) < 11)
               & (distance_transform_edt(deviation < 17) > 3) & (distance_transform_edt(~bank) < 8))
    if support.sum() < 350:
        return np.zeros(len(x))
    observed = residual*support
    coverage = support.astype(float)

    def measured(values, scale):
        return gaussian_filter(values, scale)/np.maximum(.001, gaussian_filter(coverage, scale))

    mean = np.where(gaussian_filter(coverage, 8) > .045, measured(observed, 8), measured(observed, 20))
    interior = distance_transform_edt(support) > 2.7
    if interior.sum() < 120:
        return mean[y, x]
    # Grain on printed stock persists between the registered dots. Match the
    # original amplitude in three frequency bands without repeating a tile.
    sample = np.random.default_rng(416).standard_normal(gray.shape)
    texture = np.zeros(gray.shape)
    centered = (residual-mean)*support
    for fine, coarse in ((1.05, 2.1), (2.1, 4.5), (4.5, 8.5)):
        band = measured(centered, fine)-measured(centered, coarse)
        amplitude = np.ptp(np.quantile(band[interior], [.16, .84]))/2
        noise = gaussian_filter(sample, fine)-gaussian_filter(sample, coarse)
        texture += np.clip(amplitude, 0, 4.8)*noise/max(.01, np.std(noise))
    blend = np.clip(distance_transform_edt(~support)[y, x]/5, 0, 1)
    return np.clip(mean[y, x]+blend*texture[y, x], -10, 10)


def nearby_screen_density(points, values, queries):
    """Fit the local slope of the paper using neighboring original scan samples."""
    tree = cKDTree(points)
    estimates = []
    for start in range(0, len(queries), 320):
        sample = queries[start:start+320]
        distances, indices = tree.query(sample, k=min(len(points), 280))
        delta = (points[indices]-sample[:, None])/19
        design = np.concatenate((np.ones((*indices.shape, 1)), delta), axis=2)
        weights = np.exp(-.5*(distances/19)**2)
        gram = np.einsum('nki,nk,nkj->nij', design, weights, design)
        gram += np.diag([.00001, .65, .65])
        rhs = np.einsum('nki,nk,nk->ni', design, weights, values[indices])
        estimates.append(np.linalg.solve(gram, rhs[:, :, None])[:, 0, 0])
    return np.concatenate(estimates)


def uniform_impact_phase(gray, native, power, bank, held, target, frequencies):
    y, x = np.where(bank)
    train = ~held[bank]
    points = np.column_stack((x, y))
    detail = (gray[bank]-native[bank])/np.maximum(3, power[bank])
    axes = frequencies(points[train], detail[train], gray.shape)
    if len(axes) < 2:
        return
    basis = dot_basis(x, y, np.asarray(axes))
    fit = np.linalg.lstsq(basis[train], detail[train], rcond=.001)[0]
    test = basis[~train] @ fit
    truth = detail[~train]
    if (test.std() < .65 or np.corrcoef(test, truth)[0, 1] < .975
            or np.mean(abs(test-truth)) > .24*np.mean(abs(truth))):
        return
    ty, tx = np.where(target)
    return dot_basis(tx, ty, np.asarray(axes)) @ fit


def register_impact_screen_plane(gray, native, edited, screen, mask, allowed, distance, result, frequencies):
    bank = (screen & (distance > 5) & (distance < 64)
            & (maximum_filter(native, 7)-minimum_filter(native, 7) < 13))
    target = screen & allowed & (mask | (distance <= 4.4))
    if bank.sum() < 520 or (target & mask).sum() < 125:
        return False
    gap = distance_transform_edt(~bank)
    target &= gap < 45
    yy, xx = np.indices(bank.shape)
    holdout = bank & ((xx//8+3*(yy//9)) % 5 == 0)
    train = bank & ~holdout
    if holdout.sum() < 80 or target.sum() < 110:
        return False
    held = nearby_screen_density(np.argwhere(train), native[train], np.argwhere(holdout))
    error = abs(held-native[holdout])
    if np.median(error) > 3.4 or np.quantile(error, .85) > 7.4:
        return False
    density = nearby_screen_density(np.argwhere(bank), native[bank], np.argwhere(target))
    guide = gaussian_filter(edited, 2.1)
    if np.quantile(abs(density-guide[target]), .75) < 4:
        return False
    field = native.copy()
    field[target] = density
    y, x = np.where(target)
    # The phase interpolator can attenuate dots in the middle of a wide gap.
    # Recover their local contrast from the same unprinted gradation.
    source_power = np.sqrt(gaussian_filter((gray-native)**2, 3.2))
    expected = nearby_screen_density(np.argwhere(bank), source_power[bank], np.argwhere(target))
    phase = uniform_impact_phase(gray, native, source_power, bank, holdout, target, frequencies)
    if phase is not None:
        dots = phase*expected
    else:
        dots = registered_balloon_dots(gray, native, field, bank, frequencies, y, x)
        if dots is None:
            return False
        squared = np.zeros_like(gray)
        squared[target] = dots**2
        mass = gaussian_filter(target.astype(float), 5)[target]
        sampled = np.sqrt(gaussian_filter(squared, 5)[target]/np.maximum(.01, mass))
        dots *= np.clip(expected/np.maximum(3, sampled), .72, 2.1)
    interior = distance_transform_edt(np.pad(screen, 1))[1:-1, 1:-1][target]
    alpha = (np.clip((interior-.15)/3, 0, 1)*np.clip((44-gap[target])/5, 0, 1)
             * np.clip((4.5-distance[target])/2.5, 0, 1))
    final = np.clip(density+dots, 0, 255)
    result[target, :3] = np.rint(edited[target]+alpha*(final-edited[target])).astype('u1')[:, None]
    return True


def restore_impact_screen(source, mask, result, opaque, allowed, frequencies):
    """Recover graded wall or paper tones where solid print interrupted a single dot screen."""
    if mask.sum() < 3200 or np.mean(np.ptp(source[:, :, :3], 2) > 5) > .015:
        return False
    gray, edited = (im[:, :, 1].astype(float) for im in (source, result))
    distance = distance_transform_edt(~mask)
    native, guide = (gaussian_filter(im, 2.1) for im in (gray, edited))
    low = np.where(distance > 4, native, guide)
    contrast = np.sqrt(np.where(distance > 4, gaussian_filter((gray-native)**2, 2.6),
                                gaussian_filter((edited-guide)**2, 2.6)))
    plane = ((low > 145) & (low < 249) & (contrast > 6.2) & opaque
             & (maximum_filter(low, 7)-minimum_filter(low, 7) < 19))
    labels, _ = label(plane, np.ones((3, 3)))
    from pathlib import Path
    from runpy import run_path
    paper = run_path(str(Path(__file__).with_name("qwen_light_screen.py")))
    applied = paper["restore_weathered_impact_screen"](gray, edited, mask, opaque, allowed, distance, result)
    for index, box in enumerate(find_objects(labels), 1):
        if box is None or (box[0].stop-box[0].start)*(box[1].stop-box[1].start) < 520:
            continue
        applied = register_impact_screen_plane(gray[box], native[box], edited[box], labels[box] == index,
                                              mask[box], allowed[box], distance[box], result[box], frequencies) or applied
    return applied


def restore_screen_beside_pen(gray, edited, mask, output, opaque, frequencies):
    """Restore print density on the screened side of a partially covered drawn contour."""
    if mask.sum() < 850 or np.count_nonzero(mask & (gray < 70)) < .14*mask.sum():
        return False
    distance = distance_transform_edt(~mask)
    low = gaussian_filter(gray, 2.3)
    guide = gaussian_filter(edited, 2.3)
    # The decoder supplies the interrupted contour. Keep it and a strip on both sides.
    pen = guide < 142
    if not np.any(pen & mask):
        return False
    clearance = distance_transform_edt(~pen)
    contrast = np.sqrt(gaussian_filter((gray-low)**2, 2.6))
    bank = ((distance > 5) & (distance < 53) & (clearance > 9) & (low > 160)
            & (low < 245) & (contrast > 9))
    if opaque is not None:
        bank &= opaque
    if bank.sum() < 1500:
        return False
    gap = distance_transform_edt(~bank)
    field_area = (clearance > 9) & (gap < 29) & (guide > 165) & (guide < 245)
    target = field_area & (mask | ((distance < 7) & (gray != edited)))
    if opaque is not None:
        target &= opaque
    covered = mask & target
    if not .35*mask.sum() <= covered.sum() <= .91*mask.sum():
        return False
    sy, sx = np.where(bank)
    points, values = np.column_stack((sy, sx)), low[bank]
    hold = (sy//11+3*(sx//12)) % 6 == 0
    if min(hold.sum(), (~hold).sum()) < 180:
        return False
    error = abs(nearby_screen_density(points[~hold], values[~hold], points[hold])-values[hold])
    if np.median(error) > 2.6 or np.quantile(error, .85) > 5.6:
        return False
    y, x = np.where(target)
    density = nearby_screen_density(points, values, np.column_stack((y, x)))
    deficit = (density-guide[y, x])[mask[y, x]]
    if np.median(deficit) < 6 or np.quantile(deficit, .22) < 3 or np.quantile(abs(deficit), .98) > 37:
        return False
    field = low.copy()
    field[y, x] = density
    dots = registered_balloon_dots(gray, low, field, bank, frequencies, y, x)
    if dots is None:
        return False
    alpha = (np.clip((clearance[y, x]-9)/7, 0, 1)*np.clip((30-gap[y, x])/6, 0, 1)
             * np.clip((7-distance[y, x])/2.5, 0, 1))
    target_tone = np.clip(density+dots, 0, 255)
    output[y, x] = np.rint(edited[y, x]+alpha*(target_tone-edited[y, x])).astype(np.uint8)[:, None]
    return True


def restore_residual_print_dots(source, mask, result, opaque, frequencies):
    """Remove isolated remnants of dark letterpress on a phase-registered light screen."""
    y, x = np.where(mask)
    if not 200 <= len(y) <= 9000 or max(np.ptp(x), np.ptp(y)) > 160:
        return False
    area = np.s_[max(0, y.min()-36):y.max()+37, max(0, x.min()-36):x.max()+37]
    src, written, output = source[area], mask[area], result[area]
    if np.any(np.ptp(src, axis=2) > 4):
        return False
    gray, edited = (v[:, :, 1].astype(float) for v in (src, output))
    if restore_screen_beside_pen(gray, edited, written, output, None if opaque is None else opaque[area], frequencies):
        return True
    changed = np.any(src != output, axis=2)
    writable = (distance_transform_edt(~written) < 8) & changed
    if opaque is not None:
        writable &= opaque[area]
    guide = gaussian_filter(edited, 1.7)
    dark_ink = writable & (gray < 125) & (edited < guide-42) & (guide > 167)
    if not dark_ink.any():
        return False
    low = gaussian_filter(gray, 1.7)
    fitted = registered_gradation(low, guide, written, distance_transform_edt(~(writable | written)))
    if fitted is None:
        return False
    field, bank = fitted
    y, x = np.where(writable)
    phase = gradual_dot_phase(gray, low, bank, frequencies, y, x)
    if phase is None:
        return False
    detail, truth, held = phase
    if np.corrcoef(truth, held)[0, 1] < .80:
        return False
    expected = field.copy()
    expected[y, x] += detail
    error = edited-expected
    native_tail = np.quantile(truth-held, .001)
    # The surrounding mean must already agree. A darker region extending
    # beyond one printed dot may be a genuine line carried through the opening.
    dark_ink &= (field-gray > 65) & (error < min(-48, native_tail-15)) & (abs(guide-field) < 9.5)
    # A real pen contour can cross the edit. Follow only small isolated islands
    # whose neighborhood fits the phase and contains no exposed heavy ink.
    exposed_ink = ~writable & ~written & (field-gray > 88)
    dark_ink &= distance_transform_edt(~exposed_ink) > 8
    seeds = np.column_stack(np.where(dark_ink))
    if not 1 <= len(seeds) <= 32:
        return False
    native_ink = (gray-field)[bank]
    densities = field[bank]
    for row, col in seeds:
        # A genuine deep dot can depart from the phase fit. Its physical ink
        # density should still occur somewhere on native stock of the same tone.
        samples = native_ink[abs(densities-field[row, col]) < 8]
        if len(samples) < 200 or edited[row, col]-field[row, col] >= samples.min()-12:
            dark_ink[row, col] = False
    islands, count = label(writable & (error < min(-26, .7*native_tail)), np.ones((3, 3)))
    support = np.bincount(islands[dark_ink], minlength=count+1)
    sizes = np.bincount(islands.ravel(), minlength=count+1)
    use = (islands > 0) & (support[islands] > 0) & (sizes[islands] <= 9)
    if not use.any():
        return False
    output[use] = np.rint(expected[use, None]).clip(0, 255).astype(np.uint8)
    return True


def restore_darkened_gradient(gray, low, guide, field, bank, mask, writable, decoded, opaque, frequencies):
    """A letter-shaped depression on a continuous, independently registered dot gradient."""
    distance = distance_transform_edt(~mask)
    surrounding = (distance > 8) & (distance < 26)
    if not surrounding.any() or (opaque is not None and not opaque[surrounding | mask].all()):
        return False
    error = abs(low[surrounding]-field[surrounding])
    deficit = (field-guide)[mask]
    if (np.median(error) > 2.6 or (error < 6).mean() < .94 or np.median(deficit) < 7
            or (deficit > 4).mean() < .79 or np.quantile(abs(deficit), .98) > 42):
        return False
    # The surrounding scan must be the same screened material on every side.
    # A nearby sleeve or panel edge breaks that condition even if most pixels fit.
    y, x = np.where(mask)
    cy, cx = np.median(y), np.median(x)
    by, bx = np.where(surrounding)
    angles = (np.arctan2(by-cy, bx-cx)+np.pi)*4/np.pi
    for sector in range(8):
        values = error[angles.astype(int).clip(0, 7) == sector]
        if len(values) < 22 or np.quantile(values, .85) > 6:
            return False
    y, x = np.where(writable)
    phase = gradual_dot_phase(gray, low, bank, frequencies, y, x)
    if phase is None:
        return False
    signal, known, prediction = phase
    if (np.corrcoef(known, prediction)[0, 1] < .90
            or np.mean(abs(known-prediction)) > .44*np.std(known)):
        return False
    decoded[y, x] = np.rint(field[y, x]+signal).clip(0, 255).astype(np.uint8)[:, None]
    return True


def restore_gradual_screen(source, mask, result, opaque, frequencies, darkened_only=False):
    """Continue the native dot screen through a measured overprint and its antialiasing."""
    y, x = np.where(mask)
    if not 200 <= len(x) <= 9000 or max(np.ptp(x), np.ptp(y)) > 160:
        return False
    area = np.s_[max(0, y.min()-36):y.max()+37, max(0, x.min()-36):x.max()+37]
    source, mask, decoded = source[area], mask[area], result[area]
    if (np.ptp(source, axis=2) > 5).mean() > .02:
        return False
    gray = source[:, :, 1].astype(float)
    low = gaussian_filter(gray, 1.7)
    guide = gaussian_filter(decoded[:, :, 1].astype(float), 1.7)
    writable = mask | ((distance_transform_edt(~mask) < 7.1) & np.any(source != decoded, axis=2))
    if opaque is not None:
        writable &= opaque[area]
    registration = registered_gradation(low, guide, mask, distance_transform_edt(~writable), printed_balloon=True)
    if registration is None:
        return False
    field, bank = registration
    local_opaque = opaque[area] if opaque is not None else None
    if restore_darkened_gradient(gray, low, guide, field, bank, mask, writable, decoded, local_opaque, frequencies):
        return True
    drift = abs(guide[mask]-field[mask])
    if darkened_only or np.quantile(drift, .8) > 20 or np.quantile(drift, .95) > 40:
        return False
    residual = guide-field
    islands, _ = label(mask & (residual > max(17, 4*np.median(abs(low[bank]-field[bank])))))
    sizes = np.bincount(islands.ravel())
    spots = (islands > 0) & (sizes[islands] >= 3) & (sizes[islands] <= 210)
    if not spots.any():
        # A decoder can preserve mean ink density while fading only the dots
        # under the lettering. Compare their amplitude with held-out native dots.
        if ((mask & (field-gray > 48)).sum() < 42 or (mask & (gray > 245) & (field < 237)).sum() < 20
                or field[mask].mean() < 187):
            return False
        y, x = np.where(writable)
        core = mask[y, x] & (field[y, x] < 240)
        if core.sum() < 120:
            return False
        phase = gradual_dot_phase(gray, low, bank, frequencies, y, x)
        if phase is None:
            return False
        from qwen_light_screen import missing_dot_contrast
        detail, measured, predicted = phase
        observed = decoded[y, x, 1].astype(float)-guide[y, x]
        gain = missing_dot_contrast(observed[core], detail[core], measured, predicted)
        if not gain:
            return False
        decoded[y, x] = np.rint(np.clip(decoded[y, x] + (gain*detail)[:, None], 0, 255))
        return True
    weight = np.clip((11-distance_transform_edt(~spots))/5, 0, 1)*np.clip((residual+2)/4, 0, 1)
    bright = gaussian_filter((gray-field > 30).astype(float), .85)
    dark = gaussian_filter((field-gray > 30).astype(float), .85)
    distance = distance_transform_edt(~mask)
    printed_face = ((mask & (bright > .45)).sum() > 65 and (mask & (dark > .45)).sum() > 45
                    and np.quantile(distance[bank], .68) > 11)
    if printed_face:
        # Both polarities occur on the original lettering. Its fainter strokes
        # can survive even after the bright decoder outliers have been removed.
        printed = ((bright > .22) | (dark > .22) | (abs(low-field) > 9)) & (distance < 6.7)
        shoulder = np.clip((3.9-distance_transform_edt(~printed))/2, 0, 1)
        weight = np.maximum(weight, shoulder*np.clip((7-distance)/2.2, 0, 1))
    y, x = np.where(writable & (weight > 0))
    if not len(x):
        return False
    phase = gradual_dot_phase(gray, low, bank, frequencies, y, x)
    if phase is None:
        return False
    luminance = field[y, x]+phase[0]
    if printed_face:
        luminance += native_grain_variation(gray, field, bank, distance, y, x)
    native = luminance[:, None]
    decoded[y, x] = np.rint(np.clip(decoded[y, x]+weight[y, x, None]*(native-decoded[y, x]), 0, 255))
    return True


def registered_dots(gray, blurred, power, bank, frequencies, y, x, density):
    sy, sx = np.where(bank)
    if len(sx) < 900:
        return
    sample = np.random.default_rng(72).choice(len(sx), min(len(sx), 13_500), replace=False)
    points = np.column_stack((sx[sample], sy[sample]))
    residual = (gray-blurred)[sy, sx]
    modes = frequencies(points, residual[sample]/np.maximum(6, power[sy[sample], sx[sample]]), gray.shape)
    axes = []
    for direction in modes:
        if not axes or abs(axes[0][0]*direction[1]-axes[0][1]*direction[0]) > .045:
            axes.append(direction)
        if len(axes) == 2:
            break
    if len(axes) != 2:
        return
    axes = np.array(axes)
    features = phase_features(sx, sy, blurred[sy, sx], axes)
    # Withhold complete native tiles so adjacent dots from a known tile cannot
    # be reused as the answer when validating phase, contrast and density.
    hold = (sx//10+3*(sy//11)) % 7 == 0
    if hold.sum() < 100 or (~hold).sum() < 700:
        return
    test = np.flatnonzero(hold)[::max(1, int(hold.sum()/1800))]
    prediction = nearest_detail(cKDTree(features[~hold]), features[test], residual[~hold])
    truth = residual[test]
    error = np.mean(abs(prediction-truth))/max(.01, np.mean(abs(truth)))
    correlation = np.mean(truth*prediction)/max(.01, np.sqrt(np.mean(truth**2)*np.mean(prediction**2)))
    if error > .74 or correlation < .59:
        return
    return nearest_detail(cKDTree(features), phase_features(x, y, density, axes), residual)


def calibrated_screen_density(low, aligned, bank, distance, opaque, y, x):
    # The exposed areas of the *uncomposited* reference edit also went through
    # the decoder. Use those pairs to recover the brightness of the real scan.
    guide = gaussian_filter(aligned.mean(axis=2).astype(np.float32), 2.4)
    known = ((distance > 5) & (distance < 165) & (distance_transform_edt(~bank) < 11)
             & (distance_transform_edt(low >= 125) > 11))
    if opaque is not None:
        known &= opaque
    if known.sum() < 900:
        return
    native = (low-gaussian_filter(low, 9))[known]
    matched = (guide-gaussian_filter(guide, 9))[known]
    covariance = np.mean(native*matched)
    power = np.sqrt(np.mean(native**2)*np.mean(matched**2))
    if power < 1 or covariance < .75*power:
        return
    bias = np.clip(low-guide, -35, 35) * known
    mass = known.astype(np.float32)
    offset = np.zeros(len(y), dtype=np.float32)
    for sigma, minimum in ((79, .10), (48, .27), (24, .20), (10, .17)):
        weight = gaussian_filter(mass, sigma)[y, x]
        level = gaussian_filter(bias, sigma)[y, x] / np.maximum(1e-6, weight)
        offset += np.clip(weight/minimum, 0, 1)*(level-offset)
    return guide[y, x]+offset


def restore_crossed_screen(source, mask, result, opaque, frequencies, aligned=None):
    if not 250 <= mask.sum() <= 125_000 or min(mask.shape) < 64 or mask.size > 800_000:
        return False
    allowed = mask | ((distance_transform_edt(~mask) < 7) & np.any(result != source, axis=2))
    if opaque is not None:
        allowed &= opaque
    y, x = np.where(allowed)
    if len(x) < 250:
        return False
    gray, decoded = (rgb.mean(axis=2).astype(np.float32) for rgb in (source, result))
    guide = gaussian_filter(decoded, 2.4)
    if (guide[y, x] < 124).mean() > .01 or np.quantile(np.ptp(result, axis=2)[y, x], .98) > 24:
        return False
    blurred = gaussian_filter(gray, 1.45)
    power = np.sqrt(gaussian_filter((gray-blurred)**2, 2))
    low = gaussian_filter(gray, 1.8)
    distance = distance_transform_edt(~allowed)
    bank = ((distance > 3.8) & (distance < 138) & (power > 2.8) & (blurred > 124)
            & (distance_transform_edt(low >= 103) > 13))
    if opaque is not None:
        bank &= opaque
    if bank.sum() < 900:
        return False
    slopes = exposed_directions(low, bank, allowed)
    if slopes is None:
        return False
    levels = np.full(mask.shape[0], np.nan)
    for row in range(len(levels)):
        area = np.s_[max(0, row-3):row+4]
        if bank[area].sum() > 65:
            levels[row] = np.quantile(blurred[area][bank[area]], .22)
    valid = np.flatnonzero(np.isfinite(levels))
    if len(valid) < 60:
        return False
    base = gaussian_filter1d(np.interp(np.arange(len(levels)), valid, levels[valid]), 5)[:, None]
    amplitude = np.maximum(12, 255-base)
    light = directional_light(np.clip((low-base)/amplitude, -.25, 1), bank, y, x, slopes)
    model = np.clip((guide[y, x]-base[y, 0])/amplitude[y, 0], -.25, 1)
    density = base[y, 0]+np.maximum(14, 255-base[y, 0])*np.clip(.28*light+.72*model, -.03, 1)
    wash = local_wash(gray, decoded, bank, allowed, y, x)
    density += .81*np.clip(wash[y, x], -30, 30)
    if aligned is not None:
        calibrated = calibrated_screen_density(low, aligned, bank, distance, opaque, y, x)
        if calibrated is not None:
            # Use the established screen on the seam and the calibrated model
            # where the entire underlying drawing was covered by the publisher.
            interior = np.clip(distance_transform_edt(allowed)[y, x]/6, 0, 1)
            density += interior*(calibrated-density)
    detail = registered_dots(gray, blurred, power, bank & (distance < 86), frequencies, y, x, density)
    if detail is None:
        return False
    luminance = np.clip(density+detail, 0, 255)
    result[y, x] = np.rint(np.clip(result[y, x] + (luminance-decoded[y, x])[:, None], 0, 255))
    return True
