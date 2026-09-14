import {
  activityResourcesConflict,
  pageContentResource,
} from "../../../shared/appActivityTypes";
import { useAppActivities } from "../hooks/useAppActivities";
import React from "react";
import type { SoundEffectImageRecovery } from "../../../shared/analysisTypes";
import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import { analysisGateway } from "../api/analysisGateway";
import { handoffActiveModalToWorkCenter } from "../lib/modalWorkCenterHandoff";
import { Button } from "./ui/Button";

export function SoundEffectImageRecoveryAction({
  chapter,
  disabled,
  onResume,
}: {
  chapter: ChapterSnapshot;
  disabled: boolean;
  onResume: (recovery: SoundEffectImageRecovery) => void;
}) {
  const activities = useAppActivities();
  const [recovery, setRecovery] =
    React.useState<SoundEffectImageRecovery | null>(null);
  const [error, setError] = React.useState("");
  React.useEffect(() => {
    let current = true;
    void analysisGateway.getSoundEffectImageRecovery(chapter.id).then(
      (value) => {
        if (current) {
          setRecovery(value);
          setError("");
        }
      },
      (reason: unknown) => {
        if (current)
          setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
    return () => {
      current = false;
    };
  }, [chapter.id, chapter.updatedAt]);
  if (error)
    return (
      <span role="status">이미지 복구 기록을 읽지 못했습니다: {error}</span>
    );
  if (!recovery || recovery.chapterId !== chapter.id) return null;
  const resources = [
    { kind: "codex-auth" as const, scope: "*", access: "read" as const },
    ...recovery.targets.map((target) =>
      pageContentResource(chapter.id, target.pageId),
    ),
  ];
  const conflict = activities?.activities.some((activity) =>
    activityResourcesConflict(resources, activity.resources),
  );
  return (
    <Button
      disabled={disabled || conflict}
      title="저장된 번역문과 지정 영역으로 미완료 이미지만 생성합니다. 이 창에서 새로 수정한 영역은 새 작업에 반영됩니다."
      onClick={() => {
        handoffActiveModalToWorkCenter();
        onResume(recovery);
      }}
    >
      이미지 작업 이어서 · {recovery.targets.length}페이지
    </Button>
  );
}
