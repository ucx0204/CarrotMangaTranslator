# 일관 편집 조사와 단계별 도입안

조사일: 2026-08-30  
당근망가번역기 기준 커밋: e50dd40590f949d916bf989485a9b7589be97554  
조사 브랜치: codex/beginner-batch-rules-research  
비교 저장소 기준 커밋: hgmzhn/manga-translator-ui 953f1da5847bf0afebaba503087b61f0e82467db

이 문서는 제품·기술 조사와 구현 순서 제안으로 시작했다. 같은 브랜치에 이 제안의 첫 세로 조각을 구현했으며, 현재 구현의 정확한 범위와 체험 체크리스트는 [일관 편집 v1 사용·검증 가이드](conditional-batch-editor-v1.md)에 정리했다. 기존 작업 폴더의 스테이징되지 않은 변경은 건드리지 않았다.

> 2026-08-31 구현 피드백 반영: 전용 화면과 간단/조건 모드 분리는 폐기했다. 실제 구현은 기존 편집 화면 위에 거의 전체 창 크기의 **일관 편집** 모달을 띄우며, 일반 검색·치환 기능도 같은 규칙과 실행 엔진에 직접 포함한다.

## 한 줄 결론

Scratch의 **철학**은 가져오되 Scratch/Blockly의 캔버스를 그대로 가져오지는 않는 것이 좋다.

당근망가번역기의 첫 버전은 다음 조합이 가장 적합하다.

1. 처음에는 자주 쓰는 **레시피**를 고른다.
2. 레시피를 열면 “만약 번역문이 비어 있지 않고 …”처럼 읽히는 **한국어 문장형 카드**가 보인다.
3. 왼쪽에는 조건과 작업만 두고, 오른쪽 대부분은 **실제 만화 원고 미리보기**로 쓴다.
4. 조건을 바꿀 때마다 일치 블록 수, 각 조건의 참/거짓, 변경 전/후가 즉시 갱신된다.
5. 적용은 한 번의 실행과 한 번의 실행 취소로 묶는다.
6. YAML은 저장·공유 형식으로 사용하되 초보자가 직접 편집해야만 쓸 수 있는 구조로 만들지 않는다.

첫 구현에서는 중첩 조건, 정규식, 그래프, 자동 실행을 과감히 빼는 편이 좋다. “조건 하나 + 작업 하나 + 실제 원고 미리보기 + 안전한 적용/실행 취소”를 끝까지 완성하는 것이 먼저다.

## 조사 범위와 방법

다음 세 영역을 함께 확인했다.

- 비교 대상 manga-translator-ui의 조건·작업 엔진, YAML 저장, Qt 화면, 미리보기·적용·복원 경로
- 조건 편집을 초보자에게 풀어낸 상용 제품과 오픈소스 제품
- 당근망가번역기의 기존 데이터 모델, 서식 일괄 적용, 찾기/바꾸기, 스타일 프리셋, 작업 기록, 3열 화면 구조

React Query Builder와 GoRules JDM은 문서와 소스만 읽지 않고 실제 공개 데모도 열어 화면 밀도와 조작 구조를 확인했다.

## 비교 저장소가 현재 제공하는 전체 범위

비교 저장소의 조건부 일괄 편집기는 번역 과정 자체를 자동화하는 워크플로 엔진이 아니다. 이미 생성된 \*\_translations.json의 region을 골라 후처리하는 도구다.

### 조건

조건 필드는 19개다. 이 중 14개는 값 변경도 가능하고, 5개는 조건에서만 읽을 수 있다.

| 분류   | 필드                                               | 쓰기 가능 |
| ------ | -------------------------------------------------- | --------: |
| 텍스트 | 번역문, 치환 전 번역문, 글꼴, 대상 언어, 원본 언어 |      가능 |
| 텍스트 | 원문                                               |      불가 |
| 열거형 | 방향, 정렬                                         |      가능 |
| 숫자   | 글자 크기, 각도, 줄 간격, 자간, 외곽선 두께        |      가능 |
| 숫자   | OCR 신뢰도, 줄 수, region 순번                     |      불가 |
| 색     | 글자색, 외곽선색                                   |      가능 |
| 불리언 | 리치 텍스트 보유 여부                              |      불가 |

자료형별 연산자는 다음처럼 고정돼 있다.

- 텍스트: 포함, 미포함, 같음, 다름, 정규식 일치/불일치, 비어 있음/비어 있지 않음
- 열거형: 같음, 다름
- 숫자: 같음, 다름, 초과, 이상, 미만, 이하, 범위
- 색: 같은 색, 가까운 색
- 불리언: 예, 아니오

여러 조건은 한 단계의 모두 충족 또는 하나라도 충족만 지원한다. 조건 그룹의 중첩, 괄호, 조건별 부정, IF/ELSE 분기는 없다.

중요한 안전상 특징과 한계는 다음과 같다.

- 조건이 하나도 없으면 모든 region이 일치한다.
- 알 수 없는 필드나 연산자는 거짓으로 처리한다.
- 잘못된 정규식은 오류로 막지 않고 일치 없음으로 처리한다.
- 조건은 작업 전의 region을 기준으로 평가한다.

### 작업

작업 종류는 세 가지다.

1. 필드 값 설정
2. 텍스트 치환
3. 리치 텍스트 범위 스타일 변경

텍스트 치환과 리치 텍스트 작업은 여러 개 넣을 수 있다. 실제 실행 순서는 YAML에 섞어 적더라도 필드 설정 → 텍스트 치환 → 리치 텍스트 순으로 고정되며, 같은 종류 안에서만 작성 순서를 따른다.

리치 텍스트는 전체 문장 또는 패턴에 일치한 범위에 프리셋을 적용하고, 덮어쓰기·빈 값만 채우기·전체 스타일 교체 모드를 제공한다. 기능은 강하지만 초보자가 이해해야 할 개념이 크게 늘어난다.

### 저장, 미리보기, 적용

