"""Continue an exposed, sparse dot screen through small handwritten type."""

import numpy as np
from scipy.ndimage import distance_transform_edt, find_objects, gaussian_filter, label
from scipy.spatial import Delaunay, cKDTree


def original_centers(gray, bank):
    components, _ = label((gray < 142) & bank, structure=np.ones((3, 3)))
    centers = []
    for region in find_objects(components):
        rows, cols = region
        height, width = rows.stop - rows.start, cols.stop - cols.start
        if not (2 <= width <= 8 and 2 <= height <= 8):
            continue
        y, x = round((rows.start + rows.stop - 1) / 2), round((cols.start + cols.stop - 1) / 2)
        if min(x, y) < 3 or y + 3 >= len(gray) or x + 3 >= gray.shape[1]:
            continue
        patch = np.s_[y-3:y+4, x-3:x+4]
        if not bank[patch].all():
            continue
        weights = np.maximum(0., 240. - gray[patch])
        peak = weights.max()
        if peak < 87 or (weights > .4 * peak).sum() > 17:
            continue
        offset = np.arange(-3, 4)
        centers.append([x + weights.sum(0) @ offset / weights.sum(),
                        y + weights.sum(1) @ offset / weights.sum()])
    return np.asarray(centers)


def dot_lattice(points):
    if len(points) < 60:
        return
    distance, indices = cKDTree(points).query(points, k=7)
    nearest = distance[:, 1]
    pitch = np.median(nearest)
    if not 3.2 < pitch < 14 or ((nearest > .76*pitch) & (nearest < 1.24*pitch)).mean() < .68:
        return
    neighbours = points[indices[:, 1:]] - points[:, None, :]
    steps = neighbours[(distance[:, 1:] > .83*pitch) & (distance[:, 1:] < 1.17*pitch)]
    angles = np.arctan2(steps[:, 1], steps[:, 0])
    orientation = np.mean(np.exp(4j * angles))
    if abs(orientation) < .86:
        return
    axes = []
    for angle in [np.angle(orientation) / 4, np.angle(orientation) / 4 + np.pi / 2]:
        axis = steps[np.cos(angles - angle) > .972]
        if len(axis) < 30:
            return
        axes.append(np.median(axis, axis=0))
    basis = np.asarray(axes)
    origin = points[np.argmin(np.linalg.norm(points - np.median(points, axis=0), axis=1))]
    for _ in range(4):
        cells = np.rint((points - origin) @ np.linalg.inv(basis))
        error = np.linalg.norm(points - (cells @ basis + origin), axis=1)
        matched = error < max(.52, .11*pitch)
        if matched.sum() < 60 or matched.mean() < .57:
            return
        design = np.column_stack([cells[matched], np.ones(matched.sum())])
        fit = np.linalg.lstsq(design, points[matched], rcond=None)[0]
        basis, origin = fit[:2], fit[2]
    return basis, origin, pitch, points[matched]


def estimated_paper(gray, bank, fit, robust=False):
    basis, origin, pitch, centers = fit
    y, x = np.indices(gray.shape)
    phase = (np.column_stack([x.ravel(), y.ravel()]) - origin) @ np.linalg.inv(basis)
    cell = np.rint(phase).astype(int)
    features = np.column_stack([np.cos(2*np.pi*phase), np.sin(2*np.pi*phase)])
    displaced, _ = cKDTree(centers).query(cell @ basis + origin)
    measured = bank.ravel() & (displaced < max(.45, .105*pitch))
    # Hold out entire physical dots, including their antialiased rims.
    held = (cell[:, 0] + 2*cell[:, 1]) % 5 == 1
    training = np.flatnonzero(measured & ~held)
    testing = np.flatnonzero(measured & held)
    if min(len(training), len(testing)) < 150:
        return
    tree = cKDTree(features[training])
    original = gray.ravel()

    def predict(ids):
        if robust:
            # Nearby linework can share a sampled cell with a real dot. Its
            # dark pixels do not recur at this phase in independent cells.
            _, indices = tree.query(features[ids], k=32)
            return np.median(original[training[indices]], axis=1)
        offsets, indices = tree.query(features[ids], k=8)
        weights = 1 / (.001 + offsets)**2
        return np.sum(weights * original[training[indices]], axis=1) / weights.sum(axis=1)

    truth = original[testing]
    residual = abs(predict(testing) - truth)
    baseline = abs(truth - np.median(truth)).mean()
    if residual.mean() >= min(11., .42*baseline) or np.quantile(residual, .95) > 34:
        return
    return predict(np.arange(gray.size)).reshape(gray.shape)


