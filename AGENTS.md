# Project agent instructions

## 사용자 데이터 보호

`library`·보관함·원본·출력물은 정리 대상이 아니다. 워크트리 제거 전 외부 정션/심볼릭 링크는 링크 자체만 먼저 분리하고 원본 보존을 확인한 뒤 워크트리를 제거한다. 링크가 연결된 상태로 재귀·강제 제거하지 않는다.

## UI 변경 시 실제 화면 검증

렌더러 UI를 바꾼 뒤 사용자에게 로컬 검증 실행 허락을 묻지 말고 저장소의 자체 QA 도구를 사용한다.

1. 일반 앱 흐름으로 상태를 만들기 어렵다면 실제 프로덕션 컴포넌트와 스타일을 import하는 임시 `src/renderer/qa.html` 및 엔트리를 만든다.
2. 다음 명령으로 Vite와 격리된 Chromium을 자동 실행하고 캡처한다.
   `npm run qa:ui -- --entry qa.html --output C:\tmp\manga-ui-qa.png`
   도구가 QA용 `window.mangaApi` 브리지를 페이지 로드 전에 자동 주입하므로 임시 엔트리에 불완전한 브리지 모형을 따로 만들지 않는다. 빈 `body`/`#root` 또는 렌더러 런타임 오류가 있으면 캡처는 실패 처리된다.
3. 입력·선택·드롭다운·최솟값/최댓값처럼 필요한 대표 상태는 임시 QA 엔트리에서 실제 프로덕션 컴포넌트의 상태와 이벤트를 사용해 만든다. 컴포넌트를 복제한 정적 HTML로 대신하지 않는다.
4. 좁은 화면은 `--width`, `--height`를 바꿔 별도로 캡처한다.
5. 명령이 출력한 PNG 경로를 이미지로 직접 열어 잘림, 겹침, 가로 오버플로, 정렬, 간격을 확인한 뒤 테스트와 빌드를 함께 실행한다. 반복 캡처는 이미지 뷰어 캐시를 피하도록 새 파일명을 사용한다.
6. 완료 후 임시 QA 엔트리와 캡처 이미지를 제거한다. 도구가 만든 브라우저 프로필과 프로세스는 자동 정리된다.

`npm run qa:ui -- --help`에서 전체 옵션을 볼 수 있다.

## 폰트 자동 맞춤 후속 작업

현재 production v2의 exact artifact, 출시 근거, 실패 실험, 데이터 권위와 v3 우선순위는
`docs/font-matching-v2-production-handoff.md`를 먼저 읽는다. 특히 v11 수동 감사와
1,347개 direct visual label은 각각 evaluation-only/training-only이며 human gold가 아니다.

## GitHub 외부 자산 릴리스 표준

모델, 런타임, 네이티브 도구, 대용량 리소스를 앱 릴리스와 별도 GitHub Release asset으로
게시할 때 적용한다. 현재 자산의 정확한 태그·파일명·해시는 각 기능 인계 문서와 소비
코드가 권위다. 기존 태그나 자산을 덮어쓰지 않으며 앱 버전 릴리스는 사용자가 별도로
지시하기 전에는 만들지 않는다.

1. 소비 코드를 먼저 읽어 배포 단위를 확정한다. 앱이 여러 URL을 직접 받으면 원래
   이름의 개별 asset으로 올린다. 앱이 하나의 archive를 받고 자체 extract/manifest
   검증을 한다면 그 계약대로 archive를 만든다. 습관적으로 ZIP 하나로 합치거나 반대로
   무조건 개별 파일로 올리지 않는다. 앱이 지원하지 않는 임의 분할 archive도 만들지 않는다.
2. 새 고유 태그를 정하고 `gh release view <tag>`와
   `git ls-remote --tags origin refs/tags/<tag>`가 모두 비어 있는지 확인한다. 기존 태그,
   asset 이름, cache version을 재사용하지 않는다.
