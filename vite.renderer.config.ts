import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// fonts.css 의 빌트인 @font-face 는 mgt-font:///<rel> 커스텀 스킴을 참조한다(#53).
// 스킴 이름에 하이픈이 있어 Vite 의 external-URL 정규식(/^([a-z]+:)?\/\//)이 외부 URL
// 로 인식하지 못하고, 빌드 시 url() 리졸버가 이를 로컬 파일로 해석하려다 ENOENT 로
// 실패한다. 빌드 중에만 하이픈 없는 자리표시자 스킴(mgtfontskip:)으로 치환해 Vite 가
// url() 처리를 건너뛰게 하고, 산출물로 내보낼 때 원래 mgt-font:/// 로 되돌린다.
// 런타임(Chromium)은 mgt-font: 프로토콜 핸들러로 폰트를 서빙한다.
const MGT_FONT_REAL = "mgt-font:///";
const MGT_FONT_PLACEHOLDER = "mgtfontskip:///";

const mgtFontRestorePlugin: Plugin = {
  name: "mgt-font-css-restore",
  enforce: "post",
  transform(code) {
    // dev: Vite 가 서빙하는 CSS 모듈(인라인 CSS 텍스트 포함)에서 자리표시자를
    // 원래 스킴으로 되돌려 런타임 폰트 로드가 동작하도록 한다.
    if (!code.includes(MGT_FONT_PLACEHOLDER)) return null;
    return {
      code: code.split(MGT_FONT_PLACEHOLDER).join(MGT_FONT_REAL),
      map: null,
    };
  },
  generateBundle(_options, bundle) {
    // build: 추출된 CSS 에셋의 자리표시자를 원래 스킴으로 되돌린다.
    for (const chunk of Object.values(bundle)) {
      if (
        chunk.type === "asset" &&
        typeof chunk.source === "string" &&
        chunk.source.includes(MGT_FONT_PLACEHOLDER)
      ) {
        chunk.source = chunk.source
          .split(MGT_FONT_PLACEHOLDER)
          .join(MGT_FONT_REAL);
      }
    }
  },
};

export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [react(), mgtFontRestorePlugin],
  css: {
    postcss: {
      // UrlRewritePostcssPlugin 이 Once(root).walkDecls 로 url() 을 즉시 처리하므로,
      // 같은 Once 단계에서 그보다 먼저 색출되도록 치환한다. postcss-import 가 @import 를
      // 인라인한 뒤, url 리라이트 이전에 동작한다.
      plugins: [
        {
          postcssPlugin: "postcss-mgt-font-passthrough",
          Once(root) {
            root.walkDecls((decl) => {
              if (decl.value.includes(MGT_FONT_REAL)) {
                decl.value = decl.value
                  .split(MGT_FONT_REAL)
                  .join(MGT_FONT_PLACEHOLDER);
              }
            });
          },
        },
      ],
    },
  },
  build: {
    outDir: "../../out/renderer",
    emptyOutDir: false,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
});
