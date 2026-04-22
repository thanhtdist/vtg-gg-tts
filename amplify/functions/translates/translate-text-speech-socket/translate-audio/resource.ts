import { defineFunction, secret } from "@aws-amplify/backend";

/**
 * This function creates a meeting for starting a live audio stream by the host.
 */
export const translateAudio = defineFunction({
  name: "translate-audio", // Lamda function name is used to create in the cloud
  entry: "./handler.ts", // Path to the handler file to make business logic
  environment: {
    // Environment variables that will be available during function execution
    GOOGLE_TTS_API_KEY: secret('GOOGLE_TTS_API_KEY'),
  }
});