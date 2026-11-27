"""Continue a pale printed wash across type using its exposed edge and native shade profile."""
import numpy as np
from scipy.ndimage import distance_transform_edt, find_objects, gaussian_filter, label


def falling_edge(tone):
    return np.roll(tone, 1, axis=0) - np.roll(tone, -1, axis=0)


def exposed_highlights(tone, distance, clearance):
    drop = falling_edge(tone)
    near = np.roll(tone, -3, axis=0)
    candidates = ((np.roll(tone, 4, axis=0) > 251) & (near > 211) & (near < 246)
                  & (np.roll(tone, -12, axis=0) > near + .8) & (drop > 3.6)
                  & (distance > 3) & (clearance > 8))
    candidates[:12] = candidates[-14:] = False
    components, _ = label(candidates, np.ones((3, 3)))
    for index, box in enumerate(find_objects(components), 1):
        if box is None:
            continue
        y, x = np.where(components[box] == index)
        y, x = y + box[0].start, x + box[1].start
        span = np.ptp(x)
        if not 28 <= span <= 310 or np.ptp(y) > span * .55 + 3:
            continue
        columns = np.unique(x)
        edge = np.array([np.average(y[x == c], weights=drop[y[x == c], c]) for c in columns])
        fit = np.polyfit(columns, edge, 1)
        if (np.max(abs(edge - np.polyval(fit, columns))) < 2.2
                and distance[np.rint(edge).astype(int), columns].min() <= 13):
            yield columns, fit


def decoded_ridge(prediction, distance, bank, fit):
    height, width = prediction.shape
    columns = np.arange(width)
    expected = np.rint(np.polyval(fit, columns)).astype(int).clip(10, height - 10)
    search = (expected + np.arange(-6, 7)[:, None]).clip(7, height - 12)
    drop = falling_edge(prediction)[search, columns]
    ridge = search[drop.argmax(0), columns]
    lower = prediction[ridge + 4, columns]
    span = np.ptp(bank)
    linked = ((drop.max(0) > 2.7) & (prediction[ridge - 4, columns] > 243)
              & (lower > 191) & (lower < 247) & (columns >= bank[0] - 1.7 * span)
              & (columns <= bank[-1] + 1.7 * span))
    groups = label(linked)[0]
    group = np.bincount(groups[bank]).argmax()
    if not group:
        return
    covered = np.where(groups == group)[0]
    if np.count_nonzero(distance[ridge[covered], covered] <= 3) >= 15:
        return ridge, covered


def shade_profiles(original, clearance, ridge, columns, offsets):
    """Estimate every depth using original pixels clear of the printed strokes."""
    width = original.shape[1]
    positions = np.arange(width)
    allowed = np.zeros(width, bool)
    allowed[columns] = True
    profiles = np.full((len(offsets), width), np.nan)
    for j, offset in enumerate(offsets):
        row = (ridge + offset).clip(0, original.shape[0] - 1)
        values = original[row, positions]
        donors = allowed & (clearance[row, positions] > 4.6) & (values >= 202)
        if 2 <= offset < 38:
            donors &= values < 251
        if offset <= -3:
            donors &= values >= 247
        selected = np.where(donors)[0]
        if not len(selected):
            continue
        selected = selected[np.argsort(values[selected])]
        separation = abs(columns[:, None] - selected)
        weights = np.exp(-.5 * (separation / 24) ** 2)
        sparse = weights.sum(1) < 2
        weights[sparse] = np.exp(-.5 * (separation[sparse] / 52) ** 2)
        mass = weights.cumsum(1)
        enough = mass[:, -1] >= .01
        middle = (mass >= .5 * mass[:, -1, None]).argmax(1)
        profiles[j, columns[enough]] = values[selected[middle[enough]]]
    return profiles