def restore_tall_dot_field(rgb, selected, out, opaque, gray, distance, fit, paper):
    basis, origin, pitch, _ = fit
    # Intact dots between the printed strokes witness the same lattice as the
    # outer bank. Cross the white keyline only within their measured extent.
    candidates = original_centers(gray, opaque)
    if len(candidates) < 60:
        return False
    cells = np.rint((candidates - origin) @ np.linalg.inv(basis))
    centers = candidates[np.linalg.norm(candidates - (cells @ basis + origin), axis=1) < .095*pitch]
    if len(centers) < 60 or np.linalg.matrix_rank(centers - centers.mean(0)) < 2:
        return False
    y, x = np.where((distance <= min(11, pitch)) & opaque)
    query = np.column_stack([x, y])
    offsets, _ = cKDTree(centers).query(query, k=3)
    inside = Delaunay(centers).find_simplex(query) >= 0
    line = (~selected) & (distance < 16) & (gaussian_filter(paper-gray, 1.25) > 38)
    clear = distance_transform_edt(~line) if line.any() else np.full_like(gray, 1000)
    use = inside & (offsets[:, -1] < 3.85*pitch) & (clear[y, x] >= 3)
    if np.sum(use & selected[y, x]) < .97 * selected.sum():
        return False
    y, x = y[use], x[use]
    native = (~selected[y, x]) & (abs(gray[y, x] - paper[y, x]) < 12)
    out[y, x] = np.rint(paper[y, x, None]).clip(0, 255).astype(np.uint8)
    out[y[native], x[native]] = rgb[y[native], x[native]]
    return True


def restore_dot_stock(source, mask, result, opaque):
    y, x = np.where(mask)
    if len(y) < 130:
        return False
    w, h = np.ptp(x), np.ptp(y)
    short = len(y) <= 3500 and 33 <= w <= 150 and 7 <= h <= 55
    tall = len(y) <= 24000 and 45 <= w <= 170 and 125 <= h <= 370 and h > 1.6*w
    if not (short or tall):
        return False
    region = np.s_[max(0, y.min()-55):y.max()+56, max(0, x.min()-55):x.max()+56]
    rgb, selected, out = source[region], mask[region], result[region]
    distance = distance_transform_edt(~selected)
    bank = (distance > 4) & (distance < 52) & opaque[region]
    if not bank.any() or np.quantile(np.ptp(rgb[bank | selected], axis=1), .98) > 4:
        return False
    gray = rgb[:, :, 1].astype(float)
    fit = dot_lattice(original_centers(gray, bank))
    if fit is None:
        return False
    paper = estimated_paper(gray, bank, fit, robust=tall)
    if paper is None:
        return False
    if tall:
        return restore_tall_dot_field(rgb, selected, out, opaque[region], gray, distance, fit, paper)
    # Keep the model's reconstruction across any illustrated edge entering the
    # lettering. Surrounding source dots must support each local restoration.
    pitch, centers = fit[2:]
    yy, xx = np.where(selected)
    offsets, _ = cKDTree(centers).query(np.column_stack([xx, yy]), k=3)
    nearby = offsets[:, -1] < 3.2*pitch
    mismatched = (~selected) & (distance < 16) & (gaussian_filter(paper-gray, 1.25) > 38)
    away = distance_transform_edt(~mismatched) if mismatched.any() else np.full_like(gray, 1000)
    use = nearby & (away[yy, xx] >= 3) & opaque[region][yy, xx]
    if use.mean() < .90:
        return False
    yy, xx = yy[use], xx[use]
    out[yy, xx] = np.rint(paper[yy, xx, None]).clip(0, 255).astype(np.uint8)
    return True
