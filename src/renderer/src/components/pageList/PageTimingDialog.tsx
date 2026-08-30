import React from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { MangaPage } from "../../../../shared/libraryTypes";
import {
  PAGE_PROCESSING_TIMING_STAGES,
  type PageProcessingTimingState,
  type PageProcessingTimingStage,
} from "../../../../shared/pageProcessingTiming";
import {
  buildPageTimingReport,
  type PageTimingReport,
} from "../../lib/pageTimingReport";
import { ControlTooltip } from "../ui/ControlTooltip";
import { Modal } from "../ui/Modal";

export function PageTimingDialog({
  onClose,
  pages,
}: {
  onClose: () => void;
  pages: MangaPage[];
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const report = React.useMemo(() => buildPageTimingReport(pages), [pages]);
  return (
    <Modal
      title={t("pageList.timing.title")}
      size="xl"
      maxHeight="820px"
      fillHeight
      bodyLayout="bare"
      onClose={onClose}
    >
      <div className="page-timing-dialog">
        <PageTimingSummary report={report} />
        {report.rows.length > 0 ? (
          <PageTimingTable report={report} />
        ) : (
          <div className="page-timing-empty">
            <strong>{t("pageList.timing.emptyTitle")}</strong>
            <span>{t("pageList.timing.emptyDescription")}</span>
          </div>
        )}
      </div>
    </Modal>
  );
}

function PageTimingSummary({
  report,
}: {
  report: PageTimingReport;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <header className="page-timing-summary">
      <div>
        <span>{t("pageList.timing.grandTotal")}</span>
        <strong>{formatSeconds(report.totalSeconds, t)}</strong>
      </div>
      <p>{t("pageList.timing.recordedPages", { count: report.rows.length })}</p>
    </header>
  );
}

function PageTimingTable({
  report,
}: {
  report: PageTimingReport;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="page-timing-table-scroll">
      <table className="page-timing-table">
        <thead>
          <tr>
            <th scope="col">{t("pageList.timing.page")}</th>
            {PAGE_PROCESSING_TIMING_STAGES.map((stage) => (
              <th scope="col" key={stage}>
                <span className="page-timing-column-heading">
                  {stageLabel(stage, t)}
                  {stage === "preparing" ? (
                    <ControlTooltip
                      className="page-timing-help-tooltip"
                      content={t("pageList.timing.preparingHelp")}
                      placement="bottom"
                    >
                      <button
                        type="button"
                        className="page-timing-help"
                        aria-label={t("pageList.timing.preparingHelp")}
                      >
                        ⓘ
                      </button>
                    </ControlTooltip>
                  ) : null}
                </span>
              </th>
            ))}
            <th scope="col">{t("pageList.timing.total")}</th>
          </tr>
        </thead>
        <tbody>
          {report.rows.map((row) => (
            <tr key={row.pageId}>
              <th scope="row" title={row.pageName}>
                <span className="page-timing-page-name">{row.pageName}</span>
                {row.state !== "completed" ? (
                  <span
                    className={`page-timing-state page-timing-state-${row.state}`}
                  >
                    {stateLabel(row.state, t)}
                  </span>
                ) : null}
              </th>
              {PAGE_PROCESSING_TIMING_STAGES.map((stage) => (
                <td key={stage}>
                  {formatSeconds(row.secondsByStage[stage], t)}
                </td>
              ))}
              <td className="page-timing-row-total">
                {formatSeconds(row.totalSeconds, t)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">{t("pageList.timing.grandTotal")}</th>
            {PAGE_PROCESSING_TIMING_STAGES.map((stage) => (
              <td key={stage}>
                {formatSeconds(report.secondsByStage[stage], t)}
              </td>
            ))}
            <td>{formatSeconds(report.totalSeconds, t)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function stageLabel(
  stage: PageProcessingTimingStage,
  t: TFunction<"components">,
): string {
  return t(`pageList.timing.stages.${stage}`);
}

function stateLabel(
  state: PageProcessingTimingState,
  t: TFunction<"components">,
): string {
  return t(`pageList.timing.states.${state}`);
}

function formatSeconds(
  totalSeconds: number,
  t: TFunction<"components">,
): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = (totalSeconds - hours * 3600 - minutes * 60).toFixed(2);
  if (hours > 0) {
    return t("pageList.timing.duration.hours", { hours, minutes, seconds });
  }
  if (minutes > 0) {
    return t("pageList.timing.duration.minutes", { minutes, seconds });
  }
  return t("pageList.timing.duration.seconds", { seconds });
}
