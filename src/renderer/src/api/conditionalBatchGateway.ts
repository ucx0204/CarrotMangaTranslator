import { createMangaDomainGateway } from "./mangaGateway";

export const conditionalBatchGateway = createMangaDomainGateway(
  "ConditionalBatch",
  [
    "deleteConditionalBatchScheme",
    "deleteConditionalBatchSequence",
    "exportConditionalBatchYaml",
    "importConditionalBatchYaml",
    "listConditionalBatchSchemes",
    "openConditionalBatchYamlFile",
    "saveConditionalBatchYamlFile",
    "saveConditionalBatchScheme",
    "saveConditionalBatchSequence",
  ] as const,
);
