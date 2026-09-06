# C15 신라문화체 보정: 20작품 최종 비교

2026-09-06. 메인 앱에 C15를 반영하고, 표지와 긴 이미지 작품을 제외한 20작품 194페이지의 원문 A / 이전 앱 B / 최신 앱 C를 만들었다. 10페이지 미만인 세 작품은 각각 7·9·8페이지다. 긴 이미지 W04는 사용자 요청으로 W21로 교체했다. 원본 보관함과 기존 사용자 출력물은 변경하지 않았다.

## 실제 적용 범위

- 제품 코드: MAIN `5199146a6fcf57145441d2537b8ff00caad6b14e`, 연구 워크트리 대응 커밋 `0cd44672`.
- B 기준: MAIN `13e18ed81ca4c424c6f0b18771b55644f2183ea5`.
- C는 강하게 강조된 명조·붓 느낌에 신라문화체 Medium 500을 선택하는 제한적인 추가 경로다. 전체 S18 유형/화 군집 모델은 오분류 때문에 승격하지 않았다.
- 기존 R33/proxy, C10 고딕 강조 보정과 실제 설치된 24개 render 후보를 사용한다. 기존 표현체·사용자 잠금·선택 풀 계약을 유지한다.
- 모델과 정확한 입력/출력, CPU 설정 및 롤백은 [C15 제품 인계](font-shilla-texture-c15-handoff.md)를 따른다. 이후 검사·기록 커밋은 이 렌더의 제품 알고리즘을 바꾸지 않는다.

## 평가 권위와 원본 화질

연구 워크트리 `artifacts/font-palette-lab/final-20-work-001/`이 증거 루트다.

- `page-selection.json`: 원문 경로·해시·크기와 작품별 선택 목록.
- `baseline-app-inventory.json`: 실제 이전 앱의 194페이지. SHA-256 `814f328a038aa6367f4fa59b4f08c7ac3406a71eabc02530040ce0c48cd08fb7`.
- `latest-app-inventory.json`: 실제 메인 앱의 194페이지와 페이지별 B/C 해시. 실행 전후 HEAD가 같음을 검증했다.
- 번역 inventory SHA-256 `48bbc066d4f625a57953151df1ceede094cb7d47b86cca308cf3f9dd942b72aa`. HayaiOCR 1,307개 기록 중 1,252개는 Codex 직접 번역, 55개는 제외 기록이다. 외부 번역기를 쓰지 않았다.
- B/C는 동일 번역·원문·지운 배경·말풍선 geometry를 사용하고 실제 앱 factory → worker → decision → natural reflow/export를 거친다. 변경되지 않은 페이지는 같은 B PNG를 재사용한다.
- 이 최종 평가 페이지로 학습, 문턱 조정, 작품별 예외를 만들지 않았다. 모든 작품이 새 작품이라는 주장은 하지 않는다. 별도의 미사용 두 화 26페이지 확인은 C15 인계서에 구분했다.

`review/index.html`은 한 번에 이미지 하나만 보여 준다. A는 원문 파일의 바이트 그대로, B/C는 원래 픽셀 크기의 PNG다. 화면 너비 보기는 CSS 표시 배율이며 이미지 재압축·축소본 합성이 아니다. 100/150/200%와 A/B/C 전환, 작품·페이지 선택, 이미지 직접 링크를 제공한다. B와 C가 같은 페이지는 동일 파일을 참조한다.

`review/integrity.json`: 194페이지 × A/B/C = 582개 이미지 참조의 SHA와 원본 크기 전부 일치. 최종 비교 URL은 `http://127.0.0.1:8769/final-20-work-001/review/index.html`이다. 서버가 없으면 해당 HTML을 직접 열 수 있다.

## 직접 시각 판정과 남은 문제

22페이지의 29개 블록이 신라문화체로 바뀌었고 나머지 172페이지의 B/C PNG는 동일하다. 변경 29개 전부를 원본 픽셀 크기 A/B/C 영역으로 직접 봤다. 문맥을 포함한 페이지와 일반 대사 대조군도 확인했다. 194페이지 전부에 독립적인 사람의 미학 판정이 있다는 뜻은 아니다.

`visual-audit/findings.json`과 `native-crop-inventory.json`은 Codex 시각 감사이며 human gold나 학습 정답이 아니다. 내부 감사용 영역 비교는 사용자 HTML에 넣지 않았다.

