"""Recover a low-frequency gray cast only on smooth, achromatic printed stock."""
import numpy as np
from scipy.ndimage import (
    distance_transform_edt, gaussian_filter, gaussian_filter1d, label, maximum_filter, maximum_filter1d,
    minimum_filter, minimum_filter1d,
)
from scipy.signal import find_peaks
from scipy.spatial import cKDTree
from scipy.sparse import coo_matrix
from scipy.sparse.linalg import spsolve


def local_planes(bank_points, bank_values, targets):
    tree = cKDTree(bank_points)
    radii = np.repeat([6, 18, 36, 62], 16)
    angles = np.tile(np.arange(16) * np.pi / 8, 4)
    offsets = radii[:, None] * np.column_stack((np.sin(angles), np.cos(angles)))
    for start in range(0, len(targets), 420):
        centers = targets[start:start+420]
        distances, indices = tree.query(centers[:, None, :] + offsets)
        relative = bank_points[indices] - centers[:, None, :]
        y, x = relative[:, :, 0], relative[:, :, 1]
        radius = np.hypot(x, y)
        weight = (np.exp(-.5*(radius/38)**2 - .5*(distances/19)**2)
                  * (radius < 88) * (distances < 32))
        design = np.stack((np.ones_like(x), x/45, y/45), axis=2)
        values = bank_values[indices]
        # Hold out spatial blocks. Duplicate samples of the same original pixel
        # must remain on the same side of the training/validation split.
        test = (bank_points[indices, 1]//7 + bank_points[indices, 0]//9) % 4 == 0
        train = weight * ~test
        for _ in range(2):
            gram = np.einsum("nki,nkj,nk->nij", design, design, train)
            rhs = np.einsum("nki,nk,nk->ni", design, values, train)
            coeff = np.linalg.solve(gram + .0001*np.eye(3)[None], rhs[:, :, None])[:, :, 0]
            residual = values - np.einsum("nki,ni->nk", design, coeff)
            train = weight * ~test * np.minimum(1, 1.5/np.maximum(.01, abs(residual)))
        sectors = ((np.arctan2(y, x) + 2*np.pi + np.pi/8) % (2*np.pi) * 4/np.pi).astype(int)
        support = np.stack([((sectors == i)*weight).sum(axis=1) > .62 for i in range(8)])
        test_mass = (weight*test).sum(axis=1)
        error = (abs(residual)*test*weight).sum(axis=1) / np.maximum(.001, test_mass)
        valid = ((support.sum(axis=0) >= 5) & ((support[:4] & support[4:]).sum(axis=0) >= 2)
                 & (test_mass > 2.2) & (error <= 1.12) & (abs(coeff[:, 1:]).max(axis=1) < 8))
        yield centers, coeff, valid, error + .006*distances.mean(axis=1)


def measured_stock(source, mask, result, opaque):
    gray, decoded = (image.mean(axis=2).astype(np.float32) for image in (source, result))
    chroma = np.ptp(result, axis=2)
    guard = distance_transform_edt(~mask)
    writable = mask | ((guard <= 7) & np.any(source != result, axis=2))
    if opaque is not None:
        writable &= opaque
    if ((chroma > 0) & (chroma < 12) & writable).sum() < 81:
        return False
    low, guide = gaussian_filter(gray, 1.2), gaussian_filter(decoded, 1.15)
    known = ((guard > 4) & (guard < 145) & (maximum_filter(np.ptp(source, axis=2), 5) == 0)
             & (maximum_filter(gray, 5)-minimum_filter(gray, 5) <= 7)
             & (maximum_filter(low, 7)-minimum_filter(low, 7) < 2.8) & (low > 62) & (low < 251))
    if opaque is not None:
        known &= minimum_filter(opaque, 5)
    if known.sum() < 200:
        return False
    near = distance_transform_edt(~known)
    smooth = maximum_filter(guide, 3) - minimum_filter(guide, 3)
    candidates = (writable & (near < 85) & (guide > 60) & (guide < 251) & (chroma < 12)
                  & (smooth < 7) & (abs(decoded-guide) < 9))
    coefficients = np.zeros((*mask.shape, 3), np.float32)
    errors = np.full(mask.shape, np.inf, np.float32)
    for center in range(64, 253, 6):
        target = np.argwhere(candidates & (abs(guide-center) < 6.1))
        if len(target) < 32:
            continue
        banks = np.argwhere(known & (abs(low-center) < 7))
        banks = banks[(banks % 2 == 0).all(axis=1)]
        if len(banks) < 85:
            continue
        values = gray[tuple(banks.T)]
        for pixels, fit, valid, error in local_planes(banks, values, target):
            y, x = pixels.T
            take = valid & (abs(fit[:, 0]-guide[y, x]) < 8.2) & (error < errors[y, x])
            y, x = y[take], x[take]
            coefficients[y, x] = fit[take]
            errors[y, x] = error[take]
    measured = np.isfinite(errors)
    drift = measured & (abs(coefficients[:, :, 0]-guide) > 1.05) & (chroma > 0)
    islands, count = label(drift, np.ones((3, 3), bool))
    sizes = np.bincount(islands.ravel(), minlength=count+1)
    anchors = drift & (sizes[islands] >= 81)
    if not anchors.any():
        return False
    # Around a matte boundary the original stock is visible on just one side.
    # Extend the nearest validated plane for the last few pixels up to the seam.
    distance, nearest = distance_transform_edt(~measured, return_indices=True)
    yy, xx = np.indices(mask.shape)
    py, px = nearest
    base, dx, dy = coefficients[py, px].transpose(2, 0, 1)
    field = gaussian_filter(base + (dx*(xx-px) + dy*(yy-py))/45, 1.8)
    within = (writable & (distance_transform_edt(~anchors) < 69) & (distance < 36)
              & (near < 88) & (chroma < 12))
    detail = decoded-guide
    write = within & (abs(decoded-field) < 8.2) & (smooth < 7.5) & (abs(detail) < 7)
    if not write.any():
        return False
    result[write] = np.rint(np.clip((field+.12*np.clip(detail, -1, 1))[write, None], 0, 255))
    edge = within & ~write & (distance_transform_edt(~write) <= 2.3) & (abs(decoded-field) < 30)
    if edge.any():
        shift = gaussian_filter((decoded-field)*write, 2.5) / np.maximum(.001, gaussian_filter(write.astype(np.float32), 2.5))
        result[edge] = np.rint(np.clip((decoded-shift)[edge, None], 0, 255))
    return True


def restore_neutral_stock(source, mask, result, opaque):
    rows, cols = np.where(mask)
    if len(rows) < 100:
        return False
    if restore_narrow_fold_caption(source, mask, result, opaque, rows, cols):
        return True
    if restore_folded_stock(source, mask, result, opaque, rows, cols):
        return True
    area = np.s_[max(0, rows.min()-145):rows.max()+146, max(0, cols.min()-145):cols.max()+146]
    if mask[area].size > 800_000:
        return False
    return measured_stock(source[area], mask[area], result[area], opaque[area] if opaque is not None else None)


def restore_narrow_fold_caption(source, mask, result, opaque, rows, cols):
    """Measure a light folded surface on both sides of a short boxed imprint."""
    top, bottom, left, right = rows.min(), rows.max()+1, cols.min(), cols.max()+1
    height, width = bottom-top, right-left
    if not (10 <= height <= 36 and max(75, 3.6*height) <= width <= 380
            and len(rows) == height*width and min(top, len(mask)-bottom) >= 16):
        return False
    if opaque is not None and not opaque[top-15:bottom+15, left:right].all():
        return False
    # A boxed imprint can share paper with adjacent folds. Use the same
    # independently matched pen banks as the larger, irregular caption.
    xs = slice(max(0, left-100), min(mask.shape[1], right+100))
    rect = np.s_[top:bottom, left-xs.start:right-xs.start]
    rgb = source[:, xs]
    if (np.ptp(rgb[top-15:bottom+15], axis=2) > 6).mean() > .008:
        return False
    gray = rgb[:, :, 1].astype(float)
    if (gray[rect] < 150).sum() < 25:
        return False
    distance = distance_transform_edt(~mask[:, xs])
    fields = []
    for extension in (6, 13):
        first, last = top-extension, bottom-1+extension
        matched = register_fold_profiles(gray, distance, first, last)
        if matched is None:
            return False
        field, disagreement, paths = matched
        span = (paths >= left-xs.start-8) & (paths < right-xs.start+8)
        if span.sum() < 2 or np.ptp(paths[span]) < .42*width:
            return False
        core = np.s_[extension:-extension, rect[1]]
        check = abs(field[[extension-2, -extension+1], rect[1]]
                    - gray[[top-2, bottom+1], rect[1]])
        if np.quantile(check, .95) > 4.5 or np.quantile(disagreement[core], .96) > 6:
            return False
        fields.append(field[core])
    if np.quantile(abs(fields[0]-fields[1]), .96) > 3.5:
        return False
    plate = .5*(fields[0]+fields[1])
    proposed = result[:, xs][rect].mean(axis=2)
    drift = plate-proposed
    if (plate.min() < 177 or np.ptp(np.quantile(plate, [.08, .92])) < 10
            or (abs(drift) >= 5).mean() < .18 or np.quantile(abs(drift), .97) > 43):
        return False
    native = gray.copy()
    native[rect] = plate
    write = mask[:, xs]
    tone = np.rint(np.clip(match_stock_boundary(native, gray, write), 0, 255))
    result[:] = source
    result[:, xs][write] = tone[:, None]
    return True


def fold_bank(gray, gradients, row, side):
    """Measure each visible native edge and its horizontal displacement per row."""
    profile = gaussian_filter1d(gray[row], 1.1)
    derivative = np.gradient(gaussian_filter1d(profile, 1))
    peaks, _ = find_peaks(abs(derivative), height=1.5, distance=4, prominence=1.2)
    lines = []
    rows = np.arange(max(0, row-19 if side < 0 else row),
                     min(len(gray), row+1 if side < 0 else row+20))
    for col in peaks:
        cols = np.arange(max(0, col-14), min(gray.shape[1], col+15))
        y, x = np.ix_(rows, cols)
        weight = np.exp(-.5*((x-col)/8)**2 - .5*((y-row)/10)**2)
        dx, dy = (field[y, x] for field in gradients)
        tangent = -np.sum(weight*dx*dy) / max(.001, np.sum(weight*dx*dx))
        lines.append((col, derivative[col], tangent))
    return profile, lines


def fold_position(first, last, gap, fraction):
    start, _, initial_slope = first
    end, _, final_slope = last
    mean_slope = (end-start)/gap
    bend = (1-fraction)*(initial_slope-mean_slope) + fraction*(mean_slope-final_slope)
    return (1-fraction)*start + fraction*end + fraction*(1-fraction)*gap*bend


def fold_match_cost(first, last, profiles, rows, fractions, gradient, known):
    x, ink, tangent = first
    end, other_ink, other_tangent = last
    gap = rows[-1]-rows[0]
    slope = (end-x)/gap
    if ink*other_ink <= 0 or abs(slope) >= 1.15:
        return np.inf
    offsets = np.array([-8, -4, -2, 0, 2, 4, 8])
    width = gradient.shape[1]
    a, b = (profile[(center+offsets).clip(0, width-1)] for profile, center in zip(profiles, (x, end)))
    path = np.rint(fold_position(first, last, gap, fractions)).astype(int).clip(0, width-1)
    witness = known[rows, path]
    penalty = 1
    if witness.sum() >= 3:
        strength = np.sign(ink)*gradient[rows[witness], path[witness]]/max(1, min(abs(ink), abs(other_ink)))
        penalty = min(1, np.maximum(0, 1-strength).mean())
    return (np.minimum(abs(a-b), 65).mean()/30 + .22*abs(np.log(abs(ink/other_ink)))
            + .4*abs(slope) + 2.8*(abs(tangent-slope)+abs(other_tangent-slope)) + .8*penalty)


def match_fold_banks(top, bottom, cost):
    # Match the two ordered scanlines. An unpaired boundary may leave the crop.
    if min(len(top), len(bottom)) < 4 or max(len(top), len(bottom)) > 100:
        return
    table = np.full((len(top)+1, len(bottom)+1), np.inf)
    back = np.zeros(table.shape, np.uint8)
    table[:, 0] = 1.28*np.arange(len(top)+1)
    table[0, :] = 1.28*np.arange(len(bottom)+1)
    back[0, 1:] = 1
    for i, start in enumerate(top, 1):
        for j, end in enumerate(bottom, 1):
            choices = (table[i-1, j]+1.28, table[i, j-1]+1.28, table[i-1, j-1]+cost(start, end))
            move = np.argmin(choices)
            table[i, j], back[i, j] = choices[move], move
    i, j = len(top), len(bottom)
    pairs = []
    while i or j:
        move = back[i, j]
        if move == 2:
            pairs.append((top[i-1], bottom[j-1]))
        if move != 1:
            i -= 1
        if move != 0:
            j -= 1
    if len(pairs) >= 4:
        return np.array(pairs[::-1])


def register_fold_profiles(gray, distance, top, bottom):
    gradients = (gaussian_filter(gray, .9, order=[0, 1]), gaussian_filter(gray, .9, order=[1, 0]))
    first, start = fold_bank(gray, gradients, top, -1)
    last, end = fold_bank(gray, gradients, bottom, 1)
    rows = np.arange(top, bottom+1)
    fractions = (rows-top)/(bottom-top)
    known = distance > 4

    def cost(a, b):
        return fold_match_cost(a, b, (first, last), rows, fractions, gradients[0], known)

    pairs = match_fold_banks(start, end, cost)
    if pairs is None:
        return
    first, last = pairs[:, 0].T, pairs[:, 1].T
    columns = np.arange(gray.shape[1])
    tones, differences = [], []
    for fraction in fractions:
        position = fold_position(first, last, bottom-top, fraction)
        if np.any(np.diff(position) <= 0):
            return
        a, b = (np.interp(columns + np.interp(columns, position, anchor-position), columns, gray[row])
                for row, anchor in [(top, first[0]), (bottom, last[0])])
        tones.append((1-fraction)*a+fraction*b)
        differences.append(abs(a-b))
    return gaussian_filter(np.asarray(tones), (.65, .55)), np.asarray(differences), (first[0]+last[0])/2


def match_stock_boundary(field, original, write):
    """Continue the measured tone up to the actual, unmodified paper edge."""
    y, x = np.where(write)
    indices = np.full(write.shape, -1, int)
    centers = np.arange(len(x))
    indices[y, x] = centers
    diagonal = np.full(len(x), .0008)
    rhs = np.zeros(len(x))
    rows, cols, weights = [], [], []
    for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0)):
        yy = np.clip(y+dy, 0, write.shape[0]-1)
        xx = np.clip(x+dx, 0, write.shape[1]-1)
        adjacent = indices[yy, xx]
        weight = (.12 + .88*np.exp(-.5*((field[y, x]-field[yy, xx])/8)**2)) * ((y != yy) | (x != xx))
        diagonal += weight
        inside = adjacent >= 0
        rows.append(centers[inside])
        cols.append(adjacent[inside])
        weights.append(-weight[inside])
        outside = ~inside
        drift = np.clip(original[yy[outside], xx[outside]]-field[yy[outside], xx[outside]], -27, 27)
        rhs[outside] += weight[outside]*drift
    matrix = coo_matrix((np.concatenate([*weights, diagonal]),
                         (np.concatenate([*rows, centers]), np.concatenate([*cols, centers]))),
                        shape=(len(x), len(x))).tocsr()
    return field[y, x] + spsolve(matrix, rhs)


