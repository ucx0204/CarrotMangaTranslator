"""Join an interrupted white action line using its two printed banks."""
import numpy as np
from scipy.interpolate import CubicHermiteSpline
from scipy.ndimage import distance_transform_edt, map_coordinates


def exposed_strips(tone, clearance):
    tracks, active = [], []
    for y, row in enumerate(tone):
        edges = np.flatnonzero(np.diff(np.r_[False, row >= 242, False]))
        left, right = edges[::2], edges[1::2]-1
        use = (right-left >= 3) & (right-left <= 35) & (left >= 4) & (right < len(row)-4)
        active = [track for track in active if track[-1][0] >= y-3]
        taken = set()
        for lo, hi in zip(left[use], right[use]):
            if min(clearance[y, lo-2], clearance[y, hi+2], clearance[y, (lo+hi)//2]) < 2.7:
                continue
            if min(row[lo-3:lo]) > 127 or min(row[hi+1:hi+4]) > 127:
                continue
            matches = []
            for i, track in enumerate(active):
                last, a, b = track[-1]
                delta = max(abs(a-lo), abs(b-hi))
                if i not in taken and delta <= 1.4*(y-last)+1.4:
                    matches.append((delta, i))
            if matches:
                index = min(matches)[1]
            else:
                index = len(active)
                tracks.append([])
                active.append(tracks[-1])
            active[index].append((y, lo, hi))
            taken.add(index)
    return [np.asarray(t, dtype=float) for t in tracks if len(t) >= 13 and t[-1][0]-t[0][0] >= 14]


def edge_tangent(bank):
    y, x = bank[:, 0], bank[:, 1:]
    train = np.arange(len(y)) % 4 != 1
    slope, base = np.polyfit(y[train]-y.mean(), x[train], 1)
    error = abs(x[~train] - ((y[~train]-y.mean())[:, None]*slope+base))
    if np.max(abs(slope)) <= .95 and np.max(np.median(error, axis=0)) <= 1.25:
        return slope, base, y.mean()


def matching_edges(mask, output, first, second):
    a, b = first[-1, 0], second[0, 0]
    span = b-a
    if not 9 <= span <= 108 or np.max(abs(first[-1, 1:]-second[0, 1:])) > span+4:
        return
    left, right = edge_tangent(first[-20:]), edge_tangent(second[:20])
    if left is None or right is None:
        return
    v, p, cy = left
    w, q, dy = right
    start, end = p+(a-cy)*v, q+(b-dy)*w
    if (np.max(abs(v-w)) > .34 or np.max(abs((end-start)/span-(v+w)/2)) > .15
            or max(np.max(abs(start+span*v-end)), np.max(abs(end-span*w-start))) > max(4, .24*span)):
        return
    if abs(np.diff(start)[0]-np.diff(end)[0]) > max(4, .37*np.diff(start)[0]):
        return
    y = np.arange(int(a)-4, int(b)+5)
    edge = CubicHermiteSpline([a, b], [start, end], [v, w])(y)
    if np.any(edge[:, 1]-edge[:, 0] < 2) or np.any(edge[:, 1]-edge[:, 0] > 39):
        return
    center = np.rint(edge.mean(1)).astype(int)
    middle = (y > a) & (y < b)
    if np.any(center < 5) or np.any(center >= mask.shape[1]-5):
        return
    if mask[y[middle], center[middle]].mean() >= .46 and (output[y[middle], center[middle], 1] < 202).mean() >= .30:
        return y, edge


def print_profile(tone, bank, offsets):
    rows = np.broadcast_to(bank[:, 0], (len(offsets), len(bank)))
    return [np.median(map_coordinates(tone, [rows, bank[:, col]+offsets[:, None]], order=1), axis=1)
            for col in (1, 2)]


def join_strips(tone, allowed, output, first, second, match):
    y, edges = match
    offsets = np.arange(-3.5, 3.51, .125)
    profiles = np.array([print_profile(tone, bank, offsets) for bank in (first[-20:], second[:20])])
    for iy, (lo, hi) in zip(y, edges):
        x = np.arange(max(0, int(np.floor(lo-2))), min(tone.shape[1], int(np.ceil(hi+2))+1))
        frac = np.clip((iy-first[-1, 0])/(second[0, 0]-first[-1, 0]), 0, 1)
        left, right = (1-frac)*profiles[0]+frac*profiles[1]
        value = np.minimum(np.interp(x-lo, offsets, left), np.interp(x-hi, offsets, right))
        take = allowed[iy, x]
        output[iy, x[take], :3] = np.rint(value[take, None]).astype('u1')


def restore_white_rays(source, mask, output, allowed, opaque):
    if mask.sum() < 3200 or mask.size > 1500000 or np.mean(np.ptp(source[:, :, :3], 2) > 5) > .015:
        return False
    distance = distance_transform_edt(~mask)
    distance[~opaque] = 0
    gray = source[:, :, 1].astype(float)
    applied = False
    for transpose in (False, True):
        tone, stencil, dst, writable, clear = gray, mask, output, allowed, distance
        if transpose:
            tone, stencil, dst, writable, clear = gray.T, mask.T, output.swapaxes(0, 1), allowed.T, distance.T
        tracks = exposed_strips(tone, clear)
        pairs = {}
        for i, first in enumerate(tracks):
            for j, second in enumerate(tracks):
                match = matching_edges(stencil, dst, first, second)
                if match is not None:
                    pairs[i, j] = match
        for (i, j), match in pairs.items():
            if sum(a == i or b == j for a, b in pairs) == 1:
                join_strips(tone, writable, dst, tracks[i], tracks[j], match)
                applied = True
    return applied
