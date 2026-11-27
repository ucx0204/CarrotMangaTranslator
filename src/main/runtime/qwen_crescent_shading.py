"""Register the stipple on a shaded disk to the exposed sides of an overprint."""
import numpy as np
from scipy.ndimage import gaussian_filter, map_coordinates, maximum_filter, minimum_filter
from scipy.optimize import least_squares
from scipy.sparse import coo_matrix
from scipy.sparse.linalg import spsolve


def shadow_measurement(gray, clearance, rho, center, radius):
    smooth = gaussian_filter(gray, 1.85)
    gy, gx = np.gradient(smooth)
    slope = np.hypot(gx, gy)
    band = ((rho < -2.8) & (clearance > 4.2) & (smooth >= 52) & (smooth <= 80)
            & (slope >= 5) & (minimum_filter(gray, 11) < 13) & (maximum_filter(gray, 11) > 157))
    y, x = np.nonzero(band)
    if len(x) < 48:
        return
    points = np.column_stack((x, y))
    normals = np.column_stack((gx[band], gy[band])) / slope[band, None]

    def inliers(circle, tolerance, direction):
        delta = points - circle[:2]
        distance = np.linalg.norm(delta, axis=1)
        aligned = np.sum(delta*normals, axis=1) > direction*distance
        return (abs(distance-circle[2]) < tolerance) & aligned

    def support(circle, ok):
        xy = points[ok]-circle[:2]
        angle = np.arctan2(xy[:, 1], xy[:, 0])
        _, counts = np.unique(np.rint(np.degrees(angle)/4).astype(int), return_counts=True)
        return np.minimum(counts, 5).sum()

    candidates = []
    rng = np.random.default_rng(19)
    for trial_radius in radius*np.linspace(.68, 1.40, 13):
        origins = points - trial_radius*normals
        for origin in origins[rng.choice(len(origins), min(170, len(origins)), replace=False)]:
            if not .16*radius < np.linalg.norm(origin-center) < .93*radius:
                continue
            trial = np.r_[origin, trial_radius]
            ok = inliers(trial, 3.3, .79)
            if ok.sum() >= 35:
                candidates.append((support(trial, ok), tuple(trial)))
    best = None
    for _, trial in sorted(candidates, reverse=True)[:16]:
        circle = np.asarray(trial)
        for _ in range(4):
            subset = points[inliers(circle, 3.3, .76)]
            if len(subset) < 30:
                break
            circle = least_squares(lambda p: np.linalg.norm(subset-p[:2], axis=1)-p[2],
                                   circle, loss="soft_l1").x
        ok = inliers(circle, 2.7, .80)
        if not .65*radius < circle[2] < 1.5*radius or ok.sum() < 48:
            continue
        score = support(circle, ok)
        if score < 32 or (best is not None and score <= best[0]):
            continue
        error = abs(np.linalg.norm(points[ok]-circle[:2], axis=1)-circle[2])
        if np.median(error) > 1.1:
            continue
        angles = np.arctan2(points[ok, 1]-circle[1], points[ok, 0]-circle[0])
        best = (score, circle, np.angle(np.mean(np.exp(1j*angles))))
    if best is not None:
        return best[1:]


def angular_banks(samples, valid):
    """Reflect inside continuous original scan segments on each side of the hole."""
    rows, columns = np.indices(valid.shape)
    padded = np.pad(valid, ((0, 0), (4, 4)), mode="edge")
    stable = sum(padded[:, j:j+valid.shape[1]].astype(np.int8) for j in range(9)) >= 8
    last = np.maximum.accumulate(np.where(stable, rows, -10000), axis=0)
    following = np.minimum.accumulate(np.where(stable, rows, 10000)[::-1], axis=0)[::-1]
    before = np.maximum.accumulate(np.where(~stable, rows, -99999), axis=0)
    after = np.minimum.accumulate(np.where(~stable, rows, 99999)[::-1], axis=0)[::-1]
    total = np.zeros(samples.shape)
    weight = np.zeros(samples.shape)
    for boundary, end, direction in [(last, before, -1), (following, after, 1)]:
        edge = np.clip(boundary, 0, len(rows)-1)
        reach = np.clip(abs(end[edge, columns]-edge)-1, 0, 75)
        distance = abs(boundary-rows)
        offset = reach-abs(reach-np.mod(distance, np.maximum(2, 2*reach)))
        donor = np.clip(edge+direction*offset, 0, len(rows)-1)
        confidence = np.clip((reach-5)/11, 0, 1)*np.exp(-distance/27)
        total += confidence*samples[donor, columns]
        weight += confidence
    return total/np.maximum(.00001, weight), np.clip(weight/.19, 0, 1)


