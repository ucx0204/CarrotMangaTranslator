mod manifest;
mod pdf_import;
mod rar_import;

use std::fs::{self, File};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use manifest::{Capabilities, ImportKind, ImportManifest, ProgressRecord};

pub(crate) const MAX_CONTAINER_BYTES: u64 = 1024 * 1024 * 1024;
pub(crate) const MAX_ENTRY_COUNT: usize = 10_000;
pub(crate) const MAX_PAGE_COUNT: usize = 2_000;
pub(crate) const MAX_PAGE_BYTES: u64 = 256 * 1024 * 1024;
pub(crate) const MAX_TOTAL_BYTES: u64 = 4 * 1024 * 1024 * 1024;
pub(crate) const MAX_IMAGE_PIXELS: u64 = 120_000_000;
pub(crate) const MAX_IMAGE_DIMENSION: u32 = u16::MAX as u32;

#[derive(Parser)]
#[command(name = "mgt-import-source-runner", version)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Print the machine-readable runtime contract.
    Capabilities,
    /// Rasterize every page of an unencrypted PDF to PNG.
    Pdf {
        #[arg(long)]
        input: PathBuf,
        #[arg(long)]
        output: PathBuf,
    },
    /// Extract raster pages from a RAR or CBR archive.
    Rar {
        #[arg(long)]
        input: PathBuf,
        #[arg(long)]
        output: PathBuf,
    },
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let result = match Cli::parse().command {
        Command::Capabilities => {
            print_json(&Capabilities::current())?;
            return Ok(());
        }
        Command::Pdf { input, output } => {
            prepare_paths(&input, &output)?;
            pdf_import::import_pdf(&input, &output)?
        }
        Command::Rar { input, output } => {
            prepare_paths(&input, &output)?;
            rar_import::import_rar(&input, &output)?
        }
    };
    print_json(&result)
}

fn prepare_paths(input: &Path, output: &Path) -> Result<()> {
    let input_metadata = fs::metadata(input)
        .with_context(|| format!("Unable to inspect input file: {}", input.display()))?;
    if !input_metadata.is_file() {
        bail!("Input is not a regular file: {}", input.display());
    }
    if input_metadata.len() > MAX_CONTAINER_BYTES {
        bail!(
            "Input exceeds the {} byte container limit",
            MAX_CONTAINER_BYTES
        );
    }

    let output_metadata = fs::metadata(output)
        .with_context(|| format!("Unable to inspect output directory: {}", output.display()))?;
    if !output_metadata.is_dir() {
        bail!("Output is not a directory: {}", output.display());
    }
    if fs::read_dir(output)
        .with_context(|| format!("Unable to read output directory: {}", output.display()))?
        .next()
        .transpose()?
        .is_some()
    {
        bail!("Output directory must be empty");
    }

    File::open(input).with_context(|| format!("Unable to open input: {}", input.display()))?;
    Ok(())
}

fn print_json<T: serde::Serialize>(value: &T) -> Result<()> {
    serde_json::to_writer(std::io::stdout().lock(), value)
        .context("Unable to encode JSON output")?;
    println!();
    Ok(())
}

pub(crate) fn emit_progress(current: usize, total: usize) {
    let record = ProgressRecord {
        version: 1,
        record_type: "progress",
        current,
        total,
        unit: "items",
    };
    if let Ok(json) = serde_json::to_string(&record) {
        eprintln!("MGT_PROGRESS {json}");
    }
}

pub(crate) fn manifest(kind: ImportKind, pages: Vec<manifest::ImportedPage>) -> ImportManifest {
    ImportManifest {
        version: 1,
        kind,
        pages,
    }
}
