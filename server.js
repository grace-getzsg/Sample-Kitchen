const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

require("dotenv").config();
const health = require("./api/health");
const imports = require("./api/imports");
const port = Number(process.env.PORT || 3000);
const pagePath = path.join(__dirname, "public", "index.html");

const server = http.createServer((request, response) => {
  const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

  if (requestUrl.pathname === "/api/health") {
    health(request, response);
    return;
  }

  if (requestUrl.pathname === "/api/imports") {
    imports(request, response);
    return;
  }

  if (requestUrl.pathname !== "/" && requestUrl.pathname !== "/index.html") {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  fs.readFile(pagePath, (error, content) => {
    if (error) {
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Kitchen Planner page could not be loaded.");
      return;
    }

    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(content);
  });
});

server.listen(port, () => {
  console.log(`Kitchen Planner running at http://localhost:${port}`);
});
