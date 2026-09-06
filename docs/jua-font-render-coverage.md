# 주아체의 빈 글자 렌더 보정

2026-09-06. 화 단위 주아체 비교 C13의 `P007/D007`에서 문장 끝 `—`가 사라졌다.
번역문과 블록에는 문자가 남아 있었지만, 탑재 TTF가 획이 없는 glyph를 cmap에
등록해 브라우저의 기존 보조 폰트가 사용되지 않았다.

- 자산: `src/renderer/src/assets/fonts/ko/jua.ttf`
- SHA-256: `e8e6aa8b1b662c7bf0d7f136f29e822e0985176458a6e5d0ba08afc4a5c901a9`
- cmap 17,557개 중 실제 outline 2,523개, 빈 glyph 15,034개.
- `fonts.css`의 주아체 face에 outline 2,523개와 공백/제어문자 35개의
  `unicode-range`를 명시한다. 정상 주아체 글자와 공백 폭을 보존하고 비어 있던
  가시 문자 14,999개는 원래 font stack으로 대체한다.
- TTF bytes, 라이선스, R33 분류기, proxy/reference bank, 원문 글자 크기 및
  말풍선 배치 정책은 바꾸지 않는다. 이것은 서체 선택 학습의 변경이 아니다.

근거: [CSS Fonts 4의 unicode-range와 실제 cmap의 교집합 규칙](https://www.w3.org/TR/css-fonts-4/#unicode-range-desc).
CSS는 UTF-16 문자를 직접 치환하지 않고 브라우저의 기존 glyph fallback을 사용한다.
보조 글자의 실제 모양은 플랫폼의 fallback 폰트에 따라 달라질 수 있다.

검증:

- `python -m unittest discover -s tests/python -p test_jua_font_render_coverage.py`:
  실제 TTF의 모든 outline을 독립적으로 검사해 CSS 전체 범위와 일치하는지 검증.
- `npx vitest run tests/bundledFontAssets.test.ts`: 기존 face/라이선스/해시 계약 통과.
- 실제 `OverlayText`, font catalog, layout resolver, production CSS를 import한
  임시 QA 엔트리로 `qa:ui` 1500×900 및 430×1300 캡처를 직접 확인했다.
  Chromium에서는 폰트 URL 전송 방식만 HTTP로 바꿨고 CSS descriptor를 보존했다.
- 브라우저 canvas에서 `주아 가나다 ABC 123!?…`의 수정 전후 전체 픽셀 동일,
  일반/줄바꿈 방지/전각 공백 폭 동일, `—―─·「」갂힣` 8개의 원래 ink=0 및
  수정 후 ink>0을 assert했다. actual component에서 긴 대시의 표시도 확인했다.
- Impeccable detector: 변경 CSS 경고 0. QA 임시 엔트리와 PNG는 검증 후 제거한다.

화 단위 그룹 매칭 연구의 제품 승격과 이 렌더 오류 수리는 별개다. C13의 같은
선택을 고친 exporter로 재생하는 것은 여섯 번째 서체/임계값 실험이 아니다.
