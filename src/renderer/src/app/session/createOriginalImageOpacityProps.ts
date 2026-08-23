import type { AppWorkspaceProps } from "../../components/appWorkspaceTypes";
import { isOriginalImageOpacityAvailable } from "../../lib/originalImageOpacity";
import type { AppSessionViewModel } from "./appSessionViewModel";

type OriginalImageOpacityProps = Pick<
  AppWorkspaceProps,
  | "onChangeOriginalImageOpacity"
  | "originalImageOpacity"
  | "originalImageOpacityAvailable"
>;

export function createOriginalImageOpacityProps({
  derivedState,
  uiState,
}: Pick<
  AppSessionViewModel,
  "derivedState" | "uiState"
>): OriginalImageOpacityProps {
  const selectedPageId = derivedState.selectedPage?.id ?? null;
  return {
    originalImageOpacity: selectedPageId
      ? (uiState.originalImageOpacityByPage[selectedPageId] ?? 0)
      : 0,
    originalImageOpacityAvailable: isOriginalImageOpacityAvailable({
      selectedPage: derivedState.selectedPage,
      selectedPageImageDataUrl: derivedState.selectedPageImageDataUrl,
      selectedPageImageDataUrlPageId:
        derivedState.selectedPageImageDataUrlPageId,
      selectedPageOriginalImageDataUrl:
        derivedState.selectedPageOriginalImageDataUrl,
      selectedPageOriginalImageDataUrlPageId:
        derivedState.selectedPageOriginalImageDataUrlPageId,
    }),
    onChangeOriginalImageOpacity: (opacity) => {
      if (selectedPageId) {
        uiState.setOriginalImageOpacityForPage(selectedPageId, opacity);
      }
    },
  };
}
