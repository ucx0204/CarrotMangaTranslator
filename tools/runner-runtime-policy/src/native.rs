use std::path::{Path, PathBuf};

use anyhow::{Context, Result, ensure};
use serde::Deserialize;

/// Written by the app after checksum-verified installation. A worker never
/// discovers, downloads, or substitutes a runtime on its own.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeRuntime {
    pub schema: u32,
    pub engine: String,
    pub backend: String,
    pub libraries: Vec<PathBuf>,
}

pub struct LoadedRuntime {
    pub specification: NativeRuntime,
    _libraries: Vec<libloading::Library>,
}

pub fn load_runtime(manifest: &Path, expected_engine: &str) -> Result<LoadedRuntime> {
    let specification: NativeRuntime = serde_json::from_slice(
        &std::fs::read(manifest).with_context(|| format!("read {}", manifest.display()))?,
    )?;
    validate_specification(&specification, expected_engine)?;
    let mut libraries = Vec::with_capacity(specification.libraries.len());
    for path in &specification.libraries {
        let path = path
            .canonicalize()
            .with_context(|| format!("missing runtime library {}", path.display()))?;
        #[cfg(windows)]
        let path = windows_loader_path(&path);
        // Keep handles alive for the entire worker/model lifetime.
        libraries.push(
            unsafe { open_library(&path) }
                .with_context(|| format!("load native runtime library {}", path.display()))?,
        );
    }
    Ok(LoadedRuntime {
        specification,
        _libraries: libraries,
    })
}

#[cfg(windows)]
fn windows_loader_path(path: &Path) -> PathBuf {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use std::path::{Component, Prefix};
    let mut components = path.components();
    let Some(Component::Prefix(prefix)) = components.next() else {
        return path.to_owned();
    };
    // LoadLibraryExW preserves this spelling in GetModuleFileNameW. Libraries
    // such as Tensile append forward slashes to that path when finding kernels;
    // Win32 rejects those slashes under the verbatim namespace (issue #147).
    let mut result = match prefix.kind() {
        Prefix::VerbatimDisk(drive) => PathBuf::from(format!("{}:", drive as char)),
        Prefix::VerbatimUNC(server, share) => PathBuf::from(r"\\").join(server).join(share),
        _ => return path.to_owned(),
    };
    result.push(components.as_path());
    // Some bundled DLLs (notably MSVC OpenMP) still fail at MAX_PATH even in
    // a longPathAware process. Use the existing directory's DOS alias when
    // available; keep the DLL basename so dependency lookup remains stable.
    if result.as_os_str().encode_wide().count() >= 260 {
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GetShortPathNameW(input: *const u16, output: *mut u16, size: u32) -> u32;
        }
        if let (Some(parent), Some(name)) = (path.parent(), path.file_name()) {
            let input: Vec<u16> = parent.as_os_str().encode_wide().chain(Some(0)).collect();
            let mut output = vec![0u16; 32768];
            let length = unsafe {
                GetShortPathNameW(input.as_ptr(), output.as_mut_ptr(), output.len() as u32)
            } as usize;
            if length > 0 && length < output.len() {
                let shortened =
                    PathBuf::from(std::ffi::OsString::from_wide(&output[..length])).join(name);
                // An alias can be unavailable on a volume. Do not recurse when
                // GetShortPathNameW returns the original long directory.
                if shortened.as_os_str().encode_wide().count()
                    < path.as_os_str().encode_wide().count()
                {
                    return windows_loader_path(&shortened);
                }
            }
        }
        // Volumes can disable DOS aliases. Preserve the old loading contract
        // for OpenMP, which has no DLL-relative GPU kernels to discover.
        if path
            .file_name()
            .is_some_and(|name| name.eq_ignore_ascii_case("vcomp140.dll"))
        {
            return path.to_owned();
        }
    }
    result
}

fn validate_specification(spec: &NativeRuntime, expected_engine: &str) -> Result<()> {
    ensure!(
        spec.schema == 1,
        "unsupported native runtime manifest schema"
    );
    ensure!(
        spec.engine == expected_engine,
        "native runtime engine mismatch"
    );
    ensure!(
        matches!(
            spec.backend.as_str(),
            "cpu" | "cuda" | "rocm" | "metal" | "vulkan"
        ),
        "unsupported native runtime backend"
    );
    ensure!(
        spec.backend != "vulkan" || spec.engine == "diffusion",
        "Vulkan is supported only for diffusion"
    );
    ensure!(
        !spec.libraries.is_empty() && spec.libraries.len() <= 128,
        "invalid native runtime library count"
    );
    ensure!(
        spec.libraries.iter().all(|path| path.is_absolute()),
        "native runtime libraries must use absolute paths"
    );
    Ok(())
}

