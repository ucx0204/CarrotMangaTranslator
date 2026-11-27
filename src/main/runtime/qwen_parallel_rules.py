"""Recover the native phase of fine horizontal rules inside an illustrated outline."""
import numpy as np
from scipy.ndimage import (binary_fill_holes, distance_transform_edt, gaussian_filter,
                           label, minimum_filter, uniform_filter, uniform_filter1d)
from scipy.optimize import minimize_scalar


def exposed_rules(gray, clearance):
    horizontal = uniform_filter1d(gray, 11, axis=1)
    noise = np.sqrt(np.maximum(0, uniform_filter1d((gray-horizontal)**2, 11, axis=1)))
    mean = uniform_filter1d(horizontal, 17, axis=0)
    variance = np.maximum(0, uniform_filter1d(horizontal**2, 17, axis=0) - mean**2)
    return ((clearance > 6) & (uniform_filter1d(noise, 13, axis=0) < 4.1)
            & (variance > 8**2) & (variance < 35**2) & (mean > 212) & (mean < 244)
            & (minimum_filter(gray, (9, 7)) > 151))


def rule_profile(gray, donors):
    """Two independently sampled column sets must agree on pitch, phase and density."""
    height, width = gray.shape
    measured = np.full((height, 2), np.nan)
    for side in (0, 1):
        selected = donors & ((np.arange(width) // 12) % 2 == side)
        for row in np.where(selected.sum(1) >= 5)[0]:
            measured[row, side] = np.median(gray[row, selected[row]])
    rows = np.flatnonzero(np.isfinite(measured).all(1))
    if len(rows) < 19:
        return
    sample = measured[rows].mean(1)
    sample -= sample.mean()

    def energy(frequency):
        return abs(np.exp(-2j*np.pi*frequency*rows) @ sample)

    grid = np.linspace(.13, .487, 701)
    center = grid[np.argmax([energy(frequency) for frequency in grid])]
    rate = minimize_scalar(lambda f: -energy(f), bounds=(center-.001, center+.001), method="bounded").x
    phase = 2*np.pi*rate*np.arange(height)
    basis = np.column_stack([np.ones(height), np.cos(phase), np.sin(phase), np.cos(2*phase), np.sin(2*phase)])
    coefficients = np.linalg.lstsq(basis[rows], measured[rows], rcond=None)[0]
    predictions = basis @ coefficients
    error = np.sqrt(np.mean((predictions[rows]-measured[rows])**2, axis=0))
    if (error.max() > 6 or abs(predictions[:, 0]-predictions[:, 1]).mean() > 4
            or np.hypot(coefficients[1], coefficients[2]).min() < 10):
        return
    profile = predictions.mean(1)
    known = np.isfinite(measured).any(1)
    profile[known] = np.nanmedian(measured[known], axis=1)
    return profile


def bounded_surface(current, donors, anchors):
    smooth = gaussian_filter(current, 2)
    interior = (current > 149) & (smooth > 203) & (smooth < 248)
    interior |= binary_fill_holes(interior) & (current > 159) & (smooth > 207)
    parts, count = label(interior)
    votes = np.bincount(parts[donors], minlength=count+1)
    votes[0] = 0
    supported = votes[parts] > 100
    surface = np.zeros_like(supported)
    for x in np.flatnonzero(anchors.any(0)):
        bands, count = label(supported[:, x])
        samples = np.bincount(bands[anchors[:, x]], minlength=count+1)
        samples[0] = 0
        surface[:, x] = samples[bands] >= 7
    return surface


def restore_parallel_rules(source, mask, output, opaque=None):
    y, x = np.where(mask)
    if len(x) < 500 or np.ptp(y) < 65 or np.ptp(x) < 24:
        return False
    box = np.s_[max(0, y.min()-120):y.max()+121, max(0, x.min()-140):x.max()+141]
    ink = mask[box]
    rgb, result = source[box][:, :, :3], output[box][:, :, :3]
    if ink.size > 800_000 or np.mean(np.ptp(rgb, axis=2) > 5) > .01:
        return False
    gray = rgb.mean(2)
    distance = distance_transform_edt(~ink)
    donors = exposed_rules(gray, distance)
    if np.count_nonzero(donors) < 330:
        return False
    profile = rule_profile(gray, donors)
    if profile is None:
        return False
    current = result.mean(2)
    anchors = donors & (abs(gray-profile[:, None]) < 9)
    surface = bounded_surface(current, donors, anchors)
    error = profile[:, None]-current
    strength = np.sqrt(np.maximum(0, uniform_filter(error**2, (13, 7))))
    weight = (np.clip((6.5-distance)/3, 0, 1) * np.clip((distance_transform_edt(surface)-.45)/2, 0, 1)
              * np.clip((125-distance_transform_edt(~anchors))/22, 0, 1) * np.clip((strength-2.5)/5, 0, 1))
    if opaque is not None:
        weight *= opaque[box]
    if np.count_nonzero(weight > .4) < 60:
        return False
    change = error*weight
    write = abs(change) >= .5
    result[write] = np.rint(result[write] + change[write, None]).clip(0, 255).astype(np.uint8)
    return bool(write.any())
