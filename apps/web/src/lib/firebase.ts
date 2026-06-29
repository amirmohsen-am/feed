import { initializeApp, getApps } from "firebase/app";

const firebaseConfig = {
  apiKey: "AIzaSyDTWNJ0j4Wd6l9qRGDqOufu1ILy9FGZHOM",
  authDomain: "timelines-492720.firebaseapp.com",
  projectId: "timelines-492720",
  storageBucket: "timelines-492720.firebasestorage.app",
  messagingSenderId: "777152549518",
  appId: "1:777152549518:web:9c8e4bfdebe07373de2fdf",
  measurementId: "G-72NL4ZF268",
};

export const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
