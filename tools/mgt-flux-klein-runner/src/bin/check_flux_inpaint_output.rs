use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::Parser;
use mgt_flux_klein::quality::{assert_flux_quality, measure_flux_quality};

#[derive(Debug, Parser)]
struct Args {
    input: PathBuf,
    mask: PathBuf,
    output: PathBuf,
}

fn main() -> Result<()> {
    let args = Args::parse();
    let input = image::open(&args.input)
        .with_context(|| format!("failed to open input {}", args.input.display()))?;
    let mask = image::open(&args.mask)
        .with_context(|| format!("failed to open mask {}", args.mask.display()))?;
    let output = image::open(&args.output)
        .with_context(|| format!("failed to open output {}", args.output.display()))?;
    let metrics = measure_flux_quality(&input, &mask, &output)?;
    println!("{}", serde_json::to_string_pretty(&metrics)?);
    assert_flux_quality(&metrics)
}
