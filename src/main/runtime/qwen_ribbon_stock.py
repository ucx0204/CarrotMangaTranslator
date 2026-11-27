"""Recover the native finish of a grey fold bounded by two dark contours."""
import numpy as np
from scipy.ndimage import (
    distance_transform_edt, find_objects, gaussian_filter, gaussian_filter1d, label,
    map_coordinates, maximum_filter,
)


def contour_position(rows, direction, surface):
    columns = np.arange(len(rows))
    inside = surface[np.clip(rows-3*direction, 0, len(surface)-1), columns]
    outside = surface[np.clip(rows+4*direction, 0, len(surface)-1), columns]
    offsets = np.linspace(-2.5, 2.5, 21)
    yy = rows + offsets[:, None]
    xx = np.broadcast_to(columns, yy.shape)
    sampled = map_coordinates(surface, [yy, xx], order=1, mode="nearest")
    best = np.argmin(abs(sampled-(inside+outside)/2), axis=0)
    return np.where(inside-outside > 35, rows+offsets[best], rows), outside


def registered_ribbon(component, low, width):
    columns = np.flatnonzero(component.any(0))
    if len(columns) < max(100, .45*width):
        return
    x = np.arange(width)
    top = np.interp(x, columns, component.argmax(0)[columns]).round().astype(int)
    last = len(low)-component[::-1].argmax(0)-1
    bottom = np.interp(x, columns, last[columns]).round().astype(int)
    thickness = (bottom-top)[columns]
    if not 4 <= np.median(thickness) <= len(columns)/3:
        return
    top, above = contour_position(top, -1, low)
    bottom, below = contour_position(bottom, 1, low)
    if np.mean((above[columns] < 36) & (below[columns] < 36)) < .69:
        return
    # Follow the same relative height across the fold as its two edges curve.
    levels = np.linspace(-.12, 1.12, int(np.clip(1.8*np.median(thickness), 24, 120)))
    y = top + levels[:, None]*(bottom-top)
    scan = [y, np.broadcast_to(x, y.shape)]
    yy, xx = np.indices(low.shape)
    position = (yy-top)/np.maximum(1, bottom-top)
    grid = [(position-levels[0])/(levels[1]-levels[0]), xx]
    return scan, grid, levels


def ribbon_field(samples, known):
    """Interpolate between two contiguous banks, keeping their depths for line protection."""
    height, width = samples.shape
    field, left, right = np.zeros((3, height, width))
    span = np.full((height, width), np.inf)
    x = np.arange(width)
    for row in range(height):
        visible = known[row]
        bank = np.flatnonzero(visible & (gaussian_filter1d(visible.astype(float), 2.1) > .85))
        if len(bank) < 12:
            continue
        mass = gaussian_filter1d(visible.astype(float), 2.7)
        tone = gaussian_filter1d(np.where(visible, samples[row], 0.), 2.7)/np.maximum(.01, mass)
        before = bank[np.clip(np.searchsorted(bank, x, side="right")-1, 0, len(bank)-1)]
        after = bank[np.minimum(len(bank)-1, np.searchsorted(bank, x))]
        left[row], right[row] = tone[before], tone[after]
        field[row] = np.interp(x, bank, tone[bank])
        supported = (x >= bank[0]) & (x <= bank[-1])
        span[row, supported] = after[supported]-before[supported]
    return field, left, right, span


def confirmed_ribbon(samples, visible, core):
    # Withhold whole neighboring strips of original paint including their grain.
    # Matching a narrow contour through unrelated artwork would fail this test.
    x = np.arange(samples.shape[1])
    for offset in (0, 29):
        withheld = (x+offset) % 97 < 32
        estimate, a, b, span = ribbon_field(samples, visible & ~withheld)
        test = visible & withheld & core & (span < 105) & (abs(a-b) < 20)
        if test.sum() < 130:
            return False
        error = abs(estimate[test]-samples[test])
        if np.median(error) > 2.6 or np.quantile(error, .90) > 8.5:
            return False
    return True


