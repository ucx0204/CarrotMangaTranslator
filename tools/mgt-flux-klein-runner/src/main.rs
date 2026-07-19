use std::{
    fs,
    io::{self, BufRead, Write},
    path::{Path, PathBuf},
    time::Instant,
};

#[cfg(feature = "cuda")]
use std::ffi::CStr;

use anyhow::{Context, Result, bail};
use clap::Parser;
use image::GenericImageView;
use koharu_ml::flux2_klein::{Flux2ImageToImageOptions, Flux2Klein, Flux2KleinPaths};
use koharu_runtime::{Catalog, ComputePolicy, RuntimeManager};
use serde::{Deserialize, Serialize};
use tracing_subscriber::{EnvFilter, fmt};

const CUDA_REQUIRED_DLLS: &[&str] = &[
    "cudart64_12.dll",
    "cublas64_12.dll",
    "cublasLt64_12.dll",
    "curand64_10.dll",
];
const CUDA_OPTIONAL_DLLS: &[&str] = &[
    "cudnn64_9.dll",
    "cudnn_adv64_9.dll",
    "cudnn_cnn64_9.dll",
    "cudnn_engines_precompiled64_9.dll",
    "cudnn_engines_runtime_compiled64_9.dll",
    "cudnn_engines_tensor_ir64_9.dll",
    "cudnn_graph64_9.dll",
    "cudnn_heuristic64_9.dll",
    "cudnn_ops64_9.dll",
];

