use anyhow::{Result, bail};
use image::{DynamicImage, GrayImage, RgbImage};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct FluxQualityMetrics {
    pub mean_chroma_excess: f64,
    pub p95_chroma_excess: f64,
    pub input_boundary_ratio: f64,
    pub output_boundary_ratio: f64,
    pub changed_ratio: f64,
    pub outside_mean_delta: f64,
}

pub fn measure_flux_quality(
    input: &DynamicImage,
    mask: &DynamicImage,
    output: &DynamicImage,
) -> Result<FluxQualityMetrics> {
    let input = input.to_rgb8();
    let output = output.to_rgb8();
    let mask = mask.to_luma8();
    if input.dimensions() != output.dimensions() || input.dimensions() != mask.dimensions() {
        bail!(
            "quality image dimensions differ: input={:?}, mask={:?}, output={:?}",
            input.dimensions(),
            mask.dimensions(),
            output.dimensions()
        );
    }

    let mut chroma_excess = Vec::new();
    let mut changed = 0usize;
    let mut masked = 0usize;
    let mut outside_delta = 0f64;
    let mut outside_samples = 0usize;
    for ((input_pixel, output_pixel), mask_pixel) in
        input.pixels().zip(output.pixels()).zip(mask.pixels())
    {
        if mask_pixel.0[0] > 0 {
            masked += 1;
            let input_chroma = chroma(input_pixel.0);
            let output_chroma = chroma(output_pixel.0);
            chroma_excess.push((output_chroma - input_chroma).max(0.0));
            if input_pixel != output_pixel {
                changed += 1;
            }
        } else {
            outside_delta += rgb_delta(input_pixel.0, output_pixel.0);
            outside_samples += 1;
        }
    }
    if masked == 0 {
        bail!("quality mask is empty");
    }
    chroma_excess.sort_by(f64::total_cmp);
    let p95_index = ((chroma_excess.len() - 1) as f64 * 0.95).round() as usize;
    Ok(FluxQualityMetrics {
        mean_chroma_excess: chroma_excess.iter().sum::<f64>() / chroma_excess.len() as f64,
        p95_chroma_excess: chroma_excess[p95_index],
        input_boundary_ratio: boundary_ratio(&input, &mask),
        output_boundary_ratio: boundary_ratio(&output, &mask),
        changed_ratio: changed as f64 / masked as f64,
        outside_mean_delta: if outside_samples == 0 {
            0.0
        } else {
            outside_delta / outside_samples as f64
        },
    })
}

pub fn assert_flux_quality(metrics: &FluxQualityMetrics) -> Result<()> {
    let boundary_limit = 1.04f64.max(metrics.input_boundary_ratio + 0.025);
    let mut failures = Vec::new();
    if metrics.mean_chroma_excess > 8.0 {
        failures.push(format!(
            "mean chroma excess {:.3} > 8",
            metrics.mean_chroma_excess
        ));
    }
    if metrics.p95_chroma_excess > 20.0 {
        failures.push(format!(
            "p95 chroma excess {:.3} > 20",
            metrics.p95_chroma_excess
        ));
    }
    if metrics.output_boundary_ratio > boundary_limit {
        failures.push(format!(
            "16px boundary ratio {:.4} > {:.4}",
            metrics.output_boundary_ratio, boundary_limit
        ));
    }
    if metrics.changed_ratio < 0.10 {
        failures.push(format!(
            "masked changed ratio {:.4} < 0.10",
            metrics.changed_ratio
        ));
    }
    if metrics.outside_mean_delta > 0.01 {
        failures.push(format!(
            "outside mean delta {:.5} > 0.01",
            metrics.outside_mean_delta
        ));
    }
    if failures.is_empty() {
        Ok(())
    } else {
        bail!("Flux output quality gate failed: {}", failures.join("; "))
    }
}

