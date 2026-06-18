// @ts-check
function parseResponsesSseText(rawText) {
  const deltas = [];
  let rawResponse = null;
  let eventCount = 0;

  for (const block of rawText.split(/\r?\n\r?\n/)) {
    const dataLines = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length === 0) {
      continue;
    }

    const data = dataLines.join("\n");
    if (!data || data === "[DONE]") {
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch (_error) {
      continue;
    }
    eventCount += 1;

    if (
      parsed?.type === "response.output_text.delta" &&
      typeof parsed.delta === "string"
    ) {
      deltas.push(parsed.delta);
      continue;
    }

    if (
      (parsed?.type === "response.completed" ||
        parsed?.type === "response.incomplete") &&
      parsed.response
    ) {
      rawResponse = parsed.response;
      continue;
    }

    const nestedOutput = extractModelOutputText(parsed);
    if (nestedOutput) {
      deltas.push(nestedOutput);
    }
  }

  return {
    outputText: deltas.join(""),
    rawResponse,
    eventCount,
  };
}

function extractModelOutputText(parsed) {
  if (typeof parsed?.output_text === "string") {
    return parsed.output_text.trim();
  }

  const chatContent = parsed?.choices?.[0]?.message?.content;
  if (typeof chatContent === "string") {
    return chatContent.trim();
  }
  if (Array.isArray(chatContent)) {
    return chatContent
      .map((item) => item?.text || "")
      .join("\n")
      .trim();
  }

  if (!Array.isArray(parsed?.output)) {
    return "";
  }

  const parts = [];
  for (const item of parsed.output) {
    if (typeof item?.content === "string") {
      parts.push(item.content);
      continue;
    }
    if (!Array.isArray(item?.content)) {
      continue;
    }
    for (const content of item.content) {
      if (typeof content?.text === "string") {
        parts.push(content.text);
      }
    }
  }

  return parts.join("\n").trim();
}

function extractModelOutputFailure(parsed) {
  const choice = parsed?.choices?.[0];
  const refusal = choice?.message?.refusal;
  if (typeof refusal === "string" && refusal.trim()) {
    return {
      message: `모델이 요청을 거부했습니다: ${truncateInline(refusal, 500)}`,
      failureCategory: "model-refusal",
      nonRetriable: true,
    };
  }

  if (choice?.finish_reason === "length") {
    return {
      message:
        "모델 응답이 max_tokens 제한으로 잘렸습니다. 최대 출력 토큰을 늘리거나 요청 설정을 조정하세요.",
      failureCategory: "empty-model-response",
    };
  }

  if (choice?.finish_reason === "content_filter") {
    return {
      message: "모델 응답이 content_filter로 차단되었습니다.",
      failureCategory: "model-refusal",
      nonRetriable: true,
    };
  }

  if (hasReasoningOnlyPayload(parsed)) {
    return {
      message:
        "모델이 최종 content 없이 reasoning/thoughts만 반환했습니다. reasoning_effort 또는 extra body 설정을 조정하세요.",
      failureCategory: "empty-model-response",
      nonRetriable: true,
    };
  }

  return null;
}

function hasReasoningOnlyPayload(parsed) {
  const message = parsed?.choices?.[0]?.message;
  if (hasReasoningText(message)) {
    return true;
  }
  if (hasReasoningText(parsed)) {
    return true;
  }
  if (!Array.isArray(parsed?.output)) {
    return false;
  }
  let sawReasoning = false;
  let sawText = false;
  for (const item of parsed.output) {
    if (item?.type === "reasoning") {
      sawReasoning = true;
    }
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (typeof part?.text === "string" && part.text.trim()) {
        sawText = true;
      }
      if (
        part?.type === "reasoning" ||
        typeof part?.reasoning === "string" ||
        typeof part?.thoughts === "string"
      ) {
        sawReasoning = true;
      }
    }
  }
  return sawReasoning && !sawText;
}

function hasReasoningText(value) {
  if (!value || typeof value !== "object") {
    return false;
  }
  return [
    value.reasoning,
    value.reasoning_content,
    value.thoughts,
    value.thinking,
  ].some((item) => typeof item === "string" && item.trim());
}

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
