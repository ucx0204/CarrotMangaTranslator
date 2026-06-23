use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use anyhow::{Result, bail};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComputePolicy {
    CpuOnly,
    PreferGpu,
}

#[derive(Clone)]
pub struct RuntimeManager {
    inner: Arc<RuntimeInner>,
}

pub type Runtime = RuntimeManager;

struct RuntimeInner {
    root: PathBuf,
    wants_gpu: bool,
}

impl RuntimeManager {
    pub fn new(root: impl Into<PathBuf>, policy: ComputePolicy) -> Result<Self> {
        Ok(Self {
            inner: Arc::new(RuntimeInner {
                root: root.into(),
                wants_gpu: policy != ComputePolicy::CpuOnly,
            }),
        })
    }

    pub fn root(&self) -> &Path {
        &self.inner.root
    }

    pub fn wants_gpu(&self) -> bool {
        self.inner.wants_gpu
    }

    pub fn downloads(&self) -> Downloads {
        Downloads {
            root: self.root().join("models").join("huggingface"),
        }
    }
}

#[derive(Clone)]
pub struct Downloads {
    root: PathBuf,
}

impl Downloads {
    pub async fn huggingface_model(&self, repo: &str, file: &str) -> Result<PathBuf> {
        if repo == "mayocream/lama-manga" && file == "lama-manga.safetensors" {
            return env_path("MGT_KOHARU_LAMA_WEIGHTS_PATH");
        }
        if repo == "mayocream/aot-inpainting" && file == "config.json" {
            return env_path("MGT_KOHARU_AOT_CONFIG_PATH");
        }
        if repo == "mayocream/aot-inpainting" && file == "model.safetensors" {
            return env_path("MGT_KOHARU_AOT_WEIGHTS_PATH");
        }

        let cached = self
            .root
            .join(repo.replace('/', "--"))
            .join(file.replace('/', "_"));
        if cached.exists() {
            return Ok(cached);
        }

        bail!(
            "koharu-runtime-lite cannot resolve {repo}/{file}; pass the model path from the host app"
        );
    }
}

fn env_path(name: &str) -> Result<PathBuf> {
    let path = std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| anyhow::anyhow!("{name} is not set"))?;
    if !path.exists() {
        bail!("{name} points to a missing file: {}", path.display());
    }
    Ok(path)
}

pub fn check_cuda_driver_support() -> bool {
    true
}

pub fn zluda_active() -> bool {
    std::env::var_os("KOHARU_ZLUDA_ACTIVE").is_some_and(|value| value == "1")
}

#[macro_export]
macro_rules! declare_hf_model_package {
    (
        id: $id:literal,
        repo: $repo:expr,
        file: $file:expr,
        bootstrap: $bootstrap:expr,
        order: $order:expr
        $(,)?
    ) => {
        const _: () = ();
    };
}

#[macro_export]
macro_rules! declare_native_package {
    (
        id: $id:literal,
        bootstrap: $bootstrap:expr,
        order: $order:expr,
        enabled: $enabled:path,
        present: $present:path,
        prepare: $prepare:path
        $(,)?
    ) => {
        const _: () = ();
    };
}
