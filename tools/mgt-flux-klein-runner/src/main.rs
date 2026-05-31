use std::{
    io::{self, BufRead, Write},
    path::PathBuf,
    time::Instant,
};

use anyhow::{Context, Result};
use clap::Parser;
use koharu_ml::flux2_klein::{Flux2InpaintOptions, Flux2Klein, Flux2KleinPaths};
use serde::{Deserialize, Serialize};
use tracing_subscriber::{EnvFilter, fmt};

#[derive(Parser, Debug)]
#[command(name = "mgt-flux-klein")]
#[command(about = "Gemma Manga Translator Flux.2 Klein inpainting runner")]
struct Cli {
    #[arg(long, value_name = "FILE")]
    transformer_path: PathBuf,

    #[arg(long, value_name = "FILE")]
    vae_path: PathBuf,

    #[arg(long, default_value_t = 4)]
    steps: usize,

    #[arg(long, default_value_t = 1.0)]
    strength: f64,

    #[arg(long, default_value_t = 1024 * 1024)]
    max_pixels: u32,

    #[arg(long, default_value_t = 16)]
    mask_padding: u8,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum WorkerRequest {
    #[serde(rename = "inpaint")]
    Inpaint {
        id: String,
        input: PathBuf,
        mask: PathBuf,
        output: PathBuf,
        steps: Option<usize>,
        strength: Option<f64>,
        max_pixels: Option<u32>,
        mask_padding: Option<u8>,
    },
    #[serde(rename = "shutdown")]
    Shutdown,
}

#[derive(Debug, Serialize)]
struct WorkerResponse<'a> {
    id: &'a str,
    ok: bool,
    elapsed_ms: u128,
    error: Option<String>,
}

fn main() -> Result<()> {
    init_logging();
    let cli = Cli::parse();

    let load_started = Instant::now();
    let model = Flux2Klein::load_from_paths(Flux2KleinPaths {
        transformer_gguf: cli.transformer_path.clone(),
        vae_safetensors: cli.vae_path.clone(),
    })
    .with_context(|| "Flux.2 Klein model load failed")?;
    eprintln!("mgt-flux-klein: model loaded in {:?}", load_started.elapsed());

    let prompt_started = Instant::now();
    model
        .precompute_prompt_embeddings()
        .with_context(|| "Flux.2 Klein prompt embedding load failed")?;
    eprintln!(
        "mgt-flux-klein: prompt embeddings ready in {:?}",
        prompt_started.elapsed()
    );

    run_worker(&model, &cli)?;
    Ok(())
}

fn run_worker(model: &Flux2Klein, cli: &Cli) -> Result<()> {
    let stdin = io::stdin();
    let mut stdout = io::stdout();
    eprintln!("mgt-flux-klein: worker ready");
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let request: WorkerRequest = serde_json::from_str(&line)
            .with_context(|| format!("invalid worker request: {}", line))?;
        match request {
            WorkerRequest::Shutdown => break,
            WorkerRequest::Inpaint {
                id,
                input,
                mask,
                output,
                steps,
                strength,
                max_pixels,
                mask_padding,
            } => {
                let started = Instant::now();
                let result = run_inpaint(
                    model,
                    cli,
                    &input,
                    &mask,
                    &output,
                    Flux2InpaintOptions {
                        num_inference_steps: steps.unwrap_or(cli.steps),
                        strength: strength.unwrap_or(cli.strength),
                        max_pixels: max_pixels.unwrap_or(cli.max_pixels),
                        mask_padding: mask_padding.unwrap_or(cli.mask_padding),
                    },
                );
                let response = match result {
                    Ok(()) => WorkerResponse {
                        id: &id,
                        ok: true,
                        elapsed_ms: started.elapsed().as_millis(),
                        error: None,
                    },
                    Err(error) => WorkerResponse {
                        id: &id,
                        ok: false,
                        elapsed_ms: started.elapsed().as_millis(),
                        error: Some(format!("{error:#}")),
                    },
                };
                serde_json::to_writer(&mut stdout, &response)?;
                stdout.write_all(b"\n")?;
                stdout.flush()?;
            }
        }
    }
    Ok(())
}

fn run_inpaint(
    model: &Flux2Klein,
    _cli: &Cli,
    input: &PathBuf,
    mask: &PathBuf,
    output: &PathBuf,
    options: Flux2InpaintOptions,
) -> Result<()> {
    let image = image::open(input)
        .with_context(|| format!("failed to open input image {}", input.display()))?;
    let mask_image =
        image::open(mask).with_context(|| format!("failed to open mask image {}", mask.display()))?;
    let result = model
        .inpaint(&image, &mask_image, &options)
        .with_context(|| "Flux.2 Klein inpainting failed")?;
    result
        .save(output)
        .with_context(|| format!("failed to write output image {}", output.display()))?;
    Ok(())
}

fn init_logging() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("warn"));
    let _ = fmt().with_env_filter(filter).with_target(false).try_init();
}
