// @ts-check

/** @typedef {Record<string, unknown>} JsonRecord */
/** @typedef {{ outputText: string; rawResponse: unknown; eventCount: number }} ParsedSseResponse */

/**
 * @param {string} rawText
 * @returns {ParsedSseResponse}
 */
function parseResponsesSseText(rawText) {
  const state = {
    deltas: /** @type {string[]} */ ([]),
    rawResponse: /** @type {unknown} */ (null),
    eventCount: 0,
  };
  for (const data of collectSseData(rawText)) {
    const parsed = parseJsonRecord(data);
    if (!parsed) {
      continue;
    }
    state.eventCount += 1;
    applySseEvent(state, parsed);
  }
  return {
    outputText: state.deltas.join(""),
    rawResponse: state.rawResponse,
    eventCount: state.eventCount,
  };
}

/** @param {string} rawText @returns {string[]} */
function collectSseData(rawText) {
  const values = [];
  for (const block of rawText.split(/\r?\n\r?\n/)) {
    const lines = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());
    const data = lines.join("\n");
    if (data && data !== "[DONE]") {
      values.push(data);
    }
  }
  return values;
}

/** @param {string} value @returns {JsonRecord | null} */
function parseJsonRecord(value) {
  try {
    return asRecord(JSON.parse(value));
  } catch (_error) {
    return null;
  }
}

/**
 * @param {{ deltas: string[]; rawResponse: unknown; eventCount: number }} state
 * @param {JsonRecord} event
 */
function applySseEvent(state, event) {
  if (
    event.type === "response.output_text.delta" &&
    typeof event.delta === "string"
  ) {
    state.deltas.push(event.delta);
    return;
  }
  if (isCompletedResponseEvent(event) && event.response) {
    state.rawResponse = event.response;
    return;
  }
  const nestedOutput = extractModelOutputText(event);
  if (nestedOutput) {
    state.deltas.push(nestedOutput);
  }
}

/** @param {JsonRecord} event @returns {boolean} */
function isCompletedResponseEvent(event) {
  return (
    event.type === "response.completed" || event.type === "response.incomplete"
  );
}

/** @param {unknown} parsed @returns {string} */
function extractModelOutputText(parsed) {
  const record = asRecord(parsed);
  if (!record) {
    return "";
  }
  if (typeof record.output_text === "string") {
    return record.output_text.trim();
  }
  const chatText = extractChatMessageText(record);
  return chatText !== null ? chatText : extractResponseOutputText(record);
}

/** @param {JsonRecord} parsed @returns {string | null} */
function extractChatMessageText(parsed) {
  const content = readChoiceMessage(parsed)?.content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return null;
  }
  return content
    .map((item) => {
      const text = asRecord(item)?.text;
      return text === null || text === undefined ? "" : String(text);
    })
    .join("\n")
    .trim();
}

/** @param {JsonRecord} parsed @returns {string} */
function extractResponseOutputText(parsed) {
  if (!Array.isArray(parsed.output)) {
    return "";
  }
  const parts = /** @type {string[]} */ ([]);
  for (const rawItem of parsed.output) {
    appendOutputItemText(parts, asRecord(rawItem));
  }
  return parts.join("\n").trim();
}

/** @param {string[]} parts @param {JsonRecord | null} item */
function appendOutputItemText(parts, item) {
  if (!item) {
    return;
  }
  if (typeof item.content === "string") {
    parts.push(item.content);
    return;
  }
  if (!Array.isArray(item.content)) {
    return;
  }
  for (const rawContent of item.content) {
    const text = asRecord(rawContent)?.text;
    if (typeof text === "string") {
      parts.push(text);
    }
  }
}

/**
 * @param {unknown} parsed
 * @returns {{ message: string; failureCategory: string; nonRetriable?: boolean; outputTruncated?: boolean } | null}
 */
function extractModelOutputFailure(parsed) {
  const record = asRecord(parsed);
  if (!record) {
    return null;
  }
  const responsesFailure = extractResponsesOutputFailure(record);
  if (responsesFailure) {
    return responsesFailure;
  }
  const choice = readFirstChoice(record);
  const refusal = readChoiceMessage(record)?.refusal;
  if (typeof refusal === "string" && refusal.trim()) {
    return modelRefusalFailure(refusal);
  }
  if (choice?.finish_reason === "length") {
    return {
      message:
        "모델 응답이 max_tokens 제한으로 잘렸습니다. 최대 출력 토큰을 늘리거나 요청 설정을 조정하세요.",
      failureCategory: "empty-model-response",
      outputTruncated: true,
    };
  }
  if (choice?.finish_reason === "content_filter") {
    return {
      message: "모델 응답이 content_filter로 차단되었습니다.",
      failureCategory: "model-refusal",
      nonRetriable: true,
    };
  }
  return hasReasoningOnlyPayload(record) ? reasoningOnlyFailure() : null;
}

