import React from "react";

type GatherTextFileInputsProps = {
  reviewInputRef: React.RefObject<HTMLInputElement | null>;
  textInputRef: React.RefObject<HTMLInputElement | null>;
  onReviewFile: (file: File) => Promise<void>;
  onTextFile: (file: File) => Promise<void>;
};

export function GatherTextFileInputs({
  reviewInputRef,
  textInputRef,
  onReviewFile,
  onTextFile,
}: GatherTextFileInputsProps): React.JSX.Element {
  return (
    <>
      <FileInput
        inputRef={reviewInputRef}
        accept=".csv,.tsv,text/csv,text/tab-separated-values"
        onFile={onReviewFile}
      />
      <FileInput
        inputRef={textInputRef}
        accept=".txt,text/plain"
        onFile={onTextFile}
      />
    </>
  );
}

function FileInput({
  inputRef,
  accept,
  onFile,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  accept: string;
  onFile: (file: File) => Promise<void>;
}): React.JSX.Element {
  return (
    <input
      ref={inputRef}
      type="file"
      accept={accept}
      hidden
      onChange={(event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (file) void onFile(file);
      }}
    />
  );
}
