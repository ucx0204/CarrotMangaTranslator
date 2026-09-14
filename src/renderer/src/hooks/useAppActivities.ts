import { useEffect, useState } from "react";
import type { AppActivityState } from "../../../shared/appActivityTypes";
import { appGateway } from "../api/appGateway";

export function useAppActivities(): AppActivityState | null {
  const [state, setState] = useState<AppActivityState | null>(null);
  useEffect(() => {
    let disposed = false;
    const apply = (next: AppActivityState) => {
      if (!disposed)
        setState((current) =>
          !current || next.version >= current.version ? next : current,
        );
    };
    const unsubscribe = appGateway.onAppActivities(apply);
    void appGateway
      .getAppActivities()
      .then(apply)
      .catch((error) =>
        console.error("Could not load activity permissions", error),
      );
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);
  return state;
}
