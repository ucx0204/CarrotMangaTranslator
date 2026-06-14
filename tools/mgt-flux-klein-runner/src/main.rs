use std::{
    fs,
    io::{self, BufRead, Write},
    path::{Path, PathBuf},
    time::Instant,
};

use anyhow::{Context, Result, bail};
use clap::Parser;
use koharu_ml::flux2_klein::{Flux2InpaintOptions, Flux2Klein, Flux2KleinPaths};
use koharu_runtime::{Catalog, ComputePolicy, RuntimeManager};
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

    #[arg(long)]
    require_zluda: bool,

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

#[tokio::main]
async fn main() -> Result<()> {
    install_panic_hook();
    init_logging();
    let cli = Cli::parse();

    if cli.require_zluda {
        prepare_zluda_runtime(&cli).await?;
    }

    let load_started = Instant::now();
    let model = Flux2Klein::load_from_paths(Flux2KleinPaths {
        transformer_gguf: cli.transformer_path.clone(),
        vae_safetensors: cli.vae_path.clone(),
    })
    .with_context(|| "Flux.2 Klein model load failed")?;
    eprintln!(
        "mgt-flux-klein: model loaded in {:?}",
        load_started.elapsed()
    );

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

async fn prepare_zluda_runtime(cli: &Cli) -> Result<()> {
    let runtime_root = cli.zluda_runtime_root.clone().unwrap_or_else(|| {
        std::env::current_exe()
            .ok()
            .and_then(|path| path.parent().map(|parent| parent.join("zluda-runtime")))
            .unwrap_or_else(|| PathBuf::from("zluda-runtime"))
    });
    let runtime = RuntimeManager::new(runtime_root.clone(), ComputePolicy::PreferGpu)
        .with_context(|| "failed to create Koharu ZLUDA runtime manager")?;
    let catalog = Catalog::discover();
    let package = catalog
        .all()
        .find(|package| package.id == "runtime:zluda")
        .context("Koharu ZLUDA runtime package registration was not found")?;
    (package.ensure)(&runtime)
        .await
        .with_context(|| "failed to prepare Koharu ZLUDA runtime package")?;
    ensure_zluda_dll_aliases(&runtime_root, cli.cuda_runtime_dir.as_deref())
        .with_context(|| "failed to prepare ZLUDA CUDA DLL aliases")?;
    if !koharu_runtime::zluda_active() {
        bail!(
            "ZLUDA runtime is not active. Install AMD HIP SDK or set HIP_PATH before starting AMD Flux inpainting."
        );
    }
    eprintln!("mgt-flux-klein: ZLUDA runtime active");
    Ok(())
}

fn ensure_zluda_dll_aliases(runtime_root: &Path, cuda_runtime_dir: Option<&Path>) -> Result<()> {
    const DLL_ALIASES: &[(&str, &[&str])] = &[
        (
            "cublas64_13.dll",
            &["cublas.dll", "cublas64.dll", "cublas64_12.dll"],
        ),
        (
            "cublasLt64_13.dll",
            &["cublasLt.dll", "cublasLt64.dll", "cublasLt64_12.dll"],
        ),
        (
            "nvcudart_hybrid64.dll",
            &["cudart.dll", "cudart64.dll", "cudart64_12.dll"],
        ),
    ];

    let zluda_dir = runtime_root.join("runtime").join("zluda");
    if !zluda_dir.exists() {
        bail!(
            "ZLUDA runtime directory does not exist: {}",
            zluda_dir.display()
        );
    }

    for (source_name, alias_names) in DLL_ALIASES {
        let source = zluda_dir.join(source_name);
        if !source.exists() {
            bail!("ZLUDA runtime library is missing: {}", source.display());
        }
        let source_len = source
            .metadata()
            .with_context(|| format!("failed to read metadata for {}", source.display()))?
            .len();

        for alias_name in *alias_names {
            let alias = zluda_dir.join(alias_name);
            if alias.exists() {
                let alias_len = alias
                    .metadata()
                    .with_context(|| format!("failed to read metadata for {}", alias.display()))?
                    .len();
                if alias_len == source_len {
                    continue;
                }
                fs::remove_file(&alias).with_context(|| {
                    format!(
                        "failed to replace stale ZLUDA DLL alias {}",
                        alias.display()
                    )
                })?;
            }
            link_or_copy_file(&source, &alias).with_context(|| {
                format!(
                    "failed to create ZLUDA DLL alias {} -> {}",
                    alias.display(),
                    source.display()
                )
            })?;
        }
    }

    ensure_zluda_support_dll(
        cuda_runtime_dir,
        &zluda_dir,
        "curand64_10.dll",
        &[
            "curand.dll",
            "curand64.dll",
            "curand64_13.dll",
            "curand64_130.dll",
            "curand64_130_0.dll",
        ],
    )
    .with_context(|| "failed to prepare ZLUDA cuRAND support DLL")?;

    eprintln!("mgt-flux-klein: ZLUDA DLL aliases ready");
    Ok(())
}

fn ensure_zluda_support_dll(
    source_dir: Option<&Path>,
    zluda_dir: &Path,
    file_name: &str,
    alias_names: &[&str],
) -> Result<()> {
    let destination = zluda_dir.join(file_name);
    if !destination.exists() {
        let source_dir = source_dir.with_context(|| {
            format!(
                "ZLUDA support DLL {} is missing and --cuda-runtime-dir was not provided",
                file_name
            )
        })?;
        let source = source_dir.join(file_name);
        if !source.exists() {
            bail!(
                "ZLUDA support DLL {} is missing. Expected source: {}",
                file_name,
                source.display()
            );
        }
        link_or_copy_file(&source, &destination).with_context(|| {
            format!(
                "failed to copy ZLUDA support DLL {} from {}",
                file_name,
                source.display()
            )
        })?;
    }

    let source_len = destination
        .metadata()
        .with_context(|| format!("failed to read metadata for {}", destination.display()))?
        .len();
    for alias_name in alias_names {
        let alias = zluda_dir.join(alias_name);
        if alias.exists() {
            let alias_len = alias
                .metadata()
                .with_context(|| format!("failed to read metadata for {}", alias.display()))?
                .len();
            if alias_len == source_len {
                continue;
            }
            fs::remove_file(&alias).with_context(|| {
                format!(
                    "failed to replace stale ZLUDA DLL alias {}",
                    alias.display()
                )
            })?;
        }
        link_or_copy_file(&destination, &alias).with_context(|| {
            format!(
                "failed to create ZLUDA DLL alias {} -> {}",
                alias.display(),
                destination.display()
            )
        })?;
    }
    Ok(())
}

fn link_or_copy_file(source: &Path, destination: &Path) -> Result<()> {
    match fs::hard_link(source, destination) {
        Ok(()) => Ok(()),
        Err(hard_link_error) => {
            fs::copy(source, destination).with_context(|| {
                format!(
                    "hard link failed ({hard_link_error}); copy also failed from {} to {}",
                    source.display(),
                    destination.display()
                )
            })?;
            Ok(())
        }
    }
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

fn init_logging() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("warn"));
    let _ = fmt().with_env_filter(filter).with_target(false).try_init();
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
        eprintln!("mgt-flux-klein: fatal runtime panic: {message}");
    }));
}
