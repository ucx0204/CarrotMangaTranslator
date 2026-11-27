"""Align a displaced screened silhouette using a piece of the exposed original pen."""
import numpy as np
from scipy.interpolate import CubicHermiteSpline
from scipy.ndimage import (distance_transform_edt, find_objects, gaussian_filter,
                           gaussian_filter1d, label, map_coordinates)

from qwen_screen_contours import fitted_screen


def sample(field, positions, order=1):
    return map_coordinates(field, positions.reshape(-1, 2).T[::-1], order=order,
                           mode="nearest").reshape(positions.shape[:-1])


def nearby_outline(field, center, tangent):
    soft = gaussian_filter(field, 1.45)
    dy, dx = np.gradient(soft)
    strength = np.hypot(dx, dy)
    normals = np.stack([dx, dy], -1) / np.maximum(.01, strength[:, :, None])
    y, x = np.indices(field.shape)
    dx, dy = center[0]-x, center[1]-y
    reach = np.hypot(dx, dy)
    outward = dx*normals[:, :, 0]+dy*normals[:, :, 1]
    parallel = normals[:, :, 0]*tangent[1]-normals[:, :, 1]*tangent[0]
    candidates = ((reach > 3) & (reach < 15) & (gaussian_filter(field, .52) < 124)
                  & (strength > 8) & (outward > .8*reach) & (abs(parallel) > .77))
    for row, col in np.argwhere(candidates):
        normal = normals[row, col]
        along = np.arange(-5, 6)[:, None]*np.array([-normal[1], normal[0]])
        origin = np.array([col, row])+along
        def bank(offsets):
            return sample(field, origin+np.array(offsets)[:, None, None]*normal)
        stock = bank([-3, -5, -7, -9])
        if ((bank([3, 4.5, 6, 8]) > 239).mean() >= .85 and (stock < 220).mean() >= .42
                and stock.std() >= 13 and (bank([-.65, 0, .65]).min(0) < 155).mean() >= .73):
            return normal


def exposed_bank_profiles(gray, field, clear, center, tangent, normal, steps):
    across = np.arange(-23, 23.01, .25)
    points = center+steps[:, None, None]*tangent+across[None, :, None]*normal
    original, edit, exposed = (sample(im, points) for im in (gray, field, clear.astype(float)))
    old = np.full(len(steps), np.nan)
    native = old.copy()
    for j, profile in enumerate(edit):
        for i in range(len(across)-25, 14, -1):
            if profile[i] > 180 or np.median(profile[i+10:i+25]) < 239 or profile[i-12:i+2].min() > 116:
                continue
            band = slice(i-7, i+1)
            old[j] = np.average(across[band], weights=np.maximum(0, 185-profile[band]))
            ink = (abs(across-old[j]) < 1.8) & (original[j] < 155) & (exposed[j] > .85)
            paper = (across > old[j]+2.2) & (across < old[j]+6) & (exposed[j] > .9)
            if ink.any() and paper.sum() >= 5 and np.median(original[j, paper]) > 238:
                native[j] = np.average(across[ink], weights=184-original[j, ink])
            break
    return old, native


def match_both_ends(steps, old, native):
    valid = np.isfinite(native) & (abs(native-old) < 1.2)
    neighbours = np.convolve(valid.astype(int), np.ones(5), "same") >= 4
    left = np.flatnonzero(valid & neighbours & (steps < -5))
    right = np.flatnonzero(valid & neighbours & (steps > 5))
    if not len(left) or not len(right):
        return
    ends = [left[-1], right[0]]
    slopes, intercepts = [], []
    for index, sign in zip(ends, (-1, 1)):
        delta = steps-steps[index]
        train = valid & (delta*sign >= 0) & (delta*sign < 10)
        if train.sum() < 3:
            return
        slope, intercept = np.polyfit(delta[train], native[train], 1)
        slopes.append(slope)
        intercepts.append(intercept)
    usable = np.isfinite(old)
    current = gaussian_filter1d(np.interp(steps, steps[usable], old[usable]), .85)
    if not -14 <= np.interp(0, steps, current) <= -3:
        return
    interval = slice(ends[0], ends[1]+1)
    lower, upper = steps[ends]
    target = current.copy()
    target[interval] = CubicHermiteSpline([lower, 0, upper], [intercepts[0], 0, intercepts[1]],
                                          [slopes[0], 0, slopes[1]])(steps[interval])
    return current, target, lower, upper