fn chroma(rgb: [u8; 3]) -> f64 {
    let min = rgb[0].min(rgb[1]).min(rgb[2]);
    let max = rgb[0].max(rgb[1]).max(rgb[2]);
    f64::from(max - min)
}

fn rgb_delta(left: [u8; 3], right: [u8; 3]) -> f64 {
    left.into_iter()
        .zip(right)
        .map(|(left, right)| f64::from(left.abs_diff(right)))
        .sum::<f64>()
        / 3.0
}

fn boundary_ratio(image: &RgbImage, mask: &GrayImage) -> f64 {
    let (width, height) = image.dimensions();
    let mut boundary_delta = 0f64;
    let mut boundary_edges = 0usize;
    let mut regular_delta = 0f64;
    let mut regular_edges = 0usize;
    for y in 0..height {
        for x in 0..width {
            if mask.get_pixel(x, y).0[0] == 0 {
                continue;
            }
            if x > 0 && mask.get_pixel(x - 1, y).0[0] > 0 {
                let delta = rgb_delta(image.get_pixel(x - 1, y).0, image.get_pixel(x, y).0);
                if x % 16 == 0 {
                    boundary_delta += delta;
                    boundary_edges += 1;
                } else {
                    regular_delta += delta;
                    regular_edges += 1;
                }
            }
            if y > 0 && mask.get_pixel(x, y - 1).0[0] > 0 {
                let delta = rgb_delta(image.get_pixel(x, y - 1).0, image.get_pixel(x, y).0);
                if y % 16 == 0 {
                    boundary_delta += delta;
                    boundary_edges += 1;
                } else {
                    regular_delta += delta;
                    regular_edges += 1;
                }
            }
        }
    }
    if boundary_edges == 0 || regular_edges == 0 {
        return 1.0;
    }
    let boundary_mean = boundary_delta / boundary_edges as f64;
    let regular_mean = regular_delta / regular_edges as f64;
    if boundary_mean <= f64::EPSILON && regular_mean <= f64::EPSILON {
        1.0
    } else {
        boundary_mean / regular_mean.max(1e-6)
    }
}

#[cfg(test)]
mod tests {
    use image::{DynamicImage, GrayImage, Luma, Rgb, RgbImage};

    use super::{assert_flux_quality, measure_flux_quality};

    #[test]
    fn synthetic_controls_separate_clean_fill_from_colored_tiles() {
        let (input, mask, positive, negative) = synthetic_fixtures();
        let positive_metrics = measure_flux_quality(&input, &mask, &positive).unwrap();
        assert_flux_quality(&positive_metrics).unwrap();

        let negative_metrics = measure_flux_quality(&input, &mask, &negative).unwrap();
        assert!(assert_flux_quality(&negative_metrics).is_err());
        assert!(negative_metrics.mean_chroma_excess > 8.0);
        assert!(negative_metrics.output_boundary_ratio > 1.04);
    }

    fn synthetic_fixtures() -> (DynamicImage, DynamicImage, DynamicImage, DynamicImage) {
        let mut input = RgbImage::from_pixel(256, 256, Rgb([220, 220, 220]));
        let mut mask = GrayImage::from_pixel(256, 256, Luma([0]));
        let mut positive = input.clone();
        let mut negative = input.clone();
        for y in 64..192 {
            for x in 64..192 {
                mask.put_pixel(x, y, Luma([255]));
                input.put_pixel(x, y, Rgb([170, 170, 170]));
                positive.put_pixel(x, y, Rgb([218, 218, 218]));
                let tile = ((x / 16) + (y / 16)) % 2;
                negative.put_pixel(
                    x,
                    y,
                    if tile == 0 {
                        Rgb([245, 40, 30])
                    } else {
                        Rgb([30, 80, 245])
                    },
                );
            }
        }
        (
            DynamicImage::ImageRgb8(input),
            DynamicImage::ImageLuma8(mask),
            DynamicImage::ImageRgb8(positive),
            DynamicImage::ImageRgb8(negative),
        )
    }
}