/// Explicit command, executed before model CLI parsing. It uses only the
/// app-installed ROCm core; no system SDK discovery or model downloads.
pub fn handle_rocm_probe() -> Result<bool> {
    let args: Vec<_> = std::env::args_os().collect();
    if args.get(1).is_none_or(|arg| arg != "--probe-rocm") {
        return Ok(false);
    }
    ensure!(args.len() == 4, "usage: --probe-rocm MANIFEST GPU_INDEX");
    let index: i32 = args[3].to_str().context("invalid GPU index")?.parse()?;
    let runtime = load_runtime(Path::new(&args[2]), "rocm-probe")?;
    ensure!(
        runtime.specification.backend == "rocm",
        "ROCm probe backend mismatch"
    );
    let position = runtime
        .specification
        .libraries
        .iter()
        .position(|path| {
            path.file_name()
                .is_some_and(|name| name == "amdhip64_7.dll")
        })
        .context("ROCm core manifest omits amdhip64_7.dll")?;
    let library = &runtime._libraries[position];
    type GetCount = unsafe extern "C" fn(*mut i32) -> i32;
    type GetProperties = unsafe extern "C" fn(*mut std::ffi::c_void, i32) -> i32;
    let get_count = unsafe { *library.get::<GetCount>(b"hipGetDeviceCount\0")? };
    let get_properties =
        unsafe { *library.get::<GetProperties>(b"hipGetDevicePropertiesR0600\0")? };
    let mut count = 0;
    let status = unsafe { get_count(&mut count) };
    ensure!(
        status == 0 && (1..=128).contains(&count),
        "ROCm reported status {status}, devices {count}"
    );
    ensure!(
        (0..count).contains(&index),
        "ROCm GPU index {index} is unavailable ({count} devices)"
    );
    // Same ABI-tolerant aligned buffer used by Koharu 0.83.5's ROCm probe.
    #[repr(C, align(64))]
    struct Properties([u8; 64 * 1024]);
    let mut properties = Box::new(Properties([0; 64 * 1024]));
    let status = unsafe { get_properties(properties.0.as_mut_ptr().cast(), index) };
    ensure!(status == 0, "ROCm device properties failed: {status}");
    let target =
        parse_rocm_target(&properties.0).context("ROCm did not report an exact gfx target")?;
    println!(
        "{}",
        serde_json::json!({"schema":1,"gpu_index":index,"target":target})
    );
    Ok(true)
}

fn parse_rocm_target(properties: &[u8]) -> Option<&str> {
    properties
        .windows(3)
        .enumerate()
        .find_map(|(start, bytes)| {
            if bytes != b"gfx" {
                return None;
            }
            let suffix = properties[start + 3..]
                .iter()
                .take_while(|byte| byte.is_ascii_alphanumeric())
                .count();
            let target = std::str::from_utf8(&properties[start..start + 3 + suffix]).ok()?;
            let suffix = &target[3..];
            (!suffix.is_empty()
                && suffix.bytes().all(|byte| byte.is_ascii_hexdigit())
                && suffix.bytes().any(|byte| byte.is_ascii_digit()))
            .then_some(target)
        })
}

#[cfg(windows)]
unsafe fn open_library(path: &Path) -> Result<libloading::Library, libloading::Error> {
    use libloading::os::windows::{
        LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR, LOAD_LIBRARY_SEARCH_SYSTEM32, Library,
    };
    unsafe {
        Library::load_with_flags(
            path,
            LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32,
        )
        .map(Into::into)
    }
}

