"""Run masked Qwen Image 2.1 crops within one erasure workload."""
import importlib.util
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import traceback
from functools import lru_cache
from pathlib import Path


def configure_runtime(config):
    # Torch loads cuDNN through LoadLibraryExW. Give its package an extended
    # Windows path so a deeply nested model directory works for dependent DLLs.
    if os.name == "nt":
        for index, entry in enumerate(sys.path):
            if Path(entry).name.lower() != "site-packages":
                continue
            absolute = os.path.abspath(entry)
            if not absolute.startswith("\\\\?\\"):
                sys.path[index] = ("\\\\?\\UNC\\" + absolute[2:] if
                                   absolute.startswith("\\\\") else "\\\\?\\" + absolute)
    sys.path[:0] = [config["comfy"], config["packageDirectory"]]
    # The app never starts a server. These options apply to the imported
    # inference modules inside this one worker process.
    sys.argv = [sys.argv[0], "--offline", "--disable-dynamic-vram",
                "--disable-cuda-malloc", "--disable-async-offload",
                "--lowvram", "--reserve-vram", "1.2", "--preview-method", "none"]
    from comfy.options import enable_args_parsing
    enable_args_parsing()
    import torch
    torch.set_num_threads(8)
    total = torch.cuda.get_device_properties(0).total_memory
    # The caller monitors total board use, including independent applications.
    # Leave room for CUDA libraries and the board watchdog outside the allocator.
    # WDDM's cudaMemGetInfo can exclude desktop and other processes' allocations.
    # Query the same physical adapter and units as the parent watchdog.
    adapter = os.environ.get("CUDA_VISIBLE_DEVICES")
    if not adapter:
        adapter = str(torch.cuda.get_device_properties(0).uuid)
        if not adapter.startswith("GPU-"):
            adapter = "GPU-" + adapter
    memory = subprocess.check_output([
        "nvidia-smi", "--id=" + adapter, "--query-gpu=memory.total,memory.used",
        "--format=csv,noheader,nounits",
    ], text=True, timeout=5, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    board_mib, used_mib = map(int, memory.strip().split(","))
    budget_mib = min(11 * 1024, board_mib - 1024) - used_mib - 2304
    if budget_mib < 2048:
        raise MemoryError("Insufficient memory for Qwen Image 2.1")
    cap = budget_mib * 1024**2
    torch.cuda.set_per_process_memory_fraction(min(1., cap / total))
    physical_memory = torch.cuda.mem_get_info

    def effective_memory(device=None):
        free, total = physical_memory(device)
        available = max(0, cap - torch.cuda.memory_reserved(device))
        return min(free, available), min(total, cap)

    torch.cuda.mem_get_info = effective_memory


def gguf_nodes(directory):
    name = "carrot_qwen_gguf"
    spec = importlib.util.spec_from_file_location(
        name, Path(directory) / "__init__.py", submodule_search_locations=[directory]
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return sys.modules[name + ".nodes"]


def load_encoder(nodes, config):
    import torch
    import comfy.sd
    import folder_paths

    state = nodes.CLIPLoaderGGUF().load_data([config["text"]])
    cpu = torch.device("cpu")
    encoder = comfy.sd.load_text_encoder_state_dicts(
        clip_type=comfy.sd.CLIPType.QWEN_IMAGE, state_dicts=state,
        model_options={"custom_operations": nodes.GGMLOps, "initial_device": cpu,
                       "load_device": torch.device("cuda", 0), "offload_device": cpu},
        embedding_directory=folder_paths.get_folder_paths("embeddings"),
    )
    encoder.patcher = nodes.GGUFModelPatcher.clone(encoder.patcher)
    return encoder


def text_conditioning(encoder, config, vae, reference):
    from comfy_extras.nodes_qwen import TextEncodeQwenImage21

    images = {"image_1": reference} if reference is not None else None
    if config.get("pairedReference"):
        original = pixels(config["prior"], "RGB")
        if reference is None or not config.get("referenceEdit") or original.shape != reference.shape:
            raise ValueError("Paired Qwen references must share the same edit window")
        images["image_2"] = original
    if config.get("turbo") or config.get("cfg") == 1:
        encoder = PositiveOnlyEncoder(encoder)
    return TextEncodeQwenImage21.execute(
        encoder, config["prompt"], config["negative"], resolution=0,
        vae=vae if reference is not None else None,
        images=images,
    ).result


class PositiveOnlyEncoder:
    """The pinned node asks for positive then negative. CFG=1 sampling
    never evaluates the unconditional branch; each crop still encodes its images."""
    def __init__(self, encoder):
        self.encoder = encoder
        self.positive = None

    def tokenize(self, *args, **kwargs):
        if self.positive is None:
            return self.encoder.tokenize(*args, **kwargs)

    def encode_from_tokens_scheduled(self, tokens):
        if self.positive is None:
            self.positive = self.encoder.encode_from_tokens_scheduled(tokens)
        return self.positive


def pixels(path, mode):
    import numpy as np
    import torch
    from PIL import Image
    with Image.open(path) as image:
        return torch.from_numpy(np.array(image.convert(mode), dtype=np.float32) / 255)[None]


class SessionModels:
    def __init__(self, config):
        import folder_paths
        import nodes
        for kind, key in [("diffusion_models", "diffusion"), ("text_encoders", "text"),
                          ("vae", "vae"), ("model_patches", "control")]:
            folder_paths.add_model_folder_path(kind, str(Path(config[key]).parent), is_default=True)
        self.gguf = gguf_nodes(config["nodeDirectory"])
        self.model = None
        self.turbo = None
        self.vae = nodes.VAELoader().load_vae(Path(config["vae"]).name)[0]
        self.config = config
        self._encoder = None
        self.control = None
        self.plain_text = lru_cache(maxsize=4)(self.encode_plain_text)

    @property
    def encoder(self):
        if self._encoder is None:
            self._encoder = load_encoder(self.gguf, self.config)
        return self._encoder

    def encode_plain_text(self, prompt, negative):
        # This node returns the same two conditionings for every text-only
        # crop. Its empty latent is always replaced by the encoded native prior.
        import torch
        from safetensors import SafetensorError, safe_open
        from safetensors.torch import save_file
        weights = Path(self.config["text"])
        cache = weights.with_name("qwen-plain-conditioning-v1.safetensors")
        stamp = weights.stat()
        key = hashlib.sha256(json.dumps([
            hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), self.config["comfy"],
            self.config["nodeDirectory"], str(weights), stamp.st_mtime_ns, stamp.st_size,
            torch.__version__, torch.cuda.get_device_capability(), prompt, negative,
        ]).encode()).hexdigest()
        try:
            with safe_open(str(cache), framework="pt", device="cpu") as saved:
                metadata = saved.metadata()
                if metadata["key"] == key:
                    extras = json.loads(metadata["extras"])
                    def restore(branch):
                        fields = {name: saved.get_tensor(branch + "." + name) if tensor else None
                                  for name, tensor in extras[branch].items()}
                        return [[saved.get_tensor(branch), fields]]
                    return restore("pos"), restore("neg"), None
        except (OSError, ValueError, KeyError, RuntimeError, TypeError, SafetensorError):
            pass
        conditions = text_conditioning(self.encoder, {"prompt": prompt, "negative": negative}, None, None)
        tensors, extras = {}, {}
        for branch, groups in zip(("pos", "neg"), conditions[:2]):
            if len(groups) != 1:
                return conditions
            cond, fields = groups[0]
            if any(value is not None and not isinstance(value, torch.Tensor) for value in fields.values()):
                return conditions
            tensors[branch] = cond.contiguous().cpu().clone()
            extras[branch] = {name: value is not None for name, value in fields.items()}
            for name, value in fields.items():
                if value is not None:
                    tensors[branch + "." + name] = value.contiguous().cpu().clone()
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=cache.parent, delete=False) as file:
                temporary = Path(file.name)
            save_file(tensors, str(temporary), metadata={"key": key, "extras": json.dumps(extras)})
            os.replace(temporary, cache)
        except (OSError, SafetensorError):
            pass
        finally:
            if temporary is not None:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    pass
        return conditions

    def diffusion(self, config):
        if config.get("turbo"):
            if self.turbo is None:
                import comfy.sd
                self.turbo = comfy.sd.load_diffusion_model(config["turbo"])
            return self.turbo
        if self.model is None:
            self.model = self.gguf.UnetLoaderGGUF().load_unet(Path(config["diffusion"]).name)[0]
        return self.model


