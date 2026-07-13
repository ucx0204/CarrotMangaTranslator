import React from "react";
import {
  UnifiedRightRail,
  type UnifiedRightRailProps,
} from "./rightRailPanels";

type AppRightRailProps = UnifiedRightRailProps;

// The text-block editor is rendered by EditorPanelContainer, which reads the
// selected block and edit actions from the panel session context rather than
// from these rail props.
export function AppRightRail(props: AppRightRailProps): React.JSX.Element {
  return (
    <aside className="right-rail">
      <UnifiedRightRail {...props} />
    </aside>
  );
}