def recover_ribbon(source, edited, output, visible, changed, component):
    parameters = registered_ribbon(component, gaussian_filter(edited, .95), component.shape[1])
    if parameters is None:
        return False
    scan, grid, levels = parameters
    samples = map_coordinates(source, scan, order=1, mode="nearest")
    known = map_coordinates(visible.astype(float), scan, order=0, mode="nearest") > .5
    interior = distance_transform_edt(component)
    bank = (interior > 2) & visible
    target = (interior > 2) & changed
    if bank.sum() < 240 or target.sum() < 90:
        return False
    # A narrow curved strip can be only a few pixels wide. Its black outlines
    # are structure and must not count as roughness of the grey paint.
    interior_bank = interior > 1.5
    mass = np.maximum(.001, gaussian_filter(interior_bank.astype(float), 1.4))
    power_mass = np.maximum(.001, gaussian_filter(interior_bank.astype(float), 2))
    def grain(image):
        mean = gaussian_filter(np.where(interior_bank, image, 0.), 1.4)/mass
        power = gaussian_filter(np.where(interior_bank, (image-mean)**2, 0.), 2)
        return np.sqrt(power/power_mass)
    natural, generated = np.median(grain(source)[bank]), np.median(grain(edited)[target])
    if natural > 4.7 or generated < max(5.4, natural*1.8+1.8):
        return False
    core = (levels[:, None] > .09) & (levels[:, None] < .91)
    core = core & (map_coordinates(interior, scan, order=1, mode="nearest") > 2.7)
    if not confirmed_ribbon(samples, known, core):
        return False
    field, left, right, span = ribbon_field(samples, known)
    def project(values):
        return map_coordinates(values, grid, order=1, mode="nearest")
    expected = project(field)
    reach = project(np.minimum(span, 4096))
    disagreement = project(abs(left-right))
    # Keep narrow pen strokes when either exposed bank shows ink at the same
    # depth and the decoded contour extends coherently along the fold.
    ridge = (maximum_filter(left, size=(13, 1))-left > 10) | (maximum_filter(right, size=(13, 1))-right > 10)
    corridor = project(gaussian_filter(ridge.astype(float), (2, 1))) > .08
    residual = edited-expected
    blurred = gaussian_filter(residual, 1.1)
    stroke = corridor & (blurred < -8) & (gaussian_filter(residual, (.65, 3.4)) < -6.5)
    expected += np.where(stroke, np.minimum(0, residual)*np.clip((-blurred-4)/8, 0, 1), 0)
    weight = np.clip((interior-.8)/2.7, 0, 1)*np.clip((110-reach)/12, 0, 1)
    weight *= np.clip((23-disagreement)/8, 0, 1)
    use = changed & component & (weight > 0)
    if not use.any():
        return False
    value = edited[use] + weight[use]*(expected[use]-edited[use])
    output[use] = np.rint(value[:, None]).clip(0, 255).astype(np.uint8)
    return True


def restore_ribbon_stock(source, mask, output, opaque):
    if not 2000 <= mask.sum() <= 150000 or mask.size > 1500000 or np.any(np.ptp(source, axis=2) > 4):
        return False
    original, edited = (v[:, :, 1].astype(float) for v in (source, output))
    changed = np.any(source != output, axis=2) & opaque
    if (changed & mask).sum() < 500:
        return False
    visible = (distance_transform_edt(~(changed | mask)) > 3.4) & opaque
    low = gaussian_filter(edited, 1.6)
    groups, _ = label((low > 65) & (low < 178), np.ones((3, 3)))
    sizes = np.bincount(groups.ravel())
    painted = np.bincount(groups[changed], minlength=len(sizes))
    applied = False
    for k, bounds in enumerate(find_objects(groups), 1):
        if bounds is None or sizes[k] < 1150 or painted[k] < 95:
            continue
        # Clip to a component before constructing its rectified sampling grid.
        box = tuple(slice(max(0, q.start-6), min(q.stop+6, n)) for q, n in zip(bounds, mask.shape))
        parts = (original[box], edited[box], output[box], visible[box], changed[box], groups[box] == k)
        if parts[0].shape[0] > parts[0].shape[1]:
            parts = tuple(v.swapaxes(0, 1) for v in parts)
        applied = recover_ribbon(*parts) or applied
    return applied