def generate(config, models):
    import nodes
    import numpy as np
    from PIL import Image
    from comfy_extras.nodes_model_patch import ModelPatchLoader, ZImageFunControlnet
    from comfy_extras.nodes_qwen import QwenImage21Cache

    model, vae = models.diffusion(config), models.vae
    direct = config.get("referenceEdit", False)
    if not direct and models.control is None:
        models.control = ModelPatchLoader().load_model_patch(Path(config["control"]).name)[0]
    source = pixels(config["image"], "RGB")
    mask = pixels(config["mask"], "L")
    prior = pixels(config["prior"], "RGB") if config.get("prior") else source
    height, width = source.shape[1:3]
    if mask.shape[1:3] != (height, width) or prior.shape != source.shape or height % 32 or width % 32:
        raise ValueError("Qwen source, prior and mask must use the same 32-aligned crop")
    reference = source if config.get("referenceSource") else prior if config.get("referencePrior") else None
    positive, negative, latent = (models.plain_text(config["prompt"], config["negative"])
                                  if reference is None else
                                  text_conditioning(models.encoder, config, vae, reference))
    if not direct:
        model = ZImageFunControlnet().diffsynth_controlnet(
            model, models.control, vae, strength=1., inpaint_image=source, mask=mask
        )[0]
    elif reference is not source:
        raise ValueError("A reference edit requires the original aligned artwork")
    model = QwenImage21Cache.execute(model, "cpu", "default").result[0]
    if not direct:
        latent = nodes.VAEEncode().encode(vae, prior)[0]
        latent = nodes.SetLatentNoiseMask().set_mask(latent, mask)[0]
    if config.get("turbo"):
        import torch
        import comfy.samplers
        from comfy_extras.nodes_custom_sampler import SamplerCustom
        # Keep the checkpoint's terminal intervals for thin contours and printed dots.
        schedule = ([1., .95418, .89508, .704534, .414568, 0.]
                    if config.get("shortSchedule")
                    else [1., .978453, .95418, .926626, .89508, .845148, .704534, .414568, 0.])
        sigmas = torch.tensor(schedule)
        if not direct:
            sigmas = sigmas * config.get("denoise", 1.)
        sample = SamplerCustom.execute(
            model, True, config["seed"], 1., positive, negative,
            comfy.samplers.sampler_object("euler"), sigmas, latent,
        ).result[0]
    else:
        sample = nodes.KSampler().sample(
            model, config["seed"], config["steps"], config["cfg"], "euler", "simple",
            positive, negative, latent, denoise=config.get("denoise", 1.0)
        )[0]
    decoded = nodes.VAEDecode().decode(vae, sample)[0][0].detach().float().cpu().numpy()
    if not np.isfinite(decoded).all():
        raise ValueError("Qwen crop contains non-finite values")
    Image.fromarray(np.uint8(np.clip(decoded * 255., 0, 255))).save(config["output"])


def run_session(requests, reply):
    models = None
    for request in requests:
        if request.get("type") == "shutdown":
            break
        try:
            config = json.loads(Path(request["config"]).read_text(encoding="utf-8"))
            if models is None:
                configure_runtime(config)
            import torch
            with torch.inference_mode():
                if models is None:
                    models = SessionModels(config)
                generate(config, models)
            response = {"id": request["id"], "ok": True}
        except Exception as error:
            if reply is None:
                raise
            traceback.print_exc(file=sys.stderr)
            response = {"id": request["id"], "ok": False, "error": str(error)}
        if reply:
            print(json.dumps(response), file=reply, flush=True)
        if not response["ok"]:
            break


if __name__ == "__main__":
    if sys.argv[1] == "--session":
        protocol = sys.stdout
        sys.stdout = sys.stderr
        run_session((json.loads(line) for line in sys.stdin if line.strip()), protocol)
    else:
        run_session([{"id": "1", "config": sys.argv[1]}], None)
