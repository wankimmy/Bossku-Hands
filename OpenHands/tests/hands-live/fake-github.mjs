/**
 * A tiny fake of the GitHub REST calls Bossku Hands makes, for live tests.
 *   node fake-github.mjs <port> <owner>/<repo> <bare repo dir> <token>
 * Admin: GET /admin/state, POST /admin/merge. Binds 127.0.0.1 only.
 */
import { execFileSync } from "node:child_process";
import http from "node:http";

const [port, slug, bareDir, token] = process.argv.slice(2);
const base = `/repos/${slug}`;
const state = { pulls: [], merged: false, requests: [], badAuth: 0 };

const headSha = (ref) => {
  try {
    return execFileSync("git", ["--git-dir", bareDir, "rev-parse", `refs/heads/${ref}`], {
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
};

http
  .createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      const send = (code, body) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === "/admin/state") return send(200, state);
      if (url.pathname === "/admin/merge") {
        state.merged = true;
        return send(200, { merged: true });
      }
      state.requests.push(`${req.method} ${url.pathname}`);
      if (req.headers.authorization !== `Bearer ${token}`) state.badAuth += 1;
      if (req.method === "GET" && url.pathname === `${base}/pulls`) {
        const head = url.searchParams.get("head")?.split(":")[1];
        return send(200, state.pulls.filter((p) => p.head.ref === head && p.state === "open"));
      }
      if (req.method === "POST" && url.pathname === `${base}/pulls`) {
        const body = JSON.parse(raw);
        const number = state.pulls.length + 1;
        const pull = {
          number,
          html_url: `https://github.com/${slug}/pull/${number}`,
          head: { ref: body.head },
          base: { ref: body.base },
          title: body.title,
          body: body.body,
          draft: body.draft,
          state: "open",
        };
        state.pulls.push(pull);
        return send(201, pull);
      }
      const match = url.pathname.match(new RegExp(`^${base}/pulls/(\\d+)$`));
      if (req.method === "GET" && match) {
        const pull = state.pulls[Number(match[1]) - 1];
        if (!pull) return send(404, { message: "not found" });
        return send(200, {
          ...pull,
          state: state.merged ? "closed" : "open",
          merged: state.merged,
          head: { ...pull.head, sha: headSha(pull.head.ref) },
        });
      }
      if (req.method === "GET" && /\/commits\/[0-9a-f]+\/check-runs$/.test(url.pathname)) {
        return send(200, {
          total_count: 1,
          check_runs: [
            { id: 1, name: "unit-tests", status: "completed", conclusion: "success", app: { slug: "github-actions" } },
          ],
        });
      }
      send(404, { message: "not found" });
    });
  })
  .listen(Number(port), "127.0.0.1", () => console.log(`fake GitHub on ${port}`));