- YAML을 safe_load/safe_dump로 읽고 쓴다.
- 스킴 이름을 기준으로 생성·복제·이름 변경·삭제한다.
- UI 변경 후 600ms에 자동 저장한다.
- 적용 전 미리보기 실행이 필수다.
- 표에서 개별 일치 항목을 제외할 수 있다.
- 적용 직전에 파일을 다시 읽고 조건과 작업을 다시 계산한다.
- JSON 파일 단위로 임시 파일을 쓴 뒤 교체한다.
- 원본 옆의 단일 .bak 파일로 복원한다.

미리보기는 이미지 캔버스가 아니라 이미지명, region 순번, 변경 전 텍스트, 변경 후 텍스트, 변경 항목을 보여 주는 6열 표다. 실제 말풍선 안에서 글꼴·크기·줄바꿈·외곽선이 어떻게 보이는지는 확인할 수 없다.

### UI가 어려워지는 이유

화면 한 페이지에 다음이 세로로 모두 쌓인다.

1. 스킴 선택과 관리
2. 조건 카드
3. 필드 설정 카드
4. 텍스트 치환 카드
5. 리치 텍스트 카드
6. 미리보기 표

각 조건 행은 필드 → 연산자 → 값 → 삭제 버튼이다. 방향 값도 h, v, hr, vr, auto 같은 내부 코드에 가깝다. 숙련자는 빠르게 쓸 수 있지만, 초보자는 “내가 고른 조건이 지금 선택한 말풍선에서 왜 참인지”, “적용하면 원고가 어떻게 보이는지”를 별도로 머릿속에서 계산해야 한다.

따라서 당근망가번역기가 가져올 것은 순수 평가 엔진, 미리보기 후 적용, 선택 제외, 백업/실행 취소 같은 안전장치다. 화면 밀도, 내부 필드 노출, 표만 있는 미리보기, 빈 조건의 암묵적 전체 선택은 그대로 가져오지 않는 편이 좋다.

비교 저장소 근거:

