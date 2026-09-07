/**
 * A same-origin front door for the local browser suite.
 *
 * The browser has to see one origin — the cookies are same-site and host-only
 * and the server refuses an unexpected Origin — and in development that came
 * from Next's dev rewrite. Using the dev server also means shipping an
 * unminified bundle, and hydrating it on a loaded machine can delay the
 * WebSocket `hello` past the server's five-second budget, closing the socket
 * with 4400 and costing the page every event after it.
 *
 * So this terminates TLS once and routes by path, exactly as
 * `infra/docker/ingress.conf` does in production: `/v1` to the API, everything
 * else to a *built* Next server. That removes the dev bundle from the picture
 * and makes the local run resemble the deployment it is evidence about.
 *
 * WebSocket upgrades are forwarded explicitly. A reverse proxy that carries
 * HTTP and silently drops the upgrade is the worst kind: everything looks
 * healthy and the room simply never updates.
 */
import { createServer as createHttpsServer } from "node:https";
import { connect } from "node:net";
import { request } from "node:http";

const API_PREFIX = "/v1/";

function target(url, apiPort, webPort) {
  return url.startsWith(API_PREFIX) ? apiPort : webPort;
}

export function createIngress({ key, cert, apiPort, webPort }) {
  const server = createHttpsServer({ key, cert }, (incoming, outgoing) => {
    const port = target(incoming.url ?? "/", apiPort, webPort);
    const forwarded = request({
      host: "127.0.0.1",
      port,
      path: incoming.url,
      method: incoming.method,
      headers: {
        ...incoming.headers,
        // The upstreams decide policy from these, so they have to describe the
        // front door rather than the hop.
        "x-forwarded-proto": "https",
        "x-forwarded-for": incoming.socket.remoteAddress ?? "127.0.0.1",
      },
    }, (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    });
    forwarded.on("error", () => {
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end();
    });
    incoming.pipe(forwarded);
  });

  server.on("upgrade", (incoming, socket, head) => {
    const port = target(incoming.url ?? "/", apiPort, webPort);
    // The client socket is already flowing when this fires, and connecting
    // upstream is asynchronous. Without pausing, anything the client sends in
    // that window is emitted with no listener and lost — and the first thing a
    // room client sends is its `hello`, whose absence the server answers five
    // seconds later with `4400 hello required`. The room then looks broken for
    // a reason that is entirely this proxy's.
    socket.pause();
    const upstream = connect(port, "127.0.0.1", () => {
      const lines = [`${incoming.method} ${incoming.url} HTTP/1.1`];
      for (const [name, value] of Object.entries(incoming.headers)) {
        for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`);
      }
      lines.push("x-forwarded-proto: https", "", "");
      upstream.write(lines.join("\r\n"));
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
      socket.resume();
    });
    const drop = () => { try { socket.destroy(); } catch { /* already gone */ } };
    upstream.on("error", drop);
    socket.on("error", () => { try { upstream.destroy(); } catch { /* already gone */ } });
  });

  return server;
}
