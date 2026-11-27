import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image


RUNTIME = Path(__file__).resolve().parents[2] / "src/main/runtime"


def rgba(gray, alpha):
    return np.stack((gray, gray, gray, np.broadcast_to(alpha, gray.shape)), axis=2).astype(np.uint8)


class NativePrintTest(unittest.TestCase):
    def test_caption_reconnects_a_source_supported_nib_and_removes_only_the_blank_paper_haze(self):
        from runpy import run_path
        from scipy.ndimage import distance_transform_edt

        contours = run_path(str(RUNTIME / "qwen-reconnect-balloon.py"))
        recover = run_path(str(RUNTIME / "qwen_caption_contour.py"))["close_caption_nibs"]
        y, x = np.indices((156, 135))
        paper = np.full(x.shape, 255, dtype="u1")
        paper[:, 88:] = np.where((x[:, 88:] + 2*y[:, 88:]) % 5 < 2, 219, 242)
        paper[:, 86:88] = 31
        paper[76:78, 22:81] = 29
        ink = (x >= 48) & (x <= 54) & (y >= 57) & (y <= 94)
        original = paper.copy()
        original[75:79, 46:55] = 255
        original[ink] = 26
        source = rgba(original, 255)[:, :, :3]
        target = paper.copy()
        target[76:78, 48:53] = 252
        target[58:70, 43:61] = 249
        candidate = rgba(target, 255)[:, :, :3]
        valid = np.ones_like(ink)
        valid[62, 49] = False
        distance = distance_transform_edt(~ink)
        ends = contours["visible_ends"](original.astype(float), distance)
        box = (48, 54, 66, 99)
        untouched = candidate.copy()
        self.assertFalse(recover(source, untouched, ink, valid, distance, box, [], contours))
        np.testing.assert_array_equal(untouched, candidate)
        self.assertTrue(recover(source, candidate, ink, valid, distance, box, ends, contours))
        self.assertLess(np.max(candidate[76:78, 50, 0]), 145)
        self.assertEqual(candidate[63, 50, 0], 255)
        self.assertEqual(candidate[62, 49, 0], 249)
        np.testing.assert_array_equal(candidate[:, 86:, 0], paper[:, 86:])

    def test_decoder_grid_under_type_uses_the_native_paper_and_respects_a_real_screen(self):
        from scipy.ndimage import distance_transform_edt
        from unittest.mock import patch
        with patch.object(sys, "path", [str(RUNTIME), *sys.path]):
            from qwen_caption_grain import restore_caption_grain
        y, x = np.indices((135, 120))
        random = np.random.default_rng(73)
        stock = np.rint(255 - random.uniform(0, 6, x.shape)*np.clip((x-40)/54, 0, 1)).astype('u1')
        ink = np.zeros_like(stock, bool)
        for left, top in ((42, 32), (41, 61)):
            u, v = x-left, y-top
            ink |= ((u >= 0) & (u < 25) & (v >= 0) & (v < 25)
                    & ((u < 3) | (u > 21) | (v < 3) | (v > 21) | (abs(v-12) < 2) | (abs(u-12) < 2)))
        stock[:, 18:20] = 35
        gap = distance_transform_edt(~ink)
        marked = gap <= 1.6
        raster = lambda plane: np.repeat(plane[:, :, None], 3, axis=2)
        original = raster(np.where(ink, 15, stock).astype('u1'))
        grid = (x % 4 == 1) & (y % 4 != 0)
        noisy = raster(np.where((gap < 10) & grid, 235, stock).astype('u1'))
        fixed = noisy.copy()
        opaque = (x != 52)
        self.assertTrue(restore_caption_grain(original, marked, fixed, opaque))
        self.assertTrue(np.array_equal(fixed[~opaque], noisy[~opaque]))
        self.assertTrue(np.array_equal(fixed[gap > 17], noisy[gap > 17]))
        under = ink & opaque
        error = lambda image: abs(image[:, :, 1][under].astype(float)-stock[under]).mean()
        self.assertLess(error(fixed), .55*error(noisy))
        genuine = raster(np.where(grid, 236, stock).astype('u1'))
        printed = genuine.copy()
        printed[ink] = 15
        observed = genuine.copy()
        self.assertFalse(restore_caption_grain(printed, marked, observed))
        self.assertTrue(np.array_equal(observed, genuine))

    def test_closed_display_type_on_a_burst_restores_the_known_hidden_shafts_and_dot_bands(self):
        from runpy import run_path
        from scipy.ndimage import distance_transform_edt
        from scipy.special import erf
        from unittest.mock import patch
        with patch.object(sys, "path", [str(RUNTIME), *sys.path]):
            from qwen_burst_stock import restore_burst_stock
        frequencies = run_path(str(RUNTIME / "qwen-screen-detail.py"))["screen_frequencies"]
        y, x = np.indices((428, 390))
        u, v = x-155., y-151.
        stripes = ((y % 38 >= 10) & (y % 38 < 20)) | ((y % 57 >= 50) & (y % 57 < 54))
        first = np.cos(2*np.pi*(.3376*x+.3373*y))
        second = np.cos(2*np.pi*(.3377*x-.3375*y))
        dots = np.clip(184+43*(first+second)+9*first*second, 0, 255)
        stock = np.where(stripes & ((u/151)**2+(v/165)**2 >= 1), dots, 255)
        opacity = np.zeros_like(stock)
        rng = np.random.default_rng(228)
        for angle in np.linspace(-np.pi, np.pi, 182, endpoint=False):
            c, s = np.cos(angle), np.sin(angle)
            along = c*u+s*v
            offset = -s*u+c*v-22*np.sin(2*angle)-1.4*np.sin(4*angle)
            start = 111-6*np.cos(2*angle)+rng.uniform(-4, 4)
            end = 186-11*np.cos(2*angle)+rng.uniform(-5, 5)
            width = .9*np.sin(np.pi*np.clip((along-start)/(end-start), 0, 1))**.78
            density = .5*(erf((width+offset)/.65)+erf((width-offset)/.65))
            opacity = np.maximum(opacity, density)
        truth = np.rint(stock*(1-opacity)).astype('u1')
        ink = np.zeros_like(truth, bool)
        for center, top, bottom, width, slope in ((271, 162, 293, 13, -.28), (311, 168, 230, 12, -.31),
                                                  (235, 215, 324, 17, -.22)):
            offset = x-center-slope*(y-top)
            outer = (abs(offset) < width) & (y >= top) & (y <= bottom)
            hole = (abs(offset) < width-3.8) & (y >= top+4) & (y <= bottom-4)
            ink |= outer & ~hole
        distance = distance_transform_edt(~ink)
        source = np.repeat(np.where(ink, 5, np.where(distance <= 4.8, 255, truth))[:, :, None], 3, 2)
        result = np.repeat(np.where(distance <= 9, 249, truth)[:, :, None], 3, 2)
        before = result.copy()
        self.assertTrue(restore_burst_stock(source, distance <= 1.6, result, np.ones_like(ink), frequencies))
        hidden = (distance < 4) & (truth < 200)
        self.assertLess(abs(result[:, :, 0].astype(float)-truth)[hidden].mean(), 21)
        np.testing.assert_array_equal(result[distance >= 15], before[distance >= 15])

    def test_projected_grain_preserves_a_light_fan_under_wide_ink(self):
        from runpy import run_path
        from scipy.ndimage import distance_transform_edt
        restore = run_path(str(RUNTIME / "qwen_radial_stock.py"))["restore_projected_print"]
        y, x = np.indices((205, 260))
        angle = np.arctan2(y-283., x-138.)
        grain = np.random.default_rng(191).normal(0, 2.8, y.shape)
        stock = np.rint(231+17*np.cos(148*angle+.14*np.sin(y/19))+grain).clip(0, 255).astype('u1')
        ink = (((x > 75+.32*y) & (x < 86+.32*y) & (y > 48) & (y < 102))
               | (((x-146)/15)**2+((y-90)/13)**2 < 1))
        distance = distance_transform_edt(~ink)
        valid = (x > 12) & (y > 9)
        target = (distance < 11) & valid
        hold = (distance > 13) & (distance < 27) & ((y//6+2*(x//7)) % 8 == 3)
        prediction = np.repeat(np.where(distance < 8, 235, stock).astype('u1')[:, :, None], 3, 2)
        before = prediction.copy()
        source = np.where(ink, 9, stock).astype(float)
        restore(source, ink, distance, target, valid, prediction, hold)
        self.assertLess(abs(prediction[:, :, 1].astype(float)-stock)[ink].mean(), 5)
        np.testing.assert_array_equal(prediction[~target], before[~target])
        unchanged = prediction.copy()
        restore(source, ink, distance, np.zeros_like(target), valid, prediction, hold)
        np.testing.assert_array_equal(prediction, unchanged)

    def test_paper_and_slanting_pencil_survive_removing_a_separate_sound(self):
        from runpy import run_path
        from scipy.ndimage import distance_transform_edt
        restore = run_path(str(RUNTIME / "qwen_perspective_ink.py"))["restore_pencil_stock"]
        y, x = np.indices((210, 225))
        level = np.full(y.shape, 255.)
        for intercept in range(12, 57, 6):
            density = 80*np.clip((x-40)/70, 0, 1)
            level -= density*np.exp(-.5*((y-.35*x-intercept)/.57)**2)
        stock = np.rint(level).clip(0, 255).astype('u1')
        ink = np.zeros_like(stock, bool)
        for cx, cy, rx, ry in ((78, 71, 6, 10), (95, 74, 4, 7), (99, 99, 5, 10),
                               (122, 116, 4, 9), (126, 139, 6, 5), (132, 153, 6, 4)):
            ink |= ((x-cx)/rx)**2+((y-cy)/ry)**2 < 1
        distance = distance_transform_edt(~ink)
        selected = distance < 1.42
        source = np.repeat(stock[:, :, None], 3, 2)
        result = source.copy()
        source[ink] = 8
        result[(distance < 9) & (stock > 241)] = 249
        result[selected] = 249
        before = result.copy()
        self.assertTrue(restore(source, selected, result, np.ones_like(selected)))
        self.assertEqual(result[ink & (y > 110)].min(), 255)
        covered_line = ink & (stock < 245)
        self.assertLess(np.quantile(abs(result[:, :, 1].astype(float)-stock)[covered_line], .95), 20)
        np.testing.assert_array_equal(result[distance >= 12.8], before[distance >= 12.8])

    def test_whitened_columns_recover_the_screen_of_a_known_cloud_gradient(self):
        from runpy import run_path
        from scipy.ndimage import distance_transform_edt
        restore = run_path(str(RUNTIME / "qwen_light_screen.py"))["restore_clouded_caption"]
        frequencies = run_path(str(RUNTIME / "qwen-screen-detail.py"))["screen_frequencies"]
        y, x = np.indices((190, 220))
        wash = 28*np.exp(-((y-42)/31)**2)*(1+.15*np.cos(x/33))
        dots = np.cos(2*np.pi*(x+y)*.32)+np.cos(2*np.pi*(x-y)*.32)
        paper = np.rint(255-wash+np.minimum(5, wash*.22)*dots).clip(0, 255).astype('u1')
        ink = np.zeros_like(paper, bool)
        for col in (63, 111):
            for top in (30, 55, 80, 105, 130):
                ink[top:top+19, col:col+4] = True
                ink[top:top+4, col:col+19] = True
                ink[top+8:top+11, col:col+16] = True
                ink[top+15:top+19, col:col+19] = True
        mask = distance_transform_edt(~ink) <= 1.6
        source = np.repeat(paper[:, :, None], 3, 2)
        result = source.copy()
        source[ink] = 6
        result[mask] = 253
        pen = (x == 39) & (y > 40) & (y < 121)
        source[pen] = result[pen] = 11
        original_result = result.copy()
        valid = y >= 11
        self.assertTrue(restore(source, mask, result, valid, frequencies))
        shaded = ink & (paper < 244)
        self.assertLess(np.abs(result[:, :, 1].astype(float)-paper)[shaded].mean(), 5)
        outside = (distance_transform_edt(~mask) >= 11) | pen | ~valid
        np.testing.assert_array_equal(result[outside], original_result[outside])

    def test_two_hollow_faces_restore_their_unprinted_scan_and_keep_an_adjacent_rule(self):
        from runpy import run_path
        from scipy.ndimage import distance_transform_edt
        restore = run_path(str(RUNTIME / "qwen_paper_banks.py"))["restore_hollow_print_stock"]
        y, x = np.indices((145, 220))
        gray = np.full(y.shape, 255, dtype='u1')
        selected = np.zeros_like(gray, bool)
        for left in (47, 102):
            cell = (x >= left) & (x < left+32) & (y >= 43) & (y < 91)
            rim = cell & (distance_transform_edt(cell) <= 3.2)
            gray[rim] = 7
            selected |= cell
        rule = (x == 152) & (y < 120)
        gray[rule] = 24
        source = np.repeat(gray[:, :, None], 3, 2)
        result = source.copy()
        result[selected] = 248
        self.assertTrue(restore(source, selected, result, None))
        self.assertEqual(result[selected].min(), 255)
        np.testing.assert_array_equal(result[rule], source[rule])
        invalid = np.ones_like(selected)
        invalid[80, 54] = False
        self.assertFalse(restore(source, selected, result, invalid))

    def test_stipple_gradient_retains_the_energy_of_held_out_scan_paper(self):
        from runpy import run_path
        from scipy.ndimage import distance_transform_edt, gaussian_filter
        restore = run_path(str(RUNTIME / "qwen_print_grain.py"))["restore_stipple_gradation"]
        y, x = np.indices((142, 178))
        rng = np.random.default_rng(31)
        noise = rng.normal(size=y.shape)
        rough = gaussian_filter(noise, 2.5)
        truth = np.rint(222+.04*y+8*noise+3*rough/rough.std()).clip(0, 255).astype('u1')
        mask = (abs(x-85+.18*(y-68)) < 10) & (abs(y-68) < 29)
        source = np.where(mask, 8, truth).astype(float)
        estimate = np.where(mask, np.rint(gaussian_filter(truth.astype(float), 5)), truth)
        result = np.repeat(estimate[:, :, None].astype('u1'), 3, 2)
        before = result.copy()
        verified = mask & (y < 53)
        valid = (y < 91)
        allowed = mask & valid
        self.assertTrue(restore(source, result, valid, allowed, distance_transform_edt(~mask), verified))
        inside = allowed & (distance_transform_edt(allowed) > 3)
        recovered = result[:, :, 1].astype(float)
        detail = (recovered-gaussian_filter(recovered, 3))[inside]
        self.assertGreater(detail.std(), 4)
        self.assertLess(abs((recovered-truth)[inside].mean()), 2.5)
        np.testing.assert_array_equal(result[~allowed], before[~allowed])

    def test_independent_pen_and_small_readings_beside_vertical_type(self):
        import runpy
        restore = runpy.run_path(str(RUNTIME / "qwen_typeset_stock.py"))["restore_unenclosed_readings_and_pen"]
        y, x = np.indices((170, 160))
        letters = np.zeros(y.shape, bool)
        for top in (29, 53, 77, 101):
            letters[top:top+17, 74:77] = True
            letters[top+7:top+10, 74:90] = True
            letters[top+15:top+18, 74:90] = True
        reading = np.zeros_like(letters)
        for top in (30, 42):
            reading[top:top+9, 94:96] = True
            reading[top+4:top+6, 94:99] = True
        pen = (x >= 43) & (x < 72) & (abs(y-82+.24*(x-43)) < 1.35)
        original = np.full((*y.shape, 3), 255, dtype='u1')
        original[letters | reading | pen] = 14
        marked = letters | reading | (pen & (x >= 62))
        marked[30:32, 94:96] = False
        result = np.full_like(original, 255)
        result[30:32, 94:96] = 14
        self.assertTrue(restore(original, marked, result, np.ones_like(marked)))
        self.assertEqual(result[reading].min(), 255)
        self.assertEqual(result[letters].min(), 255)
        np.testing.assert_array_equal(result[pen], original[pen])
        blank = np.full_like(original, 255)
        self.assertFalse(restore(blank, marked, blank.copy(), None))

    def test_weak_scanned_screen_uses_registered_repeat_offsets_inside_the_selected_stroke(self):
        import runpy
        from scipy.ndimage import distance_transform_edt
        restore = runpy.run_path(str(RUNTIME / "qwen_light_screen.py"))["restore_weathered_impact_screen"]
        y, x = np.indices((178, 243))
        tone = 231-.055*x-.026*y
        dots = 3*np.cos(2*np.pi*(x+y)*2/7)+2.4*np.cos(2*np.pi*(x-y)*2/7)
        native = np.rint(tone+dots+np.random.default_rng(15).normal(0, 1.2, tone.shape)).astype('u1')
        mask = (x > 68+.2*y) & (x < 110+.2*y) & (y > 15) & (y < 161)
        original = np.where(mask, 8, native).astype(float)
        decoded = np.where(mask, np.rint(tone-5), native).astype(float)
        result = np.repeat(decoded[:, :, None].astype('u1'), 3, 2)
        distance = distance_transform_edt(~mask)
        allowed = mask & (x < 130)
        self.assertTrue(restore(original, decoded, mask, np.ones_like(mask), allowed, distance, result))
        corrected = allowed & (distance_transform_edt(allowed) > 5)
        self.assertLess(abs((result[:, :, 1].astype(float)-native)[corrected].mean()), 1)
        self.assertGreater(np.corrcoef((result[:, :, 1]-tone)[corrected], dots[corrected])[0, 1], .7)
        np.testing.assert_array_equal(result[:, :, 1][~allowed], decoded[~allowed])
        flat = np.full_like(original, 222.)
        self.assertFalse(restore(np.where(mask, 8, flat), flat-2, mask, np.ones_like(mask), allowed, distance, result))

    def test_solid_print_uses_exposed_phase_and_density_of_the_same_screen(self):
        import runpy
        from scipy.ndimage import gaussian_filter
        restore = runpy.run_path(str(RUNTIME / "qwen_crossed_screen.py"))["restore_impact_screen"]
        frequencies = runpy.run_path(str(RUNTIME / "qwen-screen-detail.py"))["screen_frequencies"]
        y, x = np.indices((178, 209))
        low = 176+.22*y
        dots = 21*np.cos(2*np.pi*(.304*x+.108*y)) + 22*np.cos(2*np.pi*(.126*x-.291*y))
        native = np.rint(low+dots).clip(0, 255).astype('u1')
        mask = (x > 64+.13*y) & (x < 101+.13*y) & (y > 14) & (y < 157)
        source = np.repeat(native[:, :, None], 3, axis=2)
        source[mask] = 11
        out = source.copy()
        out[mask] = np.rint(low[mask]+16+.45*dots[mask])[:, None].astype('u1')
        before = out.copy()
        self.assertTrue(restore(source, mask, out, np.ones_like(mask), mask, frequencies))
        inner = (gaussian_filter(mask.astype(float), 5) > .998)
        delta = abs(out[:, :, 1].astype(float)-native)
        self.assertLess(np.median(delta[inner]), 4)
        np.testing.assert_array_equal(before[~mask], out[~mask])

    def test_white_ray_continues_between_matching_original_banks_through_a_solid_effect(self):
        import runpy
        restore = runpy.run_path(str(RUNTIME / "qwen_white_rays.py"))["restore_white_rays"]
        y, x = np.indices((165, 235))
        left = 60 + .23*y
        native = np.full(y.shape, 103, dtype='u1')
        native[(x >= left-2) & (x <= left+13)] = 19
        native[(x >= left) & (x <= left+11)] = 253
        selected = (y >= 62) & (y < 96) & (x >= 19) & (x < 207)
        source = np.repeat(native[:, :, None], 3, axis=2)
        source[selected] = 7
        pred = source.copy()
        pred[selected] = 98
        before = pred.copy()
        valid = np.ones_like(selected)
        self.assertTrue(restore(source, selected, pred, selected, valid))
        centers = np.rint(left[:, 0]+5).astype(int)
        self.assertGreater(pred[np.arange(65, 92), centers[65:92], 0].min(), 242)
        np.testing.assert_array_equal(pred[~selected], before[~selected])
        inconsistent = source.copy()
        inconsistent[96:] = np.roll(inconsistent[96:], 38, axis=1)
        self.assertFalse(restore(inconsistent, selected, before.copy(), selected, valid))

    def test_white_type_restores_its_dark_scan_stock_and_preserves_a_neighbouring_highlight(self):
        import runpy
        from scipy.ndimage import distance_transform_edt
        restore = runpy.run_path(str(RUNTIME / "qwen_typeset_stock.py"))["restore_reversed_type_stock"]
        yy, xx = np.indices((170, 145))
        paper = (np.array([36, 32, 29]) + ((xx//23 + yy//17) % 3 - 1)[:, :, None]).astype('u1')
        mask = np.zeros(yy.shape, bool)
        for x in (40, 68, 95):
            for y in (23, 48, 73, 98, 123):
                mask[y:y+9, x:x+3] = mask[y+5:y+8, x:x+11] = True
        src = paper.copy()
        src[mask] = [253, 251, 248]
        src[68:78, 56:58] = 252
        stencil = distance_transform_edt(~mask) <= 1.5
        shadow = distance_transform_edt(~stencil) <= 4.5
        pred = src.copy()
        pred[shadow] = paper[shadow]-6
        before = pred.copy()
        opaque = np.ones_like(mask)
        self.assertTrue(restore(src, stencil, pred, opaque))
        self.assertLess(np.max(abs(pred[mask].astype(float)-paper[mask])), 3)
        np.testing.assert_array_equal(pred[~shadow], before[~shadow])
        np.testing.assert_array_equal(pred[68:78, 56:58], src[68:78, 56:58])
        opaque[stencil] = False
        self.assertFalse(restore(src, stencil, before.copy(), opaque))
        striped = src.copy()
        striped[(xx % 12 < 3) & ~stencil] = 177
        self.assertFalse(restore(striped, stencil, before.copy(), np.ones_like(mask)))

    def test_paired_slanted_panel_edges_reconnect_to_an_interrupted_corner(self):
        import runpy
        from scipy.ndimage import distance_transform_edt
        repair = runpy.run_path(str(RUNTIME / "qwen_panel_gutters.py"))["restore_gutter_rules"]
        y, x = np.indices((485, 360))
        right, left = 133+.12*y, 115+.12*y
        def pen(distance):
            return 255*np.clip(abs(distance)-1.42, 0, 1)
        inner = (y >= 110) & ((y < 266) | (y >= 303))
        field = np.minimum(pen(x-right), np.where(inner, pen(x-left), 255))
        field = np.minimum(field, np.where(x <= left+1.5, pen(y-110), 255))
        field[338:341, :83] = 25
        face = (abs(x-119-.35*(y-50)) < 13) & (y < 292)
        face |= (x > 98) & (x < 260) & (abs(y-162) < 8)
        mask = distance_transform_edt(~face) <= 8
        def rgb(a):
            return np.repeat(np.rint(a).astype(np.uint8)[:, :, None], 3, axis=2)
        source = rgb(np.where(face, 24, np.where(mask, 254, field)))
        result = rgb(np.where(mask, 255, field))
        before = result.copy()
        self.assertTrue(repair(source, mask, result, mask, np.ones_like(mask)))
        for row,col in [(110,127), (113,129), (122,148)]:
            self.assertLess(result[row,col,0], 62)
        np.testing.assert_array_equal(result[~mask], before[~mask])
        self.assertGreater(result[288,150,0], 249)
        self.assertFalse(repair(source, mask & (x < 62), before.copy(), mask, np.ones_like(mask)))

    def test_small_dark_sound_on_white_recovers_exposed_pen_and_rejects_connected_art(self):
        import runpy
        from scipy.ndimage import distance_transform_edt
        restore = runpy.run_path(str(RUNTIME / "qwen_paper_banks.py"))["restore_separate_sound_on_white"]
        y, x = np.indices((122, 180))
        ink = ((y >= 30) & (y <= 34) & (x > 27) & (x < 64))
        ink |= (x > 35) & (x < 41) & (y > 42) & (y < 70)
        for dx in (0, 12, 24):
            ink |= (x-48-dx)**2 + (y-85)**2 < 7
        cloud = (y == 37 + x//50) & (x > 12) & (x < 152)
        to_ink = distance_transform_edt(~ink)
        original = np.where(ink, 37, np.where(cloud, 156, 255))
        original[to_ink == 1] = 172
        rgb = lambda v: np.repeat(v[:, :, None].astype(np.uint8), 3, axis=2)
        source = rgb(original)
        mask = to_ink <= 1
        prediction = rgb(np.where(to_ink <= 7, 242, original))
        visible = np.ones_like(mask)
        restored = prediction.copy()
        self.assertTrue(restore(source, mask, restored, visible))
        np.testing.assert_array_equal(restored[cloud & ~mask], source[cloud & ~mask])
        self.assertTrue(np.all(restored[ink] == 255))
        np.testing.assert_array_equal(restored[to_ink > 14], prediction[to_ink > 14])
        self.assertFalse(restore(source, mask, restored.copy(), visible))
        connected = source.copy()
        connected[32, 60:140] = 132
        self.assertFalse(restore(connected, mask, prediction.copy(), visible))
        shaded = np.minimum(source, 173)
        self.assertFalse(restore(shaded, mask, prediction.copy(), visible))

    def test_only_an_originally_overprinted_island_beside_exposed_ink_gets_repaired(self):
        import runpy
        from scipy.ndimage import distance_transform_edt
        locate = runpy.run_path(str(RUNTIME / "qwen_cover_residual.py"))["separated_ink_fragment"]
        y, x = np.indices((520, 225))
        mask = (x >= 75) & (x <= 125) & (y > 24) & (y < 495)
        island = (x >= 106) & (x < 121) & (y >= 280) & (y < 300) & (x-106 <= .78*(y-280))
        body = (x >= 125) & (y > 163) & (y < 309)
        edit = np.where(island | body, 16, 250)
        source = np.where(island & (x <= 109), 248, edit)
        rgb = lambda levels: np.repeat(levels[:, :, None].astype(np.uint8), 3, axis=2)
        sm, bg = rgb(source), rgb(edit)
        region, aperture = locate(sm, mask, bg)
        sy, sx = region["y"], region["x"]
        span = np.s_[sy:sy+region["height"], sx:sx+region["width"]]
        self.assertEqual(region["fragment"], int(island.sum()))
        self.assertTrue(np.all(aperture[island[span]] > .99))
        self.assertFalse(np.any(aperture[distance_transform_edt(~mask)[span] >= 10.5]))
        self.assertIsNone(locate(bg, mask, bg))
        self.assertIsNone(locate(rgb(np.where(body, 250, source)), mask, bg))
        self.assertIsNone(locate(sm, mask, rgb(np.where(body, 16, 250))))
        self.assertIsNone(locate(sm, mask & (y < 210), bg))

    def test_light_title_stock_crosses_an_old_erase_boundary_without_crossing_an_ink_line(self):
        from runpy import run_path
        from scipy.ndimage import distance_transform_edt
        blend = run_path(str(RUNTIME / "qwen_light_screen.py"))["blend_title_highlights"]
        y, x = np.indices((155, 258))
        ink = (x >= 80) & (x <= 190) & (y > 31) & (y < 128)
        tone = np.where((x < 191) & (y >= 75), 248, 255)
        tone[:, 191:195] = 32
        original = rgba(tone, 255)
        result = original.copy()
        dist = distance_transform_edt(~ink)
        axes = np.array([[.24, -.24], [.24, .24]])
        blend(result, dist, original[:, :, 3] == 255, axes)
        values = result[:, 112:162, 1].astype(float).mean(axis=1)
        self.assertLess(np.max(np.abs(np.diff(values[68:83]))), 1.)
        np.testing.assert_array_equal(result[:, 191:], original[:, 191:])
        np.testing.assert_array_equal(result[dist > 47], original[dist > 47])
        np.testing.assert_array_equal(result[:, :, 3], original[:, :, 3])

    def test_restores_a_measured_title_screen_without_filling_plain_paper_or_touching_a_crease(self):
        from runpy import run_path
        from scipy.ndimage import gaussian_filter, distance_transform_edt
        paper = run_path(str(RUNTIME / "qwen_light_screen.py"))["restore_washed_title_paper"]
        y, x = np.indices((275, 395))
        screen = 223 + 10*np.cos(2*np.pi*.241*(x+y)) + 13*np.cos(2*np.pi*.241*(x-y))
        density = 3*np.sin(y/75)
        original = rgba(screen+density, 255)
        mask = (x > 94) & (x < 254) & (y > 88) & (y < 215)
        crease = abs(y-48-.51*x) <= 1
        original[crease,:3] = 69
        marked, result = original.copy(), original.copy()
        marked[mask,:3] = 62
        result[mask & ~crease,:3] = 224
        paper(marked, mask, result, original[:,:,3] == 255)
        middle = mask & (distance_transform_edt(~crease)>14)
        detail = result[:,:,1].astype(float)-gaussian_filter(result[:,:,1].astype(float), 2)
        self.assertGreater(detail[middle].std(), 6)
        self.assertGreater(np.corrcoef(detail[middle], screen[middle])[0,1], .7)
        np.testing.assert_array_equal(result[crease], original[crease])
        safe = distance_transform_edt(~mask)>47
        np.testing.assert_array_equal(result[safe], original[safe])
        flat = rgba(np.full(x.shape,243),255)
        unchanged = flat.copy()
        paper(flat, mask, unchanged, flat[:,:,3] == 255)
        np.testing.assert_array_equal(unchanged, flat)

    def test_white_title_preserves_original_paper_and_alpha_outside_print_and_uses_connected_drawing(self):
        from runpy import run_path
        layer = run_path(str(RUNTIME / "qwen_layered_ink.py"))
        reg = run_path(str(RUNTIME / "qwen-restore-illustration.py"))
        y, x = np.indices((236, 352))
        dense = (x > 201) & ((x + 2*y) % 25 < 8)
        dense |= (x > 201) & ((2*x - y) % 39 < 6)
        native = np.where(dense, 46, 247).astype('u1')
        ink = (x > 64) & (x < 235) & (y > 48) & (y < 187)
        original = rgba(np.where(ink, 99, native), np.where(y < 9, 0, 255))
        prior = np.repeat(np.where(ink & (x > 192), 155, 247)[:, :, None], 3, axis=2).astype('u1')
        decoded = np.repeat(native[:, :, None], 3, axis=2)
        result = layer["restore_washed_title"](original, ink, decoded, prior,
                                               reg["register"], reg["choose_boundary"])
        np.testing.assert_array_equal(result[:, :, 3], original[:, :, 3])
        np.testing.assert_array_equal(result[:9], original[:9])
        np.testing.assert_array_equal(result[:, :60], original[:, :60])
        self.assertTrue((result[100:130, 75:105, 1] == 247).all())
        self.assertGreater((result[:, :, 1][ink & dense] < 90).mean(), .95)
        blank = layer["restore_washed_title"](original, ink & False, decoded, prior,
                                              reg["register"], reg["choose_boundary"])
        np.testing.assert_array_equal(blank, original)

    def test_vertical_pause_repairs_only_surviving_original_strokes_on_light_stock(self):
        from runpy import run_path
        from scipy.ndimage import distance_transform_edt
        repair = run_path(str(RUNTIME / "qwen_typeset_stock.py"))["restore_registered_pause_marks"]
        ink = np.zeros((115, 96), dtype=bool)
        for x, y, w, h in [(30, 17, 6, 9), (49, 21, 5, 4), (36, 40, 5, 11),
                           (49, 48, 4, 5), (41, 74, 3, 3), (41, 82, 3, 3), (41, 90, 3, 3)]:
            ink[y:y+h, x:x+w] = True
        mask = distance_transform_edt(~ink) < 3
        source = np.full((*ink.shape, 3), 246, 'u1')
        source[ink] = 46
        prediction = np.full_like(source, 246)
        prediction[21:25, 49:54] = 65
        prediction[96:102, 60:65] = 27
        original = prediction.copy()
        self.assertTrue(repair(source, mask, prediction))
        self.assertGreater(prediction[22, 51, 0], 238)
        np.testing.assert_array_equal(prediction[~mask], original[~mask])
        missing_middle = source.copy()
        missing_middle[82:85, 41:44] = 246
        dark_stock = source.copy()
        dark_stock[8:40, 40:67] = 175
        dark_stock[21:25, 49:54] = 46
        for changed_source in (missing_middle, dark_stock):
            prediction = original.copy()
            self.assertFalse(repair(changed_source, mask, prediction))
            np.testing.assert_array_equal(prediction, original)

    def test_compact_effect_keeps_a_visible_entering_pen_tip_and_ignores_an_isolated_accent(self):
        from runpy import run_path
        restore = run_path(str(RUNTIME / "qwen_printed_badge.py"))["restore_overlapping_pen_tip"]
        y, x = np.indices((110, 120))
        pen = (x >= 56) & (x <= 60)
        marks = ((y >= 31) & (y <= 64) & (x >= 43) & (x <= 73)
                 & ((y % 12 < 5) | (y == 31)))
        mask = (pen & (y >= 21) & (y < 31)) | marks
        source = rgba(np.where((pen & (y < 31)) | marks, 76, 249), 255)
        erased = rgba(np.where(pen & (y < 18), 76, 249), 255)
        result = erased.copy()
        restore(source, mask, result)
        self.assertTrue((result[21:30, 57:60, 0] == 76).all())
        self.assertLess(result[31, 58, 0], 100)
        np.testing.assert_array_equal(result[35:], erased[35:])
        np.testing.assert_array_equal(result[:, :43], erased[:, :43])
        detached = source.copy()
        detached[16:21, :, :3] = 249
        unchanged = erased.copy()
        restore(detached, mask, unchanged)
        np.testing.assert_array_equal(unchanged, erased)

    def test_closed_balloon_recovers_a_pale_native_rim_beneath_small_sound_print(self):
        from runpy import run_path
        from scipy.ndimage import distance_transform_edt
        repair = run_path(str(RUNTIME / "qwen_printed_badge.py"))["restore_balloon_rims"]
        y, x = np.indices((134, 158))
        radius = np.hypot((x-82)/30, (y-79)/40)
        normal = (radius-1)*33
        art = np.rint(254-112*np.exp(-.5*(normal/1.18)**2)).astype('u1')
        mask = (y > 23) & (y < 54) & (x > 68) & (x < 97) & ((y % 11 < 4) | (x % 19 < 4))
        source = rgba(art, 255)
        source[mask, :3] = 47
        distance = distance_transform_edt(~mask)
        edited = rgba(np.where(distance < 7, 254, art), 255)
        before = edited.copy()
        repair(source, mask, edited)
        covered_edge = (abs(normal) < 1.1) & (distance < 7)
        self.assertGreater(covered_edge.sum(), 30)
        self.assertLess(np.mean(abs(edited[covered_edge, 0].astype(float)-art[covered_edge])), 30)
        np.testing.assert_array_equal(edited[distance > 15], before[distance > 15])
        open_source = source.copy()
        open_source[65:93, 48:59, :3] = 254
        open_result = before.copy()
        repair(open_source, mask, open_result)
        np.testing.assert_array_equal(open_result, before)

    def test_coloured_headline_returns_the_measured_cream_paper_inside_ink_contours(self):
        from scipy.ndimage import distance_transform_edt
        from runpy import run_path
        y, x = np.indices((200, 340))
        art = np.empty((200, 340, 4), dtype='u1')
        art[:] = [244, 240, 231, 255]
        art[:, 174:179] = [42, 36, 37, 255]
        art[:, 179:] = [145, 97, 52, 255]
        art[95:121, 53:61, 3] = 155
        letter = (x > 53) & (x < 284) & (x % 19 < 7) & (y > 88) & (y < 108)
        distance = distance_transform_edt(~letter)
        source = art.copy()
        source[distance < 8, :3] = [217, 7, 120]
        source[letter, :3] = 252
        repaired = art.copy()
        repaired[distance < 19, :3] = np.clip(art[distance < 19, :3].astype(int) - [0, 9, 4], 0, 255)
        before = repaired.copy()
        paint = run_path(str(RUNTIME/"qwen_jacket_stock.py"))["restore_light_caption_stock"]
        mask = distance < 12
        paint(source, mask, repaired)
        self.assertEqual(list(repaired[97, 100, :3]), [244, 240, 231])
        np.testing.assert_array_equal(repaired[:, 174:], before[:, 174:])
        np.testing.assert_array_equal(repaired[art[:, :, 3] != 255], before[art[:, :, 3] != 255])
        np.testing.assert_array_equal(repaired[:52], before[:52])
        unchanged = before.copy()
        paint(art, mask, unchanged)
        np.testing.assert_array_equal(unchanged, before)

    def test_upright_volume_number_uses_its_own_hexagonal_stock(self):
        import cv2
        from runpy import run_path
        plane = run_path(str(RUNTIME/"qwen_jacket_plane.py"))
        book = np.full((390,280,3), [235,188,185], dtype='u1')
        vertices = np.array([[27,174],[41,153],[65,153],[77,174],[64,194],[39,194]])
        cv2.fillConvexPoly(book, vertices, (47,43,70))
        cv2.putText(book, "5", (39,184), cv2.FONT_HERSHEY_SIMPLEX, .87, (236,233,239), 2, cv2.LINE_AA)
        printed = np.zeros(book.shape[:2], bool)
        printed[146:282,24:235] = True
        edited = book.copy()
        alpha = np.zeros(book.shape[:2], dtype='f')
        plane["restore_volume_mark"](cv2, book, printed, edited, alpha)
        self.assertGreater(np.count_nonzero(alpha), 80)
        np.testing.assert_array_equal(edited[158:188,41:61], np.broadcast_to([47,43,70],(30,20,3)))
        np.testing.assert_array_equal(edited[:, :29], book[:, :29])
        original = np.full_like(edited, [194,167,121])
        other = original.copy()
        plane["restore_volume_mark"](cv2, book, printed, other, alpha)
        np.testing.assert_array_equal(other, original)
        untouched = book.copy()
        plane["restore_volume_mark"](cv2, book, ~printed, untouched, alpha)
        np.testing.assert_array_equal(untouched, book)

    def test_cleared_credit_matches_original_flat_paint_and_keeps_the_dividing_ink(self):
        from runpy import run_path
        from scipy.ndimage import distance_transform_edt
        restore = run_path(str(RUNTIME/"qwen_jacket_stock.py"))["restore_credit_paints"]
        y, x = np.indices((140, 260))
        art = np.full((140, 260, 3), [203, 65, 49], dtype='u1')
        art[:, 143:148] = [18, 12, 11]
        art[:, 148:] = [240, 240, 232]
        letters = (x >= 65) & (x < 205) & ((x-65) % 14 <= 4) & (y >= 58) & (y <= 78)
        distance = distance_transform_edt(~letters)
        glow = np.exp(-(distance/6.)**2)[:, :, None]
        printed = np.rint(art*(1-glow) + np.array([26,53,133])*glow).astype('u1')
        printed[letters] = 249
        alpha = np.full(x.shape, 255, dtype='u1')
        alpha[64:67, 112:118] = 0
        source = np.dstack((printed, alpha))
        predicted = art.copy()
        stain = (distance < 11) & ((x < 143) | (x >= 148))
        predicted[stain] = np.rint(.78*predicted[stain]).astype('u1')
        restored = restore(source, distance < 9, predicted)
        self.assertIsNotNone(restored)
        for col in (94, 115, 178):
            np.testing.assert_allclose(restored[70, col, :3], art[70, col], atol=2)
        np.testing.assert_array_equal(restored[:, 143:148, :3], predicted[:, 143:148])
        np.testing.assert_array_equal(restored[alpha == 0, :3], predicted[alpha == 0])
        np.testing.assert_array_equal(restored[:, :, 3], alpha)
        np.testing.assert_array_equal(restored[:36, :, :3], predicted[:36])
        self.assertIsNone(restore(np.dstack((art, alpha)), distance < 9, predicted))

    def test_colour_display_view_preserves_material_outside_the_three_printed_rows(self):
        import cv2
        from runpy import run_path
        native = run_path(str(RUNTIME / "qwen_layered_ink.py"))
        width, height = 650, 420
        y, x = np.indices((height, width))
        art = np.tile(np.array([116,75,51], dtype='u1'),(height,width,1))
        art[:,width//2:] = [184,51,37]
        printed = art.copy()
        selected = np.zeros((height,width),bool)
        for start,end,upper,lower in ((130,528,43,63),(62,587,119,178),(67,594,230,301)):
            for left in range(start,end,23):
                stroke = (x>=left)&(x<left+8)&(y>=upper)&(y<=lower)
                stroke |= (x>=left)&(x<left+16)&(abs(y-(upper+9))<3)
                rim = cv2.dilate(stroke.astype('u1'),cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(15,15)))>0
                printed[rim] = [248,248,247]
                printed[stroke] = [24,37,108]
                selected |= cv2.dilate(rim.astype('u1'),np.ones((9,9),'u1'))>0
        detected = native["prepare_display_reference"](cv2,printed,selected)
        self.assertIsNotNone(detected)
        guide, (left, top, w, h) = detected
        self.assertTrue(left <= 62 and top <= 66 and left+w >= 594 and top+h >= 301)
        np.testing.assert_array_equal(guide[-45:],printed[-45:])
        self.assertLess(np.abs(guide[148,95].astype(float)-art[148,95]).max(),20)
        self.assertIsNone(native["prepare_display_reference"](cv2,art,selected))
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            Image.fromarray(printed).save(root/"source.png")
            Image.fromarray(guide[top:top+h,left:left+w]).save(root/"guide.png")
            paired = run_path(str(RUNTIME / "qwen-rule-references.py"))["write_display_references"]
            args = [root/"source.png",root/"guide.png",(left,top,w,h),(416,288),root/"a.png",root/"b.png",root/"mask.png"]
            paired(*args)
            with Image.open(root/"mask.png") as mask:
                self.assertEqual(mask.getextrema(), (255,255))
            with Image.open(root/"b.png") as result:
                expected = Image.fromarray(printed[top:top+h,left:left+w]).resize((416,288),Image.Resampling.LANCZOS)
                np.testing.assert_array_equal(result, expected)
            args[2]=(left,top,w-1,h)
            with self.assertRaises(ValueError):
                paired(*args)

    def test_brush_motion_requires_a_missing_line_between_matching_native_banks(self):
        from runpy import run_path
        recover = run_path(str(RUNTIME / "qwen_perspective_ink.py"))["restore_brush_motion"]
        y, x = np.indices((200, 310))
        level = y+.213*(x-154.5)
        clear = np.ones(x.shape, bool)
        allowed = (x >= 104) & (x <= 201) & (abs(level-132) < 8)
        for lines in ([132], [39, 59, 78, 104, 132, 155, 178]):
            art = np.full(x.shape, 246, dtype='f')
            for place in lines:
                art -= 155*np.exp(-.5*((level-place)/.78)**2)
            native = rgba(art, 255)[:, :, :3].copy()
            current = native.copy()
            current[allowed] = 246
            native[allowed] = 9
            clear[132, 155] = False
            recover(native, allowed, current, allowed & clear, clear)
            center = allowed & (abs(level-132) < .42) & clear
            if len(lines) > 1:
                self.assertLess(np.abs(current[center, 0].astype(float)-art[center]).mean(), 22)
            else:
                self.assertTrue((current[center] == 246).all())
            self.assertTrue((current[132, 155] == 246).all())
            np.testing.assert_array_equal(current[~allowed], native[~allowed])

    def test_brush_rejoins_paper_between_prongs_and_keeps_exposed_panel_rows(self):
        from runpy import run_path
        restore = run_path(str(RUNTIME / "qwen-restore-illustration.py"))["restore_brush"]
        y, x = np.indices((135, 190))
        stock = (130 + (7*x+13*y) % 89).astype(np.uint8)
        stock[:30] = 248
        stock[30:33] = 15
        prongs = (y >= 27) & (y < 98) & (
            ((x >= 67) & (x <= 83)) | ((x >= 94) & (x <= 112)))
        punched = (y > 45) & (y < 75) & (x > 82) & (x < 95)
        gray = stock.copy()
        gray[punched] = 255
        gray[prongs] = 8
        source = rgba(gray, 255)
        source[66, 87, 3] = 0
        desired = rgba(stock, 255)[:, :, :3].copy()
        desired[:31] = 230
        for transposed in (False, True):
            axes = lambda data: data.swapaxes(0, 1) if transposed else data
            restored = axes(restore(axes(source), axes(desired), axes(prongs)))
            np.testing.assert_array_equal(restored[66, 87], source[66, 87])
            np.testing.assert_array_equal(restored[30:33, 77, 0], [15, 15, 15])
            np.testing.assert_array_equal(restored[26, 77, 0], 248)
            np.testing.assert_array_equal(restored[69, 89, 0], stock[69, 89])
            np.testing.assert_array_equal(restored[:, :40], source[:, :40])
        np.testing.assert_array_equal(restore(source, desired, prongs & False), source)

    def test_oblique_cover_measures_four_printed_edges_and_keeps_its_projection_in_scope(self):
        import cv2
        import runpy
        plane = runpy.run_path(str(RUNTIME/"qwen_jacket_plane.py"))
        height, width = 432, 416
        book = np.full((270,180,3), [244,239,231], dtype='u1')
        cv2.rectangle(book,(0,0),(179,269),(222,104,167),6)
        cv2.ellipse(book,(58,61),(28,39),0,0,360,(107,161,123),-1)
        for y in (115,174):
            for x in range(13,165,20):
                cv2.rectangle(book,(x,y),(x+6,y+21),(30,39,106),-1)
                cv2.rectangle(book,(x,y+8),(x+12,y+12),(30,39,106),-1)
        corners=np.float32([[48,111],[218,64],[286,312],[111,350]])
        matrix=cv2.getPerspectiveTransform(np.float32([[0,0],[179,0],[179,269],[0,269]]),corners)
        image=cv2.warpPerspective(book,matrix,(width,height),borderValue=(131,101,80))
        y,x=np.indices((height,width))
        selected=(x>=74)&(x<258)&(y>=159)&(y<268)
        quad=plane["jacket_quad"](cv2,image,selected)
        self.assertIsNotNone(quad)
        self.assertLess(np.linalg.norm(quad-corners,axis=1).max(),10)
        measured=plane["prepare_plane"](cv2,image,selected)
        self.assertIsNotNone(measured)
        upright,ink,forward=measured
        self.assertGreater(ink.sum(),3500)
        edited=upright.copy()
        edited[ink]=[224,201,187]
        result=plane["put_back"](cv2,image,selected,upright,ink,edited,forward)
        np.testing.assert_array_equal(result[~selected],image[~selected])
        self.assertGreater(np.sum(np.any(result!=image,axis=2)),800)
        flat=np.broadcast_to(np.uint8([171,142,123]),image.shape).copy()
        self.assertIsNone(plane["prepare_plane"](cv2,flat,selected))

    def test_printed_row_transfer_recovers_unseen_screen_and_respects_the_art_scope(self):
        import runpy
        from scipy.ndimage import distance_transform_edt
        restore = runpy.run_path(str(RUNTIME / "qwen_screen_transfer.py"))["restore_printed_screen_rows"]
        y, x = np.indices((202, 260))
        phase = 2*np.pi*(x/7+y/9)
        tone = 160 + .17*(y-90) + 59*np.cos(phase) + 18*np.cos(2*phase) + 14*np.cos(2*np.pi*y/4)
        clean = np.broadcast_to(np.rint(tone).clip(0,255).astype("u1")[...,None], (*x.shape,3))
        selected = (y>60) & (y<124) & ((abs(x-(103+.14*y))<2.8) | (abs(x-(160-.14*y))<2.7))
        distance = distance_transform_edt(~selected)
        source = clean.copy()
        source[distance<=6] = 252
        source[selected] = 16
        result = np.where((distance<13)[...,None], 145, source).astype("u1")
        opaque = x>103
        original = result.copy()
        self.assertTrue(restore(source,selected,result,opaque))
        self.assertLess(np.abs(result[selected].astype(float)-clean[selected]).mean(),1.1)
        native = (distance>=17) | ~opaque
        np.testing.assert_array_equal(result[native], original[native])
        source[distance>6] = np.random.default_rng(34).integers(40,239,((distance>6).sum(),1),dtype='u1')
        self.assertFalse(restore(source,selected,original,opaque))
        np.testing.assert_array_equal(original[native], result[native])

    def test_translucent_caption_preserves_a_crossing_highlight_and_the_art_between_letters(self):
        import runpy
        from scipy.ndimage import distance_transform_edt
        restore = runpy.run_path(str(RUNTIME / "qwen_transparent_caption.py"))["restore_transparent_caption"]
        y, x = np.indices((160, 350))
        band = (y >= 55) & (y < 109)
        cloth = np.stack((115+x//30, 81+y//20, 48+x//40), axis=2)
        cloth[band] += [-55, 4, 100]
        ridge = band & (abs(y - (120-.24*x)) < 1.8)
        cloth[ridge] += [64, 54, 43]
        cloth = cloth.astype("u1")
        faces = band & (y > 67) & (y < 96) & (x >= 42) & (x < 305) & ((x % 21 < 4) | ((y < 72) & (x % 21 < 11)))
        selected = (x > 33) & (x < 316) & (y > 64) & (y < 99)
        source = cloth.copy()
        source[faces] = 251
        decoded = np.where(selected[..., None], 180, source).astype("u1")
        opaque = x < 303
        before = decoded.copy()
        self.assertTrue(restore(source, selected, decoded, opaque))
        unchanged = (distance_transform_edt(~selected) > 14) | ~opaque
        np.testing.assert_array_equal(decoded[unchanged], before[unchanged])
        between = selected & opaque & (distance_transform_edt(~faces) > 6)
        np.testing.assert_array_equal(decoded[between], cloth[between])
        ink = faces & opaque
        self.assertLess(np.abs(decoded[ink].astype(float)-cloth[ink]).mean(), 4)
        on_ridge = ink & ridge
        self.assertGreater(on_ridge.sum(), 18)
        self.assertLess(np.abs(decoded[on_ridge].astype(float)-cloth[on_ridge]).mean(), 19)
        other = (x>108) & (x<161) & (y>29) & (y<37)
        grouped = before.copy()
        grouped[other] = [19,26,60]
        self.assertTrue(restore(source, selected | other, grouped, opaque))
        np.testing.assert_array_equal(grouped[other], np.tile([19,26,60], (other.sum(),1)))
        gray = np.broadcast_to(source.mean(2).astype("u1")[..., None], source.shape)
        self.assertFalse(restore(gray, selected, before, opaque))

    def test_partly_exposed_points_need_independent_uncovered_highlights(self):
        import runpy
        restore = runpy.run_path(str(RUNTIME / "qwen-register-substrate.py"))["preserve_clipped_highlights"]
        y, x = np.indices((90, 155))
        field = np.full(x.shape, 41.)
        target = (x-103)**2 + (y-46)**2 <= 9
        mask = (x > 102) & (y > 35) & (y < 59)
        anchors = [(16, 24), (51, 12), (38, 56)]
        for count in (0, 2, 3):
            source = np.where(target, 245., field)
            for cx, cy in anchors[:count]:
                source[(x-cx)**2+(y-cy)**2 <= 7] = 247
            prediction = np.where(mask, field, source)
            restore(source, mask, field, np.ones(x.shape, bool), prediction)
            np.testing.assert_array_equal(prediction[~mask], source[~mask])
            self.assertTrue(np.all(prediction[target & mask] == (245 if count == 3 else 41)))

    def test_stippled_crescent_meets_both_original_banks_at_different_orientations(self):
        import runpy
        from scipy.ndimage import distance_transform_edt, gaussian_filter
        restore = runpy.run_path(str(RUNTIME / "qwen_crescent_shading.py"))["restore_shaded_rim"]
        y, x = np.indices((260, 285))
        grain = 25*gaussian_filter(np.random.default_rng(98).normal(size=x.shape), .7)
        center, radius = np.array([140, 128]), 78.
        rim = np.hypot(x-center[0], y-center[1])-radius
        def light(depth):
            return 3 + 239/(1+np.exp(-(depth-2.4)/1.7))
        for rotation in [-.8, 1.8, 3.4]:
            with self.subTest(rotation=rotation):
                axis = np.array([np.cos(rotation), np.sin(rotation)])
                offset = center - 49*axis + 23*np.array([-axis[1], axis[0]])
                depth = np.hypot(x-offset[0], y-offset[1])-96
                angle = (np.arctan2(y-offset[1], x-offset[0])-rotation+np.pi) % (2*np.pi)-np.pi
                clean = np.where(rim <= 0, np.clip(light(depth)+grain*np.clip((depth+5)/10, 0, 1), 0, 255), 49.).astype("f")
                mask = (abs(angle) < .2) & (rim < -4) & (abs(depth) < 22)
                source = np.where(mask, np.where((x//3+y//7) % 4, 249, 9), clean)
                prior = np.where(rim < 0, np.clip(light(depth-6)+grain, 0, 255), 49.).astype("f")
                decoded = np.where(mask, prior, source)
                result = restore(source, mask, distance_transform_edt(~mask), rim, center, radius, prior, decoded)
                core = mask & (abs(depth) < 8)
                self.assertLess(np.abs(result[core]-clean[core]).mean(), .25*np.abs(decoded[core]-clean[core]).mean())
                np.testing.assert_array_equal(result[~mask], source[~mask])
        flat = np.full_like(prior, 82)
        self.assertIs(restore(flat, mask, distance_transform_edt(~mask), rim, center, radius, prior, decoded), decoded)

    def test_two_reference_panel_repair_retains_the_real_paper_and_limits_its_write(self):
        import runpy
        from scipy.ndimage import distance_transform_edt
        restore = runpy.run_path(str(RUNTIME / "qwen-restore-illustration.py"))["restore_crossed_rule"]
        y, x = np.indices((145, 228))
        clean = np.where(y < 57, 255, np.where(y < 60, 32, 137+(x+y) % 40)).astype("u1")
        ink = (y > 48) & (y < 77) & np.isin(x//11, (6, 9, 12))
        source = rgba(clean, 255)
        source[ink, :3] = 12
        decoded = np.repeat(clean[..., None], 3, axis=2)
        decoded[y < 57] = 246
        output = restore(source, ink, decoded, 57, 6)
        np.testing.assert_array_equal(output[:, :, 3], source[:, :, 3])
        np.testing.assert_array_equal(output[ink, 0], clean[ink])
        outside = distance_transform_edt(~ink) > 9
        np.testing.assert_array_equal(output[outside], source[outside])

    def test_model_pen_requires_two_matching_shoulders_over_blank_paper(self):
        import runpy
        trace = runpy.run_path(str(RUNTIME / "qwen_crossing_ink.py"))["interrupted_model_pen"]
        u = np.arange(-83., 84.)
        v = np.arange(-58., 58.5, .5)
        shade = 255-230*np.exp(-.5*((v[None, :]-8-.10*u[:, None])/.90)**2)
        shade[abs(u) < 11] = 255
        tips = trace(shade, v, 83, 5)
        self.assertIsNotNone(tips)
        self.assertLess(tips[0][0], 0)
        self.assertGreater(tips[1][0], 0)
        self.assertIsNone(trace(np.where(u[:, None] > 0, 255, shade), v, 83, 5))
        self.assertIsNone(trace(np.where(u[:, None] > 0, shade[:, ::-1], shade), v, 83, 5))

    def test_small_spot_colour_remnant_tracks_displaced_ink_and_leaves_an_unselected_peer(self):
        import runpy
        locate = runpy.run_path(str(RUNTIME / "qwen_cover_residual.py"))["locate"]
        y, x = np.indices((108, 269))
        blue = np.full((*x.shape, 3), [36, 73, 154], dtype=np.uint8)
        orange = [241, 120, 0]
        owned = (x > 30) & (x < 145) & (y > 23) & (y < 54) & (x % 55 < 35)
        accessory = (x > 212) & (x < 224) & (y > 50) & (y < 59)
        original = blue.copy()
        original[owned | accessory] = orange
        edit = blue.copy()
        edit[accessory] = orange
        self.assertIsNone(locate(original, owned, edit, True))
        edit[20:25, 64:84] = orange
        view, weights = locate(original, owned, edit, True)
        self.assertEqual(view["fragment"], 100)
        self.assertEqual(view["score"], 100)
        full = np.zeros(x.shape)
        top, left = view["y"], view["x"]
        full[top:top+view["height"], left:left+view["width"]] = weights
        self.assertTrue((full[20:25, 64:84] == 1).all())
        self.assertFalse(full[accessory].any())
        self.assertTrue(((full > .5) & (full < 1)).any())
        edit[20:25, 64:84] = [197, 132, 77]
        view, _ = locate(original, owned, edit, True)
        self.assertEqual(view["fragment"], 100)

    def test_jacket_uses_shared_paint_and_respects_unwritable_glyphs(self):
        import runpy
        restore = runpy.run_path(str(RUNTIME / "qwen_jacket_stock.py"))["restore_jacket_stock"]
        y, x = np.indices((145, 105))
        paper = np.broadcast_to([195, 45, 18], (*x.shape, 3)).astype(np.uint8).copy()
        original = paper.copy()
        face = (x > 12) & (x < 30) & (y > 10) & (y < 114) & ((y % 22) < 13)
        face &= (x < 17) | (y % 22 < 4)
        original[face] = 245
        edit = original.copy()
        edit[41:54, 77:83] = 249
        writable = y < 100
        before = edit.copy()
        self.assertTrue(restore(original, face, edit, writable))
        np.testing.assert_array_equal(edit[writable & face], paper[writable & face])
        np.testing.assert_array_equal(edit[~writable], before[~writable])
        np.testing.assert_array_equal(edit[:, 70:], before[:, 70:])
        self.assertFalse(restore(original, face, paper.copy(), writable))

    def test_residual_print_requires_adjacent_registered_white_faces(self):
        import runpy
        locate = runpy.run_path(str(RUNTIME / "qwen_cover_residual.py"))["locate"]
        y, x = np.indices((480, 170))
        stock = np.stack((55+x//9, 137+y//12, 102+x//14), axis=2).astype(np.uint8)
        original = stock.copy()
        mask = np.zeros(x.shape, dtype=bool)
        for top in (42, 86, 130, 360):
            face = (x >= 72) & (x < 92) & (y >= top) & (y < top+21)
            face &= (x < 78) | (y < top+5)
            original[face] = 252
            mask |= face
        found, ink = locate(original, mask, original.copy(), False)
        self.assertGreater(found["score"], 90)
        self.assertLess(found["y"] + found["height"], 360)
        self.assertTrue(ink.any())
        partly_clean = original.copy()
        partly_clean[120:158] = stock[120:158]
        self.assertIsNone(locate(original, mask, partly_clean, False))
        self.assertIsNone(locate(original, mask, stock, False))

    def test_coloured_strap_recovers_both_paint_banks_beneath_pale_type(self):
        import runpy
        restore = runpy.run_path(str(RUNTIME / "qwen_typeset_stock.py"))["restore_colour_strap"]
        y, x = np.indices((72, 270))
        grad = (4*np.sin(x/21) + y*.07).astype(np.int16)
        stock = np.stack((221+grad, 126+grad, 23+grad), axis=2).astype(np.uint8)
        region = (x > 23) & (x < 248) & (y > 24) & (y < 49)
        face = region & ((x%17 < 4) | ((y%14 < 4) & (x%17 < 12)))
        source = stock.copy()
        source[face] = [255, 244, 219]
        decoded = stock.copy()
        decoded[face] = [249, 226, 183]
        before = decoded.copy()
        allowed = x < 223
        self.assertTrue(restore(source, region, decoded, allowed))
        sample = allowed & face
        self.assertLess(abs(decoded.astype(float)-stock)[sample].mean(), 2)
        np.testing.assert_array_equal(decoded[~allowed], before[~allowed])
        self.assertFalse(restore(source, region, stock.copy(), allowed))

    def test_wall_uses_multiple_original_rails_and_preserves_an_unwritable_region(self):
        import runpy
        from scipy.ndimage import distance_transform_edt
        restore = runpy.run_path(str(RUNTIME / "qwen_ruled_wall.py"))["restore_ruled_wall"]
        y, x = np.indices((236, 170))
        background = 241 - .075*y
        rails = [47, 70, 93, 119]
        truth = background.copy()
        for center in rails:
            truth -= 85*np.exp(-.5*((x-center)/.8)**2)
        marked = (x > 40) & (x < 115) & (y > 44) & (y < 187)
        letters = marked & (x % 21 < 6) & (y % 24 < 12)
        source = truth.copy()
        source[distance_transform_edt(~letters) < 3.7] = 255
        source[letters] = 33
        drift = np.where(marked, 2*np.sin((y-42)*np.pi/136)**2, 0)
        decoded = background.copy()
        for center in rails:
            decoded -= 85*np.exp(-.5*((x-center-drift)/.8)**2)
        image = rgba(decoded, 255)
        protected = x > 108
        original = image.copy()
        permitted = ~protected
        self.assertTrue(restore(rgba(source, 255), marked, image, permitted))
        # This rail is repeatedly visible between the simulated characters.
        # The left-hand rails have long sections without a measurable nib.
        sample = marked & (abs(x-93) < 5) & (y > 85) & (y < 146)
        self.assertLess(abs(image[:, :, 0].astype(float)-truth)[sample].mean(),
                        .60*abs(original[:, :, 0].astype(float)-truth)[sample].mean())
        np.testing.assert_array_equal(image[protected], original[protected])
        self.assertFalse(restore(rgba(background, 255), marked, image, permitted))

    def test_parallel_rules_resume_the_source_phase_within_the_original_outline(self):
        import runpy
        restore = runpy.run_path(str(RUNTIME / "qwen_parallel_rules.py"))["restore_parallel_rules"]
        y, x = np.indices((160, 230))
        curve = 35 + ((x - 110) / 19)**2
        rows = np.rint(229 + 22*np.cos(2*np.pi*.364*y))
        tone = np.where(y > curve + 2, rows, np.where(y >= curve, 47, 255))
        truth = rgba(tone, 255)[:, :, :3]
        ink = (x > 79) & (x < 146) & (y > 24) & (y < 112)
        source = truth.copy()
        source[ink & ((x % 9) < 4)] = 32
        raw = truth.copy()
        inside = ink & (y > curve + 3)
        raw[inside] = np.rint(232 + 11*np.cos(.8+2*np.pi*.390*y[inside]))[:, None]
        error = np.abs(raw.astype(float) - truth)
        self.assertTrue(restore(source, ink, raw))
        safe = inside & (y > curve + 9)
        self.assertLess(np.abs(raw.astype(float)-truth)[safe].mean(), error[safe].mean()*.22)
        np.testing.assert_array_equal(raw[y < curve], truth[y < curve])
        flat = np.full_like(source, 239)
        self.assertFalse(restore(flat, ink, raw))

    def test_fading_highlight_uses_the_scan_to_recover_the_shaded_side_of_the_edge(self):
        import runpy
        restore = runpy.run_path(str(RUNTIME / "qwen_fading_highlight.py"))["restore_fading_highlight"]
        y, x = np.indices((170, 220))
        depth = y - (61-.18*x)
        shade = np.where(depth > 0, 23*np.exp(-np.maximum(depth, 0)/25), 0)
        truth = rgba(255-shade, 255)[:, :, :3]
        mask = (x > 81) & (x < 148) & (y > 18) & (y < 119)
        source = truth.copy()
        letters = mask & (x % 13 < 4) & (y % 17 < 12)
        source[letters] = 18
        raw = truth.copy()
        raw[mask] = np.rint(255-1.8*shade[mask])[:, None]
        original = raw.copy()
        self.assertTrue(restore(source, mask, raw))
        local = mask & (depth > 4) & (depth < 35)
        self.assertLess(np.abs(raw.astype(float)-truth)[local].mean(),
                        .35*np.abs(original.astype(float)-truth)[local].mean())
        np.testing.assert_array_equal(raw[:, :69], truth[:, :69])
        self.assertFalse(restore(source, mask, truth.copy()))

    def test_a_selected_letter_crossing_a_rule_matches_the_adjacent_scanned_paper(self):
        import runpy
        restore = runpy.run_path(str(RUNTIME / "qwen_paper_banks.py"))["match_ruled_paper"]
        y, x = np.indices((129, 155))
        frame = (y >= 38) & (y <= 42)
        art = (x >= 107) & (y > 44)
        truth = rgba(np.where(frame, 23, np.where(art, 207, 255)), 255)[:, :, :3]
        letters = ((abs(x-70) <= 4) & (y >= 31) & (y <= 95)) | ((y >= 63) & (y <= 69) & (abs(x-70) < 21))
        mask = letters.copy()
        source, edited = truth.copy(), truth.copy()
        source[letters] = 36
        edited[mask & ~frame] = 249
        self.assertTrue(restore(source, mask, edited, np.ones_like(mask)))
        self.assertEqual(int(edited[68, 69, 1]), 255)
        np.testing.assert_array_equal(edited[frame | art], truth[frame | art])
        shaded = source.copy()
        shaded[(~letters) & (~frame)] = 241
        self.assertFalse(restore(shaded, mask, edited.copy(), None))

    def test_faint_pencil_banks_need_a_matching_suggested_contour_in_the_gap(self):
        import runpy
        restore = runpy.run_path(str(RUNTIME / "qwen_crossing_ink.py"))["restore_faint_banks"]
        y, x = np.indices((84, 87))
        center = 48-.16*(y-22)
        nib = np.exp(-.5*((x-center)/1.1)**2)
        bank = ((y >= 22) & (y <= 30)) | ((y >= 44) & (y <= 67))
        source = 254.-110*nib*bank
        model = 254.-29*nib
        clear = np.full(x.shape, 6.)
        allowed = np.ones(x.shape, bool)
        result = np.full(x.shape, 254.)
        restore(source, model, clear, result, allowed)
        self.assertLess(result[37,46], 178)
        self.assertEqual(result[37,39], 254)
        before = np.full(x.shape, 254.)
        restore(source, np.roll(model, 8, axis=1), clear, before, allowed)
        np.testing.assert_array_equal(before, np.full(x.shape, 254.))

    def test_repeated_glass_edges_need_exposed_pigment_on_both_interleaved_row_sets(self):
        import runpy
        match = runpy.run_path(str(RUNTIME / "qwen_glass_ribs.py"))["exposed_outer_pen"]
        y, x = np.indices((29, 51))
        gray = np.where(x < 24, 248, np.where(x == 24, 97, 176))
        source = rgba(gray, 255)[:, :, :3]
        hidden = (y > 11) & (x >= 22) & (x <= 25)
        lip, front = np.full(x.shape, 18.), np.full(x.shape, 45.)
        edge, density = match(source, hidden, x, y, lip, front, 5)
        np.testing.assert_allclose(edge, 24)
        self.assertAlmostEqual(density, 97/176)
        hidden[1::2] = True
        self.assertIsNone(match(source, hidden, x, y, lip, front, 5))

    def test_a_screened_outline_uses_the_original_ends_on_each_side_of_a_displaced_edit(self):
        import runpy
        from unittest.mock import patch
        with patch.object(sys, "path", [str(RUNTIME), *sys.path]):
            match = runpy.run_path(str(RUNTIME / "qwen_screen_outline.py"))["match_both_ends"]
        steps = np.arange(-28., 29.)
        edit = -8.*np.exp(-.5*(steps/8)**2)
        native = np.where(abs(steps) > 13, edit, np.nan)
        before, after, left, right = match(steps, edit, native)
        self.assertLess(before[28], -7)
        self.assertAlmostEqual(after[28], 0.)
        np.testing.assert_array_equal(after[steps < left], before[steps < left])
        native[steps > 0] = np.nan
        self.assertIsNone(match(steps, edit, native))

    def test_crossed_cloth_stripes_preserve_both_directions_across_a_withheld_patch(self):
        import runpy
        from unittest.mock import patch
        with patch.object(sys, "path", [str(RUNTIME), *sys.path]):
            fit = runpy.run_path(str(RUNTIME / "qwen_woven_screen.py"))["woven_density"]
        y, x = np.indices((99, 106))
        actual = 173 + 18*np.cos(.27*x) + 16*np.sin(.31*y) + 4*np.cos(.27*x)*np.sin(.31*y)
        missing = (abs(x-54) < 14) & (abs(y-46) < 18)
        result = fit(np.where(missing, 22, actual), ~missing, (0., 0.), 4, 30)
        self.assertLess(abs(result[missing]-actual[missing]).mean(), 3)

    def test_small_hollow_kana_clears_white_stock_and_keeps_the_neighbouring_screen(self):
        import runpy
        from scipy.ndimage import distance_transform_edt
        repair = runpy.run_path(str(RUNTIME / "qwen_paper_banks.py"))["restore_small_outlined_paper"]
        y, x = np.indices((112, 124))
        field = (x > 63 + .38*(y-45)) & ((x+y) % 5 < 2)
        truth = rgba(np.where(field, 81, 255), 255)[:, :, :3]
        filled = ((abs(x-43) < 4) & (abs(y-42) < 13)) | ((abs(x-54) < 4) & (abs(y-51) < 8))
        core = filled & (distance_transform_edt(filled) <= 2)
        marked = distance_transform_edt(~filled) <= 3.5
        source, result = truth.copy(), truth.copy()
        source[core] = 32
        result[marked] = 250
        self.assertTrue(repair(source, marked, result, np.ones_like(marked)))
        np.testing.assert_array_equal(result[~marked], truth[~marked])
        safe_paper = distance_transform_edt(~field) > 10
        np.testing.assert_array_equal(result[marked & safe_paper], truth[marked & safe_paper])
        self.assertLess(np.abs(result[marked].astype(float)-truth[marked]).mean(), .55)
        wide = distance_transform_edt(~filled) <= 9
        result[marked] = 250
        self.assertFalse(repair(source, wide, result, np.ones_like(marked)))

    def test_dialogue_wash_returns_to_native_scan_outside_the_actual_white_press(self):
        import runpy
        from scipy.ndimage import distance_transform_edt
        restore = runpy.run_path(str(RUNTIME / "qwen_typeset_stock.py"))["restore_typeset_stock"]
        y, x = np.indices((165, 154))
        true = np.rint(237 + 4*np.sin(y/23) + 2*np.cos(x/17) + 1.6*np.sin(2*x+y))
        ink = (y > 32) & (y < 130) & ((y % 25) < 17) & (x > 48) & (x < 111) & (x % 35 < 9)
        distance = distance_transform_edt(~ink)
        source = rgba(np.where(ink, 26, np.where(distance < 3.6, 254, true)), 255)[:, :, :3]
        truth = rgba(true, 255)[:, :, :3]
        prediction = rgba(true - np.rint(9*np.exp(-.5*(distance/7)**2)), 255)[:, :, :3]
        self.assertTrue(restore(source, ink, prediction))
        self.assertLess(abs(prediction[ink].astype(float)-truth[ink]).mean(), 2.8)
        np.testing.assert_array_equal(prediction[distance >= 10], truth[distance >= 10])
        colour = source.copy()
        colour[:, :, 2] = 65
        self.assertFalse(restore(colour, ink, prediction.copy()))

    def test_registered_screened_fan_requires_continued_rays_under_type(self):
        import runpy
        restore = runpy.run_path(str(RUNTIME / "qwen_radial_stock.py"))["registered_screened_rays"]
        y, x = np.indices((217, 421))
        angle = np.arctan2(y-337, x-199)
        shade = 247 - 56*np.maximum(0., np.cos(96*angle))**3
        native = np.clip(shade + 14*np.cos(1.6*x+1.7*y)*np.cos(1.65*x-1.6*y), 0, 255)
        ink = (x > 32) & (x < 391) & (y > 55) & (y < 159) & ((x % 41 < 17) | (y % 43 < 13))
        source = rgba(np.where(ink, 33, native), 255)[:, :, :3]
        restored = rgba(native, 255)[:, :, :3]
        valid = np.ones_like(ink)
        protected = restore(source, restored, ink, valid)
        self.assertIsNotNone(protected)
        self.assertGreater(protected[ink].mean(), .83)
        erased = restored.copy()
        erased[ink] = 243
        self.assertIsNone(restore(source, erased, ink, valid))

    def test_partial_screen_repair_preserves_the_crossing_pen_and_requires_a_native_dot_pattern(self):
        import runpy
        from scipy.ndimage import distance_transform_edt
        restore = runpy.run_path(str(RUNTIME / "qwen_crossed_screen.py"))["restore_screen_beside_pen"]
        frequencies = runpy.run_path(str(RUNTIME / "qwen-screen-detail.py"))["screen_frequencies"]
        y, x = np.indices((168, 190))
        mean = 194 + .13*x + .03*y
        dot = 18*np.cos(1.49*x+1.52*y) + 16*np.sin(1.56*x-1.47*y)
        pen = abs(y-116+.14*(x-42)) <= 4
        truth = np.where(pen, 24, np.clip(mean+dot, 0, 255))
        ink = (x > 46) & (x < 139) & (y > 44) & (y < 133) & ((x % 25 < 11) | (y % 26 < 9))
        reach = distance_transform_edt(~ink)
        source = np.where(ink, 28, np.where(reach < 2.5, 253, truth))
        edited = np.where(pen, truth, np.where(ink, mean-14+.42*dot, truth))
        baseline = np.rint(edited).astype('u1')
        result = np.repeat(baseline[:, :, None], 3, axis=2)
        protected = np.ones_like(ink)
        protected[78:81, 91:96] = False
        self.assertTrue(restore(source, edited, ink, result, protected, frequencies))
        covered = ink & (distance_transform_edt(~pen) > 21) & protected
        before = abs(baseline[covered].astype(float)-truth[covered]).mean()
        self.assertLess(abs(result[covered, 0].astype(float)-truth[covered]).mean(), .48*before)
        np.testing.assert_array_equal(result[pen | ~protected, 0], baseline[pen | ~protected])
        self.assertFalse(restore(source, edited, ink, result, protected, lambda *args: []))
        self.assertFalse(restore(source, truth, ink, result, protected, frequencies))

    def test_darkened_letter_on_dotted_gradient_needs_the_same_optical_phase(self):
        import runpy
        from scipy.ndimage import distance_transform_edt, gaussian_filter
        screen = runpy.run_path(str(RUNTIME / "qwen_crossed_screen.py"))
        frequencies = runpy.run_path(str(RUNTIME / "qwen-screen-detail.py"))["screen_frequencies"]
        y, x = np.indices((133, 188))
        level = 170 + .33*x + .012*y
        dot = 16*np.sin(1.59*x+1.42*y) + 14*np.cos(1.48*x-1.56*y)
        truth = rgba(level+dot, 255)[:, :, :3]
        ink = (x > 38) & (x < 129) & (y > 39) & (y < 91) & ((x % 29 < 9) | (y % 25 < 6))
        gap = distance_transform_edt(~ink)
        source = rgba(np.where(ink, 24, np.where(gap < 3.5, 253, level+dot)), 255)[:, :, :3]
        prediction = rgba(level+.48*dot - 18*np.exp(-.5*(gap/5)**2), 255)[:, :, :3]
        low = gaussian_filter(source[:, :, 1].astype(float), 1.7)
        guide = gaussian_filter(prediction[:, :, 1].astype(float), 1.7)
        bank = (gap > 8) & (gap < 35)
        self.assertTrue(screen["restore_darkened_gradient"](source[:, :, 1].astype(float), low,
            guide, level, bank, ink, gap < 5, prediction, None, frequencies))
        self.assertLess(abs(prediction[ink].astype(float)-truth[ink]).mean(), 3)
        changed = low.copy()
        changed[:, :57] -= 31
        self.assertFalse(screen["restore_darkened_gradient"](source[:, :, 1].astype(float), changed,
            guide, level, bank, ink, gap < 5, prediction, None, frequencies))

    def test_recovers_the_smooth_tone_between_curved_dark_banks(self):
        import runpy
        restore = runpy.run_path(str(RUNTIME / "qwen_ribbon_stock.py"))["restore_ribbon_stock"]
        y, x = np.indices((160, 375))
        edge = 62+.00038*(x-170)**2-.11*x
        across = y-edge
        material = np.clip(across+.5, 0, 1)*np.clip(37.5-across, 0, 1)
        tone = np.rint(7+material*(111+.032*x+.064*across))
        mask = (y > 12) & (y < 136) & ((abs(x-108) < 18) | (abs(x-208) < 23))
        letters = mask & ((x % 15 < 7) | (y % 21 < 8))
        source = rgba(np.where(letters, 10, np.where(mask, 252, tone)), 255)[:, :, :3]
        original = rgba(tone, 255)[:, :, :3]
        paper = np.ones_like(mask)
        self.assertFalse(restore(source, mask, original.copy(), paper))
        noise = np.random.default_rng(211).normal(4, 12, x.shape)
        painted = np.where(mask & (material > .8), np.clip(tone+noise, 0, 255), tone)
        sample = rgba(painted, 255)[:, :, :3]
        unchanged = sample.copy()
        self.assertTrue(restore(source, mask, sample, paper))
        interior = mask & (across > 6) & (across < 31)
        self.assertLess(abs(sample[:, :, 1][interior].astype(float)-tone[interior]).mean(), 2)
        np.testing.assert_array_equal(sample[~mask], unchanged[~mask])
        self.assertFalse(restore(source, mask, unchanged.copy(), ~mask))

    def test_paper_tone_does_not_darken_a_light_screen_or_cross_the_panel_rule(self):
        import runpy
        from scipy.ndimage import distance_transform_edt
        restore = runpy.run_path(str(RUNTIME / "qwen_light_screen.py"))["restore_pale_caption_tone"]
        y, x = np.indices((178, 190))
        noise = np.random.default_rng(61).normal(0, 4.7, x.shape)
        truth = np.rint(np.clip(249.5+.019*(x-90)+noise, 0, 255))
        truth[x < 29] = 28
        mask = (x > 63) & (x < 119) & (y > 61) & (y < 115) & ((x % 20 < 5) | (y % 23 < 4))
        halo = distance_transform_edt(~mask) < 6
        src = rgba(np.where(mask, 13, truth), 255)[:, :, :3]
        clean = rgba(truth, 255)[:, :, :3]
        self.assertFalse(restore(src, mask, clean.copy(), None))
        decoded = rgba(np.where(halo, truth-7, truth), 255)[:, :, :3]
        before = decoded.copy()
        self.assertTrue(restore(src, mask, decoded, None))
        self.assertLess(abs(decoded[mask].astype(float)-clean[mask]).mean(), 3)
        np.testing.assert_array_equal(decoded[~halo], before[~halo])
        self.assertFalse(restore(src, mask, before, x != 85))

    def test_removes_only_an_isolated_impossibly_dark_dot_on_registered_native_print(self):
        import runpy
        restore = runpy.run_path(str(RUNTIME / "qwen_crossed_screen.py"))["restore_residual_print_dots"]
        frequencies = runpy.run_path(str(RUNTIME / "qwen-screen-detail.py"))["screen_frequencies"]
        y, x = np.indices((161, 162))
        dots = 14*np.cos(2*np.pi*(x/4+y/7)) + 9*np.sin(2*np.pi*(y/4-x/7))
        tone = np.rint(np.clip(242-.29*y+dots, 0, 255))
        truth = rgba(tone, 255)[:, :, :3]
        mask = (x >= 65) & (x < 89) & (y >= 42) & (y < 111)
        src = rgba(np.where(mask, 15, tone), 255)[:, :, :3]
        decoded = truth.copy()
        self.assertFalse(restore(src, mask, decoded, None, frequencies))
        decoded[69, 75] = 110
        before = decoded.copy()
        self.assertFalse(restore(src, mask, decoded, x != 75, frequencies))
        self.assertTrue(restore(src, mask, decoded, None, frequencies))
        self.assertLess(abs(decoded[69, 75].astype(float)-truth[69, 75]).max(), 9)
        unchanged = (y != 69) | (x != 75)
        np.testing.assert_array_equal(decoded[unchanged], before[unchanged])

    def test_keeps_the_measured_pale_face_under_saturated_title_outlines(self):
        import runpy
        recover = runpy.run_path(str(RUNTIME / "qwen_printed_badge.py"))["recover_covered_pale_details"]
        y, x = np.indices((222, 216))
        radius = np.sqrt(((x-106.1)/23.2)**2 + ((y-109.3)/17.4)**2)
        edge = np.clip(.5 + 18*(1-radius), 0, 1)
        paper = np.rint(14 + (236-14)*edge)
        caption = (x > 106) & (x < 137) & (y > 74) & (y < 117)
        border = ((x > 45) & (x < 166) & (y > 38) & (y < 71)) | caption
        letters = border & (x % 15 > 4) & (x % 15 < 11) & (y % 12 > 3) & (y % 12 < 10)
        printed = rgba(np.where(letters, 9, np.where(border, 255, paper)), 255)[:, :, :3]
        mask = (x > 42) & (x < 169) & (y > 33) & (y < 144)
        model = rgba(np.full_like(x, 14), 255)[:, :, :3]
        valid = np.ones_like(mask)
        self.assertTrue(recover(printed, mask, model, valid))
        self.assertGreater(model[:, :, 1][caption & (radius < .86)].mean(), 227)
        np.testing.assert_array_equal(model[:, :, 1][radius > 1.25], 14)
        obscured = valid.copy()
        obscured[108, 107] = False
        self.assertFalse(recover(printed, mask, model.copy(), obscured))

    def test_reconstructs_sparse_dots_in_phase_and_preserves_adjacent_illustration(self):
        import runpy
        restore = runpy.run_path(str(RUNTIME / "qwen_dot_stock.py"))["restore_dot_stock"]
        y, x = np.indices((138, 214))
        u, v = (x+y+2.3)/10.43, (x-y+.4)/10.43
        radius = ((u-np.rint(u))**2 + (v-np.rint(v))**2)*10.43**2/2
        paper = np.rint(249-222*np.exp(-.5*radius/1.14**2)).astype(np.uint8)
        paper[(x < 52) & (y < 65)] = 38
        letters = (x > 57) & (x < 133) & (y > 65) & (y < 81) & ((x % 17 < 4) | (y % 19 < 3))
        from scipy.ndimage import distance_transform_edt
        selection = distance_transform_edt(~letters) < 3.5
        source = rgba(np.where(letters, 6, paper), 255)[:, :, :3]
        model = rgba(np.where(selection, 229, paper), 255)[:, :, :3]
        self.assertTrue(restore(source, selection, model, np.ones_like(selection)))
        np.testing.assert_array_equal(model[~selection], source[~selection])
        self.assertLess(np.mean(abs(model[:, :, 1][selection].astype(float)-paper[selection])), 7)
        # Scattered dots at the same density cannot establish an underlying lattice.
        noisy = np.random.default_rng(823).permutation(paper.ravel()).reshape(paper.shape)
        self.assertFalse(restore(rgba(noisy, 255)[:, :, :3], selection, model, np.ones_like(selection)))

    def test_reconstructs_a_tall_pause_in_a_dot_screen_with_a_native_rule_beside_it(self):
        import runpy
        from scipy.ndimage import distance_transform_edt
        restore = runpy.run_path(str(RUNTIME / "qwen_dot_stock.py"))["restore_dot_stock"]
        y, x = np.indices((350, 240))
        u, v = (x+y+2.3)/15.32, (x-y+.4)/15.32
        radius = ((u-np.rint(u))**2+(v-np.rint(v))**2)*15.32**2/2
        stock = np.rint(252-226*np.exp(-.5*radius/1.11**2)).astype(np.uint8)
        stock[:, 38:42] = 13
        strokes = (x > 86) & (x < 149) & (y > 75) & (y < 269) & (
            ((x + y//7) % 40 < 8) | (y % 45 < 9))
        to_print = distance_transform_edt(~strokes)
        mask = to_print < 7
        source = rgba(np.where(strokes, 9, np.where(to_print < 4, 253, stock)), 255)[:, :, :3]
        model = rgba(np.where(mask, 254, stock), 255)[:, :, :3]
        valid = np.ones_like(mask)
        self.assertTrue(restore(source, mask, model, valid))
        self.assertLess(np.mean(abs(model[:, :, 0][mask].astype(float)-stock[mask])), 6)
        np.testing.assert_array_equal(model[:, 38:42, 1], stock[:, 38:42])
        hidden_banks = mask.copy()
        untouched = model.copy()
        self.assertFalse(restore(source, mask, model, hidden_banks))
        np.testing.assert_array_equal(model, untouched)

    def test_replaces_lost_irregular_grain_only_with_matching_original_paper(self):
        import runpy
        restore = runpy.run_path(str(RUNTIME / "qwen_print_grain.py"))["restore_stipple"]
        y, x = np.indices((194, 214))
        paper = np.rint(np.maximum(121, 255-np.random.default_rng(67).exponential(18, x.shape)))
        mask = ((x > 83) & (x < 104) & (y > 72) & (y < 109))
        ink = mask & ((x % 11 < 4) | (y % 12 < 3))
        actual = rgba(np.where(ink, 9, paper), 255)[:, :, :3]
        estimate = rgba(np.where(mask, 237, paper), 255)[:, :, :3]
        valid = np.ones_like(mask)
        self.assertTrue(restore(actual, mask, estimate, valid))
        self.assertGreater(estimate[:, :, 1][mask].std(), 12)
        np.testing.assert_array_equal(actual[~mask], estimate[~mask])
        # A line leaving the selected lettering keeps its own restoration.
        actual[90:92, 103:145] = 17
        before = estimate.copy()
        self.assertFalse(restore(actual, mask, estimate, valid))
        np.testing.assert_array_equal(estimate, before)

    def test_continues_only_a_measured_oblique_rule_on_both_sides_of_a_knockout(self):
        import runpy
        restore = runpy.run_path(str(RUNTIME / "qwen_perspective_ink.py"))["restore_perspective_ink"]
        y, x = np.indices((113, 176))
        center = 55.5-.063*(x-88)
        native = np.rint(253-245*np.exp(-.5*((y-center)/.78)**2)).astype('u1')
        mask = (x >= 64) & (x < 106) & (y >= 36) & (y < 75)
        print_ink = mask & ((x % 16 < 5) | (y % 15 < 4))
        source = rgba(np.where(print_ink, 9, np.where(mask, 253, native)), 255)
        out = rgba(np.where(mask, 249, native), 255)
        initial = out.copy()
        valid = np.ones_like(mask)
        self.assertTrue(restore(source, mask, out, valid))
        core = mask & (abs(y-center) < 1.4)
        self.assertLess(np.mean(abs(out[:,:,0][core].astype(float)-native[core])), 12)
        np.testing.assert_array_equal(out[abs(y-center) > 5], initial[abs(y-center) > 5])
        source[:,106:,:3] = 253
        trial = initial.copy()
        self.assertFalse(restore(source, mask, trial, valid))
        np.testing.assert_array_equal(trial, initial)

    def test_display_hatching_restores_hidden_paper_without_copying_type_or_tinting_the_scan(self):
        from runpy import run_path
        from scipy.ndimage import distance_transform_edt

        restore = run_path(str(RUNTIME / "qwen_hatching.py"))["restore_display_hatching"]
        y, x = np.indices((660, 980))
        phase = (x + y // 7 + 3 * (x // 31)) % 14
        paper = np.where((phase < 3) & ((y + 5 * (x // 14)) % 21 < 14), 112, 254).astype("u1")
        mask = np.zeros_like(paper, bool)
        plates = [np.s_[top:top+155, left:left+153]
                  for top in (100, 346) for left in (95, 345, 595)]
        for plate in plates:
            mask[plate] = True
        distance = distance_transform_edt(~mask)
        scan = paper.copy()
        scan[distance <= 12] = 255
        for plate, ink in zip(plates, (0, 68, 0, 94, 0, 0)):
            scan[plate] = ink
        printed = np.repeat(scan[:, :, None], 3, axis=2)
        result = restore(printed, mask)
        self.assertIsNotNone(result)
        repaired = result[:, :, 0]
        self.assertFalse(np.any(np.ptp(result, axis=2)))
        self.assertTrue(np.array_equal(repaired[distance > 21], scan[distance > 21]))
        self.assertFalse(np.any(repaired[mask] == scan[mask]))
        self.assertLess(abs(float(repaired[mask].mean() - paper[mask].mean())), 2)
        self.assertGreater((repaired[mask] < 180).mean(), .07)
        printed[0, 0, 1] = 1
        self.assertIsNone(restore(printed, mask))
        self.assertIsNone(restore(np.full_like(printed, 255), mask))

    def test_a_graded_dot_screen_is_recovered_across_an_outlined_sound(self):
        import runpy
        from scipy.ndimage import distance_transform_edt
        restore = runpy.run_path(str(RUNTIME / "qwen_screen_edge.py"))["restore_sound_screen_rows"]
        y, x = np.indices((172, 174))
        phase = (x + 2.68*(y//3 % 2) + 2.68) % 5.36 - 2.68
        native = np.rint(255-(219-.52*y)*np.exp(-.52*(phase**2+((y+1)%3-1)**2))).astype('u1')
        ink = ((y > 31) & (y < 103) & (abs(x-(63+.23*y)) < 2.6))
        for col in (87, 98, 109):
            ink[106:124,col:col+4] = ink[128:132,col:col+4] = True
        mask = distance_transform_edt(~ink) < 5.5
        rgb = lambda a: np.repeat(a[:, :, None], 3, axis=2)
        source = rgb(np.where(ink, 9, np.where(mask, 252, native)).astype('u1'))
        out = rgb(np.where(mask, 142, native).astype('u1'))
        valid = np.ones_like(mask)
        self.assertTrue(restore(source, mask, out, valid))
        self.assertLess(np.mean(abs(out[:,:,0][ink].astype(float)-native[ink])), 14)
        np.testing.assert_array_equal(out[distance_transform_edt(~mask)>3], rgb(native)[distance_transform_edt(~mask)>3])
        # A real pen from outside the selected word invalidates a sheet of uniform dots.
        source[65:68, 43:103] = 8
        before = out.copy()
        self.assertFalse(restore(source, mask, out, valid))
        np.testing.assert_array_equal(out, before)

    def test_retains_native_hatch_banks_beyond_the_measured_brush_outline(self):
        import runpy
        from scipy.ndimage import distance_transform_edt
        restore = runpy.run_path(str(RUNTIME / "qwen_sound_contours.py"))["preserve_sound_banks"]
        y, x = np.indices((110, 145))
        ink = np.zeros_like(x, dtype=bool)
        for col in (30, 61, 92):
            ink[37:63, col:col+9] = True
        dist = distance_transform_edt(~ink)
        original = np.where((x+y) % 3 == 0, 124, 213).astype("u1")
        original[(x == 49) & (y > 29)] = 19
        rgb = lambda v: np.repeat(v[:, :, None], 3, axis=2)
        marked = rgb(np.where(ink, 15, np.where(dist < 6.3, 252, original)).astype("u1"))
        out = np.full_like(marked, 187)
        self.assertTrue(restore(marked, ink, out))
        self.assertEqual(out[45,49,0], 19)
        self.assertEqual(out[45,34,0], 187)
        self.assertEqual(out[45,42,0], 187)
        flat = rgb(np.where(ink, 15, original).astype("u1"))
        self.assertFalse(restore(flat, ink, out))

    def test_dark_screen_preserves_bright_and_dark_dot_phases_together(self):
        import runpy
        from scipy.ndimage import distance_transform_edt
        contours = runpy.run_path(str(RUNTIME / "qwen_sound_contours.py"))
        y, x = np.indices((114, 152))
        ink = np.zeros_like(x, dtype=bool)
        for col in (32, 64, 96):
            ink[36:75, col:col+8] = True
        distance = distance_transform_edt(~ink)
        phase = (x % 3 == 1) | (y % 3 == 2)
        stock = np.where(phase, 118, 12)
        original = np.where(ink, 5, np.where(distance < 7.2, 255, stock))
        selected = distance < 8.3
        model = np.where(np.roll(phase, 1, axis=1), 118, 12)
        source = rgba(original, 255)[:, :, :3]
        edited = rgba(model, 255)[:, :, :3].copy()
        self.assertTrue(contours["preserve_sound_banks"](source, selected, edited))
        radius = contours["measured_print_shoulder"](original, distance)
        exposed = (distance >= radius+2.1) & (distance < radius+3.5)
        np.testing.assert_array_equal(edited[:, :, 0][exposed], stock[exposed])
        np.testing.assert_array_equal(edited[:, :, 0][ink], model[ink])

    def test_registered_screen_ends_at_the_native_paper_edge_behind_lettering(self):
        import runpy
        from scipy.ndimage import distance_transform_edt
        repair = runpy.run_path(str(RUNTIME / "qwen_screen_edge.py"))["restore_column_screen_edge"]
        y, x = np.indices((194, 186))
        dot = 255-238*np.exp(-(((x+y+3) % 8-4)**2+((x-y+3) % 8-4)**2)/8.2)
        edge = 72 + ((x-93)/28)**2
        ground = np.rint(255+(dot-255)*np.clip(edge-y+.5, 0, 1)).astype("u1")
        mask = np.zeros_like(y, dtype=bool)
        for top in (54, 83, 105, 127):
            mask[top:top+13, 90:93] = True
            mask[top+8:top+11, 92:99] = True
        shoulder = distance_transform_edt(~mask) < 5
        source = ground.copy()
        source[shoulder] = 255
        source[mask] = 22
        decoded = ground.copy()
        decoded[shoulder] = 234
        rgb = lambda gray: np.repeat(gray[:, :, None], 3, axis=2)
        out = rgb(decoded)
        self.assertTrue(repair(rgb(source), mask, out))
        dark = mask & (y < 68) & (ground < 175)
        self.assertGreater(dark.sum(), 5)
        self.assertLess(np.mean(abs(out[:,:,0][dark].astype(float)-ground[dark])), 15)
        self.assertEqual(out[111,91,0], 255)
        np.testing.assert_array_equal(out[distance_transform_edt(~mask)>9], rgb(ground)[distance_transform_edt(~mask)>9])
        flat = rgb(np.where(mask, 23, 255).astype('u1'))
        before = flat.copy()
        self.assertFalse(repair(flat, mask, before))
        np.testing.assert_array_equal(before, flat)

    def test_curved_balloon_needs_visible_pen_between_the_selected_letters(self):
        import runpy
        from scipy.ndimage import distance_transform_edt, label
        measure = runpy.run_path(str(RUNTIME / "qwen-reconnect-balloon.py"))["covered_arc"]
        p, q = np.array([75, 26]), np.array([75, 146])
        v, w = np.array([-.45, np.sqrt(1-.45**2)]), np.array([-.45, -np.sqrt(1-.45**2)])
        ends = [(p, v, 1, 20, 4), (q, w, 1, 25, 5)]
        t = np.linspace(0, 1, 241)[:, None]
        line = (2*t**3-3*t*t+1)*p+(t**3-2*t*t+t)*120*v+(-2*t**3+3*t*t)*q-(t**3-t*t)*120*w
        x, y = np.rint(line).astype(int).T
        gray = np.full((171, 158), 255, dtype=np.uint8)
        marked = np.zeros_like(gray, dtype=bool)
        for row in range(32, 144, 15):
            center = int(np.median(x[y==row]))
            marked[row:row+6, center-8:center+9] = True
        gray[marked] = 20
        dist = distance_transform_edt(~marked)
        letters = label(marked)[0]
        self.assertIsNone(measure(*ends, gray, dist, letters))
        native = (y >= 55) & (y <= 58)
        gray[y[native], x[native]] = 26
        self.assertIsNotNone(measure(*ends, gray, dist, letters))
        self.assertIsNone(measure(*ends, gray, dist, np.zeros_like(letters)))

    def test_detached_point_follows_its_selected_paired_exclamation_stem(self):
        import runpy
        from scipy.ndimage import distance_transform_edt
        measure = runpy.run_path(str(RUNTIME / "qwen-reconnect-balloon.py"))["paired_terminal_dots"]
        gray = np.full((49, 68), 255, dtype=np.uint8)
        mask = np.zeros_like(gray, dtype=bool)
        for x in [24, 31]:
            gray[10:24, x:x+3] = 30
            gray[27:30, x:x+3] = 30
            mask[10:24, x:x+3] = True
        gray[27:30, 17:20] = 30
        mask[27:30, 31:34] = True
        dots = measure(gray, mask, distance_transform_edt(~mask))
        self.assertTrue(dots[28, 25])
        self.assertFalse(dots[28, 18])
        mask[10:24, 24:27] = False
        self.assertFalse(measure(gray, mask, distance_transform_edt(~mask))[28, 25])

    def test_reconstructs_separate_shaded_speech_columns_from_their_native_dot_banks(self):
        import runpy
        from scipy.ndimage import distance_transform_edt
        repair = runpy.run_path(str(RUNTIME / "qwen_crossed_screen.py"))["restore_balloon_screens"]
        frequencies = runpy.run_path(str(RUNTIME / "qwen-screen-detail.py"))["screen_frequencies"]
        y, x = np.indices((210, 300))
        dots = np.cos(2*np.pi*(x+y)/3.87) + np.cos(2*np.pi*(x-y)/3.87)
        density = 65 + .58*y + .012*x
        original = np.rint(density+26*dots)
        ink = (y > 55) & (y < 151) & ((y-55) % 20 < 15)
        ink &= ((abs(x-78) < 11) | (abs(x-195) < 10)) & ((x % 6 < 3) | (y % 12 < 3))
        radius = distance_transform_edt(~ink)
        printed = np.where(ink, 21, np.where(radius < 4.2, 255, original))
        truth = rgba(original, 255)[:, :, :3]
        source = rgba(printed, 255)[:, :, :3]
        ghost = np.where(radius < 3.3, density-9, np.where(radius < 4.2, 198, original))
        decoded = rgba(ghost, 255)[:, :, :3]
        before = decoded.copy()
        opaque = np.ones_like(ink)
        self.assertTrue(repair(source, ink, decoded, opaque, frequencies))
        target = radius < 4.2
        self.assertLess(np.abs(decoded.astype(float)-truth)[target].mean(),
                        .40*np.abs(before.astype(float)-truth)[target].mean())
        np.testing.assert_array_equal(decoded[radius > 12], truth[radius > 12])
        plain = rgba(np.where(ink, 21, np.where(radius < 4.2, 255, density)), 255)[:, :, :3]
        result = before.copy()
        self.assertFalse(repair(plain, ink, result, opaque, frequencies))
        np.testing.assert_array_equal(result, before)

    def test_only_joins_converging_native_pens_under_a_confirmed_printed_dot(self):
        import runpy
        from scipy.ndimage import distance_transform_edt
        module = runpy.run_path(str(RUNTIME / "qwen_sound_contours.py"))
        pen = runpy.run_path(str(RUNTIME / "qwen-reconnect-balloon.py"))
        y, x = np.indices((130, 155))
        tip_x, tip_y = 63, 64
        delta = x-tip_x
        near = np.minimum(abs(y-tip_y-.26*delta), abs(y-tip_y+.32*delta))
        shade = np.where(delta >= 0, 255-181*np.exp(-.5*(near/.93)**2), 255)
        mask = np.hypot(delta, y-tip_y) < 12
        source = rgba(np.where(mask, 29, shade), 255)[:, :, :3]
        decoded = rgba(np.where(delta < 9, 255, shade), 255)[:, :, :3]
        ys, xs = np.where(mask)
        dot = np.column_stack((xs, ys))
        distance = distance_transform_edt(~mask)
        def repaired(pixels, terminal):
            result = pixels.copy()
            module["restore_obscured_pen_tip"](source, result, mask, distance,
                                              np.ones_like(mask), terminal, pen)
            return result
        result = repaired(decoded, dot)
        self.assertLess(result[tip_y-1:tip_y+2, tip_x:tip_x+4, 0].min(), 208)
        np.testing.assert_array_equal(result[~mask], decoded[~mask])
        np.testing.assert_array_equal(repaired(decoded, dot+[0, 22]), decoded)
        open_ends = np.where(mask[:, :, None], 255, decoded)
        np.testing.assert_array_equal(repaired(open_ends, dot), open_ends)

    def test_preserves_incidental_small_print_only_when_the_registered_decode_agrees(self):
        import runpy
        from scipy.ndimage import distance_transform_edt, label
        restore = runpy.run_path(str(RUNTIME / "qwen_sound_contours.py"))["preserve_registered_small_pen"]
        y, x = np.indices((65, 90))
        # The block selects a nearby character and just grazes a small graphic.
        symbol = (abs(y-32) <= 2) & (x >= 40) & (x < 56)
        target = (x >= 19) & (x <= 25) & (y >= 23) & (y <= 41)
        mask = target | (symbol & (x == 40))
        gray = np.where(target, 19, np.where(symbol, 31+19*abs(y-32)+3*(x-40), 255))
        native = rgba(gray, 255)[:, :, :3]
        groups, k = label(gray < 148, np.ones((3, 3)))
        counts = (groups, np.bincount(groups.ravel(), minlength=k+1),
                  np.bincount(groups[mask], minlength=k+1))
        damaged = native.copy()
        damaged[mask] = 255
        for agrees in (True, False):
            model = native.copy()
            model[target if agrees else target | symbol] = 255
            result = damaged.copy()
            restore(native, result, model, distance_transform_edt(~mask), np.ones_like(mask), gray, counts)
            np.testing.assert_array_equal(result[symbol], (native if agrees else damaged)[symbol])
            np.testing.assert_array_equal(result[target], damaged[target])

    def test_adjacent_printed_stems_leave_no_specks_in_verified_white_stock(self):
        import runpy
        from scipy.ndimage import distance_transform_edt
        restore = runpy.run_path(str(RUNTIME / "qwen_sound_contours.py"))["restore_paired_punctuation_paper"]
        y, x = np.indices((150, 155))
        stems = (abs(x-62) < 7) | (abs(x-83) < 7)
        mark = stems & (((y > 29) & (y < 97)) | ((y > 105) & (y < 114)))
        # A real transverse pen enters unprinted paper on both sides.
        crossing = y == 76
        source = np.where(crossing, 65, 255)
        source = rgba(np.where(mark, 28, source), 255)[:, :, :3]
        distance = distance_transform_edt(~mark)
        valid = np.ones_like(mark)
        ghost = np.where(mark & ~crossing, 249, np.where(crossing, 65, 255))
        ghost[53, 62] = 184
        before = rgba(ghost, 255)[:, :, :3]
        out = before.copy()
        restore(source, mark, out, distance, valid)
        self.assertGreaterEqual(int(out[53, 62, 0]), 254)
        np.testing.assert_array_equal(out[crossing], before[crossing])
        np.testing.assert_array_equal(out[~mark], before[~mark])
        shaded = np.minimum(source, 238)
        alternate = np.minimum(before, 238)
        out = alternate.copy()
        restore(shaded, mark, out, distance, valid)
        np.testing.assert_array_equal(out, alternate)

    def test_registered_sharpness_matches_the_native_scan_only_on_consistent_banks(self):
        import runpy
        from scipy.ndimage import gaussian_filter
        fit = runpy.run_path(str(RUNTIME / "qwen-restore-illustration.py"))["match_native_sharpness"]
        y, x = np.indices((180, 215))
        scan = np.float32(126 + 34*np.sin(x/6.7+y/8.2) + 20*np.sin(y/3.7)
                          + 32*np.cos((x+y)*1.42) + 17*np.sin((x-y)*1.72))
        raw = np.repeat(scan[:, :, None], 3, axis=2)
        target = gaussian_filter(raw, (.8, .8, 0))
        mask = ((x-99)/25)**2 + ((y-85)/30)**2 < 1
        opaque = np.ones_like(mask)
        original = target.copy()
        original[mask] = 12
        np.testing.assert_allclose(fit(original, raw, mask, opaque), target, atol=.01)
        crisp = raw.copy()
        crisp[mask] = 12
        np.testing.assert_array_equal(fit(crisp, raw, mask, opaque), raw)

    def test_registered_fork_requires_one_decoded_bank_and_no_independent_pen(self):
        import runpy
        from scipy.ndimage import distance_transform_edt
        remove = runpy.run_path(str(RUNTIME / "qwen_sound_contours.py"))["remove_decoded_fork"]
        y, x = np.indices((70, 115))
        along, near = x-18., abs(y-27.)
        mark = (x > 24) & (x < 86) & (y > 20) & (y < 53)
        pen = 255-211*np.exp(-.5*((y-27)/.85)**2)
        diagonal = 255-196*np.exp(-.5*((y-27-.30*(x-18))/.82)**2)
        original = rgba(np.where(mark & (x%12<4), 20, np.where(mark, 255, pen)), 255)[:, :, :3]
        scan = rgba(diagonal, 255)[:, :, :3]
        cropped = np.where(mark & (x>44) & (x<71), np.minimum(diagonal, pen), pen)
        valid = np.ones_like(mark)
        check = lambda before, prediction, stencil: remove(original, before, stencil,
            distance_transform_edt(~stencil), near, along, 67., np.full(3, 255.), valid, prediction)
        edited = rgba(cropped, 255)[:, :, :3].copy()
        self.assertTrue(check(edited, scan, mark))
        self.assertGreater(int(edited[38, 55, 0]), 240)
        np.testing.assert_array_equal(edited[27], rgba(cropped, 255)[27, :, :3])
        for other in (rgba(np.minimum(diagonal, pen), 255)[:, :, :3],
                      rgba(pen, 255)[:, :, :3]):
            before = rgba(cropped, 255)[:, :, :3].copy()
            self.assertFalse(check(before, other, mark))
            np.testing.assert_array_equal(before, rgba(cropped, 255)[:, :, :3])

    def test_registered_badge_arm_meets_the_native_tip_and_leaves_open_pen_alone(self):
        import runpy
        from scipy.ndimage import distance_transform_edt
        badge = runpy.run_path(str(RUNTIME / "qwen_printed_badge.py"))
        pen = runpy.run_path(str(RUNTIME / "qwen-reconnect-balloon.py"))
        y, x = np.indices((72, 78))
        trunk = np.hypot(x-25, np.maximum(0, 28-y))
        arm = np.hypot(np.maximum(0, 25-x), y-31.7)
        actual = np.minimum(trunk, np.hypot(np.maximum(0, 25-x), y-28))
        original = rgba(254-221*np.exp(-.5*(actual/1.12)**2), 255)
        mask = (x>=29) & (y<45)
        source = original.copy()
        source[mask, :3] = 32
        edited = rgba(254-212*np.exp(-.5*(np.minimum(trunk,arm)/1.08)**2), 255)
        baseline = edited.copy()
        valid = (x>4) & (x<70) & (y>5) & (y<62)
        guard = distance_transform_edt(~mask)
        badge["join_exposed_corner"](source,edited,guard,valid,np.full(x.shape,16.),pen)
        self.assertLess(int(edited[28,28,0]),int(baseline[28,28,0]))
        np.testing.assert_array_equal(edited[44:],baseline[44:])
        isolated = rgba(254-212*np.exp(-.5*(trunk/1.08)**2), 255)
        keep = isolated.copy()
        badge["join_exposed_corner"](source,isolated,guard,valid,np.full(x.shape,16.),pen)
        np.testing.assert_array_equal(isolated,keep)

    def test_partly_visible_printed_frame_requires_a_separate_native_corner(self):
        import runpy
        from scipy.ndimage import distance_transform_edt
        repair = runpy.run_path(str(RUNTIME / "qwen_printed_badge.py"))["restore_frame"]
        y, x = np.indices((110, 142))
        corners = np.array([[88, 47], [60, 30], [53, 54], [81, 71]], float)
        offset = np.full(x.shape, np.inf)
        for a, b in zip(corners, np.roll(corners, -1, axis=0)):
            vec = b-a
            frac = np.clip(((x-a[0])*vec[0]+(y-a[1])*vec[1])/(vec @ vec), 0, 1)
            offset = np.minimum(offset, np.hypot(x-a[0]-frac*vec[0], y-a[1]-frac*vec[1]))
        ink = 251-180*np.exp(-.5*(offset/1.09)**2)
        mask = ((x-61)/18)**2 + ((y-35)/19)**2 <= 1
        mask |= (x > 55) & (x < 63) & (y > 51) & (y < 61)
        original = rgba(np.where(mask, 34, ink), 255)
        predicted = rgba(np.where(mask, 251, ink), 255)
        axes = np.array([69., 53., 54., 38., 0.])
        valid = np.ones_like(mask)
        repair(original, predicted, distance_transform_edt(~mask), valid, axes)
        self.assertLess(int(predicted[38, 58, 0]), 156)
        np.testing.assert_array_equal(predicted[80:], original[80:])
        unknown = mask | ((x < 65) & (y >= 47) & (y < 63))
        original = rgba(np.where(unknown, 34, ink), 255)
        undecided = rgba(np.where(unknown, 251, ink), 255)
        before = undecided.copy()
        repair(original, undecided, distance_transform_edt(~unknown), valid, axes)
        np.testing.assert_array_equal(undecided, before)

    def test_caption_paper_uses_the_scan_on_both_sides_and_preserves_adjacent_gray(self):
        import runpy
        recover = runpy.run_path(str(RUNTIME / "qwen_paper_banks.py"))["restore_caption_paper"]
        y, x = np.indices((150, 180))
        field = np.where(x < 107, 255, 243)
        mask = (y > 40) & (y < 110) & (x > 48) & (x < 139) & (x % 10 < 3)
        paper = rgba(field, 255)[:, :, :3]
        source = paper.copy()
        source[mask] = 10
        edited = paper.copy()
        edited[(y > 36) & (y < 114) & (x > 46) & (x < 102)] = [250, 249, 250]
        edited[mask & (x > 114)] = 244
        before = edited.copy()
        recover(source, mask, edited, np.ones_like(mask))
        self.assertTrue((edited[54:95, 56:87] == 255).all())
        np.testing.assert_array_equal(edited[:, 114:], before[:, 114:])
        np.testing.assert_array_equal(edited[:32], paper[:32])

    def test_exclamation_residue_is_cleared_only_without_a_continuing_native_line(self):
        import runpy
        from scipy.ndimage import distance_transform_edt
        clean = runpy.run_path(str(RUNTIME / "qwen_sound_contours.py"))["remove_punctuation_remnants"]
        y, x = np.indices((150, 115))
        stem = (abs(x-55) <= 3) & (y >= 39) & (y <= 92)
        dot = (x-55)**2 + (y-103)**2 <= 14
        selected = stem | dot
        line = (x == 55) & (y >= 40) & (y <= 89)
        for continuous in (False, True):
            native = ((x == 55) & (y >= 7) & (y <= 39)) if continuous else np.zeros_like(selected)
            source = rgba(np.where(selected | native, 14, 251), 255)[:, :, :3]
            result = rgba(np.where(line | native, 65, 251), 255)[:, :, :3].copy()
            before = result.copy()
            clean(source, selected, result, distance_transform_edt(~selected), np.ones_like(selected))
            if continuous:
                np.testing.assert_array_equal(result, before)
            else:
                self.assertTrue((result[line] == 251).all())
            np.testing.assert_array_equal(result[~selected], before[~selected])

    def test_faint_pen_resumes_in_the_measured_white_shoulder_of_a_sound(self):
        import runpy
        from scipy.ndimage import distance_transform_edt
        pen = runpy.run_path(str(RUNTIME / "qwen-reconnect-balloon.py"))
        repair = runpy.run_path(str(RUNTIME / "qwen_sound_contours.py"))["restore_short_keyline_gaps"]
        y, x = np.indices((100, 110))
        mask = ((x-47)/10)**2 + ((y-50)/4)**2 <= 1
        line = abs(x-62-.22*(y-50)) < 1.35
        core = (y > 15) & (y < 86) & line
        keyline = distance_transform_edt(~mask) <= 8
        original = rgba(np.where(mask, 12, np.where(core & ~keyline, 84, 251)), 255)
        edited = rgba(np.where(core & ~keyline, 84, 251), 255)
        untouched = edited.copy()
        repair(original, edited, distance_transform_edt(~mask), np.ones(mask.shape, bool), pen)
        self.assertLess(int(edited[50, 62, 0]), 155)
        shifted = np.roll(mask, -24, axis=1)
        check = untouched.copy()
        repair(original, check, distance_transform_edt(~shifted), np.ones(mask.shape, bool), pen)
        np.testing.assert_array_equal(check, untouched)

    def test_model_stipple_is_replaced_only_with_matching_opposite_paper_banks(self):
        import runpy
        repair = runpy.run_path(str(RUNTIME / "qwen_light_screen.py"))["restore_light_paper_grain"]
        y, x = np.indices((112, 152))
        paper = np.uint8(228 + y//12)
        mask = (x > 62) & (x < 89) & (y > 24) & (y < 91)
        guide = rgba(paper + np.where((x+y) % 2, 9, -9), 255)[:, :, :3]
        source = rgba(np.where(mask, 36, paper), 255)[:, :, :3]
        result = np.where(mask[:, :, None], guide, source)
        opaque = np.ones(mask.shape, bool)
        self.assertTrue(repair(source, mask, result, guide, opaque))
        delta = abs(result[:, :, 0].astype(float)-paper)
        self.assertLess(delta[34:78, 68:84].mean(), 1.5)
        np.testing.assert_array_equal(result[~mask], source[~mask])
        isolated = mask.copy()
        unchanged = np.where(mask[:, :, None], guide, source)
        before = unchanged.copy()
        self.assertFalse(repair(source, mask, unchanged, guide, isolated))
        np.testing.assert_array_equal(unchanged, before)

    def test_twinned_kana_mark_is_not_reprinted_next_to_its_selected_partner(self):
        import runpy
        from scipy.ndimage import distance_transform_edt, label
        preserve = runpy.run_path(str(RUNTIME / "qwen_sound_contours.py"))["preserve_exposed_ink"]
        y, x = np.indices((74, 96))
        pen = (y > 20) & (y < 43)
        left = pen & (abs(x-29+.25*(y-30)) < 2.8)
        right = pen & (abs(x-39+.25*(y-30)) < 2.8)
        drawing = (abs(y-51) <= 2) & (x > 34) & (x < 68)
        true = np.where(left | right | drawing, 9, 253)
        source = rgba(true, 255)[:, :, :3]
        predicted = np.full_like(source, 253)
        mask = left | (right & (x <= 36)) | (drawing & (x < 40))
        groups, count = label(true < 148, np.ones((3, 3)))
        components = (groups, np.bincount(groups.ravel()), np.bincount(groups[mask], minlength=count+1))
        preserve(source, predicted, distance_transform_edt(~mask), np.ones(mask.shape, bool), true, components)
        self.assertTrue((predicted[right] == 253).all())
        self.assertLess(int(predicted[51, 46, 0]), 20)

    def test_caption_composite_carries_a_confirmed_decoded_curve_across_its_seam(self):
        import runpy
        recover = runpy.run_path(str(RUNTIME / "qwen-reconnect-balloon.py"))["complete_caption_contours"]
        y, x = np.indices((124, 190))
        stroke = (abs(y-(48+.0016*(x-90)**2)) < 2.4) & (x > 17) & (x < 165)
        gap = (x > 83) & (x < 98)
        mask = (x > 77) & (x < 110) & (y >= 55) & (y < 86)
        original = rgba(np.where(stroke & ~gap, 15, 250), 255)
        original[mask & ((x+y) % 11 < 3), :3] = 40
        edited = rgba(np.where(stroke & ~gap, 15, 250), 255)
        decoded = rgba(np.where(stroke, 15, 250), 255)[:, :, :3].copy()
        decoded[73:76, 70:115] = 19
        recover(original, mask, edited, decoded)
        self.assertLess(int(edited[48, 91, 0]), 25)
        self.assertTrue((edited[73:76, 70:115, 0] == 250).all())

    def test_rule_gap_in_the_white_edge_of_an_outlined_glyph(self):
        import runpy
        restore = runpy.run_path(str(RUNTIME / "qwen_paper_banks.py"))["restore_interrupted_rules"]
        y, x = np.indices((140, 150))
        true = np.where((x >= 70) & (x <= 75), 11, 254).astype('u1')
        original = true.copy()
        original[(y >= 56) & (y < 70) & (x >= 70) & (x <= 75)] = 254
        mask = (x >= 42) & (x <= 67) & (y > 42) & (y < 83)
        original[mask & (y % 7 < 2)] = 28
        source = rgba(original, 255)[:, :, :3]
        prediction = rgba(np.where(mask, 254, original), 255)[:, :, :3].copy()
        self.assertTrue(restore(source, mask, prediction))
        np.testing.assert_array_equal(prediction[:, 70:76, 1], true[:, 70:76])
        bent = true.copy()
        bent[55:70] = np.roll(bent[55:70], 4, axis=1)
        source = rgba(bent, 255)[:, :, :3]
        unchanged = source.copy()
        self.assertFalse(restore(source, mask, unchanged))
        np.testing.assert_array_equal(unchanged, source)

    def test_resumes_two_measured_elliptical_pen_rims_under_the_selected_sound(self):
        import runpy
        from scipy.ndimage import distance_transform_edt
        paint = runpy.run_path(str(RUNTIME / "qwen_printed_badge.py"))["restore_printed_badge"]
        y, x = np.indices((164, 192))
        rho = np.hypot((x-96)/56, (y-84)/36)
        rims = np.minimum(abs(rho-1.0), abs(rho-.83))
        paper = np.uint8(248 - 196*np.exp(-.5*(rims/.025)**2))
        target = np.repeat(paper[:, :, None], 4, 2)
        target[:, :, 3] = 255
        mask = (x > 82) & (x < 107) & (y > 36) & (y < 68)
        source = target.copy()
        source[mask, :3] = 105
        result = target.copy()
        result[mask, :3] = 248
        paint(source, result, distance_transform_edt(~mask), np.ones(mask.shape, bool))
        for row in [48, 54]:
            self.assertLess(int(result[row, 96, 0]), 140)
        self.assertGreater(int(result[51, 96, 0]), 181)
        np.testing.assert_array_equal(result[85:, :, :], target[85:, :, :])

    def test_recovers_the_measured_grain_amplitude_on_flat_paper(self):
        import runpy
        from scipy.ndimage import distance_transform_edt
        paint = runpy.run_path(str(RUNTIME / "qwen_sound_contours.py"))["calibrate_sound_stock"]
        y, x = np.indices((115, 138))
        dots = np.where((x + y) % 2, -1, 1)
        mask = (x > 49) & (x < 88) & (y > 35) & (y < 76)
        paper = np.uint8(167 + 5*dots)
        src = np.repeat(paper[:, :, None], 4, 2)
        src[:, :, 3] = 255
        src[mask, :3] = 251
        edited = src.copy()
        edited[mask, :3] = (163 + 25*dots[mask, None])
        paint(src, edited, distance_transform_edt(~mask), np.ones(mask.shape, bool))
        self.assertLess(np.abs(edited[46:67, 60:77, 0].astype(float)-paper[46:67, 60:77]).mean(), 2)
        np.testing.assert_array_equal(edited[~mask], src[~mask])

    def test_an_exposed_black_silhouette_resolves_a_local_cover_view_disagreement(self):
        import runpy
        reconcile = runpy.run_path(str(RUNTIME / "qwen-restore-illustration.py"))["reconcile_cover_views"]
        y, x = np.indices((150, 240))
        true_ink = ((y > 22) & (y < 99) & (x > 22) & (x < 61))
        truth = np.full((150, 240, 3), 226, 'u1')
        truth[true_ink] = 17
        stencil = (y > 55) & (y < 82) & (x > 20) & (x < 81)
        source = np.dstack([truth, np.full(stencil.shape, 255, 'u1')])
        source[stencil, :3] = 248
        preferred = truth.copy()
        preferred[true_ink] = 218
        other = truth.copy()
        other[30:80, 160:200] = 91
        repaired = reconcile(source, stencil, preferred, other)
        self.assertIsNotNone(repaired)
        self.assertEqual(int(repaired[68, 40, 0]), 17)
        self.assertEqual(int(repaired[56, 181, 0]), 226)
        self.assertIsNone(reconcile(source, stencil, truth, preferred))

    def test_restores_the_local_level_of_an_aligned_decoder_on_a_printed_light_screen(self):
        import runpy
        from scipy.ndimage import distance_transform_edt, gaussian_filter
        measure = runpy.run_path(str(RUNTIME / "qwen_crossed_screen.py"))["calibrated_screen_density"]
        y, x = np.indices((156, 204))
        stock = 177+.18*y+24*np.exp(-((x-y-14)/4.)**2)+19*np.exp(-((x+y-164)/4.)**2)
        ref = np.uint8(np.rint(stock))
        native = gaussian_filter(ref.astype(np.float32), 2.4)
        mask = ((x-96)/22)**2+((y-70)/28)**2 < 1
        distance = distance_transform_edt(~mask)
        ys, xs = np.where(mask)
        bank = (distance > 6) & (distance < 90)
        decoded = rgba(ref-11, 255)[:, :, :3]
        density = measure(native, decoded, bank, distance, None, ys, xs)
        self.assertLess(np.abs(density-native[ys, xs]).mean(), .5)
        self.assertIsNone(measure(native, np.full_like(decoded, 225), bank, distance, None, ys, xs))

    def test_handwriting_on_light_stock_keeps_a_faint_drawn_arc_without_a_gray_word_shadow(self):
        import runpy
        from scipy.ndimage import distance_transform_edt
        restore = runpy.run_path(str(RUNTIME / "qwen_sound_contours.py"))["restore_sound_contours"]
        y, x = np.indices((125, 204))
        arc = abs(np.hypot(x-77, y-49)-21) < 1.1
        truth = np.where(arc, 235, 255)
        glyph = (x > 36) & (x < 162) & (abs(y-67) < 14) & (x%31 < 9)
        marked = distance_transform_edt(~glyph) < 5
        ink = rgba(np.where(glyph, 26, truth), 255)
        prior = rgba(np.where(marked, truth-7, truth), 255)
        restore(ink, marked, prior)
        self.assertLess(np.abs(prior[:, :, 0][marked].astype(float)-truth[marked]).mean(), 1.1)
        self.assertLess(prior[:, :, 0][arc & glyph].max(), 243)
        np.testing.assert_array_equal(prior[:, :, 0][~marked], truth[~marked])

    def test_handwritten_dots_crossing_a_printed_rule_keep_its_native_width_and_shade(self):
        import runpy
        restore = runpy.run_path(str(RUNTIME / "qwen_sound_contours.py"))["restore_sound_contours"]
        y, x = np.indices((190, 224))
        stock = np.full(x.shape, 252)
        for col, tone in enumerate((127, 34, 20, 67, 198), 140):
            stock[:, col] = tone
        dots = ((x-142)**2 + (y-83)**2 < 5**2) | ((x-157)**2 + (y-83)**2 < 3.5**2)
        vowel = (x > 28) & (x < 128) & (abs(y-83) < 3)
        from scipy.ndimage import distance_transform_edt
        mask = distance_transform_edt(~(dots | vowel)) < 4.5
        white = (abs(y-83) < 11) & (abs(x-142) < 13)
        src = rgba(np.where(dots | vowel, 21, np.where(white, 252, stock)), 255)
        alpha = np.where(y == 83, 93, 255)
        src[:, :, 3] = alpha
        edited = rgba(np.where(white, 252, stock), alpha)
        before = edited.copy()
        restore(src, mask, edited)
        np.testing.assert_array_equal(edited[81, 140:145, 0], stock[81, 140:145])
        np.testing.assert_array_equal(edited[y == 83], before[y == 83])
        np.testing.assert_array_equal(edited[~white], before[~white])

    def test_only_a_corroborated_interrupted_balloon_reveals_registered_clothing_and_floor(self):
        import runpy
        from scipy.ndimage import binary_dilation
        reconnect = runpy.run_path(str(RUNTIME / "qwen-reconnect-balloon.py"))["reconnect"]
        y, x = np.indices((230, 206))
        contour = np.clip(255*(abs(x-(85+.13*(y-65)))-.7), 12, 255)
        stock = (y >= 65) & (y < 165) & (x >= 70) & (x <= 110)
        glyph = np.zeros_like(stock)
        for top in range(73, 159, 16):
            glyph |= ((y >= top) & (y < top+6) & (x > 77) & (x < 102)
                      & ((x < 82) | (x > 95) | (y == top+2) | (y == top+5)))
        marked = binary_dilation(glyph)
        for other_cuts in (False, True):
            truth = contour.copy()
            if other_cuts:
                for top in (105, 144):
                    floor = np.clip(255*(abs(y-(top-.14*(x-109)))-.5), 17, 255)
                    truth = np.where((x > 50) & (x < 166), np.minimum(truth, floor), truth)
            paper = np.where(stock, 255, truth)
            original = rgba(np.where(glyph, 15, paper), 255)
            before = rgba(paper, 255)
            output = before.copy()
            self.assertEqual(reconnect(original, marked, output, rgba(truth, 255)), other_cuts)
            if other_cuts:
                error = abs(output[:, :, 0].astype(float)-truth)
                self.assertLess(error[stock].mean(), .5)
                np.testing.assert_array_equal(output[~stock], before[~stock])
            else:
                np.testing.assert_array_equal(output, before)

    def test_registered_lettering_keeps_transparency_and_does_not_texture_flat_stock(self):
        import runpy
        finish = runpy.run_path(str(RUNTIME / "qwen-restore-illustration.py"))["restore_screen_phase"]
        y, x = np.indices((168, 132))
        mask = ((x-67)/22)**2 + ((y-80)/37)**2 < 1
        original = rgba(np.where(mask & (x % 9 < 3), 21, 245), np.where(x % 17 == 0, 97, 255))
        restored = rgba(np.where(x % 17 == 0, 43, 245), original[:, :, 3])
        before = restored.copy()
        finish(original, mask, restored)
        np.testing.assert_array_equal(restored, before)

    def test_reference_view_detects_a_missing_exposed_pen_next_to_the_title(self):
        import runpy
        score = runpy.run_path(str(RUNTIME / "qwen-restore-illustration.py"))["exposed_edge_error"]
        y, x = np.indices((232, 260))
        print_mask = (x > 53) & (x < 211) & (y > 75) & (y < 153)
        gray = np.where((x % 18 < 3) & (y > 35) & (y < 194), 16, 238)
        original = rgba(np.where(print_mask, 50, gray), 255)
        damaged = gray.copy()
        damaged[58:171, 108:203] = 238
        self.assertLess(score(original, rgba(gray, 255), print_mask), .04)
        self.assertGreater(score(original, rgba(damaged, 255), print_mask), .16)

    def test_spot_colour_reveals_the_sky_through_the_halo_and_preserves_neighbouring_print(self):
        import runpy
        from scipy.ndimage import distance_transform_edt
        module = runpy.run_path(str(RUNTIME / "qwen-restore-illustration.py"))
        y, x = np.indices((165, 330))
        blue = 133+.11*x+.04*y
        sky = np.stack([17+.034*x, 33+.08*y, blue], 2).round().astype('u1')
        logo = (x > 32) & (x < 289) & (x % 71 < 16) & (y > 30) & (y < 99)
        small = (x > 65) & (x < 105) & (x % 12 < 5) & (y > 102) & (y < 115)
        distance = distance_transform_edt(~logo)
        opacity = .89*np.exp(-.5*(distance/10)**2)
        original = np.rint(sky+(255-sky)*opacity[:, :, None]).astype('u1')
        original[logo | small] = [244, 122, 5]
        alpha = np.uint8(np.where((x == 141) & (y % 13 == 0), 85, 255))
        source = np.dstack([original, alpha])
        result = module["restore"](source, sky, logo, 17, masthead=True)
        checked = ((distance < 16) & ~logo & (alpha == 255)
                   & (distance_transform_edt(~small) > 13))
        self.assertLess(abs(result[:, :, :3].astype(float)-sky)[checked].mean(), 2.7)
        np.testing.assert_array_equal(result[small], source[small])
        np.testing.assert_array_equal(result[(distance > 55) | (alpha < 255)], source[(distance > 55) | (alpha < 255)])

    def test_reference_edit_aligns_visible_ink_and_leaves_the_unselected_page_intact(self):
        import runpy
        from scipy.ndimage import gaussian_filter, distance_transform_edt
        module = runpy.run_path(str(RUNTIME / "qwen-restore-illustration.py"))
        y, x = np.indices((160, 220))
        stock = gaussian_filter(np.random.default_rng(937).normal(size=x.shape), 1.3)
        ink = np.cos(x*.13+y*.063+np.sin(y*.035)) > .64
        gray = np.rint(np.clip(175+13*stock-93*ink+18*np.sin(y*.44), 0, 255)).astype(np.uint8)
        mask = (abs(x-102) < 16) & (abs(y-77) < 30)
        alpha = np.where((x == 98) & (y % 3 == 0), 140, 255)
        original = rgba(np.where(mask & (alpha == 255), 5, gray), alpha)
        shifted = rgba(np.roll(gray, (2, -3), axis=(0, 1)), 255)
        result = module["restore"](original, shifted, mask, 11)
        inside = mask & (alpha == 255)
        before = abs(shifted[:, :, 1].astype(float)-gray)[inside].mean()
        after = abs(result[:, :, 1].astype(float)-gray)[inside].mean()
        self.assertLess(after, .65*before)
        protected = (distance_transform_edt(~mask) >= 11) | (alpha != 255)
        np.testing.assert_array_equal(original[protected], result[protected])
        np.testing.assert_array_equal(result[:, :, 3], original[:, :, 3])

    def test_faded_dots_recover_contrast_on_a_light_gradient(self):
        from scipy.ndimage import distance_transform_edt, gaussian_filter

        y, x = np.indices((166, 154))
        dots = 13*np.cos(2*np.pi*(x/4 + y/7)) + 11*np.sin(2*np.pi*(y/4 - x/7))
        truth = np.rint(np.clip(202+.24*y-.08*x+dots, 0, 255)).astype(np.uint8)
        face = (abs(x-(48+.19*y)) < 4) & (y > 31) & (y < 123)
        face |= (abs(x-(63+.19*y)) < 3.5) & (y > 34) & (y < 125)
        distance = distance_transform_edt(~face)
        mask = distance < 3.6
        source = np.where(face, 12, np.where(mask, 252, truth)).astype(np.uint8)
        faded = np.rint(.53*truth + .47*gaussian_filter(truth.astype(float), 1.7))
        decoded = np.where(mask, faded, truth).astype(np.uint8)
        result = self.render("qwen-screen-detail.py", rgba(source, 255), mask, rgba(decoded, 255))
        error = lambda image: np.abs(image[mask].astype(float)-truth[mask]).mean()
        self.assertLess(error(result[:, :, 1]), .55*error(decoded))
        np.testing.assert_array_equal(result[:, :, 1][~mask], truth[~mask])

    def test_gradient_screen_recovers_a_faint_stroke_far_from_a_bright_decoder_spot(self):
        import runpy
        from scipy.ndimage import distance_transform_edt, gaussian_filter
        restore = runpy.run_path(str(RUNTIME / "qwen_crossed_screen.py"))["restore_gradual_screen"]
        frequencies = runpy.run_path(str(RUNTIME / "qwen-screen-detail.py"))["screen_frequencies"]
        y, x = np.indices((172, 144))
        dots = 12*np.cos(2*np.pi*(x/4+y/7))+10*np.sin(2*np.pi*(y/4-x/7))
        gray = np.rint(174-.82*y+dots).astype(np.uint8)
        truth = rgba(gray, 255)[:, :, :3]
        face = ((abs(x-(46+.25*(y-30))) < 3.6) & (y > 31) & (y < 126))
        face |= (abs(x-(60+.25*(y-30))) < 4) & (y > 34) & (y < 123)
        distance = distance_transform_edt(~face)
        source = rgba(np.where(face, 10, np.where(distance < 3, 245, gray)), 255)[:, :, :3]
        mask = distance < 4.1
        bright = mask & ((y-53)**2+(x-62)**2 < 5.7**2)
        faint = mask & ((y-109)**2+(x-68)**2 < 5.8**2)
        decoded = truth.copy()
        decoded[bright] += 40
        decoded[faint] += 9
        before = decoded.copy()
        opaque = x != 63
        self.assertTrue(restore(source, mask, decoded, opaque, frequencies))
        def tone(image):
            return gaussian_filter(image[:, :, 1].astype(float), 1.25)
        self.assertLess(abs(tone(decoded)-tone(truth))[faint & opaque].mean(), 1.)
        np.testing.assert_array_equal(decoded[~mask | ~opaque], before[~mask | ~opaque])
        clean = truth.copy()
        self.assertFalse(restore(source, mask, clean, opaque, frequencies))
        np.testing.assert_array_equal(clean, truth)

    def test_light_screen_recovers_native_phase_only_on_confirmed_banks(self):
        import runpy
        frequencies = runpy.run_path(str(RUNTIME / "qwen-screen-detail.py"))["screen_frequencies"]
        repair = runpy.run_path(str(RUNTIME / "qwen_light_screen.py"))["restore_light_screen"]
        y, x = np.indices((160, 160))
        dots = 12*np.cos(2*np.pi*(x/4+y/7))+10*np.sin(2*np.pi*(y/4-x/7))
        truth = np.repeat(np.rint(224+dots).astype(np.uint8)[:, :, None], 3, axis=2)
        mask = (abs(x-80) <= 9) & (abs(y-80) <= 23)
        printed = truth.copy()
        printed[mask] = 28
        smooth = truth.copy()
        smooth[mask] = 224
        opaque = x != 78
        before = smooth.copy()
        self.assertTrue(repair(printed, mask, smooth, opaque, frequencies))
        self.assertLess(np.mean(abs(smooth[mask].astype(float)-truth[mask])),
                        np.mean(abs(before[mask].astype(float)-truth[mask])))
        np.testing.assert_array_equal(smooth[~mask | ~opaque], before[~mask | ~opaque])
        correct = truth.copy()
        repair(printed, mask, correct, opaque, frequencies)
        np.testing.assert_array_equal(correct, truth)

    def test_narrow_credit_recovers_a_light_fold_and_its_unprinted_margins(self):
        import runpy
        restore = runpy.run_path(str(RUNTIME / "qwen_neutral_stock.py"))["restore_neutral_stock"]
        y, x = np.indices((125, 340))
        gray = np.uint8(np.rint(241 + 12*np.tanh((np.cos((x-.16*y)/13)-.1)*3)))
        truth = rgba(gray, 255)[:, :, :3]
        mask = (y >= 51) & (y <= 75) & (x >= 97) & (x < 229)
        source = truth.copy()
        source[mask & (y > 56) & (y < 70) & (x % 8 < 4)] = 58
        shifted = truth.copy()
        shifted[47:79, 94:232] -= 14
        self.assertTrue(restore(source, mask, shifted, None))
        np.testing.assert_array_equal(shifted[~mask], truth[~mask])
        self.assertLess(np.abs(shifted[mask].astype(float)-truth[mask]).mean(), 1.2)
        accurate = truth.copy()
        self.assertFalse(restore(source, mask, accurate, None))
        np.testing.assert_array_equal(accurate, truth)

    def test_light_fabric_recovers_registered_folds_without_writing_outside_the_print(self):
        import runpy
        restore = runpy.run_path(str(RUNTIME / "qwen_neutral_stock.py"))["restore_folded_stock"]
        y, x = np.indices((210, 410))
        across = x-.18*y
        smooth = 239 - 28*(1+np.tanh((np.cos(2*np.pi*across/57)-.05)*4))/2
        gray = np.rint(smooth).astype(np.uint8)
        gray[abs(across-188) < 1.3] = 46
        truth = rgba(gray, 255)[:, :, :3]
        mask = ((x > 51) & (x < 350) & (x % 19 < 12)
                & (((y > 65) & (y < 92)) | ((y > 99) & (y < 125))))
        source = truth.copy()
        source[mask] = 18
        guide = truth.copy()
        guide[mask] = np.maximum(0, truth[mask].astype(float)-16).astype(np.uint8)
        original_guide = guide.copy()
        rows, cols = np.where(mask)
        self.assertTrue(restore(source, mask, guide, None, rows, cols))
        error = lambda rgb: np.abs(rgb[mask].astype(float)-truth[mask]).mean()
        self.assertLess(error(guide), .6*error(original_guide))
        np.testing.assert_array_equal(guide[~mask], truth[~mask])
        intact = truth.copy()
        self.assertFalse(restore(source, mask, intact, None, rows, cols))
        np.testing.assert_array_equal(intact, truth)
        coloured = source.copy()
        coloured[:, :, 0] //= 2
        self.assertFalse(restore(coloured, mask, original_guide.copy(), None, rows, cols))

    def test_gutter_uses_both_exposed_rule_shoulders_and_keeps_transparent_pixels(self):
        import runpy
        restore = runpy.run_path(str(RUNTIME / "qwen_paper_banks.py"))["paper_beyond_panel_rule"]
        y, x = np.indices((166, 230))
        gray = np.where(y < 78, 85 + (x+y) % 17, np.where(y < 83, 8, 255))
        truth = rgba(gray, 255)[:, :, :3]
        mask = (x > 81) & (x < 138) & (y > 50) & (y < 117) & ((x+y) % 22 < 13)
        source = truth.copy()
        source[mask] = 15
        guide = truth.copy()
        guide[mask & (y > 86)] = 152
        original = guide.copy()
        opaque = (x % 16) != 0
        self.assertTrue(restore(source, mask, guide, opaque))
        write = mask & (y > 86) & opaque
        np.testing.assert_array_equal(guide[write], truth[write])
        np.testing.assert_array_equal(guide[~write], original[~write])
        broken_rule = source.copy()
        broken_rule[78:83, 140:] = 255
        self.assertFalse(restore(broken_rule, mask, original, opaque))

    def test_crossed_screen_needs_two_exposed_families_and_registered_native_dots(self):
        import runpy
        restore = runpy.run_path(str(RUNTIME / "qwen_crossed_screen.py"))["restore_crossed_screen"]
        frequencies = runpy.run_path(str(RUNTIME / "qwen-screen-detail.py"))["screen_frequencies"]
        y, x = np.indices((265, 286))
        mask = ((x-144)/22)**2 + ((y-125)/47)**2 < 1
        dot = 14*(np.cos(2*np.pi*.279*(x+y)) + np.cos(2*np.pi*.279*(x-y)))
        for crossed in (True, False):
            mean = 168 + .12*y
            for slope in ((1., -1.) if crossed else (1.,)):
                residual = ((y-slope*x+27) % 51)-25.5
                mean += 32*np.exp(-.5*(residual/2.4)**2)
            truth = rgba(np.clip(np.rint(mean+dot), 0, 255), 255)[:,:,:3]
            source = truth.copy()
            source[mask] = np.where(((x[mask]%11)<4)[:,None], 17, 252)
            edited = truth.copy()
            edited[mask] = np.rint(mean[mask,None]-4).astype(np.uint8)
            before = edited.copy()
            self.assertEqual(restore(source, mask, edited, None, frequencies), crossed)
            np.testing.assert_array_equal(edited[~mask], truth[~mask])
            if crossed:
                errors = [abs(z[mask].astype(float)-truth[mask]).mean() for z in (before, edited)]
                self.assertLess(errors[1], .7*errors[0])
            else:
                np.testing.assert_array_equal(edited, before)

    def test_corrects_a_decoder_tint_on_measured_gray_stock_without_flattening_a_clean_scan(self):
        import runpy
        repair = runpy.run_path(str(RUNTIME / "qwen_neutral_stock.py"))["restore_neutral_stock"]
        y, x = np.indices((148, 164))
        wall = np.rint(187 + .035*x + .015*y).astype(np.uint8)
        truth = rgba(wall, 255)[:,:,:3]
        mask = ((x-82)/23)**2 + ((y-75)/32)**2 < 1
        original = truth.copy()
        original[mask & ((x % 17 < 4) | (y % 18 < 4))] = 16
        opaque = (x % 31 != 0)
        decoded = truth.copy()
        decoded[mask] -= np.array([2, 3, 4], np.uint8)
        keep = decoded.copy()
        self.assertTrue(repair(original, mask, decoded, opaque))
        np.testing.assert_array_equal(decoded[~mask | ~opaque], keep[~mask | ~opaque])
        error = abs(decoded[mask & opaque].astype(float)-truth[mask & opaque]).mean()
        self.assertLess(error, .65)
        clean = truth.copy()
        self.assertFalse(repair(original, mask, clean, opaque))
        np.testing.assert_array_equal(clean, truth)

    def test_uses_exposed_paper_to_separate_selected_ink_and_a_native_pen_tip(self):
        import runpy
        restore = runpy.run_path(str(RUNTIME / "qwen_paper_banks.py"))["restore_native_white"]
        y, x = np.indices((128, 150))
        mask = (x >= 58) & (x <= 92) & (y >= 43) & (y <= 83)
        glyph = (x >= 70) & (x < 77) & (y >= 48) & (y <= 79)
        pen = (abs(y-69) <= 1) & (x >= 19) & (x <= 63)
        truth = rgba(np.where(pen, 17, 255), 255)[:,:,:3]
        original = np.where(glyph[:,:,None], 9, truth).astype(np.uint8)
        decoded = truth.copy()
        decoded[mask & pen] = 255
        fleck = glyph & (y >= 59) & (y <= 62)
        decoded[fleck] = [147,158,163]
        opaque = np.ones(mask.shape, bool)
        self.assertTrue(restore(original, mask, decoded, opaque))
        np.testing.assert_array_equal(decoded, truth)
        color = original.copy()
        color[~mask] = [55,110,145]
        candidate = decoded.copy()
        candidate[pen & mask] = 255
        before = candidate.copy()
        restore(color, mask, candidate, opaque)
        np.testing.assert_array_equal(candidate[pen], before[pen])

    def test_continues_vertical_hatching_only_between_two_native_ink_edges(self):
        import runpy
        from scipy.ndimage import gaussian_filter

        restore = runpy.run_path(str(RUNTIME / "qwen_hatching.py"))["restore_hatching"]
        y, x = np.indices((265, 290))
        top = 52 + .31*x + .0008*(x-130)**2
        bottom = top + 39 + .035*x
        substrate = np.clip(193 + 47*np.cos(2*np.pi*x/4.15) + 10*np.sin(y/13), 0, 255)
        mask = (x > 119) & (x < 153) & (y > top-4) & (y < bottom+5)
        glyph = mask & ((x%13<4) | (y%17<4))
        for closed in (True, False):
            stripe = np.where((y>top)&(y<bottom),substrate,251)
            stripe[abs(y-top)<1.8] = 15
            if closed:
                stripe[abs(y-bottom)<1.7] = 30
            truth = rgba(stripe, 255)[:,:,:3]
            source = np.where(mask[:,:,None], np.where(glyph[:,:,None],6,255),truth).astype(np.uint8)
            blurry = np.clip(gaussian_filter(truth.astype(float),(.6,.77,0))+5,0,255).astype(np.uint8)
            result = np.where(mask[:,:,None],blurry,truth)
            before = result.copy()
            self.assertEqual(restore(source,mask,result), closed)
            np.testing.assert_array_equal(result[~mask],truth[~mask])
            if closed:
                changed = np.any(before!=result,axis=2)
                self.assertGreater(changed.sum(), 80)
                self.assertLess(abs(result.astype(float)-truth)[changed].mean(),
                                abs(before.astype(float)-truth)[changed].mean())
            else:
                np.testing.assert_array_equal(result,before)

    def test_paper_visible_between_printed_strokes_corrects_a_wide_decode_cast(self):
        y, x = np.indices((220, 260))
        sloped_ink = (x < 45 + y / 5) & (y > 60)
        shadow = (x > 173) & (y < 66)
        truth = np.where(sloped_ink, np.where(x % 4 < 2, 85, 219), np.where(shadow, 197, 255))
        stencil = (x >= 91) & (x < 171) & (y >= 42) & (y < 178)
        letters = stencil & (x > 98) & (x < 157) & (x % 14 < 5) & (y % 24 < 17)
        source = rgba(np.where(letters, 15, truth), 255)
        decoder = rgba(np.where(stencil, 250, truth), 255)
        source[132:136, 139:143, 3] = 124
        decoder[132:136, 139:143, 3] = 124
        result = self.render("qwen-screen-detail.py", source, stencil, decoder)
        np.testing.assert_array_equal(result[~stencil], source[~stencil])
        np.testing.assert_array_equal(result[132:136, 139:143], decoder[132:136, 139:143])
        self.assertGreaterEqual(np.quantile(result[82:128, 106:158, 0], .02), 254)

    def test_removes_a_decode_shadow_from_native_white_stock_at_a_diagonal_rule(self):
        y, x = np.indices((135, 185))
        edge = 72 - .24*x
        paper = np.rint(255*np.clip(y-edge+.5, 0, 1)).astype(np.uint8)
        stroke = ((x-90)/6)**2 + ((y-64)/5)**2 <= 1
        mask = ((x-90)/17)**2 + ((y-62)/18)**2 <= 1
        source = rgba(np.where(stroke, 20, paper), 255)
        shaded = np.where(mask & (paper == 255), 247, paper)
        decoder = rgba(shaded, 255)
        result = self.render("qwen-screen-detail.py", source, mask, decoder)
        clean = mask & (y-edge>5)
        np.testing.assert_array_equal(result[:,:,0][clean], paper[clean])
        np.testing.assert_array_equal(result[~mask], decoder[~mask])
        np.testing.assert_array_equal(result[:,:,0][paper<235], paper[paper<235])

    def test_small_margin_print_uses_scan_paper_and_retains_the_panel_rule(self):
        y, x = np.indices((100, 94))
        ink = (y >= 43) & (y < 53) & ((x >= 34) & (x < 40) | (x >= 42) & (x < 48))
        ink &= (x % 7 < 3) | (y % 4 == 0)
        rule = x >= 51
        truth = np.where(x == 51, 11, np.where(rule, 148, 255)).astype(np.uint8)
        truth[x == 49] = 247
        mask = (x >= 30) & (x <= 52) & (y >= 40) & (y <= 55)
        source = np.where(ink, 42, truth).astype(np.uint8)
        decoder = np.where(mask & ~rule, 248, truth).astype(np.uint8)
        result = self.render("qwen-screen-detail.py", rgba(source,255), mask, rgba(decoder,255))
        np.testing.assert_array_equal(result[:,:,0], truth)
        import runpy
        repair = runpy.run_path(str(RUNTIME / "qwen-screen-detail.py"))["restore_margin_print"]
        dark_output = rgba(np.where(ink, 91, truth),255)[:,:,:3].copy()
        self.assertFalse(repair(rgba(source,255)[:,:,:3], mask, dark_output, *np.where(mask)))

    def test_dark_tapered_print_follows_supported_pale_stripes_only_within_the_stencil(self):
        import runpy
        from scipy.ndimage import distance_transform_edt
        restore = runpy.run_path(str(RUNTIME / "qwen_radial_stock.py"))["restore_pale_stripes"]
        y, x = np.indices((221, 232))
        truth = np.rint(232+22*np.cos((x-.38*y)*2*np.pi/14)).astype("u1")
        ink = np.zeros_like(x, bool)
        for left, top in ((48, 34), (80, 49), (99, 95), (66, 145), (126, 147)):
            ink |= (y >= top) & (y < top+28) & (abs(x-left-.34*(y-top)) < 3.5)
        selected = distance_transform_edt(~ink) <= 7
        source = rgba(np.where(ink, 18, truth), 255)[:, :, :3]
        decoded = rgba(np.where(selected, 221, truth), 255)[:, :, :3].copy()
        rim = (distance_transform_edt(~ink) > 8) & (distance_transform_edt(~ink) < 12)
        decoded[rim] = 241
        self.assertTrue(restore(source, selected, decoded))
        self.assertLess(abs(decoded[:, :, 0].astype(float)-truth)[ink].mean(), 4)
        np.testing.assert_array_equal(decoded[~selected], source[~selected])
        untouched = source.copy()
        self.assertFalse(restore(source, selected, untouched))
        np.testing.assert_array_equal(untouched, source)

    def test_confirmed_native_paper_removes_a_decode_shadow_across_typeset_columns(self):
        import runpy
        from scipy.ndimage import distance_transform_edt
        restore = runpy.run_path(str(RUNTIME / "qwen_typeset_stock.py"))["restore_shaded_type_imprint"]
        y, x = np.indices((180, 175))
        truth = (254-((x+3*y) % 13 == 2)).astype("u1")
        ink = np.zeros_like(x, bool)
        for left in (43, 83):
            for top in (28, 58, 88, 118):
                local = (abs(x-left) < 11) & (abs(y-top) < 12)
                ink |= local & ((abs(x-left) < 4) | (abs(y-top) < 3))
        source = rgba(np.where(ink, 15, truth), 255)[:, :, :3]
        distance = distance_transform_edt(~ink)
        decoded = rgba(np.where(distance < 10, truth.astype(float)-9, truth), 255)[:, :, :3].copy()
        self.assertTrue(restore(source, ink, decoded))
        self.assertLess(abs(decoded[:, :, 0].astype(float)-truth)[ink].mean(), 1.5)
        np.testing.assert_array_equal(decoded[:, :, 0][distance > 14], truth[distance > 14])
        faithful = rgba(truth, 255)[:, :, :3].copy()
        self.assertFalse(restore(source, ink, faithful))
        np.testing.assert_array_equal(faithful[:, :, 0], truth)

    def test_shaded_balloon_uses_matching_source_banks_and_retains_its_border(self):
        y, x = np.indices((170, 180))
        shade = np.uint8(np.rint(83 + .67*y + .013*x))
        inside = ((x-90)/61)**2 + ((y-88)/75)**2 < 1
        truth = np.where(inside, shade, 27).astype(np.uint8)
        mask = (abs(x-90) < 9) & (y > 43) & (y < 133) & ((y//9) % 4 < 2)
        from scipy.ndimage import distance_transform_edt
        halo = distance_transform_edt(~mask) <= 2.8
        source = np.where(mask, 18, np.where(halo, 252, truth)).astype(np.uint8)
        # The decode leaves alternating ink/halo residues on an accurate
        # low-frequency gradient, as observed in an outlined speech balloon.
        residual = np.where((x+y) % 4 < 2, 52., -52.)
        decoded = np.where(halo, truth.astype(float)+residual, source).astype(np.uint8)
        result = self.render("qwen-screen-detail.py", rgba(source,255), mask, rgba(decoded,255), "--speech")
        self.assertLess(np.abs(result[:,:,0].astype(float)-truth)[halo].mean(), 1)
        np.testing.assert_array_equal(result[:,:,0][~inside], truth[~inside])
        import runpy
        repair = runpy.run_path(str(RUNTIME / "qwen-screen-detail.py"))["restore_shaded_balloon"]
        selected = np.where(mask)
        changed_field = np.where(halo, 52, truth).astype(np.uint8)
        candidate = rgba(changed_field, 255)[:,:,:3].copy()
        self.assertFalse(repair(rgba(source, 255)[:,:,:3], mask, candidate, *selected))
        np.testing.assert_array_equal(candidate[:,:,0], changed_field)

    def test_restores_a_density_dependent_dot_screen_without_touching_the_surround(self):
        y, x = np.indices((190, 220))
        density = 46 + .38*x + .12*y
        first = 2*np.pi*(x+y)/8.4
        second = 2*np.pi*(x-y)/8.4
        signal = np.cos(first) + np.cos(second)
        truth = np.uint8(np.rint(np.clip(density + 28*signal + .08*density*signal**2, 0, 255)))
        mask = ((x-103)/28)**2 + ((y-90)/41)**2 < 1
        source = truth.copy()
        source[mask] = 12
        decoded = truth.copy()
        decoded[mask] = np.uint8(np.rint(density[mask] * 1.08))
        result = self.render("qwen-screen-detail.py", rgba(source,255), mask, rgba(decoded,255))
        after = result[:,:,0].astype(float)
        before = np.abs(decoded.astype(float) - truth)[mask].mean()
        self.assertLess(np.abs(after - truth)[mask].mean(), .55*before)
        np.testing.assert_array_equal(result[:,:,0][~mask], truth[~mask])

    def render(self, script, source, mask, decoder, *arguments):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name, data in (("source", source), ("mask", mask.astype(np.uint8)*255), ("decoder", decoder)):
                Image.fromarray(data).save(root / (name + ".png"))
            output = root / "result.png"
            result = subprocess.run(
                [sys.executable, str(RUNTIME / script), str(root / "source.png"),
                 str(root / "mask.png"), str(root / "decoder.png"), str(output), *arguments],
                check=True, capture_output=True, text=True,
            )
            self.assertEqual(result.stdout.strip(), "applied")
            with Image.open(output) as saved:
                return np.array(saved)

    def test_title_stock_uses_source_alpha_after_resizing_decoder_output(self):
        y, x = np.indices((172, 440))
        gray = (171 + (x//5 + y//3) % 24 * 3).astype(np.uint8)
        gray[[17, 85, 155], 12:428] = 3
        mask = ((x > 38) & (x < 401) & (x % 38 < 13)
                & (((y > 28) & (y < 66)) | ((y > 101) & (y < 142))))
        source = rgba(np.where(mask, 23, gray), 255)
        decoder = rgba(85 + (x+y) % 93, 250 + (x % 5))
        result = self.render("qwen-title-stock.py", source, mask, decoder, "finish")
        np.testing.assert_array_equal(result[~mask], source[~mask])
        np.testing.assert_array_equal(result[:, :, 3], source[:, :, 3])
        self.assertGreater(result[:, :, 1][mask].min(), 145)

    def test_round_boundary_keeps_transparent_source_and_opaque_sky(self):
        y, x = np.indices((250, 400))
        rho = np.hypot(x-235, y-127)-61
        sky = 46 + .035*x + .015*y
        clean = np.uint8(np.rint(2 + (sky-2)*np.clip((rho+.7)/1.4, 0, 1)))
        mask = (x > 62) & (x < 250) & (y > 67) & (y < 113)
        gray = np.where(mask, np.where((x//7+y//9) % 4 == 0, 11, 252), clean)
        alpha = np.where((x > 92) & (x < 103) & (y % 9 < 2), 120, 255)
        source = rgba(gray, alpha)
        decoder = rgba(clean, 250 + y % 5)
        result = self.render("qwen-register-substrate.py", source, mask, decoder)
        np.testing.assert_array_equal(result[~mask | (alpha < 255)], source[~mask | (alpha < 255)])
        np.testing.assert_array_equal(result[:, :, 3], alpha)
        check = mask & (x < 155) & (alpha == 255)
        self.assertLess(np.abs(result[:, :, 1][check].astype(float)-clean[check]).mean(), 2)


if __name__ == "__main__":
    unittest.main()
