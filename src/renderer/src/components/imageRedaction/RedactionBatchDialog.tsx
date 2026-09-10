import React from "react";
import { useTranslation } from "react-i18next";
import { copyRedactionStrokes } from "../../../../shared/imageRedactionEditing";
import { Modal } from "../ui/Modal";
import { ModalActionBar } from "../ui/ModalActionBar";
import { Button } from "../ui/Button";
import { ControlTooltip } from "../ui/ControlTooltip";
import { CheckboxField } from "../ui/CheckboxField";
import { SegmentedControl } from "../ui/SegmentedControl";
import { RedactionMaskCanvas } from "./RedactionMaskCanvas";
import { useRedactionPreview } from "./useRedactionPreview";
import type { RedactionWorkspaceController } from "./useRedactionWorkspace";
import type { RedactionBatchIntent } from "./manualRedactionWorkspaceTypes";
import {
  applyRedactionBatch,
  decideRedactionPages,
} from "./redactionWorkspaceModel";
import styles from "./RedactionWorkspace.module.css";

type Props = {
  form: RedactionWorkspaceController;
  intent: RedactionBatchIntent;
  onClose: () => void;
};
type BatchModel = ReturnType<typeof useBatchModel>;

export function RedactionBatchDialog(props: Props): React.JSX.Element {
  const { t } = useTranslation("components");
  const model = useBatchModel(props);
  const { intent, form } = props;
  return (
    <Modal
      title={t(
        intent.kind === "review"
          ? "manualRedaction.reviewSelection"
          : "manualRedaction.copySelection",
      )}
      size="md"
      onClose={props.onClose}
      footer={
        <ModalActionBar
          actions={
            <>
              <Button onClick={props.onClose}>{t("common.cancel")}</Button>
              <ControlTooltip
                content={t(
                  intent.kind === "review"
                    ? "manualRedaction.explicitReviewHint"
                    : "manualRedaction.copyReviewHint",
                )}
                placement="top"
              >
                <Button
                  variant="primary"
                  onClick={model.apply}
                  disabled={!model.valid}
                >
                  {t(
                    intent.kind === "review"
                      ? "manualRedaction.reviewSelectedCount"
                      : "manualRedaction.applyCount",
                    { count: intent.ids.length },
                  )}
                </Button>
              </ControlTooltip>
            </>
          }
        />
      }
    >
      <p>
        {t("manualRedaction.batchCount", {
          count: intent.ids.length,
          masked: intent.ids.filter(
            (id) => form.state.documents[id].strokes.length > 0,
          ).length,
        })}
      </p>
      {intent.kind === "review" ? (
        <ReviewChoices model={model} />
      ) : (
        <CopyChoices form={form} intent={intent} model={model} />
      )}
    </Modal>
  );
}

function useBatchModel({ form, intent, onClose }: Props) {
  const [scaling, setScaling] = React.useState<"exact" | "proportional">(
    "exact",
  );
  const [replace, setReplace] = React.useState(false);
  const pages = form.state.workspace.pages.filter((page) =>
    intent.ids.includes(page.id),
  );
  const failed = intent.ids.filter((id) => form.failed.has(id)).length;
  const mismatches =
    intent.kind === "copy"
      ? pages.filter(
          (page) =>
            page.width !== intent.source.width ||
            page.height !== intent.source.height,
        )
      : [];
  // Loading a thumbnail is neither a review nor a prerequisite for explicit batch review.
  const valid =
    !form.busy &&
    !form.drawing &&
    intent.ids.length > 0 &&
    (intent.kind === "review"
      ? !failed
      : intent.source.strokes.length > 0 &&
        (!mismatches.length || scaling === "proportional"));
  const apply = () => {
    if (!valid) return;
    form.commit((current) =>
      intent.kind === "review"
        ? decideRedactionPages(current, intent.ids, "reviewed")
        : applyRedactionBatch(current, { ...intent, scaling, replace }),
    );
    onClose();
  };
  return {
    scaling,
    setScaling,
    replace,
    setReplace,
    pages,
    failed,
    mismatches,
    valid,
    apply,
  };
}

function ReviewChoices({ model }: { model: BatchModel }): React.JSX.Element | null {
  const { t } = useTranslation("components");
  return model.failed ? (
    <p role="alert" className={styles.inlineError}>
      {t("manualRedaction.failedCount", { count: model.failed })}
    </p>
  ) : null;
}

function CopyChoices({
  form,
  intent,
  model,
}: {
  form: RedactionWorkspaceController;
  intent: Extract<RedactionBatchIntent, { kind: "copy" }>;
  model: BatchModel;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const { pages, mismatches, scaling, setScaling, replace, setReplace } = model;
  return (
    <div className={styles.dialogRows}>
      {mismatches.length ? (
        <p role="status">
          {t("manualRedaction.sizeMismatch", { count: mismatches.length })}
        </p>
      ) : null}
      <SegmentedControl
        ariaLabel={t("manualRedaction.copyScale")}
        value={scaling}
        onChange={setScaling}
        options={(["exact", "proportional"] as const).map((id) => ({
          id,
          label: t(`manualRedaction.scale_${id}`),
        }))}
      />
      <CheckboxField
        checked={replace}
        onCheckedChange={setReplace}
        label={t("manualRedaction.replaceExisting")}
      />
      {pages[0] ? (
        <BatchPreview
          form={form}
          intent={intent}
          targetId={(mismatches[0] ?? pages[0]).id}
          scaling={scaling}
          replace={replace}
        />
      ) : null}
    </div>
  );
}

function BatchPreview({
  form,
  intent,
  targetId,
  scaling,
  replace,
}: {
  form: RedactionWorkspaceController;
  intent: Extract<RedactionBatchIntent, { kind: "copy" }>;
  targetId: string;
  scaling: "exact" | "proportional";
  replace: boolean;
}): React.JSX.Element | null {
  const { t } = useTranslation("components");
  const page = form.state.workspace.pages.find((item) => item.id === targetId);
  const image = useRedactionPreview(
    form.previews,
    form.state.workspace.sessionId,
    targetId,
    320,
  );
  if (!page) return null;
  const compatible =
    scaling === "proportional" ||
    (page.width === intent.source.width &&
      page.height === intent.source.height);
  const copied = compatible
    ? copyRedactionStrokes(intent.source.strokes, intent.source, page, scaling)
    : [];
  const strokes = replace
    ? copied
    : [...form.state.documents[page.id].strokes, ...copied];
  const width = Math.min(240, (200 * page.width) / page.height);
  const height = (width * page.height) / page.width;
  return (
    <div className={styles.previewPanel}>
      <strong>
        {t("manualRedaction.examplePreview", { name: page.name })}
      </strong>
      <div className={styles.thumbnailStage} style={{ width, height }}>
        {image.url ? (
          <img src={image.url} alt={page.name} className={styles.sourceImage} />
        ) : null}
        <RedactionMaskCanvas
          thumbnail
          width={page.width}
          height={page.height}
          strokes={strokes}
          onFailure={form.report}
        />
      </div>
      {!compatible ? (
        <span className={styles.hint}>
          {t("manualRedaction.chooseScaling")}
        </span>
      ) : null}
    </div>
  );
}
