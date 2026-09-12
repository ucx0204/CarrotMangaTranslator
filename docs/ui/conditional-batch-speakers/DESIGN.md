---
name: 일괄 편집 화자 선택
description: 기존 일괄 편집에서 인물 이름으로 화자를 찾고 내부 ID로 판정하는 선택 필드.
colors:
  bg-sunken: "#111318"
  text: "#ece7dc"
  text-dim: "#b8b1a6"
  text-muted: "#95a4b3"
  accent-hi: "#e7b39e"
typography:
  body:
    fontFamily: '"Malgun Gothic", "Apple SD Gothic Neo", "Segoe UI", sans-serif'
  label:
    fontSize: "12px"
  metadata:
    fontSize: "11px"
rounded:
  r-md: "8px"
  r-lg: "10px"
spacing:
  sp-2: "6px"
  sp-3: "8px"
components:
  select-trigger:
    backgroundColor: "{colors.bg-sunken}"
    textColor: "{colors.text}"
    rounded: "{rounded.r-md}"
    padding: "6px 10px"
  search-input:
    textColor: "{colors.text}"
    rounded: "{rounded.r-md}"
    padding: "6px 10px"
  speaker-option:
    textColor: "{colors.text-dim}"
    rounded: "{rounded.r-md}"
    padding: "7px 9px"
---

# Design System: 일괄 편집 화자 선택

## Overview

**Creative North Star: "일괄 편집 작업대"**

화자 조건과 화자 지정에 공용 검색 Select를 사용한다. 사용자는 작품의 인물 이름으로 선택하고, 저장·판정은 기존 speaker ID 계약을 따른다. 기존 다크 데스크톱 편집기의 배치와 시각 언어를 유지한다.

이 기록은 화자 선택 필드에 한정한다. 앱 전체의 권위는 [UI 설계 규칙](../../ui-design-rules.md)과 [foundations.css](../../../src/renderer/src/styles/foundations.css), 행동 계약은 [일괄 편집 인계](../../conditional-batch-effective-values.md)다. 위 토큰은 기존 값의 발췌다.

**Key Characteristics:**

- 인물 이름을 주 정보로, 현재 화의 대사 개수를 보조 정보로 표시한다.
- 조건과 속성 바꾸기에서 같은 화자 목록을 사용한다.
- 이름을 찾지 못해도 규칙에 저장된 ID를 보존한다.

## Colors

공용 Select의 낮은 중립 표면, 밝은 값, 낮은 강조의 설명을 사용한다. 선택한 항목은 accent 계열 텍스트로 구분하고 활성 항목의 배경과 focus 테두리는 공용 상태 처리를 따른다. 화자별 색상이나 별도 팔레트는 없다.

## Typography

앱의 언어별 UI 글꼴을 상속한다. Field 레이블과 선택값은 작은 본문 계층이며, 그룹 이름·대사 개수·상태 안내는 보조 계층이다. 긴 이름은 한 줄 말줄임으로 표시하고 공용 tooltip에 전체 값을 제공한다.

## Layout

[일괄 편집 스타일](../../../src/renderer/src/components/ConditionalBatchEditor.module.css)의 규칙 rail 안에 Field를 채운다. 기본 화면은 규칙·미리보기·결과를 나란히 표시한다. 폭 1180px 이하에서는 기존 탭으로 전환하고, 680px 이하에서는 필드·비교 컨트롤을 세로로 쌓는다.

검색 메뉴는 [공용 Select](../../../src/renderer/src/components/ui/Select.module.css)와 [위치 계산](../../../src/renderer/src/components/ui/selectUtilities.ts)을 따른다. 검색칸은 위에 남고 결과 목록만 스크롤한다. 메뉴는 trigger에 맞춰 배치하되 화면 가장자리 안에서 크기와 위·아래 방향을 조정한다. 이 필드는 별도 breakpoint나 스크롤 컨테이너를 추가하지 않는다.

## Elevation & Depth

검색 메뉴는 공용 portal과 semantic layer·shadow를 사용해 규칙 rail 위에 열린다. 필드 자체에는 별도 그림자나 중첩 표면을 추가하지 않는다. 진입 모션과 reduced-motion 처리는 공용 Select가 소유한다.

## Shapes

trigger·검색 입력·선택 항목은 공용 중간 radius, 메뉴 외곽은 큰 radius를 사용한다. 레이블·입력·안내문 간격은 Field의 기존 간격을 따른다.

## Components

- **화자 필드:** [ConditionalBatchIdentityField](../../../src/renderer/src/components/ConditionalBatchIdentityField.tsx)가 `Field`와 `Select searchable`을 연결한다. 레이블은 조건에서 “화자 조건 값”, 지정 작업에서 “적용할 화자”이며 상태 안내를 `aria-describedby`로 연결한다.
- **목록과 검색:** [catalog](../../../src/renderer/src/components/conditionalBatchSpeakers.ts)는 번역 이름 → 표시 이름 → 첫 원문 이름 → ID 순으로 이름을 고른다. 이름·원문 이름·별칭·ID로 검색할 수 있다. 작품 인물과 현재 화에 연결된 미등록 화자를 그룹으로 나누고 대사 개수를 표시한다. 동명이인은 ID를 붙여 구분하며 비활성 인물 정보도 설명과 함께 유지한다.
- **누락·준비 상태:** 목록에 없는 현재 규칙 값은 “이름 미등록” 항목으로 보존한다. 조회 중·실패·빈 목록은 필드 아래에 안내하고 화자 미연결 대사의 개수를 함께 표시한다. [editor model](../../../src/renderer/src/components/useConditionalBatchEditorModel.ts)은 작품 변경 시 이전 목록과 늦은 조회 결과가 섞이지 않도록 한다.
- **비교와 적용:** [조건 편집](../../../src/renderer/src/components/ConditionalBatchConditionsCard.tsx)의 같음·다름과 [속성 바꾸기](../../../src/renderer/src/components/ConditionalBatchSetFieldsEditor.tsx)의 화자 지정이 같은 목록을 사용한다. [새 화자 조건](../../../src/renderer/src/components/conditionalBatchUi.ts)은 정확한 ID 같음으로 시작한다. 기존 포함·패턴 규칙은 그대로 유지하고, 화자 미지정은 비어 있음으로 찾는다. 인물 등록 자체가 기존 대사에 화자를 배정하지는 않는다.
- **키보드:** 메뉴가 열리면 검색 입력으로 focus를 옮긴다. 화살표·Home·End로 탐색하고 Enter로 선택하며 Esc로 메뉴를 닫아 trigger에 focus를 복원한다. Tab은 메뉴를 닫고 다음 focus로 이동한다. 이 동작은 [공용 Select controller](../../../src/renderer/src/components/ui/useSelectController.ts)의 계약이다.

## Do's and Don'ts

- **Do** 표시 이름과 저장 ID를 분리하고 정확한 ID 판정·기존 YAML 형식을 유지한다.
- **Do** 조건과 지정 작업에 같은 catalog와 공용 Field·Select를 사용한다.
- **Do** 긴 이름, 별칭 검색, 미등록 값, 조회 상태를 실제 production component로 검증한다.
- **Don't** 이름 중복이나 인물 정보 누락을 이유로 저장된 화자 ID를 바꾸거나 지운다.
- **Don't** 이 선택 필드를 근거로 앱 전체의 표면·모션·아이콘 규칙을 새로 정의한다.