- [조건 엔진 소스](https://github.com/hgmzhn/manga-translator-ui/blob/953f1da5847bf0afebaba503087b61f0e82467db/desktop_qt_ui/services/batch_edit_engine.py)
- [YAML 스킴 저장 소스](https://github.com/hgmzhn/manga-translator-ui/blob/953f1da5847bf0afebaba503087b61f0e82467db/desktop_qt_ui/services/batch_edit_schemes.py)
- [Qt 패널 소스](https://github.com/hgmzhn/manga-translator-ui/blob/953f1da5847bf0afebaba503087b61f0e82467db/desktop_qt_ui/ui/secondary_pages/batch_edit_panel.py)
- [조건 설명](https://github.com/hgmzhn/manga-translator-ui/blob/main/doc/wiki/en/desktop/batch-management/conditions.md)
- [작업 순서 설명](https://github.com/hgmzhn/manga-translator-ui/blob/main/doc/wiki/en/desktop/batch-management/actions-and-order.md)
- [미리보기·적용·복원 설명](https://github.com/hgmzhn/manga-translator-ui/blob/main/doc/wiki/en/desktop/batch-management/preview-apply-restore.md)

## 인터넷에서 찾은 좋은 구현 패턴

### 1. Microsoft PowerRename: 입력 즉시 전/후를 보여 준다

[PowerRename](https://learn.microsoft.com/en-us/windows/powertoys/powerrename)은 대량 파일 이름 변경 도구다. 검색어와 바꿀 값을 입력하는 동안 원래 이름과 새 이름이 미리보기 목록에 즉시 나타난다. 일치한 항목 중 일부만 체크 해제할 수 있고, 적용 후 탐색기의 실행 취소도 지원한다.

당근망가번역기에 그대로 옮길 수 있는 부분:

- 입력과 미리보기를 한 화면에 둔다.
- 적용될 항목만 즉시 보여 준다.
- 각 항목을 적용 대상에서 제외할 수 있다.
- 정규식은 기본이 아니라 별도 고급 옵션으로 둔다.
- 적용 후 실행 취소 경로를 명확하게 제공한다.

다만 만화 편집에서는 텍스트 표보다 실제 페이지 위 강조 표시가 더 중요하다.

### 2. Shopify Flow: 조건을 문장처럼 읽히게 하고 테스트한다

[Shopify Flow의 조건](https://help.shopify.com/en/manual/shopify-flow/getting-started/understanding-conditions)은 필드·연산자·값 구조를 유지하면서도 사람이 읽는 문장처럼 보여 준다. 조건 설명도 따로 붙일 수 있다. [워크플로 테스트](https://help.shopify.com/en/manual/shopify-flow/manage/test-workflow)는 실제 데이터를 바꾸지 않고 실행 경로와 각 단계 결과를 보여 준다.

가져올 부분:

- 내부 구조는 필드·연산자·값이어도 화면은 완성된 한국어 문장으로 읽힌다.
- 선택한 샘플에서 “이 조건은 통과/실패”를 카드 바로 아래 보여 준다.
- 실제 적용 없는 테스트 모드를 별도로 둔다.

### 3. Home Assistant: 시각 편집이 기본, YAML은 탈출구

[Home Assistant 자동화 편집기](https://www.home-assistant.io/docs/automation/editor/)는 트리거·조건·작업을 시각적으로 구성하게 하고, 전체 자동화뿐 아니라 개별 카드도 YAML로 전환할 수 있다. [Blueprint](https://www.home-assistant.io/docs/blueprint)는 다른 사람이 만든 자동화에서 필요한 빈칸만 채워 재사용하게 한다.

가져올 부분:

- 초보자는 레시피를 고르고 “어느 텍스트/어느 스타일” 같은 빈칸만 채운다.
- 고급 사용자는 특정 카드만 YAML로 열 수 있다.
- 카드에 메모와 예시를 붙일 수 있다.

처음부터 YAML 탭을 전면에 노출할 필요는 없다. “고급 설정 → YAML 보기” 정도가 적절하다.

### 4. Scratch와 Blockly: 낮은 진입 장벽은 블록 모양보다 어휘와 범위에서 나온다

[Scratch 편집기](https://scratch.mit.edu/help/studio/tips/ui/tour-intro/)의 팔레트·스크립트 영역·무대 구조는 “고를 것 / 만들 것 / 결과”를 공간적으로 분리한다. [Blockly의 작업 공간](https://developers.google.com/blockly/guides/get-started/workspace-anatomy)도 도구상자와 작업 공간을 구분한다.

더 중요한 것은 Blockly 팀의 [블록 언어 설계 지침](https://developers.google.com/static/blockly/publications/papers/TipsForCreatingABlockLanguage.pdf)이다.

- 대상 사용자의 어휘를 쓰고 전문 용어를 피한다.
- 사용 가능한 블록 수를 작게 유지한다.
- 조건처럼 추상적인 개념은 아이콘만으로 표현하기 어렵다.
- 자연어 문장은 코드보다 이해하기 쉽다.
- 현재 맥락에 필요한 블록만 동적으로 보여 줄 수 있다.

즉, 색색의 퍼즐 블록을 복제하는 것보다 “번역문이 비어 있으면”처럼 자연스럽게 읽히는 작은 카드 집합이 더 중요하다.

Blockly 자체는 최신 버전에서 키보드 탐색을 강화하고 있지만 [접근성 작업](https://www.blockly.com/accessibility)은 계속 진행 중이다. 캔버스와 드래그를 채택한다고 접근성이 자동으로 해결되는 것은 아니다.

### 5. Apple Shortcuts: IF의 경계를 눈에 보이게 한다

[Apple Shortcuts의 If 작업](https://support.apple.com/en-za/guide/shortcuts/apd83dcd1b51/ios)은 If, Otherwise, End If 표지를 명확히 보여 준다. 입력 자료형에 따라 가능한 조건이 달라지고, 여러 조건은 Any/All로 묶는다.

가져올 부분:

- 텍스트를 고르면 포함/비어 있음, 숫자를 고르면 초과/이하만 보여 준다.
- 모두/하나라도를 긴 설명과 함께 선택하게 한다.
- 나중에 분기를 넣더라도 시작·아니면·끝 경계가 항상 보이게 한다.

첫 버전에는 Otherwise가 필요 없다. 조건에 맞는 블록만 바꾸는 단일 경로로 충분하다.

### 6. Notion: 단순 필터와 고급 필터를 나눈다

[Notion 데이터베이스 필터](https://www.notion.com/help/views-filters-and-sorts)는 단순 필터를 먼저 제공하고, 필요한 사용자가 고급 필터로 전환해 AND/OR 그룹을 만든다. 현재 공식 도움말 기준 중첩은 최대 세 단계다.

가져올 부분:

- 처음에는 조건 한두 개의 단순 화면
- “고급 조건 그룹”을 명시적으로 켜야 중첩 노출
- 무제한 중첩 대신 최대 깊이 제한

당근망가번역기는 세 단계도 많다. 향후 지원하더라도 루트 + 하위 그룹 한 단계, 즉 최대 깊이 2가 적절하다.

### 7. Airtable, Zapier, Power Automate: 각 단계가 왜 통과했는지 보여 준다

- [Airtable 조건 그룹](https://support.airtable.com/articles/8153928625-conditional-groups-of-automation-actions)은 그룹별로 조건을 테스트한다.
- [Zapier Paths](https://help.zapier.com/hc/en-us/articles/8496288555917-Add-branching-logic-to-Zap-workflows-with-Paths)는 샘플 데이터에 대해 각 경로가 계속될지 멈출지 보여 준다.
- [Power Automate 디자이너](https://learn.microsoft.com/en-us/power-automate/flows-designer)는 중앙 캔버스와 설정 패널, 검사기, 실행 테스트를 결합한다.

가져올 부분:

- 선택한 말풍선 하나에 대해 각 조건 카드에 실제 값과 통과/실패를 표시한다.
- 전체 결과 숫자만 보여 주지 말고 어느 조건에서 탈락했는지 설명한다.
- 오류는 적용 순간이 아니라 편집 중 해당 카드에서 막는다.

### 8. OpenRefine: 필터 수치, 비파괴 미리보기, 재사용 가능한 작업 기록

[OpenRefine의 facet](https://openrefine.org/docs/manual/facets)은 왼쪽 필터에서 선택한 값마다 일치 행 수를 보여 주며, 데이터는 임시로 좁혀 본 뒤 작업한다. [표현식 편집기](https://openrefine.org/docs/manual/expressions/)는 실제 변경 전에 몇 개 행의 변환 결과를 미리 보여 준다. [작업 기록](https://openrefine.org/docs/manual/running/#history-undoredo)은 모든 변경을 순서대로 실행 취소·재실행하고, 일부 작업 기록을 추출해 다른 프로젝트에 적용할 수 있다.

가져올 부분:

- 조건 옵션 옆에 현재 일치 개수를 보여 준다.
- 편집하는 동안 원본 데이터는 바꾸지 않는다.
- 적용한 규칙 이름을 작업 기록에 남긴다.
- 나중에는 성공한 작업 기록을 새 레시피로 저장할 수 있다.

### 9. Node-RED와 n8n: 디버그 패널은 나중 단계에 유용하다

[Node-RED의 debug sidebar](https://nodered.org/docs/user-guide/editor/sidebar/debug)는 실행 결과를 옆에서 필터링하고, 시끄러운 노드는 잠시 끌 수 있다. [n8n 데이터 매핑 UI](https://docs.n8n.io/data/data-mapping/data-mapping-ui/)는 입력 데이터를 보면서 필요한 값을 끌어 표현식을 만든다.

이는 자동화 범위가 커진 뒤에는 좋지만, 첫 조건부 일괄 편집에는 과하다. 향후 “왜 이 블록이 바뀌었나” 감사 로그나 고급 필드 선택기에만 참고하는 편이 좋다.

## 오픈소스 후보 비교

버전은 2026-08-30 npm 공개 정보와 각 공식 저장소를 기준으로 확인했다.

| 후보                                                                                    | 장점                                                                           | 비용·문제                                                                                   | 판단                      |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ------------------------- |
| 직접 만든 문장형 카드                                                                   | 만화 용어, 실제 미리보기, 기존 스타일 프리셋과 완전히 결합 가능                | 조건 그룹·키보드 이동·검증을 직접 구현                                                      | **첫 버전 권장**          |
| [React Query Builder 8.23.1](https://github.com/react-querybuilder/react-querybuilder)  | MIT, 자료형별 편집기, ALL/ANY, 중첩, 검증, 깊이 제한, 이동·복제·실행 취소 확장 | Redux 계열 의존성, 일반 DB 질의 개념이 화면과 모델에 스며듦, 작업 편집기는 별도             | 조건이 커질 때 재검토     |
| [Blockly 13.2.1](https://github.com/google/blockly)                                     | Apache-2.0, 강한 블록 생태계, 직렬화와 사용자 정의 블록                        | 약 17MB unpacked, 캔버스·좌표·연결 규칙 학습, 미리보기 결합 별도, 드래그·접근성 부담        | 첫 버전 비권장            |
| [GoRules JDM Editor 1.52.0](https://github.com/gorules/jdm-editor)                      | MIT, 결정 그래프·표·시뮬레이션·스키마 자동완성                                 | Ant Design, Monaco, CodeMirror, React Flow, WASM, ExcelJS 등 큰 의존성; 기업 규칙 엔진 용어 | 아이디어만 차용           |
| [React Awesome Query Builder](https://github.com/ukrbublik/react-awesome-query-builder) | 함수·필드 비교·다양한 내보내기·복잡한 중첩                                     | 첫 사용자가 보게 되는 개념과 제어가 너무 많음                                               | 비권장                    |
| [json-rules-engine 7.3.1](https://github.com/CacheControl/json-rules-engine)            | ISC, ALL/ANY 재귀 조건, 브라우저/Node 지원                                     | 당근망가 도메인에는 초기 기능보다 추상화가 큼; UI와 YAML은 별도                             | 복잡한 분기 시 재검토     |
| [yaml 2.9.0](https://eemeli.org/yaml/)                                                  | ISC, 외부 의존성 없음, YAML 1.2, 문서 오류·경고와 AST 지원                     | 파싱 뒤 도메인 검증은 별도로 필요                                                           | **직접 의존성 추가 권장** |

### 실제 데모를 보고 내린 판단

React Query Builder의 공개 데모는 기본 행 자체는 필드·연산자·값으로 명료했다. 그러나 AND/OR, 규칙 추가, 그룹 추가, 중첩 그룹, 값 출처, 여러 자료형을 한 화면에 올리면 금방 일반 질의 편집기가 된다. 라이브러리는 충분히 사용자 정의할 수 있지만, 당근망가의 초보 화면을 만들려면 기본 컨트롤 대부분을 다시 감싸야 한다.

GoRules JDM 데모는 Request, Response, Decision table, Expression, Function, Switch 노드와 연결선·확대/축소·구성 패널을 제공한다. 시뮬레이터 아이디어는 훌륭하지만 “말풍선을 조건으로 골라 서식을 바꾼다”는 문제보다 훨씬 큰 정신 모델을 요구한다.

그러므로 첫 버전은 새 범용 엔진을 넣기보다 작은 도메인 평가기를 만드는 편이 낫다. 현재 프로젝트에는 이미 Zod, @dnd-kit, 스타일 프리셋, 블록별 안정 ID, 장 단위 작업 기록이 있다. 새 런타임 의존성은 YAML 파서 하나면 충분하다.

### React Query Builder를 다시 검토할 기준

다음 중 둘 이상이 실제 요구가 되면 작은 격리 프로토타입을 만들어 비교한다.

- 중첩 그룹을 두 단계 이상 제공해야 한다.
- 조건 종류가 20개를 넘는다.
- 그룹 복제·잠금·이동·비활성화가 필수다.
- SQL/JSONLogic 등 다른 질의 형식 내보내기가 필요하다.
- 직접 만든 조건 UI의 키보드 접근성 유지비가 커진다.

이 경우에도 react-querybuilder/rules-engine 패키지까지 바로 넣을 필요는 없다. 조건 트리 UI와 검증만 쓰고, 만화 블록 평가는 도메인 평가기가 맡는 편이 단순하다.

## 당근망가번역기에 맞는 화면

기존 앱은 400px 왼쪽 사이드바, 가운데 작업 공간, 400px 오른쪽 레일의 3열 구조다. 조건부 일괄 편집 모드에서는 기존 양쪽 레일을 동시에 유지하지 말고 전용 2열 작업 공간으로 전환하는 것이 좋다.

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ 조건부 일괄 편집   [레시피] [저장됨]        [도움말] [고급: YAML 보기] │
├──────────────────────┬───────────────────────────────────────────────────┤
│ 왼쪽 360~420px       │ 실제 원고 미리보기                               │
│                      │                                                   │
│ 1. 적용 범위         │ [이전 일치]  7 / 24  [다음 일치]                 │
│  ○ 선택한 블록       │ [원본] [변경 후] [겹쳐 보기]                     │
│  ● 현재 페이지       │                                                   │
│  ○ 현재 화           │       만화 페이지와 텍스트 블록                  │
│                      │       일치: 굵은 테두리 + 번호 + “적용”           │
│ 2. 만약              │       불일치: 흐리게                             │
│  [번역문][포함][...] │       제외: 빗금 + “제외”                         │
│  ✓ 현재 블록: 통과   │                                                   │
│  + 조건 추가         │ 선택 블록 변화                                   │
│                      │ “정말...” → “정말…”                              │
│ 3. 이렇게 바꾸기     │ 글꼴/크기/줄바꿈 전후 차이                       │
│  [...]을 […]로 바꿈  │                                                   │
│  + 작업 추가         │                                                   │
├──────────────────────┴───────────────────────────────────────────────────┤
│ 24개 중 7개가 바뀝니다   [일치 항목 목록] [미리보기 새로고침] [적용]   │
└──────────────────────────────────────────────────────────────────────────┘
```

### 왼쪽 패널

위에서 아래로 사용자가 생각하는 순서대로 둔다.

1. 레시피 또는 빈 규칙 선택
2. 이번 실행의 범위
3. 만약: 조건
4. 이렇게 바꾸기: 작업
5. 저장·복제·YAML 같은 고급 기능

“스킴 관리”를 맨 위의 큰 툴바로 두지 않는다. 처음 들어온 사람에게는 스킴이라는 개념보다 지금 무엇을 고르고 무엇을 바꿀지가 먼저다.

### 오른쪽 미리보기

오른쪽은 표가 아니라 기존 프로덕션 원고 캔버스를 재사용한다.

- 일치한 블록에 번호와 테두리를 표시한다.
- 색만으로 상태를 구분하지 않고 적용, 제외, 오류 같은 짧은 글자와 아이콘을 함께 쓴다.
- 원본/변경 후 토글과 잠깐 누르는 비교 기능을 둔다.
- 글자 크기·줄바꿈·외곽선처럼 화면에서 봐야 하는 변화는 실제 렌더러로 그린다.
- 선택한 블록 아래에 조건별 판정과 변경 diff를 보여 준다.
- 다음/이전 일치 버튼으로 24개 결과를 차례로 점검할 수 있게 한다.

목록이 필요한 사용자를 위해 “일치 항목 목록”을 아래 서랍으로 제공하되, 기본 화면을 표로 대체하지는 않는다.

### 좁은 창

폭이 부족할 때 두 패널을 억지로 나란히 축소하지 않는다.

- 규칙/미리보기 두 탭으로 전환한다.
- 아래의 일치 개수와 적용 버튼은 항상 고정한다.
- 미리보기로 넘어가도 규칙 요약 한 줄을 표시한다.

## 초보자가 실제로 겪는 흐름

### 첫 진입

“무엇을 하고 싶나요?”라는 레시피 선택 화면을 먼저 보여 준다.

초기 레시피 후보:

- 점 세 개를 말줄임표로 통일
- 번역이 비어 있는 말풍선 찾기
- 세로쓰기 블록에 세로쓰기 스타일 적용
- 효과음에 저장된 스타일 적용
- 검수 전 블록만 표시

각 레시피에는 결과 예시 한 줄과 “이 레시피는 텍스트만 바꿉니다” 같은 영향 범위를 적는다.

### 조건 만들기

초보자에게 다음 세 칸이 한 문장으로 읽혀야 한다.

```text
만약  [번역문] 이 [다음을 포함하면] [...]
그리고 [표시 방향] 이 [세로쓰기이면]
```

내부 필드명 translatedText, renderDirection이나 연산자 contains를 화면에 그대로 노출하지 않는다.

필드를 고르면 가능한 연산자와 값 편집기가 바뀐다.

- 텍스트 → 포함, 같음, 비어 있음
- 숫자 → 이상, 이하, 범위
- 선택 값 → 다음과 같음, 다음과 다름
- 참/거짓 → 켜짐, 꺼짐

각 카드 아래에는 현재 선택한 블록을 이용한 설명을 붙인다.

```text
✓ 이 블록은 통과합니다
실제 번역문: “정말...?”
```

### 모두와 하나라도

조건이 두 개가 된 순간에만 다음을 묻는다.

- 모든 조건을 만족하는 블록
- 조건 중 하나라도 만족하는 블록

처음부터 AND/OR라는 약어를 앞세우지 않는다. 괄호와 중첩 그룹은 고급 기능을 켜기 전에는 보이지 않는다.

### 전체 블록

조건을 비워 두면 전체 일치로 처리하지 않는다. 사용자가 명시적으로 “조건 없이 범위의 모든 블록” 카드를 골라야 한다. 적용 버튼에는 “현재 페이지의 모든 블록 24개에 적용”이라고 다시 적는다.

### 적용

적용 버튼 문구에 결과 수와 범위를 넣는다.

```text
현재 페이지의 7개 블록에 적용
```

적용 뒤에는 다음을 한 줄로 보여 준다.

```text
“말줄임표 통일”로 7개 블록을 변경했습니다.  [실행 취소]
```

## 기능을 어디까지 열 것인가

### 1단계: 반드시 먼저 만들 작은 완성품

범위:

- 선택한 블록
- 현재 페이지
- 현재 화

조건:

- 번역문: 포함, 같음, 비어 있음, 비어 있지 않음
- 원문: 포함, 같음
- 표시 방향: 가로쓰기, 세로쓰기
- 텍스트 역할: 일반 대사, 효과음
- 검수 상태
- 글자 크기: 이상, 이하

작업:

- 번역문 단순 찾기/바꾸기
- 기존 스타일 프리셋 적용
- 검수 상태 설정
- 표시 방향 설정
- 정렬 설정

안전장치:

- 입력 즉시 실제 원고 미리보기
- 일치 블록 수와 다음/이전 이동
- 블록별 적용 제외
- 한 번의 작업 기록으로 적용
- 한 번의 실행 취소
- YAML 저장/불러오기와 엄격한 검증

논리:

- 기본은 모든 조건
- 하나라도는 조건이 둘 이상일 때 선택 가능
- 중첩 그룹과 ELSE 없음
- 정규식 없음

이 단계만으로도 대부분의 반복 역식 작업을 충분히 줄일 수 있다.

### 2단계: 실제 사용 사례가 쌓인 뒤

- 정규식 찾기/바꾸기
- 숫자 범위와 색상 근접 조건
- 조건 그룹 한 단계
- 조건·작업 복제, 끄기, 위/아래 이동
- 일부 페이지만 고르는 범위
- YAML 가져오기/내보내기
- 적용 결과 보고서
- 최근 성공 작업을 레시피로 저장

정규식은 고급 배지를 붙이고, 입력 오류 시 저장·미리보기·적용을 모두 막는다. “일치 없음”으로 조용히 처리하면 안 된다. 예시 문자열과 일치 부분 강조를 함께 제공한다.

### 3단계: 정말 요구가 확인될 때만

- 리치 텍스트의 문장 일부 스타일 변경
- 작품 전체 범위
- 조건 분기 IF/ELSE
- 자동 실행 트리거
- 외부 규칙 엔진 또는 그래프 편집기
- 팀 공유·승인·감사 로그

특히 문장 일부 리치 텍스트는 텍스트 인덱스, 스타일 span, 치환 후 범위 이동, 기존 스타일 병합 정책까지 필요하다. 첫 버전에서 넣으면 가장 쉬운 사용 사례가 가장 어려운 내부 모델에 끌려간다.

## 가장 좋은 첫 세로 조각

첫 구현은 다음 한 사례를 처음부터 끝까지 완성하는 것이 좋다.

> 현재 페이지에서 번역문에 “...”가 들어 있는 블록을 찾아 “…”로 바꾸고, 실제 원고에서 결과를 확인한 뒤 한 번에 적용하고 실행 취소한다.

이 작은 사례 하나로 다음 기반을 모두 검증할 수 있다.

- 문장형 조건 카드
- 텍스트 작업 카드
- 순수 평가기
- 변경 전/후 복제
- 실제 캔버스 미리보기
- 안정적인 pageId/blockId 결과
- 일부 결과 제외
- YAML 저장
- 한 번의 작업 기록과 실행 취소

정규식 없이도 만들 수 있어 초기에 불필요한 오류 처리를 줄인다.

그다음 세로 조각은 “세로쓰기인 블록에 기존 세로쓰기 스타일 프리셋 적용”이 적합하다. 이 사례가 텍스트 외 서식 미리보기를 검증한다.

## YAML은 저장 형식이지 사용자 인터페이스가 아니다

### 제안 스키마

```yaml
schemaVersion: 1
schemes:
  - id: scheme_01J7M8E0KQ4QZ1X5V8Y2C3D4E5
    name: 말줄임표 통일
    description: 번역문의 점 세 개를 한 글자 말줄임표로 바꿉니다.
    match:
      mode: all
      conditions:
        - id: condition_01J7M8H7N1QK9G4S6T2V3W5X8Y
          field: translatedText
          operator: contains
          value: "..."
    actions:
      - id: action_01J7M8K3P6R9T2V4W5X7Y8Z0A1
        type: replaceText
        target: translatedText
        find: "..."
        replace: "…"
        allOccurrences: true
```

### 중요한 계약

- schemaVersion을 필수로 둔다.
- 스킴·조건·작업에 안정 ID를 둔다.
- 화면의 접힘 상태, 선택된 미리보기 블록, 스크롤 위치는 YAML에 넣지 않는다.
- 이번 실행 범위는 YAML 규칙과 분리한다. 저장된 규칙을 열었다고 작품 전체에 적용되는 일이 없어야 한다.
- 실행 전에 사용자가 선택한 범위와 일치 수를 항상 다시 보여 준다.
- 조건은 원본 블록에서 모두 평가한다.
- 작업은 원본의 복제본에 목록 순서대로 적용한다.
- 미리보기와 실제 적용은 같은 평가 함수와 같은 규칙 모델을 사용한다.
- 작업 중 화 데이터가 바뀌면 기존 미리보기를 폐기하고 다시 계산한다.
- 결과는 파일 순번이 아니라 기존 pageId와 block.id로 식별한다.

### 읽기와 쓰기

현재 lockfile에 yaml 계열 패키지가 간접 의존성으로 보이더라도 직접 계약으로 사용할 패키지는 package.json에 직접 선언해야 한다. yaml 2.9.0과 기존 Zod를 조합하는 것이 가장 단순하다.

권장 절차:

1. YAML 문서를 파싱하고 줄·열 위치가 있는 오류와 경고를 수집한다.
2. 사용자 정의 태그와 alias 같은 불필요한 기능은 허용하지 않거나 거부한다.
3. 파싱 결과를 엄격한 Zod 스키마로 검증한다.
4. 알 수 없는 필드, 잘못된 연산자, 중복 ID, 빈 작업 목록을 오류로 처리한다.
5. 파일 크기, 스킴 수, 조건 수, 작업 수, 중첩 깊이에 상한을 둔다.
6. 임시 파일을 같은 디렉터리에 쓴 뒤 교체하는 방식으로 저장한다.
7. 잘못된 YAML 원본은 덮어쓰지 않고 오류 위치와 고치는 방법을 보여 준다.
8. 새 버전은 마이그레이션한 뒤 다시 검증하고, 알 수 없는 미래 버전은 열지 않는다.

초기 상한 제안:

- 파일 512KiB
- 스킴 200개
- 스킴당 조건 50개
- 스킴당 작업 20개
- 조건 깊이 1, 향후 최대 2

이 숫자는 보안 한계이자 UI가 감당할 수 없는 규칙을 미리 막는 제품 한계다.

## 평가·미리보기·적용의 정확한 의미

### 순수 평가기

평가기 입력:

- 하나의 TranslationBlock
- 조건 트리

평가기 출력:

- 전체 일치 여부
- 조건 ID별 참/거짓
- 조건이 읽은 실제 값
- 검증 오류

작업 적용기 입력:

- 원본 TranslationBlock
- 순서 있는 작업 목록

작업 적용기 출력:

- 변경된 복제본
- 변경 필드 목록
- 사용자에게 보여 줄 요약
- 경고

두 함수는 파일이나 React 상태를 직접 만지지 않는 순수 함수로 두어야 한다.

### 미리보기

미리보기는 현재 화를 메모리에서 복제해 규칙을 실행하고, 실제 저장은 하지 않는다. 기존 렌더러가 복제 결과를 그리게 한다.

미리보기 결과에는 다음이 있어야 한다.

- 미리보기 기준 화 revision
- pageId, blockId
- 조건별 판정
- 원본 블록
- 변경 블록
- 변경 필드
- 사용자가 제외했는지 여부

### 적용

적용 시 현재 revision이 미리보기 기준과 같은지 확인한다.

- 같으면 사용자가 제외하지 않은 결과만 한 번에 반영한다.
- 다르면 적용을 중지하고 자동으로 미리보기를 다시 계산한다.

현재 프로젝트의 updateCurrentChapter와 workspace history는 여러 페이지의 블록 변경을 한 기록으로 묶을 수 있다. 새 별도 백업 체계보다 이 경로를 우선 재사용하는 것이 자연스럽다.

## 기존 당근망가번역기에서 재사용할 수 있는 것

### 데이터와 조건

TranslationBlock에는 이미 다음과 같은 조건 후보가 있다.

- sourceText, translatedText
- type, textRole, fontRole
- confidence, fontRoleConfidence
- sourceDirection, renderDirection
- fontFamily, fontSizePx, lineHeight, letterSpacing
- textAlign, textColor, outlineColor, outlineWidthPx
- bold, italic, textEffect
- autoFitText, inpaintExcluded
- reviewStatus, speakerId, glossaryEntryIds

하지만 존재하는 필드를 전부 첫 화면에 노출해서는 안 된다. 필드 레지스트리에서 novice, standard, advanced 수준을 지정하고, 첫 버전은 앞서 정한 6개 조건군만 보여 주는 편이 좋다.

### 작업

- FormatBatchApplyModal은 선택 블록의 13개 서식 그룹을 선택/페이지/화 범위로 복사한다.
- SearchReplacePanel은 페이지/화 범위, 원문/번역문, 대소문자, 정규식, 결과 목록과 한 번의 적용을 이미 갖고 있다.
- 스타일 프리셋은 복잡한 글꼴·외곽선·효과 설정을 “프리셋 적용” 작업 하나로 줄여 준다.
- block.id가 있으므로 외부 저장소처럼 region 순번에 의존할 필요가 없다.
- workspace history를 이용하면 여러 페이지 적용도 한 번에 취소할 수 있다.

즉, 새 기능의 중심은 기존 기능을 다시 만드는 것이 아니라 조건 평가, 비파괴 미리보기, YAML 코덱, 초보자용 조립 화면을 한 흐름으로 연결하는 것이다.

### 화면

현재 app-shell의 가운데 원고 캔버스는 그대로 살리고, 조건부 일괄 편집 모드에서 왼쪽을 전용 규칙 패널로 바꾼다. 기존 오른쪽 빠른 편집 레일은 숨겨 미리보기 폭을 확보한다.

## 접근성은 첫 버전의 구조 문제다

[WCAG 2.2의 드래그 동작 설명](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements)은 드래그와 같은 결과를 내는 클릭/탭 대안을 요구한다.

필수 원칙:

- 조건·작업 이동은 드래그뿐 아니라 위로/아래로 버튼과 “다음 위치로 이동” 메뉴를 제공한다.
- 기본 HTML 버튼, 입력, select의 의미를 보존한다.
- “조건 2, 번역문이 포함, 통과”처럼 스크린 리더가 읽을 이름을 준다.
- 초록/빨강만 쓰지 않고 체크/엑스와 통과/실패 텍스트를 함께 쓴다.
- 오류는 카드 바로 아래에 원인과 해결 방법을 쓴다.
- 키보드만으로 추가, 편집, 이동, 삭제, 미리보기 이동, 적용이 가능해야 한다.
- 포커스가 미리보기 블록으로 이동했을 때 해당 블록의 조건 판정을 읽을 수 있어야 한다.
- 애니메이션 감소 설정을 존중한다.

Scratch처럼 보이게 하기 위해 카드 색상을 쓰는 것은 괜찮지만, 색은 범주를 돕는 보조 신호여야 한다.

## 실패하기 쉬운 설계

### “Scratch 같게”를 “블록을 드래그하게”로 해석

드래그 캔버스는 재미있어 보이지만 조건 하나를 추가하려고 팔레트에서 블록을 찾고 정확히 끼우는 과정이 생긴다. 마우스 정밀 조작과 키보드 접근성 비용도 커진다.

대신 카드의 색, 둥근 그룹, 문장형 빈칸, 즉시 실행 결과라는 장점만 가져온다.

### 필드와 연산자를 한꺼번에 모두 노출

선택지가 많다는 것은 기능이 많다는 뜻이지 접근성이 좋다는 뜻이 아니다. 자주 쓰는 조건을 먼저 보이고 “고급 필드 더 보기”에서 나머지를 연다.

### YAML을 양방향 실시간 편집기의 중심으로 사용

시각 편집 중 매 키마다 YAML을 다시 쓰고, YAML 편집 중 카드를 즉시 재구성하면 오류 상태와 주석 보존 문제가 복잡해진다.

첫 버전은 카드 모델이 편집의 권위이고 YAML은 저장/가져오기 경계로 둔다. 고급 YAML 편집을 넣을 때는 적용 버튼으로 명시적으로 반영하고, 오류가 있으면 기존 카드 모델을 유지한다.

### 미리보기와 실제 적용에 다른 코드 사용

미리보기는 맞는데 적용 결과가 다르면 기능 전체를 신뢰할 수 없다. 평가와 작업 적용 함수는 공유하고, 차이는 “복제본에 실행”과 “작업 기록을 만들며 저장”뿐이어야 한다.

### 빈 조건을 조용히 전체 선택으로 처리

대량 편집에서 가장 위험한 기본값이다. 전체 적용은 명시적인 선택과 수량이 들어간 확인 문구를 요구한다.

### 처음부터 작품 전체 범위 제공

첫 버전은 선택/페이지/화까지만 지원한다. 작품 전체는 성능, 취소 데이터 크기, 저장 실패의 원자성, 긴 실행 중 변경 문제를 별도로 설계한 뒤 추가해야 한다.

## 단계별 구현 순서

### PR 1. 도메인 모델, 평가기, YAML 코덱

- 버전 있는 Zod 스키마
- 필드 레지스트리와 자료형별 연산자
- 순수 조건 평가기와 작업 적용기
- yaml 직접 의존성
- 잘못된 파일, 미래 버전, 중복 ID, 한계값 테스트
- 기본 레시피 두 개

UI 없이 단위 테스트로 조건별 판정과 변경 결과를 고정한다.

### PR 2. 비파괴 미리보기 어댑터

- 현재 화 복제 실행
- pageId/blockId별 결과
- revision 불일치 감지
- 원본/변경 블록 diff
- 기존 원고 렌더러에 preview override 공급

이 단계에서 개발자용 최소 패널로 실제 원고 전/후가 같은 평가 결과를 쓰는지 검증한다.

### PR 3. 초보자용 2열 작업 공간

- 왼쪽 범위/조건/작업 카드
- 오른쪽 실제 원고 미리보기
- 일치 강조, 다음/이전, 제외
- 문장형 한국어 레이블
- 카드별 실제 값과 통과/실패
- 넓은 창과 좁은 창 QA

### PR 4. 안전한 적용과 실행 취소

- revision 재검사
- 제외하지 않은 결과만 updateCurrentChapter로 반영
- 여러 페이지를 한 history entry로 기록
- 성공 요약과 즉시 실행 취소
- 저장 실패와 충돌 시 원본 보존

### PR 5. 레시피·도움말·접근성 마무리

- 첫 진입 레시피 선택
- 빈 상태와 예시
- 키보드 전 경로
- 드래그 대체 이동
- 오류 문구와 스크린 리더 레이블
- 실제 역식 초보자 3~5명 과업 테스트

정규식, 중첩 조건, 리치 텍스트 범위 스타일은 이 다섯 PR이 실제로 잘 쓰인다는 것을 확인한 뒤 별도 단계로 다룬다.

## 초보자 테스트 과업

설명 없이 다음 과업을 줄 수 있다.

1. 현재 페이지에서 “...”만 “…”로 바꾼다.
2. 바뀔 7개 중 효과음 하나는 제외한다.
3. 세로쓰기 블록만 골라 세로쓰기 프리셋을 적용한다.
4. 적용 전 첫 번째와 마지막 결과를 확인한다.
5. 적용한 변경을 한 번에 취소한다.
6. 만든 규칙을 “말줄임표 통일”로 저장하고 다시 연다.

관찰할 것:

- 조건과 작업을 반대로 이해하는가
- 범위를 놓치는가
- 모두/하나라도 설명을 이해하는가
- 미리보기와 실제 변경을 구분하는가
- 제외 상태를 알아보는가
- YAML을 몰라도 저장·재사용을 끝내는가
- 오류가 났을 때 스스로 복구하는가

목표는 기능 설명서를 먼저 읽게 하는 것이 아니라, 화면의 예시와 피드백만으로 첫 규칙을 끝내게 하는 것이다.

## 최종 권고

우선순위는 다음과 같다.

1. **실제 원고 기반 비파괴 미리보기와 한 번의 실행 취소**
2. **레시피에서 시작하는 한국어 문장형 조건/작업 카드**
3. **선택·페이지·화 범위와 결과별 제외**
4. **버전 있는 YAML 저장과 엄격한 검증**
5. **정규식과 한 단계 조건 그룹**
6. **리치 텍스트 부분 스타일, 작품 전체, 분기·자동화**

첫 버전에서 권장하는 새 의존성은 yaml 하나다. React Query Builder, Blockly, GoRules JDM, json-rules-engine은 지금 당장 넣지 않고 구현 아이디어와 향후 확장 기준으로 남긴다.

가장 중요한 차별점은 “조건을 많이 지원한다”가 아니다. 초보자가 실제 만화 페이지를 보면서 **왜 선택됐는지**, **어떻게 바뀌는지**, **실수해도 어떻게 되돌리는지**를 한 화면에서 이해하게 하는 것이다.

## 참고 자료

### 제품과 UX

- [Microsoft PowerRename](https://learn.microsoft.com/en-us/windows/powertoys/powerrename)
- [Shopify Flow 조건](https://help.shopify.com/en/manual/shopify-flow/getting-started/understanding-conditions)
- [Shopify Flow 테스트](https://help.shopify.com/en/manual/shopify-flow/manage/test-workflow)
- [Home Assistant 자동화 편집기](https://www.home-assistant.io/docs/automation/editor/)
- [Home Assistant Blueprint](https://www.home-assistant.io/docs/blueprint)
- [Scratch 편집기 둘러보기](https://scratch.mit.edu/help/studio/tips/ui/tour-intro/)
- [Blockly 작업 공간 구성](https://developers.google.com/blockly/guides/get-started/workspace-anatomy)
- [Blockly 블록 언어 설계 논문](https://developers.google.com/static/blockly/publications/papers/TipsForCreatingABlockLanguage.pdf)
- [Blockly 접근성](https://www.blockly.com/accessibility)
- [Apple Shortcuts If](https://support.apple.com/en-za/guide/shortcuts/apd83dcd1b51/ios)
- [Notion 필터](https://www.notion.com/help/views-filters-and-sorts)
- [Airtable 조건 그룹](https://support.airtable.com/articles/8153928625-conditional-groups-of-automation-actions)
- [Zapier Paths](https://help.zapier.com/hc/en-us/articles/8496288555917-Add-branching-logic-to-Zap-workflows-with-Paths)
- [Power Automate 디자이너](https://learn.microsoft.com/en-us/power-automate/flows-designer)
- [OpenRefine facet](https://openrefine.org/docs/manual/facets)
- [OpenRefine 표현식 미리보기](https://openrefine.org/docs/manual/expressions/)
- [OpenRefine 작업 기록](https://openrefine.org/docs/manual/running/#history-undoredo)
- [n8n 데이터 매핑 UI](https://docs.n8n.io/data/data-mapping/data-mapping-ui/)
- [Node-RED debug sidebar](https://nodered.org/docs/user-guide/editor/sidebar/debug)

### 오픈소스와 기술

- [React Query Builder](https://github.com/react-querybuilder/react-querybuilder)
- [React Query Builder 문서](https://react-querybuilder.js.org/)
- [Blockly](https://github.com/google/blockly)
- [GoRules JDM Editor](https://github.com/gorules/jdm-editor)
- [GoRules JDM 문서](https://docs.gorules.io/developers/jdm/jdm-editor)
- [React Awesome Query Builder](https://github.com/ukrbublik/react-awesome-query-builder)
- [json-rules-engine](https://github.com/CacheControl/json-rules-engine)
- [yaml](https://eemeli.org/yaml/)
- [WCAG 2.2 Dragging Movements](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements)
- [Nielsen Norman Group: Recognition Rather Than Recall](https://www.nngroup.com/articles/recognition-and-recall/)
- [Nielsen Norman Group: Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/)
