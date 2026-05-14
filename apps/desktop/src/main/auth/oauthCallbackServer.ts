import { createServer } from "node:http";

export async function awaitOAuthCode(port: number, pathname: string, timeoutMs: number): Promise<{ code: string; state: string }> {
  return new Promise((resolve, reject) => {
    const callbackUrl = `http://127.0.0.1:${port}${pathname}`;
    const timer = setTimeout(() => {
      server.close();
      reject(new Error(`OAuth callback timed out. Confirm the browser completed sign-in and that ${callbackUrl} is allowed in Supabase Auth redirect URLs.`));
    }, timeoutMs);

    const server = createServer((request, response) => {
      if (!request.url) {
        response.statusCode = 400;
        response.end("Missing request URL.");
        return;
      }

      const url = new URL(request.url, `http://localhost:${port}`);
      if (url.pathname !== pathname) {
        response.statusCode = 404;
        response.end("Not found.");
        return;
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        clearTimeout(timer);
        response.statusCode = 400;
        response.end(`Authorization failed: ${error}`);
        server.close();
        reject(new Error(`Authorization failed: ${error}`));
        return;
      }

      if (!code || !state) {
        response.statusCode = 400;
        response.end("Missing authorization code.");
        return;
      }

      clearTimeout(timer);
      response.statusCode = 200;
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end("<html><body><h2>Listen connected successfully.</h2><p>You can return to the app.</p></body></html>");
      server.close();
      resolve({ code, state });
    });

    server.listen(port, () => undefined);
    server.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