def apply_shade(original, before, smooth, distance, clearance, bank, fit, ridge, columns, opaque):
    height, width = original.shape
    offsets = np.arange(-8, 70)
    profiles = shade_profiles(original, clearance, ridge, columns, offsets)
    extension = min(53, int(np.ptp(bank) * .8))
    for end, sign in [(columns[0], -1), (columns[-1], 1)]:
        extra = np.arange(end + sign, end + sign * (extension + 1), sign)
        extra = extra[(extra >= 0) & (extra < width)]
        ridge[extra] = np.rint(ridge[end] + fit[0] * (extra - end)).astype(int).clip(4, height - 5)
    delta = np.zeros_like(before)
    weight = np.zeros_like(delta)
    for x in range(max(0, columns[0] - extension), min(width, columns[-1] + extension + 1)):
        anchor = np.clip(x, columns[0], columns[-1])
        profile = profiles[:, anchor]
        if not np.isfinite(profile).all():
            continue
        row = (ridge[x] + offsets).clip(0, height - 1)
        current = before[row, x]
        blend = (np.clip((current - 186) / 22, 0, 1) * np.clip((offsets + 9) / 5, 0, 1)
                 * np.clip((70 - offsets) / 12, 0, 1) * np.clip((6.25 - distance[row, x]) / 3, 0, 1))
        if x != anchor:
            # A pale wash can end on a curved nib. Follow each depth only
            # until the first contour along its own path.
            sign = np.sign(x - anchor)
            path = np.arange(anchor, x + sign, sign)
            rows = (ridge[path] + offsets[:, None]).clip(0, height - 1)
            trace = smooth[rows, path]
            edge = np.maximum(abs(np.diff(trace, axis=1)).max(1) / 8.5, (211 - trace.min(1)) / 24)
            blend *= np.clip((1.24 - edge) / .42, 0, 1) * np.clip((extension - abs(x - anchor)) / 12, 0, 1)
        delta[row, x] = gaussian_filter(profile, .8) - current
        weight[row, x] = blend * opaque[row, x]
    supported = weight > .7
    if supported.sum() >= 60 and np.quantile(abs(delta[supported]), .68) >= 4:
        return delta * weight


def restore_fading_highlight(source, mask, output, opaque=None):
    y, x = np.where(mask)
    if len(x) < 450 or np.ptp(y) < 70 or np.ptp(x) < 30:
        return False
    box = np.s_[max(0, y.min()-125):y.max()+126, max(0, x.min()-125):x.max()+126]
    ink = mask[box]
    rgb, edited = source[box][:, :, :3], output[box][:, :, :3]
    if ink.size > 650_000 or np.mean(np.ptp(rgb, axis=2) > 5) > .01:
        return False
    actual = rgb.mean(2)
    if (np.count_nonzero(ink & (actual < 120)) < 150
            or np.count_nonzero(ink & (actual > 240)) < 250):
        return False
    current = edited.mean(2)
    smooth = gaussian_filter(current, 1.)
    distance = distance_transform_edt(~ink)
    clearance = distance_transform_edt(actual > 174)
    allowed = np.ones_like(ink) if opaque is None else opaque[box]
    correction = np.zeros_like(current)
    witnesses = np.zeros(ink.shape, dtype=np.uint16)
    for bank, fit in exposed_highlights(gaussian_filter(actual, 1.), distance, clearance):
        path = decoded_ridge(smooth, distance, bank, fit)
        if path is None:
            continue
        offset = apply_shade(actual, current, smooth, distance, clearance, bank, fit, *path, allowed)
        if offset is not None:
            changed = abs(offset) >= .5
            correction[changed] += offset[changed]
            witnesses[changed] += 1
    changed = witnesses > 0
    if not changed.any():
        return False
    # The same edge can be witnessed on both sides of the lettering.
    correction[changed] /= witnesses[changed]
    edited[changed] = np.rint(edited[changed] + correction[changed, None]).clip(0, 255).astype(np.uint8)
    return True
