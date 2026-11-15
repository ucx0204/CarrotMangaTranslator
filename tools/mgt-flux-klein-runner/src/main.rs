use anyhow::{Context, Result, bail};
use clap::Parser;
use serde::{Deserialize, Serialize};
use std::{
    io::{self, BufRead, Write},
    path::PathBuf,
    time::Instant,
};
use tracing_subscriber::{EnvFilter, fmt};
mod model;
use model::{Flux2ImageToImageOptions, Flux2InpaintOptions, Flux2Klein, Flux2KleinPaths};
#[derive(Parser, Debug)]
#[command(name = "mgt-flux-klein")]
#[command(about = "Carrot Manga Translator Flux.2 Klein inpainting runner")]
struct Cli {
    #[arg(long, value_name = "FILE")]
    transformer_path: PathBuf,

    #[arg(long, value_name = "FILE")]
    vae_path: PathBuf,

    #[arg(long, value_name = "FILE")]
    text_encoder_path: PathBuf,

    #[arg(long, value_name = "FILE")]
    native_runtime: PathBuf,

    #[arg(long, default_value_t = 4)]
    steps: usize,

    #[arg(long, default_value_t = 1.0)]
    strength: f64,

    #[arg(long, default_value_t = 1024 * 1024)]
    max_pixels: u32,

    #[arg(long, default_value_t = 0)]
    mask_padding: u8,

    #[arg(long)]
    require_zluda: bool,

    #[arg(long)]
    require_metal: bool,

    #[arg(long, value_name = "DIR")]
    zluda_runtime_root: Option<PathBuf>,

    #[arg(long, value_name = "DIR")]
    cuda_runtime_dir: Option<PathBuf>,
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
        speech_bubble: Option<bool>,
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
    install_panic_hook();
    init_logging();
    if runner_runtime_policy::native::handle_rocm_probe()? {
        return Ok(());
    }
    if std::env::args_os().any(|arg| arg == "--capabilities") {
        return print_capabilities();
    }
    if std::env::args_os().any(|arg| arg == "--protocol-smoke") {
        return run_protocol_smoke();
    }
    let cli = Cli::parse();
    if cli.require_zluda {
        bail!("FLUX 0.83.5 uses the native ROCm backend on AMD; ZLUDA is no longer supported");
    }
    let runtime = runner_runtime_policy::native::load_runtime(&cli.native_runtime, "diffusion")?;
    if cfg!(not(any(
        feature = "cuda",
        feature = "metal",
        feature = "vulkan"
    ))) && runtime.specification.backend != "cpu"
    {
        bail!("CPU-only FLUX runner cannot use a GPU runtime");
    }
    if cfg!(feature = "vulkan") && runtime.specification.backend != "vulkan" {
        bail!("Vulkan runner requires a Vulkan runtime");
    }
    if cli.require_metal && runtime.specification.backend != "metal" {
        bail!("Metal request/runtime mismatch");
    }
    koharu_diffusion::send_logs_to_tracing()?;
    koharu_diffusion::set_progress_callback(|_| {})?;
    let started = Instant::now();
    let model = Flux2Klein::load_from_paths(
        Flux2KleinPaths {
            transformer_gguf: cli.transformer_path.clone(),
            vae_safetensors: cli.vae_path.clone(),
            text_encoder_gguf: cli.text_encoder_path.clone(),
        },
        &runtime.specification.backend,
    )?;
    eprintln!(
        "mgt-flux-klein: native model loaded in {:?}",
        started.elapsed()
    );
    run_worker(&model, &cli)
}

fn print_capabilities() -> Result<()> {
    println!(
        "{}",
        serde_json::json!({
            "protocol_version": 1,
            "engine": "koharu-diffusion-0.83.5",
            "runtime_validation": "deferred-until-load",
            "runner": "mgt-flux-klein",
            "backend": compiled_backend(),
            "metal_device": cfg!(feature = "metal"),
            "cpu_only": cfg!(not(any(feature = "cuda", feature = "metal", feature = "vulkan"))),
            "cuda_compiled": cfg!(feature = "cuda"),
            "metal_compiled": cfg!(feature = "metal"),
            "vulkan_compiled": cfg!(feature = "vulkan"),
            "models": ["flux-klein"],
        })
    );
    Ok(())
}

