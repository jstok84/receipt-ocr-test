import React, { useState } from 'react';
import Tesseract from 'tesseract.js';

function App() {
  const [text, setText] = useState('');
  const [image, setImage] = useState(null);

  const handleFileChange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setImage(URL.createObjectURL(file));
    const result = await Tesseract.recognize(file, 'eng', {
      logger: m => console.log(m),
    });
    setText(result.data.text);
  };

  return (
    <div style={{ padding: '1em' }}>
      <h1>🧾 OCR Receipt Test</h1>
      <input type="file" onChange={handleFileChange} />
      {image && <img src={image} alt="preview" width="300" />}
      <pre>{text}</pre>
    </div>
  );
}

export default App;