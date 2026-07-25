use std::{
    fs,
    io::{self, BufRead, Write},
    path::{Path, PathBuf},
    time::Instant,
};

#[cfg(feature = "cuda")]
use std::ffi::CStr;

use anyhow::{Context, Result, bail};
use clap::{Parser, ValueEnum};
use koharu_ml::{
    anime_text::{AnimeTextDetection, AnimeTextDetector, AnimeTextYoloVariant},
    aot_inpainting::AotInpainting,
    lama::Lama,
    types::TextRegion,
};
use koharu_runtime::{ComputePolicy, RuntimeManager};
use serde::{Deserialize, Serialize};
use tracing_subscriber::{EnvFilter, fmt};

use runner_runtime_policy::{CudaRuntimeProbe, decide_cuda_runtime_probe};

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
#[command(about = "Carrot Manga Translator Koharu model runner")]
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
    #[value(name = "anime-text-yolo")]
    AnimeTextYolo,
}

#[derive(Debug, Clone, Copy, ValueEnum, PartialEq, Eq)]
enum BackendKind {
    #[value(name = "auto")]
    Auto,
    #[value(name = "cuda-native")]
    CudaNative,
    #[value(name = "zluda-native")]
    ZludaNative,
    #[value(name = "metal-native")]
    MetalNative,
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
    #[serde(rename = "detect_text")]
    DetectText {
        id: String,
        input: PathBuf,
        confidence_threshold: Option<f32>,
        nms_threshold: Option<f32>,
    },
    #[serde(rename = "shutdown")]
    Shutdown,
}

#[derive(Debug, Serialize)]
struct WorkerResponse {
    id: String,
    ok: bool,
    elapsed_ms: u128,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<AnimeTextDetection>,
    error: Option<String>,
}

enum LoadedModel {
    Lama(Lama),
    Aot(AotInpainting),
    AnimeText(AnimeTextDetector),
}

trait WorkerOperations {
    fn inpaint(
        &self,
        input: &Path,
        mask: &Path,
        bubble_mask: &Path,
        output: &Path,
        windows: Vec<[u32; 4]>,
    ) -> Result<()>;

    fn detect_text(
        &self,
        input: &Path,
        confidence_threshold: f32,
        nms_threshold: f32,
    ) -> Result<AnimeTextDetection>;
}

impl WorkerOperations for LoadedModel {
    fn inpaint(
        &self,
        input: &Path,
        mask: &Path,
        bubble_mask: &Path,
        output: &Path,
        windows: Vec<[u32; 4]>,
    ) -> Result<()> {
        run_inpaint(self, input, mask, bubble_mask, output, windows)
    }

    fn detect_text(
        &self,
        input: &Path,
        confidence_threshold: f32,
        nms_threshold: f32,
    ) -> Result<AnimeTextDetection> {
        run_text_detection(self, input, confidence_threshold, nms_threshold)
    }
}

enum WorkerDispatch {
    Shutdown,
    Response(WorkerResponse),
}

