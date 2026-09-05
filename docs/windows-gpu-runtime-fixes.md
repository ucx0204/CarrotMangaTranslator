# Windows GPU 선택 및 런타임 시작 오류 (#89, #88)

## GPU 선택

KoharuLayout의 DirectML 세션은 DXGI `EnumAdapters1` 순번을 `deviceId`로
명시한다. 고성능 설정은 `EnumAdapterByGpuPreference(HIGH_PERFORMANCE)`의
순위로 고른 뒤 같은 LUID의 원래 DXGI 순번을 사용한다. 소프트웨어/D3D12
미지원 어댑터를 제외해도 순번을 다시 매기지 않는다.

GPU/CUDA OCR에서 연산 장치를 직접 지정하면 OCR과 같은 환경의
`CUDA_VISIBLE_DEVICES`와 `cuDeviceGetLuid`로 DXGI 어댑터를 찾는다. HIP/Vulkan
순번은 DirectML에 대입하지 않는다. 매핑이나 초기화 실패는 진단 로그를 남기고
기존 CPU 폴백으로 이어진다. 성공 로그에는 제공자, GPU 이름, LUID, DXGI 순번이
남는다. 세션 캐시는 GPU 설정별로 구분하며 작업 시작 시 설정을 고정한다.

Windows SDK 탐색은 숨겨진 PowerShell 자식 프로세스에서 실행한다. 시스템 DLL만
로드하며 제한 시간은 15초다. 앱 화면의 GPU 변경은 저장 후 재시작해야 한다.

- [DirectML device_id 계약](https://onnxruntime.ai/docs/execution-providers/DirectML-ExecutionProvider.html)
- [DXGI GPU 선호 순서](https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_6/nf-dxgi1_6-idxgifactory6-enumadapterbygpupreference)
- [CUDA 장치 LUID](https://docs.nvidia.com/cuda/cuda-driver-api/group__CUDA__DEVICE.html)

## 시작 오류

Windows x64의 `ERR_DLOPEN_FAILED`에서 실제 `onnxruntime_binding.node`가
존재하고 VC++ DLL이 누락된 경우, 부트스트랩이 Microsoft x64 설치 링크를
안내하고 종료한다. 실행 파일 옆, 바인딩 옆, System32를 검사하며 실제 바인딩
누락이나 다른 로딩 오류는 기존 오류 경로를 유지한다. 자세한 누락 DLL은 로그에
기록한다. 설치 프로그램 자동 실행이나 배포 패키지 변경은 포함하지 않는다.

- [Microsoft 런타임 배포 안내](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist?view=msvc-170)

## 검증 자료

`artifacts/qa/issues-88-89/screenshots.md`에 최종 캡처를 모았다. 실제 GPU 설정
컴포넌트와 공통 UI를 `qa:ui`로 렌더링하고 넓은/좁은 창, 자동/최솟값/최댓값,
드롭다운, 비활성, 한국어/영어/일본어, 축소 viewport를 확인했다. 임시 렌더러
엔트리는 제거했고 캡처는 사용자 요청에 따라 보존한다.

실제 RTX 4090에서 DXGI/CUDA LUID 조회 및 원본 ONNX 모델의 DirectML 추론과
Hayai 영역 전처리를 실행했다. 하이브리드 GPU 순번 불일치는 단위 테스트로
검증했다. 런타임 누락 화면은 누락 조건만 주입한 실제 Electron 기본 대화상자이며
시스템 DLL을 변경하지 않았다. 측정 자료와 coverage floor 출처는
`windows-gpu-runtime-fixes-evidence.json`에 기록한다. 기존 coverage floor와
historical artifact는 그대로 유지한다.
