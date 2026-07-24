#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CudaRuntimeProbe {
    Run,
    SkipForZluda,
    Disabled,
}

pub const fn decide_cuda_runtime_probe(
    uses_zluda: bool,
    uses_native_cuda: bool,
) -> CudaRuntimeProbe {
    if uses_zluda {
        CudaRuntimeProbe::SkipForZluda
    } else if uses_native_cuda {
        CudaRuntimeProbe::Run
    } else {
        CudaRuntimeProbe::Disabled
    }
}

#[cfg(test)]
mod tests {
    use super::{CudaRuntimeProbe, decide_cuda_runtime_probe};

    #[test]
    fn zluda_never_uses_the_cuda_runtime_api_probe() {
        assert_eq!(
            decide_cuda_runtime_probe(true, true),
            CudaRuntimeProbe::SkipForZluda
        );
        assert_eq!(
            decide_cuda_runtime_probe(true, false),
            CudaRuntimeProbe::SkipForZluda
        );
    }

    #[test]
    fn native_cuda_runs_the_probe() {
        assert_eq!(
            decide_cuda_runtime_probe(false, true),
            CudaRuntimeProbe::Run
        );
    }

    #[test]
    fn metal_and_cpu_disable_the_cuda_probe() {
        assert_eq!(
            decide_cuda_runtime_probe(false, false),
            CudaRuntimeProbe::Disabled
        );
    }
}
