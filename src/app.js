import React, { useState } from "react";
import Tesseract from "tesseract.js";

export default function App() {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);

  const handleImageUpload = async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    setLoading(true);
    setText("Processing OCR...");

    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const result = await Tesseract.recognize(reader.result, "slv", {
          logger: (m) => console.log(m),
        });
        setText(result.data.text);
      } catch (err) {
        setText("Error during OCR");
        console.error(err);
      }
      setLoading(false);
    };
    reader.readAsDataURL(file);
  };

  return (
    <div style={{ padding: "2rem", fontFamily: "sans-serif" }}>
      <h2>🧾 Receipt OCR Test</h2>
      <input type="file" accept="image/*,.pdf" onChange={handleImageUpload} />
      <p>{loading ? "Recognizing..." : text}</p>
    </div>
  );
}
