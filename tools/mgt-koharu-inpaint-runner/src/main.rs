use std::{
    ffi::CStr,
    fs,
    io::{self, BufRead, Write},
    path::{Path, PathBuf},
    time::Instant,
};

use anyhow::{Context, Result, bail};
use clap::{Parser, ValueEnum};
use koharu_ml::{aot_inpainting::AotInpainting, lama::Lama, types::TextRegion};
use koharu_runtime::{ComputePolicy, RuntimeManager};
use serde::{Deserialize, Serialize};
use tracing_subscriber::{EnvFilter, fmt};

const ZLUDA_RELEASE_BASE_URL: &str = "https://github.com/vosen/ZLUDA/releases/download";
const ZLUDA_RELEASE_TAG: &str = "v6-preview.65";
const ZLUDA_ASSET_NAME: &str = "zluda-windows-5c75a54.zip";
const ZLUDA_DLLS: &[&str] = &[
    "nvcuda.dll",
    "nvcudart_hybrid64.dll",
    "cublas64_13.dll",
    "cublasLt64_13.dll",
    "cufft64_12.dll",
    "cudnn64_9.dll",
];
const HIP_ROOT_CANDIDATES: &[&str] = &[
    r"C:\hip_sdk",
    r"C:\Program Files\AMD\ROCm",
    r"C:\Program Files\AMD\ROCm\7.1",
    r"C:\Program Files\AMD\ROCm\7.0",
    r"C:\Program Files\AMD\ROCm\6.4",
    r"C:\Program Files\AMD\ROCm\6.3",
    r"C:\Program Files\AMD\ROCm\6.2",
    r"C:\Program Files\AMD\ROCm\6.1",
    r"C:\Program Files\AMD\ROCm\6.0",
];
const HIP_RUNTIME_DLLS: &[&str] = &["amdhip64_7.dll", "amdhip64_6.dll"];
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
#[command(name = "mgt-koharu-inpaint-runner")]
#[command(about = "Carrot Manga Translator Koharu LaMa/AOT inpainting runner")]
struct Cli {
    #[arg(long, value_enum)]
    model: ModelKind,

    #[arg(long, value_name = "FILE")]
    weights: PathBuf,

    #[arg(long, value_name = "FILE")]
    config: Option<PathBuf>,

    #[arg(long, value_enum, default_value_t = BackendKind::Auto)]
    backend: BackendKind,

    #[arg(long)]
    require_zluda: bool,

    #[arg(long, value_name = "DIR")]
    zluda_runtime_root: Option<PathBuf>,

