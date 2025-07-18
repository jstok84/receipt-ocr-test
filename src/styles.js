const styles = {
  container: {
    padding: "1rem",
    fontFamily: "sans-serif",
    maxWidth: "600px",
    margin: "auto",
  },
  header: {
    fontSize: "1.5rem",
    textAlign: "center",
    marginBottom: "1rem",
  },
  controls: {
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
    marginBottom: "1rem",
  },
  input: {
    fontSize: "1rem",
  },
  button: {
    padding: "0.75rem",
    fontSize: "1rem",
    backgroundColor: "#007bff",
    color: "white",
    border: "none",
    borderRadius: "6px",
    cursor: "pointer",
  },
  videoPreview: {
    width: "100%",
    maxHeight: "300px",
    borderRadius: "8px",
    objectFit: "cover",
    marginTop: "1rem",
  },
  textarea: {
    width: "100%",
    height: "180px",
    marginTop: "1rem",
    fontSize: "1rem",
  },
  parsedSection: {
    marginTop: "2rem",
  },
};

export default styles;
