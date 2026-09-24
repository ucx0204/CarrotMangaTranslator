/** User-facing scope labels shared by the native approval page and settings UI.
 * Authorization still belongs to the existing OAuth and tool policies. */
export function describeMcpScopes(scope: string): string {
  const labels: Record<string, string> = {
    "carrot.read": "보관함·텍스트·문맥 조회",
    "carrot.images": "이미지 및 이미지 포함 파일 전송",
    "carrot.edit": "텍스트·서식·문맥 편집",
    "carrot.process": "블록·보관함 관리와 앱 모델 처리",
    offline_access: "다음 실행에도 승인 유지",
  };
  return scope
    .split(/\s+/)
    .filter(Boolean)
    .map((item) => (Object.hasOwn(labels, item) ? labels[item] : item))
    .join(" · ");
}