def match_boundary(source, generated, guidance, mask, active):
    """Preserve the texture gradient inside and the original exposure at its edge."""
    y, x = np.nonzero(active)
    index = np.full(mask.shape, -1, dtype=int)
    index[y, x] = np.arange(len(x))
    rows = [np.arange(len(x))]
    cols = rows.copy()
    weights = [np.full(len(x), 4.006)]
    rhs = np.zeros(len(x))
    for dy, dx in [(0, 1), (0, -1), (1, 0), (-1, 0)]:
        yy, xx = y+dy, x+dx
        neighbor = index[yy, xx]
        interior = neighbor >= 0
        rows.append(np.flatnonzero(interior))
        cols.append(neighbor[interior])
        weights.append(np.full(interior.sum(), -1))
        edge_y, edge_x = yy[~interior], xx[~interior]
        exterior = np.where(mask[edge_y, edge_x], generated[edge_y, edge_x], source[edge_y, edge_x])
        rhs[~interior] += exterior-guidance[edge_y, edge_x]
    matrix = coo_matrix((np.concatenate(weights), (np.concatenate(rows), np.concatenate(cols))),
                        shape=(len(x), len(x))).tocsr()
    return guidance[y, x]+spsolve(matrix, rhs)


def restore_shaded_rim(gray, mask, clearance, rho, outer_center, radius, native_prior, prediction):
    measured = shadow_measurement(gray, clearance, rho, outer_center, radius)
    if measured is None:
        return prediction
    (cx, cy, r), axis = measured
    y, x = np.indices(mask.shape)
    angle = (np.arctan2(y-cy, x-cx)-axis+np.pi) % (2*np.pi)-np.pi
    depth = np.hypot(x-cx, y-cy)-r
    active = mask & (rho < -1) & (abs(depth) < 35)
    active[[0, -1], :] = False
    active[:, [0, -1]] = False
    if not 25 <= active.sum() <= 24000 or (active & (abs(depth) < 4)).sum() < 15:
        return prediction
    angles = np.radians(np.arange(-180, 180.01, .38))
    depths = np.arange(-37, 44, .55)
    ra, rd = np.broadcast_arrays(angles[:, None]+axis, depths[None, :])
    grid = [cy+(r+rd)*np.sin(ra), cx+(r+rd)*np.cos(ra)]
    def polar(array):
        return map_coordinates(array, grid, order=1, mode="nearest")
    samples = polar(gray)
    clear = (polar(clearance) > 2.1) & (polar(rho) < -1.55)
    # Both exposure banks and textured paper have to occur on the same
    # unoccluded radii. Reject flat logos, holes and unrelated dark contours.
    valid = (clear[:, (depths >= -5) & (depths <= 9)].all(1)
             & (np.median(samples[:, (depths > -10) & (depths < -4)], axis=1) < 19)
             & (np.quantile(samples[:, (depths > 5) & (depths < 14)], .65, axis=1) > 137))
    if valid.sum() < 17:
        return prediction
    grain, confidence = angular_banks(samples, clear)
    xy = [(angle-angles[0])/(angles[1]-angles[0]), (depth-depths[0])/.55]
    def cart(array):
        return map_coordinates(array, xy, order=1, mode="nearest")
    confidence = cart(confidence)
    if np.mean(confidence[active & (abs(depth) < 5)]) < .28:
        return prediction
    original_texture = cart(grain)
    guidance = native_prior + .85*confidence*(original_texture-native_prior)
    corrected = match_boundary(gray, prediction, guidance, mask, active)
    blend = np.clip((31-abs(depth[active]))/9, 0, 1)*np.clip((-rho[active]-1)/2.4, 0, 1)
    result = prediction.copy()
    result[active] += blend*(corrected-result[active])
    return result
