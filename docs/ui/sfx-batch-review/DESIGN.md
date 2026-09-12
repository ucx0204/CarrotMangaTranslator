---
name: 효과음 일괄 검토
description: 기존 편집기 안에서 페이지별 원문·번역문과 이미지 영역을 함께 검토하는 작업 화면.
colors:
  bg-modal: "#20242c"
  bg-sunken: "#111318"
  control-bg: "#20242b"
  text: "#ece7dc"
  text-dim: "#b8b1a6"
  accent: "#a64e36"
  accent-hi: "#e7b39e"
  accent-text: "#fbf3ef"
typography:
  title:
    fontSize: "15px"
    fontWeight: 700
    letterSpacing: "0.01em"
  body:
    fontFamily: '"Malgun Gothic", "Apple SD Gothic Neo", "Segoe UI", sans-serif'
    fontSize: "13px"
  label:
    fontSize: "12px"
  caption:
    fontSize: "11px"
rounded:
  r-sm: "6px"
  r-md: "8px"
  r-lg: "10px"
spacing:
  sp-1: "4px"
  sp-2: "6px"
  sp-3: "8px"
  sp-5: "12px"
  sp-6: "16px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-text}"
    rounded: "{rounded.r-md}"
    padding: "6px 12px"
  button-secondary:
    backgroundColor: "{colors.control-bg}"
    textColor: "{colors.text}"
    rounded: "{rounded.r-md}"
    padding: "6px 12px"
  text-field:
    backgroundColor: "{colors.bg-sunken}"
    textColor: "{colors.text}"
    rounded: "{rounded.r-md}"
    padding: "6px 10px"
  page-navigation:
    rounded: "{rounded.r-md}"
    padding: "{spacing.sp-5}"
  tool-picker:
    backgroundColor: "{colors.bg-sunken}"
    rounded: "{rounded.r-md}"
---

# Design System: 효과음 일괄 검토

## Overview

**Creative North Star: "페이지 검토 작업대"**

기존 다크 데스크톱 편집기의 밀도와 공용 컨트롤을 유지한다. 페이지를 선택하고, 원본 이미지의 번호 상자와 연결된 원문·번역문을 수정한 뒤 전체 페이지를 한 번에 확정하는 작업 화면이다.

이 문서는 이 화면만 기록한다. 앱 전체의 권위는 [UI 설계 규칙](../../ui-design-rules.md)과 [foundations.css](../../../src/renderer/src/styles/foundations.css)이며, 위 토큰은 그중 실제 사용한 부분의 기록이다. 기능·인증의 기술 인계는 [기존 문서](../../codex-image-tools-handoff.md)를 따른다.

**Key Characteristics:**

- 페이지 목록, 이미지 작업 공간, 텍스트 목록을 분리한다.
- 페이지를 바꿔도 각 페이지의 입력 상태를 보존한다.
- 전체 확정과 생성은 하단의 단일 primary action으로 실행한다.

## Colors

어두운 중립 표면 위에 밝은 본문과 낮은 강조의 안내문을 놓는다. 테라코타 계열 accent는 전체 확정 버튼, 활성 페이지·도구, 선택한 영역의 연계 표시에 사용한다. 색상과 focus 처리는 공용 semantic token을 참조하며 별도 팔레트를 정의하지 않는다.

## Typography

기존 한국어·플랫폼 UI 글꼴 스택을 상속한다. 다이얼로그 제목, 입력문, 레이블·안내문, 페이지별 개수 순으로 작은 크기 차이를 둔다. 이미지 속 글자는 사용자 콘텐츠이며 UI 타이포그래피의 기준으로 삼지 않는다.

## Layout

[일괄 검토 스타일](../../../src/renderer/src/components/SoundEffectTextReviewModal.module.css)과 [영역 편집기 스타일](../../../src/renderer/src/components/RegionReviewEditor.module.css)이 배치의 계약이다.

| 조건                           | 실제 배치                                                                                                                               |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| 기본                           | 폭 96vw, 높이 상한 94vh의 공용 Modal. 왼쪽 페이지 rail은 120–164px, 오른쪽 텍스트 목록은 240–300px, 가운데 이미지는 남은 폭을 사용한다. |
| 화면 폭 1000px 이하            | 페이지 rail이 위쪽 가로 목록으로 바뀌며 자체 가로 스크롤을 가진다.                                                                      |
| 폭 760px 이하, 높이 560px 이상 | 도구 아래에 이미지, 그 아래에 텍스트 목록을 쌓는다.                                                                                     |
| 폭 760px 이하, 높이 559px 이하 | 이미지와 180–220px 텍스트 목록을 나란히 유지한다.                                                                                       |
| 폭 640px 이하                  | 공용 Modal이 바깥 여백과 내부 padding을 줄인다.                                                                                         |

