use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::Arc;

use anyhow::{Context, Result, bail};
use hayro::hayro_interpret::InterpreterSettings;
use hayro::hayro_interpret::hayro_syntax::Pdf;
use hayro::vello_cpu::color::palette::css::WHITE;
use hayro::{RenderCache, RenderSettings, render};
use memmap2::Mmap;

use crate::manifest::{ImportKind, ImportManifest, ImportedPage};
use crate::{
    MAX_IMAGE_DIMENSION, MAX_IMAGE_PIXELS, MAX_PAGE_BYTES, MAX_PAGE_COUNT, MAX_TOTAL_BYTES,
    manifest,
};

const TARGET_SCALE: f32 = 300.0 / 72.0;

pub(crate) fn import_pdf(input: &Path, output: &Path) -> Result<ImportManifest> {
    let file = File::open(input).context("Unable to open PDF")?;
    // SAFETY: The read-only mapping is retained by PdfData for the whole parse/render
    // operation, and this process never modifies or truncates the input file.
    let mapped = unsafe { Mmap::map(&file) }.context("Unable to map PDF")?;
    let pdf = Pdf::new(Arc::new(mapped))
        .map_err(|error| anyhow::anyhow!("Invalid or encrypted PDF: {error:?}"))?;
    let pages = pdf.pages();
    if pages.is_empty() {
        bail!("PDF contains no pages");
    }
    if pages.len() > MAX_PAGE_COUNT {
        bail!("PDF has more than {MAX_PAGE_COUNT} pages");
    }

    let cache = RenderCache::new();
    let interpreter_settings = InterpreterSettings::default();
    let mut imported = Vec::with_capacity(pages.len());
    let mut total_bytes = 0_u64;
    crate::emit_progress(0, pages.len());

    for (index, page) in pages.iter().enumerate() {
        let (width, height, scale) = bounded_render_size(page.render_dimensions())?;
        let pixmap = render(
            page,
            &cache,
            &interpreter_settings,
            &RenderSettings {
                x_scale: scale,
                y_scale: scale,
                width: Some(width as u16),
                height: Some(height as u16),
                bg_color: WHITE,
            },
        );
        let png = pixmap
            .into_png()
            .context("Unable to encode rendered PDF page")?;
        let byte_length = png.len() as u64;
        if byte_length > MAX_PAGE_BYTES {
            bail!(
                "Rendered PDF page {} exceeds the page byte limit",
                index + 1
            );
        }
        total_bytes = total_bytes
            .checked_add(byte_length)
            .context("Rendered PDF byte count overflow")?;
        if total_bytes > MAX_TOTAL_BYTES {
            bail!("Rendered PDF exceeds the total byte limit");
        }

        let relative_path = format!("page-{:06}.png", index + 1);
        let output_path = output.join(&relative_path);
        let mut output_file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&output_path)
            .with_context(|| format!("Unable to create {}", output_path.display()))?;
        output_file.write_all(&png)?;
        output_file.sync_all()?;
        imported.push(ImportedPage {
            name: relative_path.clone(),
            relative_path,
            byte_length,
            width: Some(width),
            height: Some(height),
        });
        crate::emit_progress(index + 1, pages.len());
    }

    Ok(manifest(ImportKind::Pdf, imported))
}

fn bounded_render_size((width_points, height_points): (f32, f32)) -> Result<(u32, u32, f32)> {
    if !width_points.is_finite()
        || !height_points.is_finite()
        || width_points <= 0.0
        || height_points <= 0.0
    {
        bail!("PDF page has invalid dimensions");
    }
    let dimension_scale =
        (MAX_IMAGE_DIMENSION as f32 / width_points).min(MAX_IMAGE_DIMENSION as f32 / height_points);
    let pixel_scale =
        ((MAX_IMAGE_PIXELS as f64 / (width_points as f64 * height_points as f64)).sqrt()) as f32;
    let scale = TARGET_SCALE.min(dimension_scale).min(pixel_scale);
    if !scale.is_finite() || scale <= 0.0 {
        bail!("PDF page cannot be rendered within image limits");
    }
    let width = (width_points * scale)
        .floor()
        .clamp(1.0, MAX_IMAGE_DIMENSION as f32) as u32;
    let height = (height_points * scale)
        .floor()
        .clamp(1.0, MAX_IMAGE_DIMENSION as f32) as u32;
    if u64::from(width) * u64::from(height) > MAX_IMAGE_PIXELS {
        bail!("PDF page exceeds the pixel limit");
    }
    Ok((width, height, scale))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn renders_a_minimal_pdf_to_a_bounded_png() {
        let temp = tempdir().unwrap();
        let input = temp.path().join("sample.pdf");
        let output = temp.path().join("output");
        fs::create_dir(&output).unwrap();
        fs::write(&input, minimal_pdf()).unwrap();

        let result = import_pdf(&input, &output).unwrap();

        assert_eq!(result.pages.len(), 1);
        assert_eq!(result.pages[0].width, Some(300));
        assert_eq!(result.pages[0].height, Some(300));
        let bytes = fs::read(output.join("page-000001.png")).unwrap();
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
    }

    fn minimal_pdf() -> Vec<u8> {
        let objects = [
            b"<< /Type /Catalog /Pages 2 0 R >>".as_slice(),
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".as_slice(),
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] /Resources << >> /Contents 4 0 R >>".as_slice(),
            b"<< /Length 25 >>\nstream\n0 0 0 rg 0 0 72 72 re f\nendstream".as_slice(),
        ];
        let mut bytes = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::new();
        for (index, object) in objects.iter().enumerate() {
            offsets.push(bytes.len());
            bytes.extend_from_slice(format!("{} 0 obj\n", index + 1).as_bytes());
            bytes.extend_from_slice(object);
            bytes.extend_from_slice(b"\nendobj\n");
        }
        let xref = bytes.len();
        bytes.extend_from_slice(b"xref\n0 5\n0000000000 65535 f \n");
        for offset in offsets {
            bytes.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
        }
        bytes.extend_from_slice(
            format!("trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n").as_bytes(),
        );
        bytes
    }
}
