import http from "node:http";
import { renderDashboard } from "./render.mjs";

export function createDashboardServer(options = {}) {
  const dataProvider = options.dataProvider;
  if (typeof dataProvider !== "function") {
    throw new TypeError("dataProvider must be a function");
  }

  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  const maxResponseBytes = options.maxResponseBytes ?? 2_000_000;
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? host}`);
      if (!["GET", "HEAD"].includes(request.method ?? "")) {
        response.writeHead(405, { Allow: "GET, HEAD" });
        response.end();
        return;
      }
      if (url.pathname === "/healthz") {
        write(response, request.method, 200, "text/plain; charset=utf-8", "ok\n");
        return;
      }
      if (url.pathname !== "/") {
        write(response, request.method, 404, "text/plain; charset=utf-8", "Not found\n");
        return;
      }

      const { html, nonce } = renderDashboard(await dataProvider(), options.render);
      if (Buffer.byteLength(html) > maxResponseBytes) {
        throw new RangeError("Rendered dashboard exceeds response size limit");
      }
      response.setHeader(
        "Content-Security-Policy",
        `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      );
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("X-Frame-Options", "DENY");
      response.setHeader("Cache-Control", "no-store");
      write(response, request.method, 200, "text/html; charset=utf-8", html);
    } catch {
      write(
        response,
        request.method,
        500,
        "text/plain; charset=utf-8",
        "Dashboard unavailable\n",
      );
    }
  });

  return {
    server,
    host,
    port,
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve(server.address());
        });
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function write(response, method, status, contentType, body) {
  response.statusCode = status;
  response.setHeader("Content-Type", contentType);
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(method === "HEAD" ? undefined : body);
}