def finish_fold_stock(gray, result, write, band, field):
    native = gray.copy()
    native[band] = field
    guide = result[:, :, 1].astype(float)

    def behind_ink(values):
        return minimum_filter1d(maximum_filter1d(values, 11, axis=1, mode="nearest"),
                                11, axis=1, mode="nearest")

    # Keep the decoded pen contour position where the banks differ by a fraction of a pixel.
    dark = np.clip(behind_ink(guide)-guide, 0, 255)
    ink = np.clip((dark-4)/13, 0, 1)*np.clip((199-guide)/27, 0, 1)
    native += (behind_ink(native)-native)*np.clip((204-native)/25, 0, 1)
    native -= ink*dark
    result[write] = np.rint(np.clip(match_stock_boundary(native, gray, write), 0, 255))[:, None]


def verify_fold_field(gray, model, bank, write, field, disagreement):
    flat = abs(np.gradient(field, axis=1)) < 2.3
    visible = gray[bank & flat]
    if len(visible) < 90 or np.ptp(np.quantile(visible, [.125, .875])) < 10:
        return False
    error = abs(visible-field[bank & flat])
    baseline = abs(visible-np.median(visible)).mean()
    if error.mean() > min(4, .6*max(1, baseline)) or np.quantile(error, .90) > 9:
        return False
    supported = write & flat & (disagreement < 19) & (field > 165)
    if supported.sum() < .47*write.sum():
        return False
    drift = field[supported]-model[supported]
    return abs(np.median(drift)) >= 3 and (abs(drift) < 44).mean() >= .94


