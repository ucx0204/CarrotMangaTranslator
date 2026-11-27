"""Reconnect screened paper, ruled borders and individual pens under hollow display type."""
import numpy as np
from scipy.ndimage import (distance_transform_edt, gaussian_filter, maximum_filter1d, minimum_filter,
                           minimum_filter1d, uniform_filter1d)
from scipy.optimize import least_squares
from scipy.signal import find_peaks
from scipy.special import erf, expit

from qwen_burst_balloon import (angular_register, elliptical_focus, exposed_shafts, owned_rims,
                                radial_coordinates, refine_shafts, shaft_limits)


def dark_border(gray, known, rim, core):
    y, x = np.indices(gray.shape)
    mid = np.where(rim)[0].mean()
    smooth = gaussian_filter(gray, (.92, .4))
    strength = np.minimum(np.roll(smooth, 4, 1), np.roll(smooth, -4, 1))-smooth
    active = known & (strength > 68) & (smooth < 140) & (x >= 9) & (x < gray.shape[1]-9)
    ys, xs = np.where(active & (abs(y-mid) < 1.35*np.ptp(np.where(rim)[0])))
    if len(ys) < 60:
        return
    options = []
    for slope in np.arange(-.18, .181, .008):
        intercepts = np.rint(xs-slope*(ys-mid)).astype(int)
        usable = (intercepts > 3) & (intercepts < gray.shape[1]-3)
        votes = np.bincount(intercepts[usable], minlength=gray.shape[1])
        for pos in find_peaks(votes, height=max(34, .15*np.ptp(ys)), distance=5)[0]:
            options.append((votes[pos], slope, pos))
    for _, slope, pos in sorted(options, reverse=True)[:20]:
        if abs(core[0]-pos) < .22*gray.shape[1]:
            continue
        for _ in range(4):
            good = abs(xs-(pos+slope*(ys-mid))) < 2.1
            if good.sum() < 34:
                break
            slope, pos = np.polyfit(ys[good]-mid, xs[good], 1, w=strength[ys[good], xs[good]])
        offset = x-pos-slope*(y-mid)
        blocked = np.where(rim & (abs(offset) < 9))[0]
        if not len(blocked):
            continue
        first, last = blocked.min(), blocked.max()
        tops = ys[good & (ys < first) & (ys > first-77)]
        ends = ys[good & (ys > last) & (ys < last+77)]
        if min(len(np.unique(tops)), len(np.unique(ends))) < 17:
            continue
        banks = known & (y >= tops.min()) & (y <= ends.max())
        direction = np.sign(pos-core[0])
        gutter = banks & (direction*offset > 4) & (direction*offset < 10)
        if gutter.sum() < 70 or np.mean(gray[gutter] >= 242) < .85:
            continue
        samples = banks & (abs(offset) < 4.5)
        bins = np.arange(-4, 4.01, .18)
        values = [gray[samples & (abs(offset-b) < .23)] for b in bins]
        if sum(len(v) >= 2 for v in values) < .8*len(bins):
            continue
        shades = np.array([np.median(v) if len(v) else np.nan for v in values])
        valid = np.isfinite(shades)
        profile = np.interp(offset, bins[valid], shades[valid])
        if np.min(shades[valid]) < 65:
            return direction*offset, profile