    #[arg(long, value_name = "DIR")]
    cuda_runtime_dir: Option<PathBuf>,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum ModelKind {
    #[value(name = "lama-manga")]
    LamaManga,
    #[value(name = "aot-inpainting")]
    AotInpainting,
}

#[derive(Debug, Clone, Copy, ValueEnum, PartialEq, Eq)]
enum BackendKind {
    #[value(name = "auto")]
    Auto,
    #[value(name = "cuda-native")]
    CudaNative,
    #[value(name = "zluda-native")]
    ZludaNative,
    #[value(name = "cpu")]
    Cpu,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum WorkerRequest {
    #[serde(rename = "inpaint")]
    Inpaint {
        id: String,
        input: PathBuf,
        mask: PathBuf,
        bubble_mask: PathBuf,
        output: PathBuf,
        windows: Option<Vec<[u32; 4]>>,
        #[serde(rename = "max_pixels")]
        _max_pixels: Option<u32>,
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

enum LoadedModel {
    Lama(Lama),
    Aot(AotInpainting),
}

#[tokio::main]
async fn main() -> Result<()> {
    install_panic_hook();
    init_logging();
    let cli = Cli::parse();

    let uses_zluda = cli.require_zluda || cli.backend == BackendKind::ZludaNative;
    if uses_zluda {
        prepare_zluda_runtime(&cli).await?;
        // ZLUDA is initialized through the CUDA Driver API. Its hybrid cudart
        // library does not provide the full CUDA Runtime API surface required
        // by the diagnostic below, including cudaGetDeviceCount.
        eprintln!("mgt-koharu-inpaint-runner: CUDA runtime probe skipped for ZLUDA");
    } else if cli.backend != BackendKind::Cpu {
        prepare_cuda_runtime(cli.cuda_runtime_dir.as_deref())?;
        log_cuda_runtime_probe();
    }

    let load_started = Instant::now();
    let model = load_model(&cli).await?;
    eprintln!(
        "mgt-koharu-inpaint-runner: model loaded in {:?}",
        load_started.elapsed()
    );

    run_worker(&model)?;
    Ok(())
}

async fn load_model(cli: &Cli) -> Result<LoadedModel> {
    let cpu = cli.backend == BackendKind::Cpu;
    match cli.model {
        ModelKind::LamaManga => {
            set_env_path("MGT_KOHARU_LAMA_WEIGHTS_PATH", &cli.weights);
            let runtime_root = resolve_runtime_root();
            let runtime = RuntimeManager::new(
                runtime_root,
                if cpu {
                    ComputePolicy::CpuOnly
                } else {
                    ComputePolicy::PreferGpu
                },
            )?;
            let model = Lama::load(&runtime, cpu).await?;
            Ok(LoadedModel::Lama(model))
        }
        ModelKind::AotInpainting => {
            let config = cli
                .config
                .as_ref()
                .context("--config is required for aot-inpainting")?;
            set_env_path("MGT_KOHARU_AOT_CONFIG_PATH", config);
            set_env_path("MGT_KOHARU_AOT_WEIGHTS_PATH", &cli.weights);
            let model = AotInpainting::load_from_paths(config, &cli.weights, cpu)?;
            Ok(LoadedModel::Aot(model))
        }
    }
}

fn resolve_runtime_root() -> PathBuf {
    std::env::var_os("KOHARU_DATA_ROOT")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::env::current_exe()
                .ok()
                .and_then(|path| path.parent().map(|parent| parent.join("koharu-data")))
                .unwrap_or_else(|| PathBuf::from("koharu-data"))
        })
}

async fn prepare_zluda_runtime(cli: &Cli) -> Result<()> {
    let runtime_root = cli.zluda_runtime_root.clone().unwrap_or_else(|| {
        std::env::current_exe()
            .ok()
            .and_then(|path| path.parent().map(|parent| parent.join("zluda-runtime")))
            .unwrap_or_else(|| PathBuf::from("zluda-runtime"))
    });
    install_zluda_runtime_if_needed(&runtime_root)
        .with_context(|| "failed to prepare Koharu ZLUDA runtime package")?;
    ensure_zluda_dll_aliases(&runtime_root, cli.cuda_runtime_dir.as_deref())
        .with_context(|| "failed to prepare ZLUDA CUDA DLL aliases")?;
    activate_zluda_runtime(&runtime_root).with_context(|| "failed to activate ZLUDA runtime")?;
    if !koharu_runtime::zluda_active() {
        bail!(
            "ZLUDA runtime is not active. Install AMD HIP SDK or set HIP_PATH before starting AMD Koharu inpainting."
        );
    }
    eprintln!("mgt-koharu-inpaint-runner: ZLUDA runtime active");
    Ok(())
}

fn install_zluda_runtime_if_needed(runtime_root: &Path) -> Result<()> {
    let install_dir = runtime_root.join("runtime").join("zluda");
    if ZLUDA_DLLS.iter().all(|dll| install_dir.join(dll).exists()) {
        return Ok(());
    }

    fs::create_dir_all(&install_dir)
        .with_context(|| format!("failed to create {}", install_dir.display()))?;
    let downloads_dir = runtime_root.join("runtime").join(".downloads");
    fs::create_dir_all(&downloads_dir)
        .with_context(|| format!("failed to create {}", downloads_dir.display()))?;
    let archive_path = downloads_dir.join(ZLUDA_ASSET_NAME);
    download_zluda_archive(&archive_path)?;
    extract_selected_zluda_dlls(&archive_path, &install_dir)?;

    let missing = ZLUDA_DLLS
        .iter()
        .filter(|dll| !install_dir.join(dll).exists())
        .copied()
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        bail!(
            "ZLUDA runtime archive is missing DLLs: {}",
            missing.join(", ")
        );
    }
    Ok(())
}

fn download_zluda_archive(archive_path: &Path) -> Result<()> {
    if archive_path.exists() && archive_path.metadata()?.len() > 0 {
        return Ok(());
    }
    let url = format!("{ZLUDA_RELEASE_BASE_URL}/{ZLUDA_RELEASE_TAG}/{ZLUDA_ASSET_NAME}");
    let partial_path = archive_path.with_extension("zip.partial");
    let mut response = ureq::get(&url)
        .call()
        .with_context(|| format!("failed to download `{url}`"))?;
    let mut reader = response.body_mut().as_reader();
    let mut file = fs::File::create(&partial_path)
        .with_context(|| format!("failed to create {}", partial_path.display()))?;
    io::copy(&mut reader, &mut file)
        .with_context(|| format!("failed to write {}", partial_path.display()))?;
    fs::rename(&partial_path, archive_path).with_context(|| {
        format!(
            "failed to finalize ZLUDA download {}",
            archive_path.display()
        )
    })?;
    Ok(())
}

fn extract_selected_zluda_dlls(archive_path: &Path, install_dir: &Path) -> Result<()> {
    let file = fs::File::open(archive_path)
        .with_context(|| format!("failed to open {}", archive_path.display()))?;
    let mut archive = zip::ZipArchive::new(file)
        .with_context(|| format!("failed to read {}", archive_path.display()))?;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)?;
        let Some(file_name) = Path::new(entry.name())
            .file_name()
            .and_then(|name| name.to_str())
        else {
            continue;
        };
        if !ZLUDA_DLLS.contains(&file_name) {
            continue;
        }
        let destination = install_dir.join(file_name);
        let mut output = fs::File::create(&destination)
            .with_context(|| format!("failed to create {}", destination.display()))?;
        io::copy(&mut entry, &mut output)
            .with_context(|| format!("failed to extract {}", destination.display()))?;
    }
    Ok(())
}

