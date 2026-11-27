"""Measure a printed burst balloon from the unoccluded shafts around its blank center."""
import numpy as np
from scipy.ndimage import (binary_fill_holes, distance_transform_edt, find_objects, gaussian_filter,
                           gaussian_filter1d, label, map_coordinates, minimum_filter)
from scipy.signal import find_peaks


def owned_rims(gray, selected):
    parts, count = label(gray < 100, np.ones((3, 3)))
    sizes = np.bincount(parts.ravel(), minlength=count+1)
    owned = np.bincount(parts[selected], minlength=count+1)
    ids = []
    boxes = find_objects(parts)
    for index in np.flatnonzero((owned > .81*sizes) & (sizes >= 65)):
        if not index:
            continue
        cell = parts[boxes[index-1]] == index
        if (binary_fill_holes(cell) & ~cell).sum() > max(30, .45*sizes[index]):
            ids.append(index)
    if len(ids) >= 2 and sum(sizes[ids]) > 400:
        return parts, ids


def sample(values, y, x):
    return map_coordinates(values, [y, x], order=1, mode="nearest")


def exposed_shafts(gray, clearance, core, radius):
    smooth = gaussian_filter(gray, 1.1)
    gy, gx = np.gradient(smooth)
    xx, xy, yy = [gaussian_filter(v, 4.5) for v in (gx*gx, gx*gy, gy*gy)]
    theta = .5*np.arctan2(2*xy, xx-yy)+np.pi/2
    y, x = np.indices(gray.shape)
    power = xx+yy
    distance = np.hypot(x-core[0], y-core[1])
    eligible = ((clearance > 3) & (distance > .92*radius) & (distance < 2.8*radius)
                & (gray > 19) & (gray < 238) & (power > 12) & (x % 3 == 0) & (y % 3 == 0)
                & (np.hypot(xx-yy, 2*xy) > .89*np.maximum(1, power)))
    rows, cols = np.where(eligible)
    angles = theta[rows, cols]
    dx, dy = np.cos(angles), np.sin(angles)
    valid = np.ones(len(rows), bool)
    for t in (-4, 0, 4):
        sy, sx = rows+t*dy, cols+t*dx
        bank = np.minimum(sample(smooth, sy-2.8*dx, sx+2.8*dy), sample(smooth, sy+2.8*dx, sx-2.8*dy))
        valid &= (bank > 192) & (bank-sample(smooth, sy, sx) > 9)
    return np.column_stack((cols[valid], rows[valid])).astype(float), np.column_stack((dx[valid], dy[valid]))


def refine_shafts(gray, clearance, centers, axes):
    # Density centroids give a subpixel tangent. A single sampled edge cannot
    # fix a long narrow pen's direction accurately enough to join it further on.
    smooth = gaussian_filter(gray, .54)
    along = np.arange(-17., 18, 1.5)
    t, u = along[None, :, None], np.arange(-3., 3.01, .4)[None, None, :]
    for _ in range(3):
        dx, dy = axes[:, 0, None, None], axes[:, 1, None, None]
        x = centers[:, 0, None, None]+t*dx-u*dy
        y = centers[:, 1, None, None]+t*dy+u*dx
        light = sample(smooth, y, x)
        bank = np.minimum(light[:, :, 0], light[:, :, -1])
        density = np.maximum(0, bank[:, :, None]-light)
        mass = density.sum(2)
        offset = (u*density).sum(2)/np.maximum(.0001, mass)
        valid = ((sample(clearance, y, x).min(2) > 1.5) & (density.max(2) > 14)
                 & (bank > 185) & (abs(offset) < 1.7) & (mass > 35))
        count = valid.sum(1).clip(1)
        mean_t, mean_u = (valid*along).sum(1)/count, (valid*offset).sum(1)/count
        centered = along-mean_t[:, None]
        slope = (valid*centered*(offset-mean_u[:, None])).sum(1)/(valid*centered**2).sum(1).clip(1)
        bias = mean_u-slope*mean_t
        residual = abs(offset-bias[:, None]-slope[:, None]*along)
        span = np.ptp(np.where(valid, along, 0), axis=1)
        trusted = (count >= 10) & (span >= 19) & ((valid*residual).sum(1)/count < .45) & (abs(slope) < .18)
        normal = np.column_stack((-axes[:, 1], axes[:, 0]))
        centers += bias[:, None]*normal
        axes += slope[:, None]*normal
        axes /= np.linalg.norm(axes, axis=1)[:, None]
    return centers[trusted], axes[trusted]


