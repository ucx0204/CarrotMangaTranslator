import React from "react";
import { DEFAULT_BLOCK_FONT_ID } from "../../../shared/blockFontCatalog";
import { ConditionalBatchSpeakersContext } from "./conditionalBatchSpeakers";
import { FontSelect } from "./FontSelect";
import { Field } from "./ui/Field";
import { Select } from "./ui/Select";

export function ConditionalBatchIdentityField({
  field,
  label,
  ariaLabel = label,
  value,
  useDefaultFont = false,
  onChange,
}: {
  field: "speakerId" | "fontFamily";
  label: string;
  ariaLabel?: string;
  value: string;
  useDefaultFont?: boolean;
  onChange: (value: string) => void;
}): React.JSX.Element {
  if (field === "speakerId") {
    return <SpeakerField label={label} value={value} onChange={onChange} />;
  }
  return (
    <Field as="div" label={label}>
      <FontSelect
        ariaLabel={ariaLabel}
        preserveFontId
        value={value || undefined}
        onChange={(font) =>
          onChange(font ?? (useDefaultFont ? DEFAULT_BLOCK_FONT_ID : ""))
        }
      />
    </Field>
  );
}

function SpeakerField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}): React.JSX.Element {
  const catalog = React.useContext(ConditionalBatchSpeakersContext);
  const hintId = React.useId();
  const options = [...catalog.options];
  if (value && !options.some((option) => option.value === value)) {
    options.push({
      value,
      label: `이름 미등록 · ${value}`,
      tooltip: value,
      group: "현재 규칙에 저장된 화자",
      description: "현재 작품에서 인물 정보를 찾을 수 없습니다.",
      searchText: value,
    });
  }
  const status = catalog.error
    ? "화자 이름을 불러오지 못했습니다. 창을 다시 열어 재시도하세요."
    : !catalog.ready
      ? "화자 이름을 불러오는 중입니다."
      : catalog.options.length === 0
        ? "등록된 인물과 대사에 연결된 화자가 없습니다. 작품의 인물 정보를 먼저 확인하세요."
        : "이름·원문 이름·별칭으로 검색할 수 있습니다.";
  return (
    <Field
      as="div"
      label={label}
      hint={
        <span id={hintId}>
          {status}
          {catalog.unassignedCount > 0
            ? ` 현재 화에서 화자가 연결되지 않은 대사: ${catalog.unassignedCount}개.`
            : null}
        </span>
      }
    >
      <Select
        ariaLabel={label}
        ariaDescribedBy={hintId}
        searchable
        searchPlaceholder="화자 이름·별칭 검색"
        placeholder="화자 선택"
        value={value}
        options={options}
        onValueChange={onChange}
      />
    </Field>
  );
}
