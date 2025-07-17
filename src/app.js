import React, { useState } from "react";
import Tesseract from "tesseract.js";

export default function App() {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);

  const handleImageUpload = async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    setLoading(true);
    setText("Reading text...");

    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const result = await Tesseract.recognize(reader.result, "eng", {
          logger: (m) => console.log(m), // Optional: logs progress to console
        });
        setText(result.data.text);
      } catch (error) {
        setText("Error during OCR!");
        console.error(error);
      } finally {
        setLoading(false);
      }
    };
    reader.readAsDataURL(file);
  };

  return (
    <div style={{ padding: "2rem", fontFamily: "sans-serif" }}>
      <h1>🧾 Receipt OCR Test</h1>
      <input type="file" accept="image/*" onChange={handleImageUpload} />
      <p>{loading ? "Processing OCR..." : text}</p>
    </div>
  );
}