fn activate_zluda_runtime(runtime_root: &Path) -> Result<()> {
    let zluda_dir = runtime_root.join("runtime").join("zluda");
    let hip_root = hip_root_dir().context(
        "HIP SDK not found. Set HIP_PATH or install AMD HIP SDK before starting AMD Koharu inpainting.",
    )?;
    let hip_bin = hip_root.join("bin");
    prepend_path(&hip_bin);
    prepend_path(&zluda_dir);
    set_env_path("HIP_PATH", &hip_root);

    for dll in ZLUDA_DLLS {
        preload_library(&zluda_dir.join(dll))?;
    }
    set_env_value("KOHARU_ZLUDA_ACTIVE", "1");
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
        "mgt-koharu-inpaint-runner: CUDA runtime DLLs preloaded path=\"{}\" count={preloaded}",
        cuda_runtime_dir.display()
    );
    Ok(())
}

fn hip_root_dir() -> Option<PathBuf> {
    std::env::var_os("HIP_PATH")
        .map(PathBuf::from)
        .into_iter()
        .chain(HIP_ROOT_CANDIDATES.iter().map(PathBuf::from))
        .find(|dir| {
            HIP_RUNTIME_DLLS
                .iter()
                .any(|dll| dir.join("bin").join(dll).exists())
        })
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
    )?;
    Ok(())
}

fn set_env_path(name: &str, value: &Path) {
    unsafe { std::env::set_var(name, value) };
}

