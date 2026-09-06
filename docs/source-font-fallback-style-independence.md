# 원문 글자 크기 fallback의 번역 서체 의존 제거

2026-09-06. 제품 내부 수정 `source-size-peer-independence-1`.

한글 자동 서체가 바뀌면, 선택이 바뀌지 않은 다른 말풍선의 글자 크기까지 변했다.
원문 크기를 직접 측정하지 못한 블록에서 이웃의 **번역 결과 bold**가 같은 블록만
골라 원문 크기 중앙값을 구했기 때문이다. 원문 크기는 번역 서체에 의존하면 안 된다.

`resolvePageSourceFontFaceFallbacks()`는 이제 신뢰할 수 있는 원문 측정값 중 원문
방향과 역할이 같은 이웃을 사용한다. 자체 원문 측정값이 있는 블록의 경로, 글자
크기 변환 정책, 말풍선 모델·마스크·조판 알고리즘은 이번 변경 대상이 아니다.

## 재현과 확인

폰트 연구 lab의 confirmation-007 P004/D004는 동일한 `……`, 나눔명조 bold,
source-match 블록이었다. 이웃 서체만 달라지는 B/C 입력을 실제 Electron exporter의
동일 세션에서 B,C,B,C 순서로 재생했다. 변경 전 26px/10px였고 네 PNG가 각각
이전 봉인 출력과 byte-identical이었다. 변경 후에는 양쪽 모두 28px, 동일한
기호 측정 폭 53.21875px였다. 폰트는 모두 정상 loaded 상태였다.

증거는 별도 lab의 다음 경로에 보존한다. 이전 C13 출력은 덮어쓰지 않는다.

- `artifacts/font-palette-lab/fresh-series-rotation-001/source-size-peer-before/receipt.json`
- `artifacts/font-palette-lab/fresh-series-rotation-001/source-size-peer-after/receipt.json`

회귀 테스트는 선택이 바뀌지 않은 기호 블록을 두고 이웃의 fontFamily/bold/italic을
바꾸어도 원문 fallback이 24px로 유지되는지 검증한다. 원문 역할 선택 테스트도
번역 bold 필터가 제거된 중앙값으로 갱신했다. 관련 4개 파일 64개 테스트, typecheck,
focused ESLint, Electron compile과 전체 `npm run check` 26개 gate를 통과했다.
전체 검사는 186.56초였으며 coverage, build, page artwork parity와 image protocol
smoke를 포함한다. 로그: `.tmp/source-font-fallback-style-independence-check-002.log`.

첫 전체 검사는 기존 사용 화 레지스트리 JSON의 형식 검사에서 실패했다. 해당 파일을
Prettier로 정리한 뒤 전체 검사를 다시 통과했으며 알고리즘 실패를 rerun으로 숨기지 않았다.

이는 원문 추정값의 잘못된 의존성을 제거한 수정이다. 모든 크기 선택의 미학적 최적화나
S6/C13 원문 그룹 연구의 승격을 의미하지 않는다. 화 단위 서체 그룹은 여전히 연구 중이다.

rollback은 이 수정의 함수와 회귀 테스트를 함께 되돌리는 것이다. 사용자 원본,
라이브러리, 기존 프로젝트·출력물, 모델 자산에는 migration이 없다.
