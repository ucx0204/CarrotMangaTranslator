# 원문 고딕 강조 보정: C10 제품 인계

2026-09-06. 기반은 `5a0dcb7304a36d4034b06bebf31216eae7b333e4`의 R33와
meaning-free cross-script proxy v2이다. 추가 정책은 `source-ink-heavy-sans-v3`이다.
이번 변경은 강한 고딕이 가는 일반체나 명조로 사라지는 현상을 줄이는 제한된 제품 증분이다.
화 전체 군집, 사용자 폰트 풀 UI, 손글씨 자동 대응을 완성했다고 해석하지 않는다.

## 현재 적용 계약

- 기존 verified cross-script proxy 경계를 통과한 원문만 새 픽셀 증거를 얻는다.
- 원문 잉크의 연결 성분을 학습한 작은 분류기로 6개 유형의 증거를 만든다.
  실제 교체는 `heavy_sans` 한 유형에만 허용한다. 나머지 다섯 유형은 기존 결정을 유지한다.
- 최대 16개, 최소 2개 성분, 유형 확률 0.6 이상, 차순위와 0.3 이상의 차이를 요구한다.
  이 확률을 물리적 굵기로 해석하거나 폰트 굵기에 선형 변환하지 않는다.
- 선택 가능한 풀 안에 도현체가 있고 번역문 glyph coverage가 충족될 때
  `dohyeon`, 실제 face 400, synthetic bold/italic 없이 대응한다.
- 사용자 잠금, 작품 프로필, 수동 편집 우선순위는 기존 결정 경로가 그대로 처리한다.
  새 스타일은 최종 결정이 `v2_automatic`이고 선택 폰트가 일치할 때만 적용한다.
- 크기 추정, 말풍선 분할, 글자 배치 알고리즘, R33/proxy 외부 자산은 바꾸지 않았다.
  폰트 변경에 따른 실제 advance와 줄바꿈 변화는 원래 production 렌더로 확인한다.

## 실패 후보와 사용자 판정

C5의 기존 decoder 그룹 평균은 볼드를 남발했고, C6의 같은 문자 기준 서체 매칭은
손글씨와 강한 표현까지 일반 리디바탕으로 평탄화했다. 둘 다 기각했다.

C7은 원문 연결 성분 분류라는 새 입력 경로를 시험했다. 이미 굵은 명조 캡션까지
경찰감성체로 바꾸는 퇴보가 있어 기각했다. C8은 기존 굵은 명조 보존 조건을 붙였으나,
사용자가 P006/D005의 블랙 한 산스가 과하고 P004/D009의 명조와 004 P006/D002의
리디바탕이 원문의 고딕을 잃는다고 판정했다.

C9에서 강한 고딕을 도현체로 대응하고 적용 문턱을 낮췄다. 005의 고딕 5곳은
개선됐지만 P013/D001, P022/D005의 단정한 명조를 경찰감성체로 바꿔 거친 붓터치가
붙었다. Codex의 직접 관찰과 P022/D005에 대한 사용자 판정이 모두 퇴보였다.
따라서 C9 전체를 승격하지 않았다. C10은 명조→붓글씨 매핑을 완전히 제거했다.
단순히 확률 문턱을 올려 같은 오분류를 숨기는 후보가 아니다.

사용자의 **끄적인 글씨에는 ‘다시 시작해’** 선호는 보존한다. 이 선호의 수동 비교는
유용했지만 자동 검출의 일반화가 검증되지는 않았다. C10은 손글씨를 새로 선택하지 않는다.

## 검증 데이터와 판정 단위

연구 작업공간은 `../망가번역기-font-palette-lab-20260905`이며 산출물은 그곳의
`artifacts/font-palette-lab/`에 보존한다. 원본 Tachidesk 코퍼스는 읽기 전용이다.
HayaiOCR과 Codex 직접 번역을 사용했고 후보 간 source, translation, inpaint, geometry를
봉인했다. 오래된 91쪽 블록 분할 실패 세트는 이번 평가에 사용하지 않았다.

| 화                      | 역할                            | C10의 변경 / 평가 영역 |
| ----------------------- | ------------------------------- | ---------------------- |
| source-confirmation-002 | C5~C8로 5회 소진한 고정 회귀    | 3 / 93                 |
| confirmation-004        | C8/C9 개발, C10 고정 재생       | 3 / 24                 |
| confirmation-005        | C9 새 확인 실패 후 C10 개발 2/5 | 5 / 159                |
| confirmation-006        | C10 봉인 후 무작위 새 화        | 0 / 294                |

006은 `Rawkuma (JA)/Minikui Orc No Gyakushuu/Chapter 16`의 32쪽 전체다.
seed는 `8237a106e314bc8efaa13a7cfe995b1b664d6fc4c82d12b8efa5372921c0968b`.
표지는 없으며 화 제목 1곳과 생각 풍선 연결 점 1곳을 제외했다. 일반 명조가 많은 화에서
불필요한 새 고딕 교체가 없었다는 음성 대조군이다. 새 화에서 강조 회수율까지
입증했다고 과장하지 않는다. 작품 단위 독립 표본이나 human gold 평가도 아니다.

실제 main `out`의 worker → page coordinator → automatic decision/style을 실행했고,
그 선택을 고정된 기존 inpaint/geometry에 실제 production export로 재생했다.
변경되지 않은 block 객체와 변경이 없는 페이지 PNG는 그대로여야 한다.
변경된 block은 폰트, bold/italic, 동일 내용의 줄바꿈과 렌더 방향만 달라질 수 있다.
R33 증거와 proxy 후보 순서는 동일하다. DML 재실행의 proxy 실수 점수에는 미세한 차이가
있으므로 raw float가 bitwise 동일하다고 주장하지 않는다. 정확한 최대 차이는 receipt에 있다.

