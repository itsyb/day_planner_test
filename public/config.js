// Firebase web config: Firebase Console → Project settings → Your apps → Web app.
// These values are not secrets; access is controlled by Firebase rules and App Check.
export const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.firebasestorage.app",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID",
};

// Gemini model used through Firebase AI Logic (Gemini Developer API, works on the free Spark plan).
export const GEMINI_MODEL = "gemini-3.8-flash";

// Speech recognition language for the microphone.
export const SPEECH_LANG = "uk-UA";

export const isConfigured = !firebaseConfig.apiKey.startsWith("YOUR_");