#[tokio::main]
async fn main() -> Result<()> {
    install_panic_hook();
    init_logging();
    if std::env::args_os().any(|arg| arg == "--capabilities") {
        return print_capabilities();
    }
    let cli = Cli::parse();

    let uses_zluda = cli.require_zluda || cli.backend == BackendKind::ZludaNative;
    if uses_zluda && cli.backend == BackendKind::MetalNative {
        bail!("--require-zluda and --backend metal-native cannot be used together");
    }
    let uses_native_cuda =
        cli.backend != BackendKind::MetalNative && cli.backend != BackendKind::Cpu;
    let runtime_probe = decide_cuda_runtime_probe(uses_zluda, uses_native_cuda);
    if cli.backend == BackendKind::MetalNative {
        ensure_metal_available()?;
    } else if uses_zluda {
        prepare_zluda_runtime(&cli).await?;
    } else if cli.backend != BackendKind::Cpu {
        prepare_cuda_runtime(cli.cuda_runtime_dir.as_deref())?;
    }
    match runtime_probe {
        CudaRuntimeProbe::Run => log_cuda_runtime_probe(),
        CudaRuntimeProbe::SkipForZluda => {
            eprintln!("mgt-koharu-inpaint-runner: CUDA runtime probe skipped for ZLUDA");
        }
        CudaRuntimeProbe::Disabled => {}
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

fn print_capabilities() -> Result<()> {
    #[cfg(feature = "metal")]
    let (backend, metal_device) = {
        ensure_metal_available()?;
        ("metal-native", true)
    };
    #[cfg(all(not(feature = "metal"), feature = "cuda"))]
    let (backend, metal_device) = ("cuda-native", false);
    #[cfg(not(any(feature = "metal", feature = "cuda")))]
    let (backend, metal_device) = ("cpu", false);
    println!(
        "{}",
        serde_json::json!({
            "protocol_version": 1,
            "runner": "mgt-koharu-inpaint-runner",
            "backend": backend,
            "metal_device": metal_device,
            "models": ["lama-manga", "aot-inpainting", "anime-text-yolo"],
        })
    );
    Ok(())
}

fn ensure_metal_available() -> Result<()> {
    #[cfg(feature = "metal")]
    {
        let device = koharu_ml::Device::new_metal(0)
            .with_context(|| "Metal device initialization failed")?;
        if !device.is_metal() {
            bail!("Metal device preflight returned a non-Metal device");
        }
        eprintln!("mgt-koharu-inpaint-runner: Metal device preflight passed");
        Ok(())
    }
    #[cfg(not(feature = "metal"))]
    {
        bail!("Metal backend requested, but this runner was not built with --features metal")
    }
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
        ModelKind::AnimeTextYolo => {
            let model =
                AnimeTextDetector::load_from_path(&cli.weights, AnimeTextYoloVariant::N, cpu)?;
            Ok(LoadedModel::AnimeText(model))
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
    run_worker_stream(model, stdin.lock(), &mut stdout)
}

fn run_worker_stream<R, W, O>(operations: &O, input: R, output: &mut W) -> Result<()>
where
    R: BufRead,
    W: Write,
    O: WorkerOperations,
{
    for line in input.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let request: WorkerRequest = serde_json::from_str(&line)
            .with_context(|| format!("invalid worker request: {}", line))?;
        match dispatch_worker_request(operations, request) {
            WorkerDispatch::Shutdown => break,
            WorkerDispatch::Response(response) => write_jsonl(output, &response)?,
        }
    }
    Ok(())
}

fn dispatch_worker_request<O: WorkerOperations>(
    operations: &O,
    request: WorkerRequest,
) -> WorkerDispatch {
    match request {
        WorkerRequest::Shutdown => WorkerDispatch::Shutdown,
        WorkerRequest::Inpaint {
            id,
            input,
            mask,
            bubble_mask,
            output,
            windows,
            _max_pixels: _,
        } => WorkerDispatch::Response(timed_worker_response(id, || {
            operations.inpaint(
                &input,
                &mask,
                &bubble_mask,
                &output,
                windows.unwrap_or_default(),
            )?;
            Ok(None)
        })),
        WorkerRequest::DetectText {
            id,
            input,
            confidence_threshold,
            nms_threshold,
        } => WorkerDispatch::Response(timed_worker_response(id, || {
            operations
                .detect_text(
                    &input,
                    confidence_threshold.unwrap_or(0.25),
                    nms_threshold.unwrap_or(0.45),
                )
                .map(Some)
        })),
    }
}

fn timed_worker_response<F>(id: String, operation: F) -> WorkerResponse
where
    F: FnOnce() -> Result<Option<AnimeTextDetection>>,
{
    let started = Instant::now();
    match operation() {
        Ok(result) => WorkerResponse {
            id,
            ok: true,
            elapsed_ms: started.elapsed().as_millis(),
            result,
            error: None,
        },
        Err(error) => WorkerResponse {
            id,
            ok: false,
            elapsed_ms: started.elapsed().as_millis(),
            result: None,
            error: Some(format!("{error:#}")),
        },
    }
}

fn write_jsonl<W: Write>(output: &mut W, response: &WorkerResponse) -> Result<()> {
    serde_json::to_writer(&mut *output, response)?;
    output.write_all(b"\n")?;
    output.flush()?;
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
        LoadedModel::AnimeText(_) => {
            bail!("anime-text-yolo does not accept inpaint requests")
        }
    };
    result
        .save(output)
        .with_context(|| format!("failed to write output image {}", output.display()))?;
    Ok(())
}

fn run_text_detection(
    model: &LoadedModel,
    input: &Path,
    confidence_threshold: f32,
    nms_threshold: f32,
) -> Result<AnimeTextDetection> {
    validate_detection_threshold("confidence_threshold", confidence_threshold)?;
    validate_detection_threshold("nms_threshold", nms_threshold)?;
    let detector = match model {
        LoadedModel::AnimeText(detector) => detector,
        LoadedModel::Lama(_) | LoadedModel::Aot(_) => {
            bail!("the loaded inpainting model does not accept detect_text requests")
        }
    };
    let image = image::open(input)
        .with_context(|| format!("failed to open input image {}", input.display()))?;
    detector.inference_with_thresholds(&image, confidence_threshold, nms_threshold)
}

fn validate_detection_threshold(name: &str, value: f32) -> Result<()> {
    if !value.is_finite() || !(0.0..=1.0).contains(&value) {
        bail!("{name} must be a finite number between 0 and 1");
    }
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

#[cfg(feature = "cuda")]
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

#[cfg(feature = "cuda")]
fn cuda_device_name(name: &[std::os::raw::c_char]) -> String {
    unsafe { CStr::from_ptr(name.as_ptr()).to_string_lossy().into_owned() }
}

#[cfg(not(feature = "cuda"))]
fn log_cuda_runtime_probe() {
    eprintln!("mgt-koharu-inpaint-runner: CUDA probe unavailable in this build");
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

#[cfg(test)]
mod tests {
    use std::{
        cell::{Cell, RefCell},
        collections::VecDeque,
        io::Cursor,
    };

    use super::*;

    #[derive(Default)]
    struct StubOperations {
        inpaint_results: RefCell<VecDeque<Result<()>>>,
        inpaint_calls: Cell<usize>,
    }

    impl StubOperations {
        fn with_inpaint_results(results: Vec<Result<()>>) -> Self {
            Self {
                inpaint_results: RefCell::new(results.into()),
                inpaint_calls: Cell::new(0),
            }
        }
    }

    impl WorkerOperations for StubOperations {
        fn inpaint(
            &self,
            _input: &Path,
            _mask: &Path,
            _bubble_mask: &Path,
            _output: &Path,
            _windows: Vec<[u32; 4]>,
        ) -> Result<()> {
            self.inpaint_calls.set(self.inpaint_calls.get() + 1);
            self.inpaint_results
                .borrow_mut()
                .pop_front()
                .unwrap_or(Ok(()))
        }

        fn detect_text(
            &self,
            _input: &Path,
            _confidence_threshold: f32,
            _nms_threshold: f32,
        ) -> Result<AnimeTextDetection> {
            bail!("unexpected detect_text operation")
        }
    }

    #[test]
    fn parses_detect_text_request_with_thresholds() {
        let request: WorkerRequest = serde_json::from_str(
            r#"{"type":"detect_text","id":"42","input":"page.png","confidence_threshold":0.4,"nms_threshold":0.5}"#,
        )
        .expect("detect_text request");
        match request {
            WorkerRequest::DetectText {
                id,
                input,
                confidence_threshold,
                nms_threshold,
            } => {
                assert_eq!(id, "42");
                assert_eq!(input, PathBuf::from("page.png"));
                assert_eq!(confidence_threshold, Some(0.4));
                assert_eq!(nms_threshold, Some(0.5));
            }
            _ => panic!("unexpected request variant"),
        }
    }

    #[test]
    fn rejects_invalid_detection_thresholds() {
        assert!(validate_detection_threshold("confidence", -0.1).is_err());
        assert!(validate_detection_threshold("confidence", 1.1).is_err());
        assert!(validate_detection_threshold("confidence", f32::NAN).is_err());
        assert!(validate_detection_threshold("confidence", 0.25).is_ok());
    }

    #[test]
    fn shutdown_stops_without_running_or_writing() {
        let operations = StubOperations::default();
        let input = Cursor::new(
            concat!(
                "{\"type\":\"shutdown\"}\n",
                "{\"type\":\"inpaint\",\"id\":\"ignored\",\"input\":\"i\",",
                "\"mask\":\"m\",\"bubble_mask\":\"b\",\"output\":\"o\"}\n"
            )
            .as_bytes(),
        );
        let mut output = Vec::new();

        run_worker_stream(&operations, input, &mut output).expect("shutdown");

        assert_eq!(operations.inpaint_calls.get(), 0);
        assert!(output.is_empty());
    }

    #[test]
    fn operation_error_is_a_response_and_does_not_stop_the_worker() {
        let operations = StubOperations::with_inpaint_results(vec![
            Err(anyhow::anyhow!("expected operation failure")),
            Ok(()),
        ]);
        let input = Cursor::new(
            [
                inpaint_request("failed"),
                inpaint_request("succeeded"),
                r#"{"type":"shutdown"}"#.to_string(),
            ]
            .join("\n"),
        );
        let mut output = Vec::new();

        run_worker_stream(&operations, input, &mut output).expect("worker stream");

        let responses = parse_jsonl(&output);
        assert_eq!(operations.inpaint_calls.get(), 2);
        assert_eq!(responses.len(), 2);
        assert_eq!(responses[0]["id"], "failed");
        assert_eq!(responses[0]["ok"], false);
        assert_eq!(responses[0]["error"], "expected operation failure");
        assert_eq!(responses[1]["id"], "succeeded");
        assert_eq!(responses[1]["ok"], true);
    }

    #[test]
    fn successful_operation_writes_a_success_response() {
        let operations = StubOperations::with_inpaint_results(vec![Ok(())]);
        let input = Cursor::new(inpaint_request("success"));
        let mut output = Vec::new();

        run_worker_stream(&operations, input, &mut output).expect("worker stream");

        let responses = parse_jsonl(&output);
        assert_eq!(responses.len(), 1);
        assert_eq!(responses[0]["id"], "success");
        assert_eq!(responses[0]["ok"], true);
        assert!(responses[0]["elapsed_ms"].is_number());
        assert_eq!(responses[0]["error"], serde_json::Value::Null);
        assert!(responses[0].get("result").is_none());
    }

    #[test]
    fn jsonl_writer_appends_exactly_one_newline() {
        let response = WorkerResponse {
            id: "line".to_string(),
            ok: false,
            elapsed_ms: 7,
            result: None,
            error: Some("first\nsecond".to_string()),
        };
        let mut output = Vec::new();

        write_jsonl(&mut output, &response).expect("JSONL response");

        assert_eq!(output.iter().filter(|byte| **byte == b'\n').count(), 1);
        assert_eq!(output.last(), Some(&b'\n'));
        serde_json::from_slice::<serde_json::Value>(&output[..output.len() - 1])
            .expect("valid JSON before newline");
    }

    fn inpaint_request(id: &str) -> String {
        format!(
            r#"{{"type":"inpaint","id":"{id}","input":"input.png","mask":"mask.png","bubble_mask":"bubble.png","output":"output.png"}}"#
        )
    }

    fn parse_jsonl(output: &[u8]) -> Vec<serde_json::Value> {
        String::from_utf8(output.to_vec())
            .expect("UTF-8 JSONL")
            .lines()
            .map(|line| serde_json::from_str(line).expect("valid JSON line"))
            .collect()
    }
}