/**
 * Accept both a Responses API response object and a raw response.incomplete
 * event so every transport can share the same truncation classification.
 *
 * @param {JsonRecord} parsed
 * @returns {{ message: string; failureCategory: string; outputTruncated: true } | null}
 */
function extractResponsesOutputFailure(parsed) {
  const response =
    parsed.type === "response.incomplete"
      ? (asRecord(parsed.response) ?? parsed)
      : parsed;
  const details = asRecord(response.incomplete_details);
  if (
    (response.status === "incomplete" ||
      parsed.type === "response.incomplete") &&
    details?.reason === "max_output_tokens"
  ) {
    return {
      message:
        "모델 응답이 max_output_tokens 제한으로 잘렸습니다. 최대 출력 토큰을 늘리거나 요청 설정을 조정하세요.",
      failureCategory: "empty-model-response",
      outputTruncated: true,
    };
  }
  return null;
}

/** @param {string} refusal */
function modelRefusalFailure(refusal) {
  return {
    message: `모델이 요청을 거부했습니다: ${truncateInline(refusal, 500)}`,
    failureCategory: "model-refusal",
    nonRetriable: true,
  };
}

function reasoningOnlyFailure() {
  return {
    message:
      "모델이 최종 content 없이 reasoning/thoughts만 반환했습니다. reasoning_effort 또는 extra body 설정을 조정하세요.",
    failureCategory: "empty-model-response",
    nonRetriable: true,
  };
}

/** @param {JsonRecord} parsed @returns {boolean} */
function hasReasoningOnlyPayload(parsed) {
  if (extractChatMessageText(parsed)?.trim()) {
    return false;
  }
  if (hasReasoningText(readChoiceMessage(parsed)) || hasReasoningText(parsed)) {
    return true;
  }
  if (!Array.isArray(parsed.output)) {
    return false;
  }
  const evidence = parsed.output.reduce(
    (state, item) => collectReasoningEvidence(state, asRecord(item)),
    { reasoning: false, text: false },
  );
  return evidence.reasoning && !evidence.text;
}

/**
 * @param {{ reasoning: boolean; text: boolean }} state
 * @param {JsonRecord | null} item
 */
function collectReasoningEvidence(state, item) {
  if (!item) {
    return state;
  }
  state.reasoning ||= item.type === "reasoning";
  const content = Array.isArray(item.content) ? item.content : [];
  for (const rawPart of content) {
    const part = asRecord(rawPart);
    if (!part) {
      continue;
    }
    state.text ||= typeof part.text === "string" && Boolean(part.text.trim());
    state.reasoning ||= isReasoningPart(part);
  }
  return state;
}

/** @param {JsonRecord} part */
function isReasoningPart(part) {
  return (
    part.type === "reasoning" ||
    typeof part.reasoning === "string" ||
    typeof part.thoughts === "string"
  );
}

/** @param {unknown} value @returns {boolean} */
function hasReasoningText(value) {
  const record = asRecord(value);
  if (!record) {
    return false;
  }
  return [
    record.reasoning,
    record.reasoning_content,
    record.thoughts,
    record.thinking,
  ].some((item) => typeof item === "string" && Boolean(item.trim()));
}

/** @param {JsonRecord} parsed @returns {JsonRecord | null} */
function readFirstChoice(parsed) {
  return Array.isArray(parsed.choices) ? asRecord(parsed.choices[0]) : null;
}

/** @param {JsonRecord} parsed @returns {JsonRecord | null} */
function readChoiceMessage(parsed) {
  return asRecord(readFirstChoice(parsed)?.message);
}

/** @param {unknown} value @returns {JsonRecord | null} */
function asRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? /** @type {JsonRecord} */ (value)
    : null;
}

/** @param {unknown} value @param {number} maxLength @returns {string} */
function truncateInline(value, maxLength) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}...`;
}

module.exports = {
  extractModelOutputFailure,
  extractModelOutputText,
  parseResponsesSseText,
};