3. 게시 전 producer/promoter/validator를 통과시키고, 배포 대상의 정확한 파일 목록,
   파일명, byte size, SHA-256과 상호 binding manifest를 기록한다. 소스 디렉터리를 통째로
   올리지 말고 소비 계약에 필요한 파일만 새 staging에 복사한다. archive라면 기대하는
   최상위 경로 구조를 그대로 만들고 불필요한 중첩 폴더, 임시 파일, cache, log, 비밀,
   개발 전용 sidecar와 symlink를 제외한다. 같은 입력에서 같은 inventory가 나오도록 파일
   순서를 고정하고, 압축 전후 manifest를 남긴다.
4. 앱 릴리스 전 선게시라면 `gh release create <tag> --prerelease`로 asset-only release를
   만든다. 자산은 명시적 목록으로 순차 업로드하고 `--clobber`는 사용하지 않는다. 일부
   업로드가 실패하면 성공한 asset과 누락 asset을 먼저 감사한 뒤 이어가며, 동일 이름을
   다른 bytes로 교체하지 않는다.
5. 업로드 직후 반드시 새 빈 `.tmp/...` 디렉터리에 `gh release download <tag>`로 다시
   내려받는다. 서버 asset count/name/byte size와 다운로드된 SHA-256 전체가 게시 전
   manifest와 같아야 한다. archive 계약이면 실제 extract 후 내부 inventory와 경로 안전성도
   검증한다. 로컬 원본만 재검사하고 성공으로 처리하지 않는다.
6. 원격 검증이 끝난 뒤에만 소비 코드의 tag/URL, expected SHA/bytes, 새 cache version을
   바꾼다. 빈 data root/cache에서 migration이나 기존 파일 재사용 없이 실제 원격 설치를
   한 번 수행하고 loader/runtime이 ready인지 확인한다. 이후 focused tests, typecheck,
   lint, build, production preflight와 가장 작은 실제 end-to-end smoke를 통과시킨다.
7. 릴리스 URL, 태그, 자산 manifest, 재다운로드 결과, 소비 코드 위치, rollback 방법을 기능
   인계 문서에 남긴다. 대용량 검증용 임시 복사본은 확인 후 제거하되 원본 producer artifact와
   게시된 불변 자산은 보존한다.

일반 명령 골격은 다음과 같다. `$assets`에는 staging에서 검증한 명시적 파일 경로만 넣는다.

```powershell
$repo = "owner/repository"
$tag = "unique-asset-tag"
gh release view $tag --repo $repo                 # 존재하면 중단
git ls-remote --tags origin "refs/tags/$tag"     # 출력이 있으면 중단
gh release create $tag --repo $repo --target <commit-sha> --prerelease `
  --title "<asset release title>" --notes-file <notes.md>
