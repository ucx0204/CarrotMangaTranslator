import React from "react";
import type { RenderTextDirection } from "../../../shared/textTypes";
import { tokenizeVerticalTextSpacing } from "../lib/verticalTextSpacing";

export function TextWithVerticalSpacing({
  direction,
  text,
}: {
  direction: RenderTextDirection;
  text: string;
}): React.JSX.Element {
  if (direction !== "vertical") return <>{text}</>;
  return (
    <>
      {tokenizeVerticalTextSpacing(text).map((token, index) =>
        token.advanceEm === undefined ? (
          <React.Fragment key={index}>{token.text}</React.Fragment>
        ) : (
          <span
            key={index}
            data-vertical-space={token.kind}
            style={{
              display: "inline-block",
              inlineSize: `${token.advanceEm}em`,
              whiteSpace: "pre",
            }}
          >
            {token.text}
          </span>
        ),
      )}
    </>
  );
}
