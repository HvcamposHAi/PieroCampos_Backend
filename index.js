const http = require("http");
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "PieroCampos Backend" }));
    return;
  }
  res.writeHead(200);
  res.end("PieroCampos Backend rodando");
});

server.listen(PORT, () => {
  console.log("Servidor rodando na porta " + PORT);
});