foreach ($asset in $assets) {
  gh release upload $tag --repo $repo $asset      # --clobber 금지
}
gh release view $tag --repo $repo --json assets,isDraft,isPrerelease,url
gh release download $tag --repo $repo --dir <new-empty-verify-dir>
```

마지막 두 명령의 결과를 사전 manifest와 코드로 대조하고, 브라우저 화면이나 업로드 성공
문구만 보고 완료 처리하지 않는다.

## 안정 앱 버전 릴리스 표준

Windows와 Apple Silicon macOS 정식 버전을 게시할 때 적용한다. 저장소의 현재 workflow가
권위이며 수동으로 installer를 GitHub Release에 바로 올리지 않는다. 시작 전 기본 브랜치가
깨끗하고 최신인지 확인하고, 기준 태그부터 최종 트리까지의 diff만으로 패치노트를 쓴다.
개발 중 추가했다가 되돌린 변경이나 출시하지 않은 실험은 릴리스 기능으로 적지 않는다.

1. `package.json`과 lockfile의 버전을 함께 올리고 `docs/release-notes/vX.Y.Z.md`를 만든다.
   README의 현재 버전과 링크도 맞춘다. 태그와 release가 아직 없는지 확인한다.
2. `npm run check`, `npm run verify:hf-assets`와 대상 플랫폼의 package/smoke를 로컬 또는
   CI에서 통과시킨다. UI 변경은 위 `qa:ui` 절차로 넓은 창과 좁은 창을 직접 확인한다.
3. 버전·문서·코드를 한 커밋으로 기본 브랜치에 push하고 `Check` workflow가 같은 HEAD에서
   성공할 때까지 기다린다. 실패하면 로그의 실제 원인을 고치고 새 커밋으로 다시 검증한다.
4. `Release` workflow를 기본 브랜치에서 `tag_name=vX.Y.Z`로 실행한다. 이 workflow가
   버전/패치노트/태그 target을 검증하고 Windows installer를 빌드·smoke·봉인한 뒤 stable
   release와 Windows checksum/provenance를 게시한다. 성공 전에는 macOS workflow를 켜지 않는다.
5. stable release와 Windows asset이 확인된 뒤 `macOS Release`를 같은 태그로 실행한다.
   workflow가 태그가 현재 HEAD인지, Windows installer가 있는지 확인한 뒤 arm64 DMG/ZIP,
   checksum과 provenance를 같은 release에 추가한다. signing secret이 없으면 ad-hoc임을
   패치노트에 정확히 밝힌다.
6. 두 workflow의 최종 conclusion이 success인지 확인한다. 이어 새 빈 `.tmp/...` 폴더에
   `gh release download vX.Y.Z`로 모든 자산을 재다운로드해 이름·개수·byte size를 확인하고,
   Windows/macOS checksum manifest를 실제 파일에 대조한다. provenance의 commit은 태그
   commit과 같아야 한다. release가 draft/prerelease가 아니고 tag가 같은 commit인지도 확인한다.
7. 사용자에게 release URL, tag/commit, Windows EXE와 macOS DMG/ZIP, checksum/provenance,
   workflow URL과 서명 상태를 전달한다. 검증용 다운로드 디렉터리는 제거하되 published
   release와 태그는 덮어쓰지 않는다.

일반 명령 골격:

```powershell
$tag = "vX.Y.Z"
npm version X.Y.Z --no-git-tag-version
npm run check
git push origin master
$checkRun = gh run list --workflow Check --branch master --limit 1 --json databaseId --jq '.[0].databaseId'
gh run watch $checkRun
gh workflow run Release --ref master -f tag_name=$tag
$windowsRun = gh run list --workflow Release --branch master --limit 1 --json databaseId --jq '.[0].databaseId'
gh run watch $windowsRun
gh workflow run "macOS Release" --ref master -f tag_name=$tag
$macRun = gh run list --workflow "macOS Release" --branch master --limit 1 --json databaseId --jq '.[0].databaseId'
gh run watch $macRun
gh release view $tag --json url,isDraft,isPrerelease,tagName,targetCommitish,assets
gh release download $tag --dir <new-empty-verify-dir>
```

workflow 재실행은 transient runner 실패처럼 소스와 무관한 근거가 분명한 경우에만 하며,
코드·테스트 실패를 단순 rerun으로 숨기지 않는다.

이 PC에서 `gh` keyring 토큰이 만료됐는데 Git Credential Manager 자격 증명은 유효할 수
있다. 이때 비밀값을 출력·파일 저장하지 말고 `git credential fill`의 `password`를 현재
PowerShell 프로세스의 `GH_TOKEN`에만 넣는다. Anaconda의 `SSL_CERT_FILE` 때문에 GitHub
API가 x509 오류를 내면 그 프로세스에서만
`C:\Program Files\Git\mingw64\ssl\certs\ca-bundle.crt`로 설정한다. 작업 후
`GH_TOKEN`을 즉시 제거한다. TLS 검증 비활성화와 토큰 로그 출력은 금지한다.