def elliptical_focus(points, axes, core, radius):
    if len(points) < 65:
        return
    axes *= np.sign(np.sum((points-core)*axes, axis=1))[:, None]
    normals = np.column_stack((-axes[:, 1], axes[:, 0]))
    angles = np.arctan2(axes[:, 1], axes[:, 0])
    design = np.column_stack((normals, np.sin(2*angles), np.sin(4*angles)))
    response = np.sum(normals*points, axis=1)
    choices = np.random.default_rng(305).integers(len(points), size=(3500, 4))
    choices = choices[abs(np.linalg.det(design[choices])) > .075]
    if not len(choices):
        return
    guesses = np.linalg.solve(design[choices], response[choices][..., None])[:, :, 0]
    guesses = guesses[(np.linalg.norm(guesses[:, :2]-core, axis=1) < radius)
                      & (abs(guesses[:, 2]) < radius) & (abs(guesses[:, 3]) < .20*radius)]
    if not len(guesses):
        return
    counts = [np.sum(abs(design @ chunk.T-response[:, None]) < 2, axis=0) for chunk in np.array_split(
        guesses, max(1, len(guesses)//96))]
    selected = abs(design @ guesses[np.argmax(np.concatenate(counts))]-response) < 2
    for tolerance in (3, 2.2, 1.8, 1.7):
        if selected.sum() < max(47, .38*len(points)):
            return
        fit = np.linalg.lstsq(design[selected], response[selected], rcond=None)[0]
        selected = abs(design @ fit-response) < tolerance
    if len(np.unique(np.floor(angles[selected]/.23))) >= 7:
        return fit


def positions(angle, radius, focus):
    cx, cy, oval, correction = focus
    offset = oval*np.sin(2*angle)+correction*np.sin(4*angle)
    return cy+np.sin(angle)*radius+np.cos(angle)*offset, cx+np.cos(angle)*radius-np.sin(angle)*offset


def radial_coordinates(shape, focus, bearing):
    y, x = np.indices(shape)
    cx, cy, oval, correction = focus
    x, y = x-cx, y-cy
    angle = np.arctan2(y, x)
    for _ in range(6):
        normal = np.cos(angle)*y-np.sin(angle)*x-oval*np.sin(2*angle)-correction*np.sin(4*angle)
        slope = -np.sin(angle)*y-np.cos(angle)*x-2*oval*np.cos(2*angle)-4*correction*np.cos(4*angle)
        angle -= np.clip(np.divide(normal, slope, out=np.zeros_like(angle), where=abs(slope) > 18), -.2, .2)
    radius = x*np.cos(angle)+y*np.sin(angle)
    return bearing+(angle-bearing+np.pi) % (2*np.pi)-np.pi, radius


def angular_register(gray, clearance, focus, radius, bearing):
    angles = bearing+np.deg2rad(np.arange(-100, 100, .085))
    radii = np.arange(.66*radius, 2.47*radius, .7)
    a = angles[None, :]
    y, x = positions(a, radii[:, None], focus)
    smooth = gaussian_filter(gray, .64)
    valid = ((sample(clearance, y, x) > 3) & (x >= 1) & (y >= 1)
             & (x < gray.shape[1]-1) & (y < len(gray)-1))
    def bank(offset):
        dy, dx = offset*np.cos(a), -offset*np.sin(a)
        return np.minimum(sample(smooth, y+dy, x+dx), sample(smooth, y-dy, x-dx))
    density = np.maximum(0, np.minimum(bank(2.), bank(3.1))-sample(smooth, y, x)-4)*valid
    strength = np.maximum(0, gaussian_filter1d(density, 4, axis=0)-7).sum(0)/np.maximum(20, valid.sum(0))**.67
    peaks = angles[find_peaks(strength, height=5, distance=7, prominence=3)[0]]
    if len(peaks) < 37:
        return
    gaps = np.diff(peaks)
    pitch = np.deg2rad(1.9)
    added = []
    for index, gap in enumerate(gaps):
        local = gaps[max(0, index-5):index+6]
        local = local[(local > .56*pitch) & (local < 1.75*pitch)]
        if len(local) < 3:
            continue
        cadence = np.median(local)
        intervals = round(gap/cadence)
        if not 2 <= intervals <= 17 or gap < 1.55*cadence:
            continue
        missing = np.linspace(peaks[index], peaks[index+1], intervals+1)[1:-1]
        if intervals >= 8:
            # A long swath of outlined lettering may cover many consecutive
            # peaks. Short original fragments in its counters still fix their phase.
            positions_in_scan = np.searchsorted(angles, missing).clip(2, len(angles)-3)
            nearby_strength = np.max(strength[positions_in_scan[:, None]+np.arange(-2, 3)], axis=1)
            if (len(local) < 6 or np.quantile(abs(local-cadence), .8) > .13*cadence
                    or abs(gap/intervals-cadence) > .12*cadence
                    or (nearby_strength > .1).sum() < .28*len(missing)):
                continue
        added.extend(missing)
    return np.sort(np.r_[peaks, added])


def shaft_limits(gray, clearance, focus, radius, angles):
    smooth = gaussian_filter(gray, .57)
    radii = np.arange(.68*radius, 2.52*radius, .6)
    offsets = np.arange(-.5, .501, .025)
    rho, u = np.meshgrid(radii, offsets, indexing="ij")
    shoulder, core = abs(offsets) > .36, abs(offsets) < .26
    measured = np.full((len(angles), 4), np.nan)
    complete = np.zeros(len(angles), bool)
    for index, (angle, pitch) in enumerate(zip(angles, np.gradient(angles))):
        y, x = positions(angle+pitch*u, rho, focus)
        inside = (y >= 1) & (x >= 1) & (y < len(gray)-1) & (x < gray.shape[1]-1)
        valid = inside & (sample(clearance, y, x) > 1.3)
        level = sample(smooth, y, x)
        bank = np.quantile(level[:, shoulder], .68, axis=1)
        density = np.maximum(0, bank-np.quantile(level[:, core], .17, axis=1))
        good = (valid[:, shoulder].mean(1) > .66) & (valid[:, core].mean(1) > .8)
        strength = gaussian_filter1d(density*good, 2)/np.maximum(.01, gaussian_filter1d(good.astype(float), 2))
        hits = np.flatnonzero((strength > 19) & good)
        runs = [run for run in np.split(hits, np.flatnonzero(np.diff(hits) > 13)+1) if len(run) > 8]
        if not runs:
            continue
        run = max(runs, key=lambda segment: np.minimum(140, strength[segment]).sum())
        left, right = run[[0, -1]]
        if left < 1 or right >= len(radii)-1:
            continue
        clear_left = good[max(0, left-13):left+1].mean() > .82 and (strength[max(0, left-9):left] < 23).mean() > .44
        clear_right = good[right:right+15].mean() > .82 and (strength[right+1:right+11] < 25).mean() > .44
        measured[index] = radii[left], radii[right], clear_left and len(run) >= 16, clear_right and len(run) >= 16
        complete[index] = (clear_left and clear_right and len(run) > 34 and .35*radius < radii[right]-radii[left] < 1.05*radius
                           and valid[max(0, left-3):right+4].mean() > .94)
    if complete.sum() < 15:
        return
    basis = np.column_stack((np.ones(len(angles)), np.cos(2*angles), np.sin(2*angles)))
    limits = []
    donors = np.flatnonzero(complete)
    for end, tolerance in ((0, .094*radius), (1, .177*radius)):
        values = measured[:, end]
        use = complete.copy()
        for _ in range(4):
            if use.sum() < 9:
                return
            expected = basis @ np.linalg.lstsq(basis[use], values[use], rcond=None)[0]
            use = complete & (abs(values-expected) < tolerance)
        trusted = (measured[:, end+2] == 1) & (abs(values-expected) < tolerance)
        result = np.where(trusted, values, expected)
        for index in np.flatnonzero(~trusted):
            nearby = donors[np.argsort(abs(angles[donors]-angles[index]))[:9]]
            donor = nearby[(index*19+3) % len(nearby)]
            result[index] += np.clip(values[donor]-expected[donor], -.7*tolerance, .7*tolerance)
        limits.append(result)
    return tuple(limits)
