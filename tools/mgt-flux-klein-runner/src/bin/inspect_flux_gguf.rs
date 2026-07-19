use std::{fs::File, path::PathBuf};

use anyhow::{Context, Result, bail};
use candle_core::quantized::{GgmlDType, gguf_file::Content};
use clap::Parser;

#[derive(Debug, Parser)]
struct Args {
    /// FLUX transformer GGUF file to inspect.
    gguf: PathBuf,

    /// Fail unless at least one double-stream image projection is quantized.
    #[arg(long)]
    require_quantized_image_projection: bool,
}

fn main() -> Result<()> {
    let args = Args::parse();
    let mut reader = File::open(&args.gguf)
        .with_context(|| format!("failed to open GGUF {}", args.gguf.display()))?;
    let content = Content::read(&mut reader).context("failed to parse GGUF metadata")?;
    let mut projections = content
        .tensor_infos
        .iter()
        .filter(|(name, _)| {
            name.starts_with("double_blocks.") && name.ends_with(".img_attn.proj.weight")
        })
        .collect::<Vec<_>>();
    projections.sort_by(|left, right| left.0.cmp(right.0));
    if projections.is_empty() {
        bail!("GGUF contains no double-stream image attention projections");
    }

    let mut quantized = 0usize;
    for (name, info) in &projections {
        let is_quantized = !matches!(
            info.ggml_dtype,
            GgmlDType::F32 | GgmlDType::F16 | GgmlDType::BF16
        );
        quantized += usize::from(is_quantized);
        println!(
            "{name}\tshape={:?}\tdtype={:?}\tquantized={is_quantized}",
            info.shape.dims(),
            info.ggml_dtype,
        );
    }
    println!(
        "image projections: total={}, quantized={quantized}",
        projections.len()
    );
    if args.require_quantized_image_projection && quantized == 0 {
        bail!("all double-stream image projections are full precision");
    }
    Ok(())
}
