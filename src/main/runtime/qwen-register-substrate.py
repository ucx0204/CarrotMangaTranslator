"""Continue a verified circular ink boundary and its native dark background across print."""
import sys
from pathlib import Path
from runpy import run_path

import numpy as np
from PIL import Image
from scipy.ndimage import (
    distance_transform_edt, find_objects, gaussian_filter, gaussian_filter1d,
    label, map_coordinates, maximum_filter,
)
from scipy.optimize import least_squares
from scipy.signal import fftconvolve


def sample(image, x, y):
    return map_coordinates(image, [y, x], order=1, mode="nearest")


def seeds(gray, mask):
    height, width = gray.shape
    printed_width = np.ptp(np.nonzero(mask)[1]) + 1
    smooth = gaussian_filter(gray, 1.15)
    ny, nx = np.gradient(smooth)
    strength = np.hypot(nx, ny)
    nx /= np.maximum(.01, strength)
    ny /= np.maximum(.01, strength)
    y, x = np.indices(gray.shape)
    edge = ((strength > 5) & (strength >= sample(strength, x+nx, y+ny))
            & (strength >= sample(strength, x-nx, y-ny)) & (distance_transform_edt(~mask) > 3.9))
    sy, sx = np.where(edge)
    dx, dy = nx[edge], ny[edge]
    sides = []
    for sign in (-1, 1):
        exterior = np.stack([sample(smooth, sx+k*sign*dx, sy+k*sign*dy) for k in (2.5, 4.5, 7.5)], 1)
        opposite = sample(smooth, sx-4*sign*dx, sy-4*sign*dy)
        tone = np.median(exterior, axis=1)
        use = (np.ptp(exterior, axis=1) < 16) & (tone > 9) & (tone < 110) & (abs(tone-opposite) > 19)
        sides.append((sx[use], sy[use], -sign*dx[use], -sign*dy[use], np.clip(strength[edge][use]/18, .6, 2)))
    radii = np.arange(max(18, round(.12*printed_width)), round(.4*printed_width)+1, 3)
    rows, cols = (height+2)//3, (width+2)//3
    votes = np.zeros((len(radii), rows, cols), dtype=np.float32)
    for index, radius in enumerate(radii):
        for x, y, dx, dy, weight in sides:
            cx, cy = np.rint((x+radius*dx)/3).astype(int), np.rint((y+radius*dy)/3).astype(int)
            valid = (cx >= 0) & (cy >= 0) & (cx < cols) & (cy < rows)
            votes[index] += np.bincount(cy[valid]*cols + cx[valid], weights=weight[valid],
                                        minlength=rows*cols).reshape(rows, cols)
    votes = gaussian_filter(votes, (.77, .81, .81))
    k, y, x = np.where((votes == maximum_filter(votes, size=(5, 5, 5))) & (votes > 1.18))
    for index in np.argsort(-votes[k, y, x])[:36]:
        yield np.array([3*x[index], 3*y[index], radii[k[index]]], dtype=float)


def fit_circle(points, keep, initial, scale):
    def residual(params):
        return np.linalg.norm(points[keep]-params[:2], axis=1)-params[2]
    return least_squares(residual, initial, loss="soft_l1", f_scale=scale).x


def corroborated(points, good, circle):
    # An ellipse can agree with one circular arc to a fraction of a pixel.
    # Two independently fitted arc halves must recover the same centre.
    angles = np.flatnonzero(good)
    gaps = np.diff(np.r_[angles, angles[0]+360])
    span = 360-gaps.max()
    if span < 170 or len(angles) < 73:
        return False
    start = angles[(np.argmax(gaps)+1) % len(angles)]
    angle = (np.arange(360)-start) % 360
    centers = []
    for half in (good & (angle < .53*span), good & (angle > .47*span)):
        other = good & ~half
        if min(half.sum(), other.sum()) < 16:
            return False
        side = fit_circle(points, half, circle, .32)
        error = np.abs(np.linalg.norm(points[other]-side[:2], axis=1)-side[2])
        if np.median(error) > 2.15:
            return False
        centers.append(side[:2])
    return np.linalg.norm(centers[0]-centers[1]) <= min(2.5, .025*circle[2]+.55)


