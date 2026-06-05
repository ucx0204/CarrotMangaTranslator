const { DEFAULT_API_KEY } = require("./simple-page-defaults.cjs");
const {
  buildSystemPrompt,
  getOverlayPrompt,
  readPositiveInteger
} = require("./simple-page-prompts.cjs");
const {
  isOpenAICodexProvider,
  resolveConfiguredCodexReasoningEffort
} = require("./simple-page-model-config.cjs");

function buildMessages(options, imageVariants) {
  const promptText = options.promptOverrideText || getOverlayPrompt(options, imageVariants);
  const imageParts = imageVariants.flatMap((variant, index) => ([
    {
      type: "image_url",
      image_url: {
        url: variant.dataUrl
      }
    },
    {
      type: "text",
      text: describeImageVariant(variant, index, options)
    }
  ]));

  return [
    {
      role: "system",
      content: [{ type: "text", text: buildSystemPrompt(options) }]
    },
    {
      role: "user",
      content: [...imageParts, { type: "text", text: promptText }]
    }
  ];
}

function buildResponsesInput(options, imageVariants, promptText = options.promptOverrideText || getOverlayPrompt(options, imageVariants)) {
  const content = imageVariants.flatMap((variant, index) => ([
    {
      type: "input_image",
      image_url: variant.dataUrl,
      detail: "original"
    },
    {
      type: "input_text",
      text: describeImageVariant(variant, index, options)
    }
  ]));

  return [
    {
      role: "user",
      content: [...content, { type: "input_text", text: promptText }]
    }
  ];
}

function describeImageVariant(variant, index, options = {}) {
  const originalWidth = readPositiveInteger(options.imageWidth) || readPositiveInteger(variant.originalWidth);
  const originalHeight = readPositiveInteger(options.imageHeight) || readPositiveInteger(variant.originalHeight);
  const width = readPositiveInteger(variant.width);
  const height = readPositiveInteger(variant.height);
  const sizeText = width && height ? ` It is ${width}x${height} px.` : "";
  const originalSizeText = originalWidth && originalHeight ? ` Original page size is ${originalWidth}x${originalHeight} px.` : "";

  if (variant.role === "openai-vision") {
    return `Image ${index + 1}: the full manga page prepared for OpenAI detail: original vision. Use it as the geometry authority.${sizeText}${originalSizeText}`;
  }

  if (variant.role === "enhanced") {
    return `Image ${index + 1}: the same full manga page rendered as grayscale/high-contrast assist view. Use it only for OCR help, never as the coordinate authority.${sizeText}${originalSizeText}`;
  }

  return `Image ${index + 1}: the original full manga page. Use it as the geometry authority.${sizeText}${originalSizeText}`;
}

function buildChatRequestHeaders(options = {}) {
  const headers = {
    "Content-Type": "application/json"
  };
  if (!isOpenAICodexProvider(options)) {
    headers.Authorization = `Bearer ${DEFAULT_API_KEY}`;
  }
  return headers;
}

function buildChatRequestBodyWithModelResolver(options, messages, maxTokens = options.maxTokens, resolveRequestModelName) {
  if (isOpenAICodexProvider(options)) {
    return {
      model: resolveRequestModelName(options),
      max_tokens: maxTokens,
      reasoning_effort: resolveConfiguredCodexReasoningEffort(options),
      messages
    };
  }

  return {
    model: resolveRequestModelName(options),
    temperature: options.temperature,
    top_p: options.topP,
    top_k: options.topK,
    presence_penalty: 0,
    frequency_penalty: 0,
    max_tokens: maxTokens,
    reasoning_budget: 0,
    enable_thinking: false,
    messages
  };
}

function buildResponsesRequestBodyWithModelResolver(options, imageVariants, promptText, systemPrompt, resolveRequestModelName) {
  return {
    model: resolveRequestModelName(options),
    instructions: systemPrompt || buildSystemPrompt(options),
    input: buildResponsesInput(options, imageVariants, promptText),
    max_output_tokens: options.maxTokens,
    reasoning: {
      effort: resolveConfiguredCodexReasoningEffort(options)
    },
    stream: true,
    store: false
  };
}

module.exports = {
  buildChatRequestBodyWithModelResolver,
  buildChatRequestHeaders,
  buildMessages,
  buildResponsesInput,
  buildResponsesRequestBodyWithModelResolver,
  describeImageVariant
};