fn set_env_value(name: &str, value: &str) {
    unsafe { std::env::set_var(name, value) };
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
                "ZLUDA support DLL {file_name} is missing and --cuda-runtime-dir was not provided"
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
        link_or_copy_file(&source, &destination)?;
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
        link_or_copy_file(&destination, &alias)?;
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

fn run_worker(model: &LoadedModel) -> Result<()> {
    let stdin = io::stdin();
    let mut stdout = io::stdout();
    eprintln!("mgt-koharu-inpaint-runner: worker ready");
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
                bubble_mask,
                output,
                windows,
                _max_pixels: _,
            } => {
                let started = Instant::now();
                let result = run_inpaint(
                    model,
                    &input,
                    &mask,
                    &bubble_mask,
                    &output,
                    windows.unwrap_or_default(),
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
    model: &LoadedModel,
    input: &Path,
    mask: &Path,
    bubble_mask: &Path,
    output: &Path,
    windows: Vec<[u32; 4]>,
) -> Result<()> {
    let image = image::open(input)
        .with_context(|| format!("failed to open input image {}", input.display()))?;
    let mask_image = image::open(mask)
        .with_context(|| format!("failed to open mask image {}", mask.display()))?;
    let bubble_image = image::open(bubble_mask)
        .with_context(|| format!("failed to open bubble mask {}", bubble_mask.display()))?;

    let result = match model {
        LoadedModel::Lama(lama) => {
            let text_regions = windows_to_text_regions(windows);
            if text_regions.is_empty() {
                lama.inference(&image, &mask_image, &bubble_image)?
            } else {
                lama.inference_with_blocks(&image, &mask_image, &bubble_image, &text_regions)?
            }
        }
        LoadedModel::Aot(aot) => aot.inference(&image, &mask_image, &bubble_image)?,
    };
    result
        .save(output)
        .with_context(|| format!("failed to write output image {}", output.display()))?;
    Ok(())
}

fn windows_to_text_regions(windows: Vec<[u32; 4]>) -> Vec<TextRegion> {
    windows
        .into_iter()
        .filter_map(|[x1, y1, x2, y2]| {
            if x2 <= x1 || y2 <= y1 {
                return None;
            }
            Some(TextRegion {
                x: x1 as f32,
                y: y1 as f32,
                width: (x2 - x1) as f32,
                height: (y2 - y1) as f32,
                confidence: 1.0,
                detector: Some("carrot-window".to_string()),
                ..TextRegion::default()
            })
        })
        .collect()
}

fn init_logging() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("warn"));
    let _ = fmt().with_env_filter(filter).with_target(false).try_init();
}

fn log_cuda_runtime_probe() {
    match cudarc::runtime::result::device::get_count() {
        Ok(count) => {
            eprintln!("mgt-koharu-inpaint-runner: CUDA runtime device count {count}");
            for ordinal in 0..count.min(4) {
                match cudarc::runtime::result::device::get_device_prop(ordinal) {
                    Ok(prop) => eprintln!(
                        "mgt-koharu-inpaint-runner: CUDA device {ordinal}: name=\"{}\" compute_capability={}.{} total_global_mem_mib={} multiprocessors={}",
                        cuda_device_name(&prop.name),
                        prop.major,
                        prop.minor,
                        prop.totalGlobalMem / 1024 / 1024,
                        prop.multiProcessorCount
                    ),
                    Err(error) => eprintln!(
                        "mgt-koharu-inpaint-runner: CUDA device {ordinal} probe failed: {error:?}"
                    ),
                }
            }
        }
        Err(error) => eprintln!("mgt-koharu-inpaint-runner: CUDA runtime probe failed: {error:?}"),
    }
}

fn cuda_device_name(name: &[std::os::raw::c_char]) -> String {
    unsafe { CStr::from_ptr(name.as_ptr()).to_string_lossy().into_owned() }
}

fn install_panic_hook() {
    std::panic::set_hook(Box::new(|panic_info| {
        let message = panic_info
            .payload()
            .downcast_ref::<&str>()
            .copied()
            .or_else(|| {
                panic_info
                    .payload()
                    .downcast_ref::<String>()
                    .map(|text| text.as_str())
            })
            .unwrap_or("unknown panic");
        eprintln!("mgt-koharu-inpaint-runner: fatal runtime panic: {message}");
    }));
}
