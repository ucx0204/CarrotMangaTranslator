import { createMangaDomainGateway } from "./mangaGateway";
export const pageWorkflowGateway = createMangaDomainGateway("PageWorkflow", [
  "preflightPageWorkflow",
  "startPageWorkflow",
  "getPageWorkflowRun",
]);