#[derive(Parser, Debug)]
#[command(name = "mgt-flux-klein")]
#[command(about = "Carrot Manga Translator Flux.2 Klein inpainting runner")]
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
    if std::env::args_os().any(|arg| arg == "--capabilities") {
        return print_capabilities();
    }
    if std::env::args_os().any(|arg| arg == "--protocol-smoke") {
        return run_protocol_smoke();
    }
    let cli = Cli::parse();

    if cli.require_zluda && cli.require_metal {
        bail!("--require-zluda and --require-metal cannot be used together");
    }
    if cli.require_metal {
        ensure_metal_available()?;
        prepare_metal_matrix_runtime();
    } else if cli.require_zluda {
        prepare_zluda_runtime(&cli).await?;
        // ZLUDA's nvcudart_hybrid64.dll is not a complete CUDA Runtime API
        // implementation and does not export entry points such as
        // cudaGetDeviceCount. Candle initializes ZLUDA through the CUDA Driver
        // API instead, so a runtime-only diagnostic would abort before model
        // loading even though the supported driver path is ready.
        eprintln!("mgt-flux-klein: CUDA runtime probe skipped for ZLUDA");
    } else {
        prepare_cuda_runtime(cli.cuda_runtime_dir.as_deref())?;
        log_cuda_runtime_probe();
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

fn prepare_metal_matrix_runtime() {
    if std::env::var_os("CANDLE_DEQUANTIZE_ALL").is_none()
        && std::env::var_os("CANDLE_DEQUANTIZE_ALL_F16").is_none()
    {
        // Candle's quantized Metal matmul corrupts the FLUX transformer output
        // on some Apple GPUs. Materializing the GGUF weights as F16 once during
        // model load keeps inference on Metal while using the stable matmul path.
        unsafe { std::env::set_var("CANDLE_DEQUANTIZE_ALL_F16", "1") };
        eprintln!("mgt-flux-klein: using dequantized F16 Metal matrix kernels");
    }
}

fn print_capabilities() -> Result<()> {
    ensure_metal_available()?;
    println!(
        "{}",
        serde_json::json!({
            "protocol_version": 1,
            "runner": "mgt-flux-klein",
            "backend": "metal-native",
            "metal_device": true,
            "models": ["flux-klein"],
        })
    );
    Ok(())
}

fn run_protocol_smoke() -> Result<()> {
    ensure_metal_available()?;
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
                    "runner": "mgt-flux-klein",
                    "backend": "metal-native",
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

fn ensure_metal_available() -> Result<()> {
    #[cfg(feature = "metal")]
    {
        let device = koharu_ml::Device::new_metal(0)
            .with_context(|| "Metal device initialization failed")?;
        if !device.is_metal() {
            bail!("Metal device preflight returned a non-Metal device");
        }
        eprintln!("mgt-flux-klein: Metal device preflight passed");
        Ok(())
    }
    #[cfg(not(feature = "metal"))]
    {
        bail!("Metal backend requested, but this runner was not built with --features metal")
    }
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

fn prepare_cuda_runtime(cuda_runtime_dir: Option<&Path>) -> Result<()> {
    let Some(cuda_runtime_dir) = cuda_runtime_dir else {
        return Ok(());
    };
    if !cuda_runtime_dir.exists() {
        bail!(
            "CUDA runtime directory does not exist: {}",
            cuda_runtime_dir.display()
        );
    }

    prepend_path(cuda_runtime_dir);
    let missing_required = CUDA_REQUIRED_DLLS
        .iter()
        .filter(|dll| !cuda_runtime_dir.join(dll).exists())
        .copied()
        .collect::<Vec<_>>();
    if !missing_required.is_empty() {
        bail!(
            "CUDA runtime directory is missing required DLLs: {} ({})",
            missing_required.join(", "),
            cuda_runtime_dir.display()
        );
    }

    let mut preloaded = 0usize;
    for dll in CUDA_REQUIRED_DLLS.iter().chain(CUDA_OPTIONAL_DLLS.iter()) {
        let path = cuda_runtime_dir.join(dll);
        if path.exists() {
            preload_library(&path)?;
            preloaded += 1;
        }
    }
    eprintln!(
        "mgt-flux-klein: CUDA runtime DLLs preloaded path=\"{}\" count={preloaded}",
        cuda_runtime_dir.display()
    );
    Ok(())
}

fn prepend_path(path: &Path) {
    let current = std::env::var_os("PATH").unwrap_or_default();
    let mut paths = std::env::split_paths(&current).collect::<Vec<_>>();
    if !paths.iter().any(|candidate| candidate == path) {
        paths.insert(0, path.to_path_buf());
    }
    if let Ok(joined) = std::env::join_paths(paths) {
        unsafe { std::env::set_var("PATH", joined) };
    }
}

fn preload_library(path: &Path) -> Result<()> {
    let library = unsafe { libloading::Library::new(path) }
        .with_context(|| format!("failed to preload {}", path.display()))?;
    std::mem::forget(library);
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
                // The app owns mask expansion and final compositing.  Keep accepting
                // mask_padding for protocol compatibility, but do not crop or clamp
                // latents a second time inside the model runtime.
                let _mask_padding = mask_padding.unwrap_or(cli.mask_padding);
                let result = run_inpaint(
                    model,
                    cli,
                    &input,
                    &mask,
                    &output,
                    Flux2ImageToImageOptions {
                        num_inference_steps: steps.unwrap_or(cli.steps),
                        strength: strength.unwrap_or(cli.strength),
                        max_pixels: max_pixels.unwrap_or(cli.max_pixels),
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
    options: Flux2ImageToImageOptions,
) -> Result<()> {
    let image = image::open(input)
        .with_context(|| format!("failed to open input image {}", input.display()))?;
    let mask_image = image::open(mask)
        .with_context(|| format!("failed to open mask image {}", mask.display()))?;
    if image.dimensions() != mask_image.dimensions() {
        bail!(
            "image/mask dimensions mismatch: image is {:?}, mask is {:?}",
            image.dimensions(),
            mask_image.dimensions()
        );
    }
    if !mask_image.to_luma8().pixels().any(|pixel| pixel.0[0] > 0) {
        bail!("inpainting mask is empty");
    }

    // FLUX.2 Klein is an image-edit model.  Generate the complete contextual
    // crop, then let the Electron side blend only the requested mask back into
    // the page. This mirrors the proven MangaTranslator pipeline and avoids a
    // second internal crop plus per-step latent clamping that would deprive the
    // edit model of the surrounding context prepared by the app.
    let result = model
        .image_to_image(&image, &options)
        .with_context(|| "Flux.2 Klein image edit failed")?;
    result
        .save(output)
        .with_context(|| format!("failed to write output image {}", output.display()))?;
    Ok(())
}

fn init_logging() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("warn"));
    let _ = fmt().with_env_filter(filter).with_target(false).try_init();
}

#[cfg(feature = "cuda")]
fn log_cuda_runtime_probe() {
    match cudarc::runtime::result::device::get_count() {
        Ok(count) => {
            eprintln!("mgt-flux-klein: CUDA runtime device count {count}");
            for ordinal in 0..count.min(4) {
                match cudarc::runtime::result::device::get_device_prop(ordinal) {
                    Ok(prop) => eprintln!(
                        "mgt-flux-klein: CUDA device {ordinal}: name=\"{}\" compute_capability={}.{} total_global_mem_mib={} multiprocessors={}",
                        cuda_device_name(&prop.name),
                        prop.major,
                        prop.minor,
                        prop.totalGlobalMem / 1024 / 1024,
                        prop.multiProcessorCount
                    ),
                    Err(error) => {
                        eprintln!("mgt-flux-klein: CUDA device {ordinal} probe failed: {error:?}")
                    }
                }
            }
        }
        Err(error) => eprintln!("mgt-flux-klein: CUDA runtime probe failed: {error:?}"),
    }
}

#[cfg(feature = "cuda")]
fn cuda_device_name(name: &[std::os::raw::c_char]) -> String {
    unsafe { CStr::from_ptr(name.as_ptr()).to_string_lossy().into_owned() }
}

#[cfg(not(feature = "cuda"))]
fn log_cuda_runtime_probe() {
    eprintln!("mgt-flux-klein: CUDA probe unavailable in this build");
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
