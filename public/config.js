// Firebase web config: Firebase Console → Project settings → Your apps → Web app.
// These values are not secrets; access is controlled by Firebase rules and App Check.
export const firebaseConfig = {
  apiKey: "AIzaSyDhMphfnPlstOGUA7XKcaXTSVPopUCQiHY",
  authDomain: "day-planner-test.firebaseapp.com",
  projectId: "day-planner-test",
  storageBucket: "day-planner-test.firebasestorage.app",
  messagingSenderId: "429873993823",
  appId: "1:429873993823:web:24a1d9f1b0aa62cf5163ea",
  measurementId: "G-HVH8G8DV5N",
};

// Gemini model used through Firebase AI Logic (Gemini Developer API, works on the free Spark plan).
export const GEMINI_MODEL = "gemini-3.8-flash";

// Firebase Console → App Check → Apps → web app → reCAPTCHA Enterprise → site key.
// Required when App Check enforcement is on for Firebase AI Logic.
export const RECAPTCHA_ENTERPRISE_SITE_KEY = "";

// Speech recognition language for the microphone.
export const SPEECH_LANG = "uk-UA";

export const isConfigured = !firebaseConfig.apiKey.startsWith("YOUR_");
