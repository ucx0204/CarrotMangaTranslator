use std::{fs, path::PathBuf};

use anyhow::{Context, Result};
use clap::Parser;
use image::{GrayImage, Luma, Rgb, RgbImage};

#[derive(Debug, Parser)]
struct Args {
    output_dir: PathBuf,
}

fn main() -> Result<()> {
    let args = Args::parse();
    fs::create_dir_all(&args.output_dir).with_context(|| {
        format!(
            "failed to create fixture directory {}",
            args.output_dir.display()
        )
    })?;
    let mut input = RgbImage::from_pixel(256, 256, Rgb([220, 220, 220]));
    let mut mask = GrayImage::from_pixel(256, 256, Luma([0]));
    let mut positive = input.clone();
    let mut negative = input.clone();
    for y in 64..192 {
        for x in 64..192 {
            mask.put_pixel(x, y, Luma([255]));
            input.put_pixel(x, y, Rgb([170, 170, 170]));
            positive.put_pixel(x, y, Rgb([218, 218, 218]));
            negative.put_pixel(
                x,
                y,
                if ((x / 16) + (y / 16)) % 2 == 0 {
                    Rgb([245, 40, 30])
                } else {
                    Rgb([30, 80, 245])
                },
            );
        }
    }
    input.save(args.output_dir.join("input.png"))?;
    mask.save(args.output_dir.join("mask.png"))?;
    positive.save(args.output_dir.join("positive.png"))?;
    negative.save(args.output_dir.join("negative-colored-tiles.png"))?;
    Ok(())
}
