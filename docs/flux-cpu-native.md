# Flux Klein CPU-native 호환 모드

## 제품 결정

Flux Klein CPU는 일반 권장 경로가 아니라 **매우 느린 호환 모드**다. 공개 설정값은
`cpu-native`이며 Python이나 Diffusers를 설치하지 않고 CPU-only로 컴파일한
`mgt-flux-klein-cpu.exe`와 Q4_K_M transformer, small decoder VAE를 사용한다.

- 기존 저장값 `python-cpu`와 `cpu`는 로드 시 `cpu-native`로 자동 마이그레이션한다.
- 기존 Diffusers CPU 런타임은 UI와 IPC enum에서 제거했다.
- 한 버전 동안의 진단 목적에만 `MGT_FLUX_LEGACY_DIFFUSERS_CPU=1` 환경변수로 기존
  Diffusers CPU worker를 강제로 사용할 수 있다. 이 환경변수는 사용자 설정이나 자동
  fallback이 아니다.
- 실사용 CPU 인페인팅은 LaMa Manga 또는 AOT를 권장한다.

## 2026-08-29 기준 실측

패키지에 포함된 `mgt-flux-klein-cpu.exe`로 동일한 4-step 프로토콜 요청을 실행했다.
`--capabilities`는
`backend=cpu-native`, `cpu_only=true`, `cuda_compiled=false`,
`metal_compiled=false`를 반환했다. 테스트 PC에는 RTX 4090이 설치되어 있었지만 이
바이너리에는 CUDA 기능 자체가 컴파일되지 않았으므로 CPU 선택 PC 시나리오를 검증한다.

| 항목                  |                                      결과 |
| --------------------- | ----------------------------------------: |
| CPU                   |        AMD Ryzen 9 7950X, 16코어/32스레드 |
| 시스템 RAM            |                                 127.6 GiB |
| GPU 존재 여부         |              RTX 4090 존재, 사용하지 않음 |
| 입력                  | 256×256, 중앙 마스크, 4 steps, padding 16 |
| 모델 준비 시간        |                                   2.600초 |
| 최초 memory sample    |                                 0.721 GiB |
| 준비 완료 working set |                                 2.975 GiB |
| 최대 working set      |                                 3.383 GiB |
| 최대 private bytes    |                                 3.404 GiB |
| 첫 페이지 runner 시간 |                    351.001초 (5분 51.0초) |

이 결과만으로도 CPU Flux를 일반 기능이나 기본 추천으로 제공하기에는 지나치게 느리다.
큰 영역은 기존 보수적 타일 경로를 사용하지만 총 처리 시간은 더 길어질 수 있다.

## 하드웨어 검증 매트릭스

서로 다른 물리 RAM과 CPU-only PC의 결과를 추정값으로 채우지 않는다. 아래 미실측 행은
해당 하드웨어에서 같은 벤치마크 JSON을 수집한 뒤에만 완료 처리한다.

| 환경                        | 상태      | 최초/준비/최대 working set | 페이지 시간 |
| --------------------------- | --------- | -------------------------- | ----------- |
| NVIDIA 장착 PC에서 CPU 선택 | 완료      | 0.721 / 2.975 / 3.383 GiB  | 351.001초   |
| CPU-only, 16 GB RAM         | 실기 필요 | 미실측                     | 미실측      |
| CPU-only, 32 GB RAM         | 실기 필요 | 미실측                     | 미실측      |

현재 실측의 runner 최대 메모리는 약 3.4 GiB지만 앱, OS, 디코딩 버퍼와 다른 모델의
메모리를 포함하지 않는다. 따라서 16 GB는 최소 검증 대상이고 32 GB를 권장 검증
대상으로 둔다. 물리 RAM이 다른 PC에서 측정하기 전에는 두 환경의 안정성을 보장하지
않는다.

## 재현 절차

CPU runner는 유니코드 저장소 경로에서 일부 CMake 의존성이 실패할 수 있으므로 빌드
target을 ASCII 임시 경로에 둔다. 준비 스크립트가 이 규칙과 CPU-only capability 검증을
자동 적용한다.

```powershell
npm run build:flux-cpu-runner
npm run bench:flux-cpu -- `
  --runner tools\mgt-flux-klein-cpu\mgt-flux-klein-cpu.exe `
  --transformer <flux-2-klein-4b-Q4_K_M.gguf> `
  --vae <diffusion_pytorch_model.safetensors> `
  --size 256 `
  --steps 4 `
  --scenario nvidia-cpu-selected `
  --expected-memory-gb 128 `
  --output-json <result.json>
```

벤치마크 JSON은 runner capability, 모델 준비 시간, 요청 처리 시간, 첫/준비/최대 working
set, 최대 private bytes, CPU/논리 코어 수와 총 RAM을 기록한다. 16 GB와 32 GB 행도 이
명령의 실제 결과 파일로 채운다. CPU-only 행은 `--scenario cpu-only`, 16/32 GB 행은 각각
`--expected-memory-gb 16` 또는 `32`를 지정하면 잘못된 PC에서 측정한 결과가 섞이는 것을
막는다.