def align_fragment(gray, mask, output, center, tangent, frequencies):
    field = output.mean(2)
    edge = nearby_outline(field, center, tangent)
    if edge is None:
        return False
    normal = np.array([-tangent[1], tangent[0]])
    if normal@edge < 0:
        normal *= -1
    steps = np.arange(-45, 46, dtype=float)
    old, native = exposed_bank_profiles(gray, field, ~mask, center, tangent, normal, steps)
    fit = match_both_ends(steps, old, native)
    if fit is None:
        return False
    old, target, lower, upper = fit
    y, x = np.indices(gray.shape)
    rx, ry = x-center[0], y-center[1]
    along = rx*tangent[0]+ry*tangent[1]
    lateral = rx*normal[0]+ry*normal[1]
    depth = lateral-np.interp(along, steps, target)
    shift = np.interp(along, steps, old-target)
    clearance = distance_transform_edt(~mask)
    soft = gaussian_filter(gray, 1.25)
    bank = ((depth < -3) & (depth > -25) & (along > lower-9) & (along < upper+8)
            & (clearance > 2) & (soft > 108) & (soft < 221))
    stock = fitted_screen(gray, bank, frequencies)
    if stock is None:
        return False
    warp = shift*np.exp(-.5*(depth/8.5)**2)
    use = (abs(warp) > .015) & mask
    if not use.any():
        return False
    positions = np.stack([x[use]+warp[use]*normal[0], y[use]+warp[use]*normal[1]], -1)
    old_depth = lateral-np.interp(along, steps, old)
    # Preserve interior drawing already on the correct side of both outlines.
    keep = (np.clip((-old_depth-2.4)/2.25, 0, 1)*np.clip((-depth-1)/2.2, 0, 1))[use]
    dots = (np.clip((-depth-1.1)/2.1, 0, 1)*np.clip((24+depth)/5, 0, 1)
            *np.clip((abs(shift)-.3)/2, 0, 1))[use]*(1-keep)
    for ch in output.transpose(2, 0, 1):
        moved = sample(ch.astype(float), positions, order=3).clip(0, 255)
        moved += (ch[use]-moved)*keep
        ch[use] = np.rint(moved+(stock[use]-moved)*dots).clip(0, 255).astype("u1")
    return True


def restore_screen_outline(source, mask, output, opaque, frequencies):
    if not mask.any() or mask.size > 1_500_000:
        return False
    gray = source.mean(2)
    field = output.mean(2)
    groups, _ = label((gray < 121) & opaque, np.ones((3, 3)))
    clearance = distance_transform_edt(~mask)
    changed = False
    for index, box in enumerate(find_objects(groups), 1):
        if max(part.stop-part.start for part in box) > 11:
            continue
        y, x = np.where(groups[box] == index)
        if not 4 <= len(x) <= 31:
            continue
        y += box[0].start
        x += box[1].start
        if (not .17 < mask[y, x].mean() < .87 or clearance[y, x].max() > 3.8
                or field[y, x].min() < 237 or gray[y, x].min() > 66):
            continue
        center = np.array([x.mean(), y.mean()])
        cx, cy = np.rint(center).astype(int)
        if min(cx, cy, gray.shape[1]-cx, len(gray)-cy) < 24:
            continue
        values, vectors = np.linalg.eigh(np.cov([x, y]))
        if values[1] < 1.35*max(.3, values[0]):
            continue
        tangent = vectors[:, -1]
        probes = np.arange(3, 12)[:, None]*tangent
        votes = [mask[tuple(np.rint(center+sign*probes).astype(int).T[::-1])].mean() for sign in (-1, 1)]
        if min(votes) < .21 or max(votes) < .65:
            continue
        top, left = max(0, int(center[1])-55), max(0, int(center[0])-55)
        area = np.s_[top:int(center[1])+56, left:int(center[0])+56]
        if not opaque[area].all() or (np.ptp(source[area], axis=2) > 12).mean() > .01:
            continue
        changed |= align_fragment(gray[area], mask[area], output[area], center-[left, top],
                                  tangent, frequencies)
    return changed
