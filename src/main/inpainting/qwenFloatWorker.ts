import { serveInference } from "../runtimeSupport/inferenceUtilityHost";
import { createQwenFloatInference } from "./qwenFloatInference";

serveInference(createQwenFloatInference());