fn run_protocol_smoke() -> Result<()> {
    let mut line = String::new();
    io::stdin()
        .read_line(&mut line)
        .with_context(|| "failed to read Flux worker protocol smoke request")?;
    match serde_json::from_str::<WorkerRequest>(line.trim())
        .with_context(|| "invalid Flux worker protocol smoke request")?
    {
        WorkerRequest::Shutdown => {
            println!(
                "{}",
                serde_json::json!({
                        "protocol_version": 1,
                "engine": "koharu-diffusion-0.83.5",
                "runtime_validation": "deferred-until-load",
                        "runner": "mgt-flux-klein",
                        "backend": compiled_backend(),
                        "request": "shutdown",
                        "ok": true,
                    })
            );
            Ok(())
        }
        WorkerRequest::Inpaint { .. } => {
            bail!("protocol smoke accepts only the shutdown request")
        }
    }
}

fn compiled_backend() -> &'static str {
    #[cfg(feature = "vulkan")]
    {
        return "vulkan-native";
    }
    #[cfg(feature = "metal")]
    {
        return "metal-native";
    }
    #[cfg(all(not(feature = "metal"), not(feature = "vulkan"), feature = "cuda"))]
    {
        return "cuda-native";
    }
    #[cfg(not(any(feature = "metal", feature = "cuda", feature = "vulkan")))]
    {
        "cpu-native"
    }
}

fn run_worker(model: &Flux2Klein, cli: &Cli) -> Result<()> {
    let stdin = io::stdin();
    let mut stdout = io::stdout();
    if cli.require_metal {
        eprintln!("mgt-flux-klein: Metal image-to-image mode");
    }
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
                speech_bubble,
            } => {
                let started = Instant::now();
                let num_inference_steps = steps.unwrap_or(cli.steps);
                let strength = strength.unwrap_or(cli.strength);
                let max_pixels = max_pixels.unwrap_or(cli.max_pixels);
                let result = if cli.require_metal {
                    run_image_to_image(
                        model,
                        &input,
                        &output,
                        Flux2ImageToImageOptions {
                            num_inference_steps,
                            strength,
                            max_pixels,
                            speech_bubble: speech_bubble.unwrap_or(false),
                        },
                    )
                } else {
                    run_inpaint(
                        model,
                        &input,
                        &mask,
                        &output,
                        Flux2InpaintOptions {
                            num_inference_steps,
                            strength,
                            max_pixels,
                            mask_padding: mask_padding.unwrap_or(cli.mask_padding),
                            speech_bubble: speech_bubble.unwrap_or(false),
                        },
                    )
                };
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
    input: &PathBuf,
    mask: &PathBuf,
    output: &PathBuf,
    options: Flux2InpaintOptions,
) -> Result<()> {
    let image = image::open(input)
        .with_context(|| format!("failed to open input image {}", input.display()))?;
    let mask_image = image::open(mask)
        .with_context(|| format!("failed to open mask image {}", mask.display()))?;
    let result = model
        .inpaint(&image, &mask_image, &options)
        .with_context(|| "Flux.2 Klein inpainting failed")?;
    result
        .save(output)
        .with_context(|| format!("failed to write output image {}", output.display()))?;
    Ok(())
}

fn run_image_to_image(
    model: &Flux2Klein,
    input: &PathBuf,
    output: &PathBuf,
    options: Flux2ImageToImageOptions,
) -> Result<()> {
    let image = image::open(input)
        .with_context(|| format!("failed to open input image {}", input.display()))?;
    let result = model
        .image_to_image(&image, &options)
        .with_context(|| "Flux.2 Klein Metal image edit failed")?;
    result
        .save(output)
        .with_context(|| format!("failed to write output image {}", output.display()))?;
    Ok(())
}

fn init_logging() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("warn"));
    let _ = fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(filter)
        .with_target(false)
        .try_init();
}

fn install_panic_hook() {
    std::panic::set_hook(Box::new(|panic_info| {
        let message = panic_info
            .payload()
            .downcast_ref::<&str>()
            .map(|text| *text)
            .or_else(|| {
                panic_info
                    .payload()
                    .downcast_ref::<String>()
                    .map(|text| text.as_str())
            })
            .unwrap_or("unknown panic");
        let location = panic_info
            .location()
            .map(|location| format!(" at {}:{}", location.file(), location.line()))
            .unwrap_or_default();
        eprintln!("mgt-flux-klein: fatal runtime panic: {message}{location}");
    }));
}