def observe(gray, clearance, mask, trial, unit, shifts):
    height, width = mask.shape
    coords = trial[:2] + (trial[2]+shifts[:, None, None])*unit
    x, y = coords[..., 0], coords[..., 1]
    known = ((sample(clearance, x, y).min(0) > 3.5) & (x.min(0) > 1) & (x.max(0) < width-2)
             & (y.min(0) > 1) & (y.max(0) < height-2))
    crossing = trial[:2] + trial[2]*unit
    if (sample(mask, crossing[:, 0], crossing[:, 1]) > .5).sum() < 9:
        return
    rows = sample(gray, x, y).T
    exterior = np.median(rows[:, -8:], axis=1)
    contrast = np.abs(exterior-np.median(rows[:, :8], axis=1))
    good = known & (exterior >= 9) & (exterior <= 110) & (np.ptp(rows[:, -8:], axis=1) < 15) & (contrast > 17)
    if good.sum() < 42:
        return
    background = np.median(exterior[good])
    good &= np.abs(exterior-background) < 26
    gradient = np.abs(np.gradient(gaussian_filter1d(rows, 1.3, axis=1), shifts, axis=1))
    gradient[:, abs(shifts) > 6.4] = 0
    peak = np.argmax(gradient, axis=1)
    points = trial[:2] + (trial[2]+shifts[peak, None])*unit
    candidate = fit_circle(points, good, trial, .52)
    errors = np.abs(np.linalg.norm(points-candidate[:2], axis=1)-candidate[2])
    good &= (errors <= 1.3) & (gradient[np.arange(360), peak] > 6.6)
    sectors = len(np.unique(np.flatnonzero(good)//16))
    train = good & ((np.arange(360)//3) % 5 != 2)
    hold = good & ~train
    if good.sum() < 73 or sectors < 6 or hold.sum() < 8:
        return
    circle = fit_circle(points, train, candidate, .36)
    errors = np.abs(np.linalg.norm(points[hold]-circle[:2], axis=1)-circle[2])
    if np.median(errors) > .6 or np.percentile(errors, 87) > .99 or not corroborated(points, good, circle):
        return
    return good.sum()+4*sectors-8*np.median(errors), circle, background


def background_field(gray, known, x, y):
    basis = np.stack((np.ones_like(x), x, y, x*y, x*x, y*y), axis=-1)
    row, col = np.indices(gray.shape)
    train = known & ((col//6 + row//7) % 7 != 3)
    hold = known & ~train
    if hold.sum() < 160 or train.sum() < 650:
        return
    model = np.linalg.lstsq(basis[train], gray[train], rcond=None)[0]
    errors = np.abs(gray-basis@model)
    clean = train & (errors <= np.quantile(errors[train], .86))
    model = np.linalg.lstsq(basis[clean], gray[clean], rcond=None)[0]
    field = basis@model
    if np.mean(np.abs(gray[hold]-field[hold])) > 6.5:
        return
    return field


def cross_arms(image, cx, cy, dx, dy):
    along, across = np.meshgrid(np.arange(-6, 7), np.r_[np.arange(-15, -2), np.arange(3, 16)], indexing="ij")
    length = np.hypot(dx, dy)
    nx, ny = dx/length, dy/length
    x, y = cx+along*nx-across*ny, cy+along*ny+across*nx
    values = sample(image, x, y)
    return values - np.median(values[[0,1,2,-3,-2,-1]], axis=0), x, y


def copied_ray(gray, prior, mask, field, exterior, cx, cy, dx, dy, half):
    # A partially copied star can lose its transverse arms before it loses its
    # long ray. An isolated bright strip does not reproduce those arms twice.
    template, _, _ = cross_arms(gray, cx, cy, dx, dy)
    bright = template > 12
    power = np.sum(template**2)
    if bright.sum() < 22 or power < 4000:
        return
    stencil = mask.astype(np.float32)
    step = np.hypot(dx, dy)
    nx, ny = dx/step, dy/step
    # The resized prior rounds the displacement twice. Inspect a small
    # neighbourhood of its predicted second peak while keeping the first fixed.
    for k, min_corr, min_gain in ((1, .73, .27), (2, .21, .027)):
        jitter = [(0, 0)] if k == 1 else [(a, b) for a in (-2.7, -1.3, 0, 1.3, 2.7) for b in (-1, 0, 1)]
        matches = 0
        two_arms = False
        for along, across in jitter:
            px, py = cx+k*dx+along*nx-across*ny, cy+k*dy+along*ny+across*nx
            obs, x, y = cross_arms(prior, px, py, dx, dy)
            dot = np.sum(template*obs)
            if (dot / np.sqrt(max(1, power*np.sum(obs**2))) > min_corr and dot/power > min_gain
                    and sample(stencil, x, y)[bright].mean() > .72):
                matches += 1
                half_width = template.shape[1]//2
                gains = [np.sum(template[:, side]*obs[:, side])/max(1, np.sum(template[:, side]**2))
                         for side in (slice(None, half_width), slice(half_width, None))]
                two_arms |= min(gains) > .32*max(gains)
        if matches < k or not two_arms:
            return
    t = np.arange(min(round(5.7*step), int(np.hypot(*gray.shape))))
    u = np.arange(-half-4, half+5)
    x, y = (cx+t*nx)[:,None]-ny*u, (cy+t*ny)[:,None]+nx*u
    surplus = sample(prior-field, x, y)
    side = (abs(u) > max(6, half*.5)) & (abs(u) <= half+2)
    stripe = abs(u) <= 3.4
    left = np.median(abs(surplus[:, side & (u<0)]), axis=1)
    right = np.median(abs(surplus[:, side & (u>0)]), axis=1)
    banks = (np.minimum(left, right) < 18) & (np.maximum(left, right) < 42)
    visible = ((np.max(surplus[:,stripe], axis=1) > 24) & banks
               & (sample(stencil, x, y)[:,stripe].mean(axis=1) > .63)
               & (sample(exterior.astype(np.float32), x, y)[:,stripe].mean(axis=1) > .84))
    follow = np.convolve(visible.astype(int), np.ones(5), mode="same") >= 3
    stop, missed = round(2*step), 0
    for index in range(stop, len(t)):
        missed = 0 if follow[index] else missed+1
        if missed >= 4:
            break
        if follow[index]:
            stop = index+1
    yy, xx = np.indices(mask.shape)
    along = (xx-cx)*nx + (yy-cy)*ny
    across = abs((yy-cy)*nx - (xx-cx)*ny)
    preserve = (along < 1.2*step) & (across < 3.5) & (gray > field+16) & (gray < 252)
    return (mask & exterior & ~preserve & (along >= .97*step) & (along <= stop+1)
            & (across <= max(8, min(15, half*.93))))


def duplicate_peaks(gray, prior, mask, field, exterior):
    known = (~mask) & exterior
    marks, _ = label((gray-field > 88) & known, structure=np.ones((3, 3)))
    erase = np.zeros_like(mask)
    for number, box in enumerate(find_objects(marks), 1):
        ys, xs = box
        h, w = ys.stop-ys.start, xs.stop-xs.start
        component = marks[box] == number
        if min(w,h) < 6 or max(w,h) > 120 or component.sum() < 29 or not .026 < component.mean() < .67:
            continue
        distance = distance_transform_edt(np.pad(component, 1))[1:-1, 1:-1]
        y, x = np.unravel_index(np.argmax(distance), distance.shape)
        cy, cx = ys.start+y, xs.start+x
        half = min(24, max(11, round(max(w,h)*.23)))
        if min(cy-half, cx-half) < 0 or cy+half >= len(gray) or cx+half >= gray.shape[1]:
            continue
        tile = np.s_[cy-half:cy+half+1, cx-half:cx+half+1]
        feature = marks[tile] == number
        bank = gray[tile][(~feature) & known[tile]]
        if feature.sum() < 29 or len(bank) < .3*feature.size or np.ptp(np.quantile(bank,[.2,.8])) > 23:
            continue
        template = gray[tile].astype(float)
        template -= template.mean()
        ones = np.ones(template.shape)
        energy = fftconvolve(prior**2, ones, mode="same") - fftconvolve(prior, ones, mode="same")**2/ones.size
        correlation = fftconvolve(prior, template[::-1,::-1], mode="same") / np.sqrt(
            np.maximum(1, energy * np.sum(template**2)))
        peaks = (correlation == maximum_filter(correlation, size=11)) & (correlation > .82)
        locate_duplicates(erase, peaks, correlation, exterior, mask, feature, cx, cy, half, w, h)
        for y, x in zip(*np.where(peaks & (correlation > .88) & mask & exterior)):
            step = np.hypot(x-cx, y-cy)
            if not half < step < 6*half:
                continue
            tail = copied_ray(gray, prior, mask, field, exterior, cx, cy, x-cx, y-cy, half)
            if tail is not None:
                erase |= tail
    return erase


def locate_duplicates(erase, peaks, correlation, exterior, mask, feature, cx, cy, half, w, h):
    height, width = mask.shape
    def covered(x, y):
        if not (half <= y < height-half and half <= x < width-half and exterior[y,x]):
            return 0
        return mask[y-half:y+half+1,x-half:x+half+1][feature].mean()
    hits = [(x-cx,y-cy) for y,x in zip(*np.where(peaks))
            if half < np.hypot(x-cx,y-cy) < 6*half and covered(x,y) > .67]
    yy,xx = np.ogrid[:height,:width]
    for dx,dy in hits:
        if not any(abs(tx-2*dx) <= 2 and abs(ty-2*dy) <= 2 for tx,ty in hits):
            continue
        copies = []
        for k in range(1,7):
            x,y = cx+k*dx,cy+k*dy
            if covered(x,y) < .7 or (k>2 and correlation[y,x] < .21):
                break
            copies.append((x,y))
        if len(copies) >= 2:
            for x,y in copies:
                erase |= mask & exterior & (((xx-x)/max(half+4,w*.59))**2 + ((yy-y)/max(half+4,h*.64))**2 < 1)


def smooth_exterior(gray, prior, mask, field, exterior):
    # Use the undecoded native prior to distinguish a soft exposure shift
    # from nearby ink, highlights, and texture. Only extrapolate from visible
    # sky, allowing the original foreground to interrupt its support.
    observed = ~mask & exterior
    reach = distance_transform_edt(~(observed & (abs(gray-field) < 12)))
    guard = distance_transform_edt(~(observed & (abs(gray-field) > 18)))
    detail = gaussian_filter(abs(prior-gaussian_filter(prior, 1.65)), 1.6)
    floor = np.maximum(12, .27*field)
    foreground = exterior & ((prior < floor) | (prior > field+34) | (detail > 7.2))
    clearance = distance_transform_edt(~foreground)
    level = np.clip((prior-floor)/6, 0, 1) * np.clip((field+25-prior)/10, 0, 1)
    nearby = np.clip((82-reach)/22, 0, 1) * np.clip((guard-1.5)/4, 0, 1)
    return (exterior * level * nearby * np.clip((8.2-detail)/4, 0, 1)
            * np.clip((clearance-1.9)/3.2, 0, 1))


def reflected_shadow(gray, prior, mask, field, rho, radius):
    # A true shadow continues into the exposed scan. The native prior can
    # instead bring a second copy of the limb across a strip of original sky.
    # Require that the same dark component contradict the scan at two levels.
    annulus = (rho > .12) & (rho < .6*radius)
    visible = annulus & ~mask & (rho > 2.4)
    sky = visible & (abs(gray-field) < 13)
    other = visible & ((gray < field-24) | (gray > field+27))

    def witnesses(level):
        components, count = label(annulus & (prior < field-level), np.ones((3, 3)))
        def votes(area):
            return np.bincount(components[area], minlength=count+1)
        sky_votes = votes(sky)
        size = np.bincount(components.ravel(), minlength=count+1)
        supported = ((size > 70) & (votes(mask & (rho < 4)) >= 11) & (sky_votes >= 17)
                     & (votes(other) < .025*sky_votes) & (votes(mask) > 36)
                     & (sky_votes > .019*size))
        supported[0] = False
        for number in np.flatnonzero(supported):
            y, x = np.where((components == number) & sky)
            tiles = x//4 + ((gray.shape[1]+3)//4)*(y//4)
            if np.hypot(np.ptp(x), np.ptp(y)) < 12 or len(np.unique(tiles)) < 5:
                supported[number] = False
        return components, supported[components]

    components, soft = witnesses(12)
    if not soft.any():
        return
    _, dark = witnesses(24)
    overlaps = np.bincount(components[dark], minlength=components.max()+1) > 9
    overlaps[0] = False
    confirmed = soft & overlaps[components]
    if confirmed.any():
        return (np.clip((4.2-distance_transform_edt(~confirmed))/3, 0, 1)
                * np.clip((rho+1.5)/.85, 0, 1))


def preserve_clipped_highlights(gray, mask, field, exterior, prediction):
    # An original point can sit in the space between two opaque letters.
    # Establish its exposure and dimensions from other points on the same sky.
    contrast = gray-field
    components, _ = label(exterior & (contrast > 55), np.ones((3, 3)))
    anchors, partial = [], []
    for number, box in enumerate(find_objects(components), 1):
        if box is None:
            continue
        sy, sx = box
        height, width = sy.stop-sy.start, sx.stop-sx.start
        if not (2 <= min(width, height) and max(width, height) <= 13
                and max(width, height) < 2.2*min(width, height)):
            continue
        view = np.s_[max(0, sy.start-4):sy.stop+4, max(0, sx.start-4):sx.stop+4]
        point = components[view] == number
        area = point.sum()
        if area < .47*width*height or gray[view][point].max() < 209:
            continue
        distance = distance_transform_edt(~point)
        surface = (distance > 0) & (distance < 3.8) & ~mask[view] & exterior[view]
        held = np.mean(~mask[view][point])
        if surface.sum() < 4 or abs(np.median(contrast[view][surface])) > 12:
            continue
        if held == 1 and np.quantile(abs(contrast[view][surface]), .7) < 19:
            anchors.append(area)
        elif .14 <= held <= .86 and (point & ~mask[view] & (gray[view] > 159)).sum() >= 2:
            partial.append((area, view, point, distance))
    for area, view, point, distance in partial:
        if sum(.32*area <= witness <= 2.7*area for witness in anchors) < 3:
            continue
        edge = (distance <= 1.5) & (contrast[view] > 7) & (contrast[view] <= 55)
        keep = mask[view] & (point | edge)
        prediction[view][keep] = gray[view][keep]


def registered_prior(source, mask, prior, decoded=None):
    rows, cols = np.nonzero(mask)
    if len(cols) < 1500 or np.ptp(cols) < 130 or mask.size > 900_000:
        return
    gray = source[:,:,1].astype(np.float32)
    if np.mean(gray[mask]>229) < .36 or np.mean(gray[mask]<115) < .17:
        return
    if np.percentile(np.ptp(source, axis=2)[mask], 92) > 6:
        return
    distance = distance_transform_edt(~mask).astype(np.float32)
    if np.percentile(np.ptp(source,axis=2)[distance<18],99) > 7:
        return
    phi = np.radians(np.arange(360))
    unit, shifts = np.column_stack((np.cos(phi), np.sin(phi))), np.arange(-8,8.01,.32)
    stencil = mask.astype(np.float32)
    candidates = [found for trial in seeds(gray,mask)
                  if (found := observe(gray,distance,stencil,trial,unit,shifts)) is not None]
    if not candidates:
        return
    _, (cx,cy,radius), background = max(candidates, key=lambda item:item[0])
    y,x = np.indices(mask.shape)
    rho = np.hypot(x-cx,y-cy)-radius
    known = (distance>=5) & (rho>2) & (rho<115) & (abs(gray-background)<28)
    field = background_field(gray,known,(x-cx)/radius,(y-cy)/radius)
    if field is None:
        return
    def support(observed,total,sigma):
        return gaussian_filter(observed.astype(np.float32),sigma) / np.maximum(
            .00001,gaussian_filter(total.astype(np.float32),sigma))
    outer = (rho>2) & (distance>=6)
    clean = outer & (abs(gray-field)<14)
    strength = np.minimum(support(clean,outer,12),support(clean,outer,24))
    sky = np.clip((strength-.35)/.35,0,1)*np.clip((rho+.8)/1.6,0,1)
    # Where the native-size prior independently matches the observed sky, keep
    # that exposure through an opaque word. A VAE can introduce an otherwise
    # visible dark stripe across the entire region during decoding.
    material = prior[:,:,1].astype(float)
    difference = np.abs(material-field)
    supported = gaussian_filter(((difference < 12) & (rho>1.8)).astype(np.float32), 2.8)
    nearby = np.clip((105-distance_transform_edt(~clean))/29, 0, 1)
    confirmed = (np.clip((21-difference)/12, 0, 1) * np.clip((supported-.32)/.42, 0, 1)
                 * nearby * np.clip((rho-.1)/2.5, 0, 1))
    sky = np.maximum(sky, confirmed)
    flat = smooth_exterior(gray, material, mask, field, rho>1.8)
    sky += (1-sky)*flat
    inner = (rho < -1) & (distance>3)
    dark = inner & (gray<12)
    if dark.sum() < 180:
        return
    strength = np.minimum(support(dark,inner,11),support(dark,inner,22))
    ink = np.clip((strength-.63)/.22,0,1)*np.clip((-rho+.8)/1.6,0,1)
    proposal = (prior if decoded is None else decoded)[:,:,1].astype(float)
    black = np.median(gray[dark])
    prediction = proposal*(1-sky-ink) + field*sky + black*ink
    shadow = reflected_shadow(gray, material, mask, field, rho, radius)
    if shadow is not None:
        edge = np.clip((rho+.6)/1.28, 0, 1)
        prediction += shadow*(field*edge + black*(1-edge) - prediction)
    if decoded is not None:
        restore = run_path(str(Path(__file__).with_name("qwen_crescent_shading.py")))["restore_shaded_rim"]
        prediction = restore(gray, mask, distance, rho, np.array([cx, cy]), radius, material, prediction)
    replicas = duplicate_peaks(gray,prior[:,:,1].astype(float),mask,field,rho>1.8)
    prediction[replicas] = field[replicas]
    if decoded is not None:
        preserve_clipped_highlights(gray, mask, field, rho > 3, prediction)
    output = source.copy()
    delta = (prediction-proposal)[mask,None]
    target = prior if decoded is None else decoded
    output[mask] = np.rint(np.clip(target[mask].astype(float)+delta,0,255)).astype(np.uint8)
    return output


if __name__ == "__main__":
    source_path, mask_path, candidate_path, destination, *evidence_path = sys.argv[1:]
    with Image.open(source_path) as image:
        original = np.array(image.convert("RGB"))
        alpha = image.getchannel("A") if "A" in image.getbands() else None
    with Image.open(mask_path) as image:
        stencil = np.array(image.convert("L")) > 127
    with Image.open(candidate_path) as image:
        candidate = np.array(image.convert("RGB"))
    # Resampling an opaque decoder output with Electron can yield alpha 250–254.
    # Only the original page defines transparency and which pixels may be edited.
    if alpha is not None:
        stencil &= np.asarray(alpha) == 255
    if evidence_path:
        with Image.open(evidence_path[0]) as image:
            prior = np.array(image.convert("RGB"))
    else:
        prior = candidate
    if original.shape != prior.shape or candidate.shape != original.shape or original.shape[:2] != stencil.shape:
        raise ValueError("Qwen native substrate and mask use different pixel grids")
    result = registered_prior(original, stencil, prior, candidate if evidence_path else None)
    if result is None:
        print("unchanged")
    else:
        image = Image.fromarray(result)
        if alpha is not None:
            image.putalpha(alpha)
        image.save(destination)
        print("applied")