헤더와 전체 확정 footer는 고정된 영역이다. 페이지 rail, 이미지 viewport, 텍스트 목록이 각각 필요한 스크롤을 소유한다. 도구와 footer 행동은 폭에 맞게 줄바꿈한다. 페이지 파일명은 줄바꿈하고 스타일 연결 항목의 긴 텍스트는 공용 tooltip으로 확인한다.

## Elevation & Depth

Modal의 배경·그림자·진입 모션은 공용 Modal에서 온다. 이미지 viewport만 별도의 작업 공간으로 낮은 표면을 사용한다. 페이지 항목은 기존 SelectionSurface 상태 처리를 그대로 사용하며 기능 전용 그림자나 쌓임 순서를 추가하지 않는다.

## Shapes

Modal, 입력·버튼·페이지 항목, 이미지 viewport의 모서리는 각각 공용 큰·중간·작은 radius를 따른다. 영역 상자는 편집 대상의 실제 사각형이며 장식용 표면으로 취급하지 않는다.

## Components

- **일괄 검토 Modal:** [SoundEffectTextReviewModal](../../../src/renderer/src/components/SoundEffectTextReviewModal.tsx)은 페이지별 개수와 총합을 표시한다. 모든 form이 유효해야 전체 확정 버튼이 활성화된다. 확정 준비 또는 제출 중에는 페이지 전환, 편집, 취소·닫기를 막고 중복 제출을 차단한다. 오류는 `role="alert"`로 표시한다.
- **페이지 전환:** [SoundEffectTextReviewPage](../../../src/renderer/src/components/SoundEffectTextReviewPage.tsx)는 각 form을 유지하고 활성 페이지의 편집기만 표시한다. 페이지 선택은 `SelectionSurface`의 button/row이며 현재 페이지에 `aria-current="page"`를 준다.
- **영역 편집:** [RegionReviewEditor](../../../src/renderer/src/components/RegionReviewEditor.tsx)는 공용 도구 선택, 원본 이미지, 영역 상자, 확대·화면 맞춤을 제공한다. 영역 추가·이동·크기 조정, 브러시 칠하기·제외·복구, 실행 취소·다시 실행을 지원한다.
- **연결된 텍스트:** [RegionReviewTextList](../../../src/renderer/src/components/RegionReviewTextList.tsx)는 번역문과 원문을 각각 편집 가능한 Field로 표시한다. 입력 focus와 이미지 영역의 선택을 공유하고 [navigation hook](../../../src/renderer/src/components/useRegionReviewNavigation.ts)이 선택 항목을 목록 안으로 드러낸다. 선택 영역의 좌표·크기, 삭제, 다른 영역과의 스타일 연결도 이 목록에서 조작한다.
- **확정·취소:** [Dialog](../../../src/renderer/src/components/SoundEffectTextReviewDialog.tsx)와 [session hook](../../../src/renderer/src/hooks/useSoundEffectTextReview.ts)이 전체 페이지 확정을 연결한다. 원문 제거와 이미지 생성은 전체 확정 이후 시작한다. Cancel, 닫기 버튼, Esc는 같은 취소 동작을 사용하며 제출 중에는 닫히지 않는다. Esc는 영역 편집기에서 가로채지 않고 공용 Modal에 전달한다.

## Do's and Don'ts

- **Do** 페이지별 form과 이미지·텍스트 선택의 연결을 유지한다.
- **Do** 공용 Modal, Field, SelectionSurface, RegionReviewEditor의 상태와 접근성 계약을 사용한다.
- **Do** 실제 production component로 넓은 창과 좁은 창을 캡처하여 외부 넘침과 footer 접근성을 확인한다.
- **Don't** 이 화면을 근거로 앱 전체의 색상·표면·타이포그래피 규칙을 새로 정의한다.
- **Don't** 임시 QA 이미지나 이미지 속 글자를 제품 자산 또는 UI 디자인 토큰으로 기록한다.