def restore_folded_stock(source, mask, result, opaque, rows, cols):
    if not 1100 <= len(cols) <= 45_000:
        return False
    top, bottom, left, right = rows.min(), rows.max(), cols.min(), cols.max()
    h, w = bottom-top+1, right-left+1
    if not (24 <= h <= 155 and max(125, 1.65*h) <= w <= 670 and .12 < len(cols)/(w*h) < .88):
        return False
    if min(top, len(mask)-bottom-1) < 13:
        return False
    area = np.s_[max(0, top-54):bottom+55, max(0, left-115):right+116]
    original, selected, decoded = source[area], mask[area], result[area]
    if (np.ptp(original, axis=2) > 7).mean() > .01:
        return False
    gray = original[:, :, 1].astype(float)
    y, x = np.where(selected)
    top, bottom = y.min()-6, y.max()+6
    band = np.s_[top:bottom+1, :]
    distance = distance_transform_edt(~selected)
    bank = (distance[band] > 3.5) & (distance[band] < 27)
    bank[:, :max(0, x.min()-10)] = False
    bank[:, x.max()+11:] = False
    if bank.sum() < 320 or (gray[band][bank] > 165).mean() < .85 or (gray[selected] < 122).sum() < 95:
        return False
    registered = register_fold_profiles(gray, distance, top, bottom)
    if registered is None:
        return False
    field, disagreement, paths = registered
    paths = paths[(paths > x.min()-8) & (paths < x.max()+8)]
    if len(paths) < 4 or np.ptp(paths) < .55*w:
        return False
    if not verify_fold_field(gray[band], decoded[band][:, :, 1], bank, selected[band], field, disagreement):
        return False
    write = selected | ((distance < 7.1) & np.any(decoded != original, axis=2))
    write[:top] = write[bottom+1:] = False
    if opaque is not None:
        write &= opaque[area]
    if not write.any():
        return False
    finish_fold_stock(gray, decoded, write, band, field)
    return True