- W08/P002, W09/P007·P008, W10/P008·P010, W12/P001, W15/P002·P004·P010, W19/P009에서는 얇은 기본체가 잃던 강한 획의 대비와 강조감이 개선됐다. 여전히 원문 세로 조판과 한국어 가로 조판의 모양은 다르다.
- W11/P008·P010, W19/P004, W21/P002는 기존 굵은 명조도 자연스러운 경계 사례다. 특히 W21/P002의 정중한 대사에 새 붓 느낌이 더 낫다고 확정하지 않는다. 문장 의미를 모델의 입력으로 쓰지는 않는다.
- W16/P007은 새 서체의 자연 재배치에서 작은 획과 조밀한 덩어리가 생겨 가독성이 나빠졌다. W15/P006은 강조감은 좋아졌지만 느낌표만 따로 줄바꿈된다. W11/P002의 단어 분리와 마침표 고립도 남았다. 전체 조판 문제가 해결됐다고 표현하지 않는다.
- W02/P008은 주변 그림의 아주 작은 `!` 변화로 의미 있는 개선에 포함하지 않는다.
- 같은 화의 모든 비슷한 원문을 같은 한국어 family/weight로 묶는 목표는 아직 미완료다. 이 결과를 전체 군집 모델 성공 근거로 쓰지 않는다.

판정: 강한 명조 강조의 제한된 보정으로 메인에 유지하되, 위 경계와 가독성 반례를 함께 인계한다. 전체 품질이 정돈되었다거나 모든 변경이 개선이라는 판정은 아니다. 후속 실험은 이 평가를 학습에 재사용했다고 숨기지 말고, 사용할 경우 development로 명시 전환한 뒤 다른 화로 새 확인을 해야 한다.

## 제품·화면 검증

- MAIN 전체 check 26개 gate 통과: 151.91초. 전체 테스트 5,359 passed / 2 skipped, 총 5,361개.
- typecheck, lint, build, renderer/preload bundle, page-artwork pixel parity, image-protocol smoke 포함.
- 실제 PageArtwork와 production font loading을 사용한 넓은/좁은 화면에서 신라문화체와 `『』` 기호 보완을 직접 확인했다. 임시 renderer QA 엔트리와 캡처는 제거했다.
- 최종 HTML 1500×1000 / 430×900 캡처 확인. 최초 좁은 화면의 fit-width 가로 스크롤과 작품 라벨 줄바꿈을 수정한 뒤 두 크기에서 확인했다. 독립 Impeccable finish reviewer 판정 ship, material fixes 없음. 실제 브라우저에서 작품/페이지 선택, 100%의 natural/display 폭 일치, B/C 전환 뒤 스크롤 위치 유지도 확인했다.
- check 전부터 수정돼 있던 `docs/font-size-ai-lab-used-chapters.json`은 기존 포맷 문제 때문에 실행 중에만 같은 JSON의 공백을 정규화하고 종료 후 원래 바이트로 복원했다. 이 사용자 파일은 제품 커밋에서 제외했다.
- 기존 coverage floor를 낮추지 않았다. 기존 기준 artifact에 이미 존재하는 후보 평가 파일 1개와 새 실행 파일 5개를 inventory에 등록했다. 전체 검사 뒤 실제 service/disposal 테스트를 포함한 캡처로 새 runtime floor를 lines 92.30%, statements 93.75%, functions 100%, branches 87.50%로 올렸다. 새 기준의 gate와 관련 28개 테스트도 통과했다.
- 기존 accepted coverage artifact는 `.tmp/production-cleanup-coverage-accepted-node26-pre-c15.json`에 보존했다. 새 5개 기록을 추가한 accepted artifact SHA-256은 `f812a53fbcbd17519c7d910c054b2c54a460cad5635a8bae58e62bc4daaff029`다. 기존 파일의 floor는 그대로다.

최종 C 생성 중 전체 검사와 병행하여 테스트가 build asset을 잠시 제거한 W10 실행은 실패로 남겼다. 전체 check/build가 끝난 뒤 동일 HEAD와 봉인 입력으로 재개했고 194페이지 전부 완료했다. 실패 로그를 성공 기록으로 바꾸지 않았다. 후속에서는 전체 검사와 실제 out 기반 렌더를 동시에 실행하지 않는다.

메인 앱 코드는 빌드돼 있다. 이미 열린 앱 프로세스는 재시작해야 새 코드를 읽을 수 있으며 기존 번역 출력은 자동으로 덮어쓰지 않는다. 앱 버전 릴리스나 외부 모델 자산 게시를 수행하지 않았다.