005의 번역 metadata 중 `effect` 4곳은 renderer domain의 `sfx_motion`으로만 정규화했다.
이 수정은 잘못된 연구 어댑터 표기를 고친 것이다. 봉인한 OCR, 번역 bytes, 폰트 결정은
변하지 않았으며 효과음 품질 개선으로 세지 않았다.

최신 보고서는 로컬 서버 8769의 `font-app-review-009`(005), `010`(002), `011`(004),
`012`(006) 아래 `review.html`이다. 이전 C7/C8/C9 보고서와 receipt는 실패 기록으로 보존한다.
원본 pixels를 정수 crop으로 보존하는 후속 확대 뷰어는 `font-hd-review-016`(005),
`017`(002), `018`(004)와 `font-app-review-012`(006)이다. 100/200/300%, 문장 선택,
동기 이동과 확대/Escape를 1500/430px에서 76쪽 570문장으로 검사했다.
직접 링크 예: `http://127.0.0.1:8769/font-hd-review-016/review.html?block=P019%2FD004`.
새 사용 화와 각 후보 횟수는 연구 워크트리의 `docs/font-size-ai-lab-used-chapters.json`이 권위다.

## 해결되지 않은 사용자 반례

002 P004/P006 연결 말풍선과 보통 대사, 004 P005 내레이션은 여전히 같은 원문 서체인데
일부만 볼드/다른 계열이 된다. 005 P019/D004~D005의 손으로 쓴 듯한 획끝도 현재 대응이
충분하지 않다. 확대 화면 수정이나 C10의 11개 고딕 수정으로 이 반례를 해결했다고
처리하지 않는다. 사용자 스크린샷은 연구 `user-failures-002`의 evaluation-only 자료다.

후속 S4는 OFL 같은 face의 다른 성분을 묶어 유형과 face identity를 학습했다.
합성 검증은 나아졌으나 실제 화에서 동일한 혼합 인쇄체를 가나/한자 구성에 따라
여러 유형으로 분리하여 source 단계에서 기각했다. 제품 모델/정책에는 포함하지 않는다.

## 모델과 데이터 권위

모델은 `fontExpressionModel.json`에 base64로 묶인 1,047,989 byte ONNX다.
SHA-256: `71f15f0b1bef9fd57fcf20246586cdbe06749bf31d60e2bfdd26f3a1d788a183`.
런타임은 byte size, SHA, schema, class order를 확인한 뒤 공용 native ONNX gateway에서
CPU 2 threads로 로드한다. 기존 다운로드 자산의 태그, cache version, manifest는 불변이다.
외부 릴리스나 앱 버전 릴리스는 이 변경에 포함하지 않는다.

`scripts/font-expression-model.py`는 학습에 사용한 정확한 producer snapshot이다.
그 파일의 `POLICY`와 `infer`는 기각한 C7 연구 기본값을 보존하므로 제품 정책으로 쓰지 않는다.
제품 정책의 권위는 `automaticFontMatchingExpression.ts`이며 메타데이터와 학습 SHA는
`font-expression-heavy-sans-evidence.json`을 본다.

학습은 기존 검증된 OFL 원문 폰트 pack을 렌더한 합성 연결 성분만 사용했다.
실제 만화 픽셀, 사용자 스크린샷, v11 수동 감사, 1,347개 direct visual label은 사용하지 않았다.
OFL source inventory의 `training_allowed`와 각 파일 SHA를 확인한다. 합성 검증의
문자 holdout 정확도는 약 68.1%, family holdout은 약 43.9%다. heavy-serif는 family
holdout 자체가 없어 그 수치로 명조→붓글씨 매핑을 정당화할 수 없다.

재현: producer `data <OFL manifest> <data-dir>`, `train <data-dir> <model-dir>`.
PyTorch 2.9.1+cu130, OpenCV 4.11, 12,000 steps, seed 732611을 사용했다.
출력 해시는 producer 환경에 종속될 수 있으므로 새 bytes는 새 artifact로 검증한다.
현재 모델, data NPZ, inventory, receipt, executed-source는 연구 산출물에서 보존한다.

## 검사와 롤백

합성 parity fixture로 Python/OpenCV 전처리와 TS 전처리, 실제 native ORT logits를 비교한다.
일반·명조·brush·scribble·display의 무변경, 빈 입력, 취소, 유효하지 않은 모델 증거,
후보 풀 제외, 실제 V2 결정과 수동 잠금 보존을 테스트한다.
`npm run check`의 전체 테스트·타입·린트·아키텍처·coverage·빌드·page artwork parity·
image protocol smoke를 통과해야 한다. 실행 receipt는 별도 evidence JSON에 기록한다.

기존 coverage floor는 내리지 않았다. 새로 보호 범위에 들어온 전처리 파일은 원래
node22 baseline에서 floor를 가져왔고 새 4개 실행 파일은 이번 focused 측정으로 추가했다.
기존 manifest의 historical introducedArtifact는 옛 399개 파일의 권위로 유지하며,
새 4개 파일의 측정 파일과 SHA는 evidence JSON의 appendix로 구분한다.

롤백은 이 추가 기능 커밋을 revert하고 앱을 다시 빌드·시작한다. 기존 R33/proxy 자산,
원본, 보관함, 출력물의 이동이나 삭제는 필요 없다. 기존에 저장한 block을 소급 변환하지
않으며 새 자동 맞춤 실행부터 새 정책을 사용한다.
