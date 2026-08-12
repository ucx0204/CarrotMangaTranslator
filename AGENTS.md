# Project agent instructions

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

이 PC에서 `gh` keyring 토큰이 만료됐는데 Git Credential Manager 자격 증명은 유효할 수
있다. 이때 비밀값을 출력·파일 저장하지 말고 `git credential fill`의 `password`를 현재
PowerShell 프로세스의 `GH_TOKEN`에만 넣는다. Anaconda의 `SSL_CERT_FILE` 때문에 GitHub
API가 x509 오류를 내면 그 프로세스에서만
`C:\Program Files\Git\mingw64\ssl\certs\ca-bundle.crt`로 설정한다. 작업 후
`GH_TOKEN`을 즉시 제거한다. TLS 검증 비활성화와 토큰 로그 출력은 금지한다.