#[cfg(not(windows))]
unsafe fn open_library(path: &Path) -> Result<libloading::Library, libloading::Error> {
    use libloading::os::unix::{Library, RTLD_LAZY, RTLD_LOCAL};
    unsafe { Library::open(Some(path), RTLD_LAZY | RTLD_LOCAL).map(Into::into) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn loader_paths_preserve_drive_unc_unicode_and_long_paths() {
        #[derive(Deserialize)]
        struct Fixture {
            input: String,
            expected: String,
        }
        let fixtures: Vec<Fixture> = serde_json::from_str(include_str!(
            "../../../tests/fixtures/windows-native-runtime-paths.json"
        ))
        .unwrap();
        for fixture in fixtures {
            assert_eq!(
                windows_loader_path(Path::new(&fixture.input)),
                Path::new(&fixture.expected)
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn openmp_keeps_long_path_loading_when_a_dos_alias_is_unavailable() {
        let path = PathBuf::from(format!(
            r"\\?\C:\mgt-nonexistent-{}\{}\vcomp140.dll",
            std::process::id(),
            "x".repeat(240)
        ));
        assert_eq!(windows_loader_path(&path), path);
    }

    #[cfg(windows)]
    #[test]
    fn loaded_library_exposes_a_joinable_path_even_in_a_long_unicode_directory() {
        use std::os::windows::ffi::{OsStrExt, OsStringExt};
        use std::time::{SystemTime, UNIX_EPOCH};
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GetModuleFileNameW(module: isize, path: *mut u16, size: u32) -> u32;
            fn CreateFileW(
                path: *const u16,
                access: u32,
                share: u32,
                security: *const std::ffi::c_void,
                disposition: u32,
                flags: u32,
                template: isize,
            ) -> isize;
            fn CloseHandle(handle: isize) -> i32;
        }
        let root = std::env::temp_dir().join(format!(
            "mgt-native-path-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let directory = root.join(format!("한글 with spaces-{}", "x".repeat(180)));
        std::fs::create_dir_all(&directory).unwrap();
        let dll = directory.join("path-fixture.dll");
        std::fs::copy(
            Path::new(&std::env::var_os("SystemRoot").unwrap()).join("System32/version.dll"),
            &dll,
        )
        .unwrap();
        let manifest = root.join("runtime.json");
        std::fs::write(
            &manifest,
            serde_json::to_vec(&serde_json::json!({
                "schema": 1, "engine": "diffusion", "backend": "rocm", "libraries": [dll]
            }))
            .unwrap(),
        )
        .unwrap();
        let runtime = load_runtime(&manifest, "diffusion").unwrap();
        let library: libloading::os::windows::Library =
            runtime._libraries.into_iter().next().unwrap().into();
        let handle = library.into_raw();
        let mut buffer = vec![0u16; 32768];
        let length =
            unsafe { GetModuleFileNameW(handle, buffer.as_mut_ptr(), buffer.len() as u32) };
        let loaded = PathBuf::from(std::ffi::OsString::from_wide(&buffer[..length as usize]));
        let kernel_dir = directory.join("kernels/gfx1200");
        std::fs::create_dir_all(&kernel_dir).unwrap();
        std::fs::write(
            kernel_dir.join("Kernels.so-000-gfx1200.hsaco"),
            b"kernel fixture",
        )
        .unwrap();
        let mut mixed_path = loaded.parent().unwrap().as_os_str().to_owned();
        mixed_path.push("/kernels/gfx1200/Kernels.so-000-gfx1200.hsaco");
        let wide: Vec<u16> = mixed_path.encode_wide().chain(Some(0)).collect();
        let kernel =
            unsafe { CreateFileW(wide.as_ptr(), 0x80000000, 7, std::ptr::null(), 3, 0, 0) };
        let error = std::io::Error::last_os_error();
        if kernel != -1 {
            unsafe {
                CloseHandle(kernel);
            }
        }
        drop(unsafe { libloading::os::windows::Library::from_raw(handle) });
        std::fs::remove_dir_all(&root).unwrap();
        assert_ne!(kernel, -1, "DLL-relative kernel file must open: {error}");
        assert!(
            dll.as_os_str().encode_wide().count() > 260,
            "test must cover a long Windows DLL path"
        );
        assert!(
            !loaded.as_os_str().to_string_lossy().starts_with(r"\\?\"),
            "DLL-relative kernel discovery must be able to append forward slashes: {}",
            loaded.display()
        );
    }
    #[test]
    fn recognizes_exact_rocm_target_without_accepting_grouped_names() {
        assert_eq!(
            parse_rocm_target(b"noise gfx1100:xnack-\0"),
            Some("gfx1100")
        );
        assert_eq!(parse_rocm_target(b"gfx90a\0"), Some("gfx90a"));
        assert_eq!(parse_rocm_target(b"gfx110X\0 gfx1201\0"), Some("gfx1201"));
        assert_eq!(parse_rocm_target(b"gfx\0"), None);
    }
    fn specification() -> NativeRuntime {
        NativeRuntime {
            schema: 1,
            engine: "torch".into(),
            backend: "cpu".into(),
            libraries: vec![std::env::current_exe().unwrap()],
        }
    }
    #[test]
    fn rejects_mismatched_engine_schema_backend_and_relative_paths() {
        let mut spec = specification();
        assert!(validate_specification(&spec, "torch").is_ok());
        assert!(validate_specification(&spec, "diffusion").is_err());
        spec.schema = 2;
        assert!(validate_specification(&spec, "torch").is_err());
        spec.schema = 1;
        spec.backend = "auto".into();
        assert!(validate_specification(&spec, "torch").is_err());
        spec.backend = "cpu".into();
        spec.libraries = vec!["relative.dll".into()];
        assert!(validate_specification(&spec, "torch").is_err());
        spec.libraries.clear();
        assert!(validate_specification(&spec, "torch").is_err());
    }

    #[test]
    fn vulkan_is_diffusion_only_and_existing_backends_remain_valid() {
        let mut spec = specification();
        for backend in ["cpu", "cuda", "rocm", "metal"] {
            spec.backend = backend.into();
            assert!(validate_specification(&spec, "torch").is_ok());
        }
        spec.backend = "vulkan".into();
        assert!(validate_specification(&spec, "torch").is_err());
        spec.engine = "diffusion".into();
        assert!(validate_specification(&spec, "diffusion").is_ok());
    }
}
