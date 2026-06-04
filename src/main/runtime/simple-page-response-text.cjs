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
    } catch {
      continue;
    }
    eventCount += 1;

    if (parsed?.type === "response.output_text.delta" && typeof parsed.delta === "string") {
      deltas.push(parsed.delta);
      continue;
    }

    if ((parsed?.type === "response.completed" || parsed?.type === "response.incomplete") && parsed.response) {
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
    eventCount
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
    return chatContent.map((item) => item?.text || "").join("\n").trim();
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

module.exports = {
  extractModelOutputText,
  parseResponsesSseText
};