def dot_template(gray, known, study, frequencies):
    y, x = np.indices(gray.shape)
    average = lambda image, size: uniform_filter1d(image, size, axis=1)
    blurred = gaussian_filter(gray, 1.1)
    residual = gray-blurred
    level = average(gray, 13)
    power = np.maximum(0, average(residual**2, 13))
    contrast = maximum_filter1d(gray, 9, axis=1)-minimum_filter1d(gray, 9, axis=1)
    donors = (known & (level > 142) & (level < 239) & (power > 300) & (power < 5600)
              & (contrast > 59) & (abs(blurred-average(blurred, 19)) < 7))
    repeat = np.minimum.reduce([average(abs(gray-np.roll(gray, n, 1)), 9) for n in (3, 4, 5)])
    donors &= (repeat < 24) & (repeat < .66*np.sqrt(power))
    yy, xx = np.where(donors)
    if len(yy) < 950:
        return
    selection = np.random.default_rng(661).choice(len(yy), min(12000, len(yy)), replace=False)
    yy, xx = yy[selection], xx[selection]
    normalized = residual/np.maximum(4, np.sqrt(power))
    axes = frequencies(np.column_stack((xx, yy)), normalized[yy, xx], gray.shape)
    if axes is None or len(axes) < 2:
        return
    second = next((axis for axis in axes[1:] if abs(np.linalg.det([axes[0], axis])) > .044), None)
    if second is None:
        return
    first = axes[0]
    a, b = 2*np.pi*(first[0]*x+first[1]*y), 2*np.pi*(second[0]*x+second[1]*y)
    def harmonics(a, b):
        columns = [np.ones_like(a)]
        for i in range(3):
            for j in range(-2, 3):
                if i or j > 0:
                    columns.extend((np.sin(i*a+j*b), np.cos(i*a+j*b)))
        return np.stack(columns, axis=-1)
    basic = np.stack((np.ones_like(a), np.sin(a), np.cos(a), np.sin(b), np.cos(b)), axis=-1)
    coeff = np.linalg.lstsq(basic[yy, xx], normalized[yy, xx], rcond=None)[0]
    wave = basic @ coeff
    correlation = average(residual*wave, 13)/np.maximum(3, np.sqrt(np.maximum(0, power*average(wave**2, 13))))
    mean = average(gray, 21)
    deviation = np.sqrt(np.maximum(0, average((gray-mean)**2, 21)))
    usable = donors & study & (correlation > .74) & (deviation > 22) & (deviation < 71)
    yy, xx = np.where(usable)
    if len(yy) < 325:
        return
    hold = (xx//7+2*(yy//9)) % 7 == 2
    if hold.sum() < 40:
        return
    values = np.clip((gray[yy, xx]-mean[yy, xx])/deviation[yy, xx], -3.5, 3.5)
    design = harmonics(a[yy, xx], b[yy, xx])
    coeff = np.linalg.lstsq(design[~hold], values[~hold], rcond=None)[0]
    if np.corrcoef(design[hold] @ coeff, values[hold])[0, 1] < .82:
        return
    base, amplitude = np.median(mean[usable]), np.median(deviation[usable])
    template = np.empty_like(gray)
    for block in np.array_split(np.arange(len(gray)), max(1, len(gray)//48)):
        template[block] = np.clip(base+amplitude*(harmonics(a[block], b[block]) @ coeff), 0, 255)
    return template


def row_exposure(gray, template, valid):
    density = 255-template
    strengths = np.arange(0, 1.301, .05)
    rows = np.zeros(len(gray))
    for row in np.flatnonzero(valid.any(1)):
        sample = valid[row] & (density[row] > 30) & (density[row] < 200)
        if sample.sum() < 2:
            continue
        predicted = strengths[:, None]*density[row, sample]
        error = (255-gray[row, sample]-predicted)/(8+.14*predicted)
        agreement = np.exp(-.5*error**2).sum(1)
        if agreement[0] <= .9*agreement[10:].max():
            rows[row] = strengths[np.argmax(agreement)]
    return rows


def screened_oval(gray, template, known, near, gap, fraction, focus, radius):
    y, x = np.indices(gray.shape)
    clean = known & near & gap
    rows = row_exposure(gray, template, clean & (fraction > .82))
    opacity = rows[:, None]*(255-template)
    ink = abs(255-gray-opacity) < .31*opacity+6
    paper = 255-gray < .105*opacity+2
    use = clean & (rows[:, None] > .60) & (fraction > .1) & (fraction < 1.65) & (template < 205) & (ink | paper)
    target = ink[use].astype(float)
    if min(target.sum(), len(target)-target.sum()) < 100:
        return
    xr, yr = (x-focus[0])/(1.86*radius), (y-focus[1])/(1.86*radius)
    design = np.column_stack((np.ones_like(target), xr[use], yr[use], xr[use]**2, xr[use]*yr[use], yr[use]**2))
    hold = (x[use]//7+3*(y[use]//9)) % 11 == 3
    if hold.sum() < 60:
        return
    def residual(q):
        return np.r_[expit(design[~hold] @ q)-target[~hold], .038*q[[1, 2, 4]], .013*q[[3, 5]]]
    q = least_squares(residual, [-36, 0, 0, 37, 0, 24], loss="soft_l1", f_scale=.22, max_nfev=75).x
    if np.mean((design[hold] @ q > 0) == target[hold]) < .90 or min(q[3], q[5]) < 4:
        return
    coverage = expit(q[0]+q[1]*xr+q[2]*yr+q[3]*xr**2+q[4]*xr*yr+q[5]*yr**2)
    rows = row_exposure(gray, template, clean & (coverage > .88))
    return 255-rows[:, None]*coverage*(255-template)


def native_nibs(gray, stock, known, focus, angles, limits):
    # Fit the coverage of a solid pen convolved with the scan's pixel footprint.
    # Nearby complete shafts supply a width profile for a shaft occluded by type.
    y, x = np.indices(gray.shape)
    cx, cy, oval, correction = focus
    inner, outer = limits
    nodes = np.linspace(-.09, 1.09, 12)
    base = np.interp(nodes, [-.09, 0, .09, .3, .65, .91, 1, 1.09], [0, .12, .5, .70, .65, .44, .12, 0])
    initial = np.r_[0., 0., base]
    lower = np.r_[-1.9, -2.8, np.zeros(len(nodes))]
    upper = np.r_[1.9, 2.8, np.full(len(nodes), 2.7)]
    check = (y//7+2*(x//9)) % 9 == 1
    geometry, complete = [], []
    for i, angle in enumerate(angles):
        c, s = np.cos(angle), np.sin(angle)
        offset = -(x-cx)*s+(y-cy)*c-oval*np.sin(2*angle)-correction*np.sin(4*angle)
        along = ((x-cx)*c+(y-cy)*s-inner[i])/max(10, outer[i]-inner[i])
        yy, xx = np.where((along > -.10) & (along < 1.10) & (abs(offset) < 3.75))
        u, t = offset[yy, xx], along[yy, xx]
        observation = np.clip(1-gray[yy, xx]/np.maximum(24, stock[yy, xx]), -.25, 1)
        use = known[yy, xx] & ~check[yy, xx] & (stock[yy, xx] > 83)
        geometry.append((yy, xx, u, t, observation, use))
        complete.append(sum(np.sum(use & (t > k) & (t < k+.17) & (abs(u) < 1.55)) > 5 for k in np.arange(0, 1, .17)) >= 5)
    donors = np.flatnonzero(complete)
    if len(donors) < 12:
        return
    def shade(v, u, t):
        d = u-v[0]-v[1]*(t-.5)
        width = np.interp(t, nodes, v[2:])
        return .5*(erf((width+d)/.665)+erf((width-d)/.665))
    def fit(index, start, prior, weight):
        _, _, u, t, observed, use = geometry[index]
        u, t, observed = u[use], t[use], observed[use]
        def error(v):
            return np.r_[shade(v, u, t)-observed, (v[:2]-prior[:2])*[.65, 1.1],
                         (v[2:]-prior[2:])*weight, 1.3*np.diff(v[2:], 2), 2*v[[2, -1]]]
        return least_squares(error, start, bounds=(lower, upper), loss="soft_l1", f_scale=.14, max_nfev=37).x
    models = np.array([fit(i, initial, initial, .78) for i in range(len(angles))])
    ink = np.zeros_like(gray)
    for i, angle in enumerate(angles):
        nearby = donors[np.argsort(abs(angles[donors]-angle))[:8]]
        prior = np.median(models[nearby], axis=0)
        prior[:2] = np.median(models[nearby[:4], :2], axis=0)
        v = fit(i, models[i], prior, 1.35)
        yy, xx, u, t, _, _ = geometry[i]
        ink[yy, xx] = np.maximum(ink[yy, xx], shade(v, u, t))
    return ink, check


def restore_burst_stock(source, stencil, result, opaque, frequencies):
    if not 2000 <= stencil.sum() <= 40000 or stencil.size > 600000 or min(stencil.shape) < 140:
        return False
    gray = source[:, :, :3].mean(2)
    rims = owned_rims(gray, stencil)
    if rims is None or np.quantile(np.ptp(source[:, :, :3][stencil], axis=1), .95) > 4:
        return False
    parts, ids = rims
    all_rims = np.isin(parts, ids)
    distance = distance_transform_edt(~all_rims)
    known = (distance > 6) & opaque
    white = known & (gaussian_filter(gray, 3.2) > 248) & (minimum_filter(gray, 5) > 228)
    core_distance = distance_transform_edt(np.pad(white, 1))[1:-1, 1:-1]
    core_distance[distance > .60*min(gray.shape)] = 0
    cy, cx = np.unravel_index(np.argmax(core_distance), gray.shape)
    radius = core_distance[cy, cx]
    if not 48 <= radius <= .4*min(gray.shape):
        return False
    core = np.array([cx, cy])
    clearance = distance_transform_edt(known)
    centers, axes = exposed_shafts(gray, clearance, core, radius)
    if not 95 <= len(centers) <= 12000:
        return False
    points, axes = refine_shafts(gray, clearance, centers, axes)
    focus = elliptical_focus(points, axes, core, radius)
    if focus is None:
        return False
    y, x = np.indices(gray.shape)
    reach = np.hypot(x-focus[0], y-focus[1])
    nearby = [i for i in ids if np.median(reach[parts == i]) < 2.45*radius]
    if len(nearby) < 2:
        return False
    chosen = np.isin(parts, nearby)
    ys, xs = np.where(chosen)
    bearing = np.arctan2(ys.mean()-focus[1], xs.mean()-focus[0])
    angles = angular_register(gray, clearance, focus, radius, bearing)
    if angles is None:
        return False
    limits = shaft_limits(gray, clearance, focus, radius, angles)
    if limits is None:
        return False
    theta, rho = radial_coordinates(gray.shape, focus, bearing)
    first, last = (np.interp(theta, angles, limit) for limit in limits)
    fraction = (rho-first)/np.maximum(12, last-first)
    closest = np.clip(np.searchsorted(angles, theta), 1, len(angles)-1)
    unseen = (angles[closest]-angles[closest-1]) > 2.2*np.median(np.diff(angles))
    if np.sum(chosen & (fraction > 0) & (fraction < 1) & unseen) > 12:
        return False
    gap = (np.minimum(abs(angles[closest]-theta), abs(theta-angles[closest-1]))*np.maximum(radius, rho) > 1.55)
    gap |= (fraction < -.04) | (fraction > 1.07)
    sector = ((theta >= angles[0]) & (theta <= angles[-1]) & (rho < np.max(reach[chosen])+.4*radius))
    # Connected type may extend from an oval onto a neighboring panel. Identify
    # a border from independently visible lengths on both sides of that break.
    borders = []
    for transpose in (False, True):
        edge = (dark_border(gray.T, known.T, chosen.T, core[::-1]) if transpose
                else dark_border(gray, known, chosen, core))
        if edge is not None:
            offset, profile = (tuple(a.T for a in edge) if transpose else edge)
            sector &= offset < -2
            borders.append((offset, profile))
    study = sector & (distance > 6.2)
    template = dot_template(gray, distance > 9, study, frequencies)
    if template is None:
        return False
    stock = screened_oval(gray, template, distance > 5.3, sector, gap, fraction, focus, radius)
    if stock is None:
        return False
    fitted = native_nibs(gray, stock, known & sector, focus, angles, limits)
    if fitted is None:
        return False
    ink, check = fitted
    native = stock*(1-ink)
    hold = known & sector & check & (fraction > 0) & (fraction < 1) & (reach > .8*radius)
    if hold.sum() < 170 or np.mean(abs(native[hold]-gray[hold])) >= .63*np.mean(abs(stock[hold]-gray[hold])):
        return False
    for offset, profile in borders:
        margin = (offset > -4) & (offset <= 12)
        native[margin] = np.where(offset[margin] > 0, profile[margin], np.minimum(profile[margin], native[margin]))
    separation = distance_transform_edt(~chosen)
    paint = (separation < 15) & opaque
    blend = np.clip((8.6-separation[paint])/1.8, 0, 1)
    result[paint, :3] = np.rint(gray[paint]+blend*(native[paint]-gray[paint])).clip(0, 255).astype("u1")[:, None]
    return True
