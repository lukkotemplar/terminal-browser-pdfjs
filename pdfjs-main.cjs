const { app, webContents } = require("electron");
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const PDFJS_ROOT = path.join(
  os.homedir(),
  ".local/share/tb-pdfjs/pdfjs"
);

const LOG_FILE = "/tmp/tb-pdfjs.log";
const PORT_FILE = "/tmp/tb-pdfjs-port";

const jobs = new Map();
const recentRoutes = new Map();

/* ---------------------------------------------------------
 * Logging
 * --------------------------------------------------------- */

function log(message) {
  try {
    fs.appendFileSync(
      LOG_FILE,
      `[${new Date().toISOString()}] ${message}\n`
    );
  } catch {}
}

/* ---------------------------------------------------------
 * MIME types for PDF.js
 * --------------------------------------------------------- */

function mimeType(file) {
  const ext = path.extname(file).toLowerCase();

  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".wasm": "application/wasm",

    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",

    ".properties": "text/plain; charset=utf-8",
    ".ftl": "text/plain; charset=utf-8",

    ".bcmap": "application/octet-stream",

    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
  };

  return types[ext] || "application/octet-stream";
}

/* ---------------------------------------------------------
 * Detect Moodle PDFs
 * --------------------------------------------------------- */

function isMoodlePdf(rawUrl) {
  try {
    const url = new URL(rawUrl);

    return (
      url.hostname === "moodle.upm.es" &&
      /\.pdf$/i.test(url.pathname)
    );
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------
 * Serve PDF using Terminal Browser's own Chromium session
 * --------------------------------------------------------- */

async function servePdf(token, req, res) {
  const job = jobs.get(token);

  if (!job) {
    res.writeHead(404, {
      "Content-Type": "text/plain; charset=utf-8",
    });

    res.end("Unknown PDF token.");
    return;
  }

  try {
    const headers = {
      Accept: "application/pdf,*/*",
      Referer: "https://moodle.upm.es/",
    };

    /*
     * PDF.js sometimes asks for byte ranges.
     * Forward those requests to Moodle.
     */
    if (req.headers.range) {
      headers.Range = req.headers.range;
    }

    /*
     * IMPORTANT:
     *
     * We use wc.session.fetch(), not normal Node fetch().
     *
     * That means the request uses Chromium's network session,
     * including the Moodle session belonging to Terminal Browser.
     */
    const response = await job.session.fetch(job.url, {
      method: "GET",
      redirect: "follow",
      credentials: "include",
      headers,
    });

    const contentType =
      response.headers.get("content-type") || "";

    const arrayBuffer = await response.arrayBuffer();
    const data = Buffer.from(arrayBuffer);

    log(
      `FETCH ${job.url} -> ${response.status} ` +
      `${contentType} (${data.length} bytes)`
    );

    /*
     * Detect the common Moodle-login-page problem.
     */
    const beginsWithPdf =
      data.length >= 5 &&
      data.subarray(0, 5).toString() === "%PDF-";

    const looksLikePdf =
      contentType.toLowerCase().includes("application/pdf") ||
      contentType.toLowerCase().includes("application/octet-stream") ||
      beginsWithPdf ||
      response.status === 206;

    if (!looksLikePdf) {
      res.writeHead(502, {
        "Content-Type": "text/plain; charset=utf-8",
      });

      res.end(
        "Moodle did not return a PDF.\n\n" +
        `HTTP: ${response.status}\n` +
        `Content-Type: ${contentType}\n\n` +
        "Your Moodle login may have expired."
      );

      return;
    }

    const responseHeaders = {
      "Content-Type": "application/pdf",
      "Cache-Control": "no-store",
    };

    const contentRange =
      response.headers.get("content-range");

    const acceptRanges =
      response.headers.get("accept-ranges");

    const contentLength =
      response.headers.get("content-length");

    if (contentRange) {
      responseHeaders["Content-Range"] = contentRange;
    }

    if (acceptRanges) {
      responseHeaders["Accept-Ranges"] = acceptRanges;
    } else {
      responseHeaders["Accept-Ranges"] = "bytes";
    }

    if (contentLength) {
      responseHeaders["Content-Length"] = contentLength;
    } else {
      responseHeaders["Content-Length"] =
        String(data.length);
    }

    res.writeHead(
      response.status === 206 ? 206 : 200,
      responseHeaders
    );

    res.end(data);

  } catch (error) {
    log(`PDF FETCH ERROR: ${error.stack || error}`);

    res.writeHead(500, {
      "Content-Type": "text/plain; charset=utf-8",
    });

    res.end(String(error));
  }
}

/* ---------------------------------------------------------
 * Serve PDF.js static files
 * --------------------------------------------------------- */

function serveStatic(urlPath, res) {
  let relative;

  try {
    relative = decodeURIComponent(
      urlPath.replace(/^\/pdfjs\//, "")
    );
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }

  const root = path.resolve(PDFJS_ROOT);
  const file = path.resolve(PDFJS_ROOT, relative);

  /*
   * Prevent ../ escaping from PDFJS_ROOT.
   */
  if (
    file !== root &&
    !file.startsWith(root + path.sep)
  ) {
    res.writeHead(403);
    res.end();
    return;
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      log(`STATIC 404 ${file}`);

      res.writeHead(404, {
        "Content-Type": "text/plain; charset=utf-8",
      });

      res.end(`Not found: ${relative}`);
      return;
    }

    res.writeHead(200, {
      "Content-Type": mimeType(file),
      "Cache-Control": "no-cache",
    });

    res.end(data);
  });
}

/* ---------------------------------------------------------
 * Understand old AND new Electron navigation event formats
 * --------------------------------------------------------- */

function navigationInfo(args) {
  /*
   * Newer Electron:
   *
   *   event.url
   *   event.isMainFrame
   */
  const first = args[0];

  if (
    first &&
    typeof first === "object" &&
    typeof first.url === "string"
  ) {
    return {
      event: first,
      url: first.url,
      isMainFrame:
        first.isMainFrame === undefined
          ? true
          : first.isMainFrame,
    };
  }

  /*
   * Some APIs may provide a second details object.
   */
  const second = args[1];

  if (
    second &&
    typeof second === "object" &&
    typeof second.url === "string"
  ) {
    return {
      event: first,
      url: second.url,
      isMainFrame:
        second.isMainFrame === undefined
          ? true
          : second.isMainFrame,
    };
  }

  /*
   * Older Electron:
   *
   *   event, url, isInPlace, isMainFrame, ...
   */
  if (typeof second === "string") {
    return {
      event: first,
      url: second,
      isMainFrame:
        typeof args[3] === "boolean"
          ? args[3]
          : true,
    };
  }

  return null;
}

/* ---------------------------------------------------------
 * Main
 * --------------------------------------------------------- */

app.whenReady().then(() => {
  fs.writeFileSync(LOG_FILE, "");

  log("tb-pdfjs starting");
  log(`PDF.js root: ${PDFJS_ROOT}`);

  if (
    !fs.existsSync(
      path.join(PDFJS_ROOT, "web", "viewer.html")
    )
  ) {
    log("ERROR: PDF.js viewer.html not found");
  }

  const server = http.createServer(
    async (req, res) => {
      try {
        const requestUrl = new URL(
          req.url,
          "http://127.0.0.1"
        );

        if (requestUrl.pathname === "/pdf") {
          const token =
            requestUrl.searchParams.get("token");

          return await servePdf(
            token,
            req,
            res
          );
        }

        if (
          requestUrl.pathname.startsWith(
            "/pdfjs/"
          )
        ) {
          return serveStatic(
            requestUrl.pathname,
            res
          );
        }

        res.writeHead(404);
        res.end();

      } catch (error) {
        log(`SERVER ERROR: ${error.stack || error}`);

        res.writeHead(500);
        res.end(String(error));
      }
    }
  );

  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;

    fs.writeFileSync(
      PORT_FILE,
      String(port)
    );

    log(`PDF.js server listening on ${port}`);

    function routePdf(wc, pdfUrl) {
      if (!isMoodlePdf(pdfUrl)) {
        return;
      }

      /*
       * Multiple Electron navigation events can describe
       * the same navigation. Avoid redirecting repeatedly.
       */
      const routeKey =
        `${wc.id}:${pdfUrl}`;

      const previous =
        recentRoutes.get(routeKey) || 0;

      if (
        Date.now() - previous < 3000
      ) {
        return;
      }

      recentRoutes.set(
        routeKey,
        Date.now()
      );

      const token =
        crypto.randomUUID();

      jobs.set(token, {
        url: pdfUrl,
        session: wc.session,
      });

      /*
       * Keep tokens around for one hour.
       */
      setTimeout(() => {
        jobs.delete(token);
      }, 60 * 60 * 1000);

      const pdfProxy =
        `http://127.0.0.1:${port}` +
        `/pdf?token=${encodeURIComponent(token)}`;

      const viewer =
        `http://127.0.0.1:${port}` +
        `/pdfjs/web/viewer.html?file=` +
        encodeURIComponent(pdfProxy);

      log(`PDF DETECTED: ${pdfUrl}`);
      log(`REDIRECT -> ${viewer}`);

      try {
        wc.stop();
      } catch {}

      /*
       * Do it on the next event loop tick so we don't
       * fight Chromium's currently-running navigation.
       */
      setTimeout(() => {
        if (wc.isDestroyed()) {
          return;
        }

        wc.loadURL(viewer).catch(error => {
          log(
            `loadURL ERROR: ` +
            `${error.stack || error}`
          );
        });
      }, 0);
    }

    function attach(wc) {
      if (
        !wc ||
        wc.isDestroyed() ||
        wc.__tbPdfJsAttached
      ) {
        return;
      }

      wc.__tbPdfJsAttached = true;

      log(
        `ATTACH webContents=${wc.id} ` +
        `type=${wc.getType?.() || "unknown"} ` +
        `url=${wc.getURL?.() || ""}`
      );

      /*
       * Normal link navigation.
       */
      wc.on("will-navigate", (...args) => {
        const nav = navigationInfo(args);

        if (
          !nav ||
          !nav.isMainFrame ||
          !isMoodlePdf(nav.url)
        ) {
          return;
        }

        log(
          `will-navigate PDF: ${nav.url}`
        );

        if (
          nav.event &&
          typeof nav.event.preventDefault ===
            "function"
        ) {
          nav.event.preventDefault();
        }

        routePdf(wc, nav.url);
      });

      /*
       * Frames, including main frame.
       */
      wc.on(
        "will-frame-navigate",
        (...args) => {
          const nav =
            navigationInfo(args);

          if (
            !nav ||
            !nav.isMainFrame ||
            !isMoodlePdf(nav.url)
          ) {
            return;
          }

          log(
            `will-frame-navigate PDF: ` +
            nav.url
          );

          if (
            nav.event &&
            typeof nav.event.preventDefault ===
              "function"
          ) {
            nav.event.preventDefault();
          }

          routePdf(wc, nav.url);
        }
      );

      /*
       * IMPORTANT:
       *
       * This one also sees programmatic navigation such
       * as webContents.loadURL(), which will-navigate does
       * not necessarily see.
       */
      wc.on(
        "did-start-navigation",
        (...args) => {
          const nav =
            navigationInfo(args);

          if (
            !nav ||
            !nav.isMainFrame ||
            !isMoodlePdf(nav.url)
          ) {
            return;
          }

          log(
            `did-start-navigation PDF: ` +
            nav.url
          );

          routePdf(wc, nav.url);
        }
      );

      /*
       * Catch server-side redirects to a PDF.
       */
      wc.on(
        "will-redirect",
        (...args) => {
          const nav =
            navigationInfo(args);

          if (
            !nav ||
            !nav.isMainFrame ||
            !isMoodlePdf(nav.url)
          ) {
            return;
          }

          log(
            `will-redirect PDF: ${nav.url}`
          );

          if (
            nav.event &&
            typeof nav.event.preventDefault ===
              "function"
          ) {
            nav.event.preventDefault();
          }

          routePdf(wc, nav.url);
        }
      );

      /*
       * Last-resort fallback. If the PDF already loaded,
       * replace it afterwards.
       */
      wc.on(
        "did-navigate",
        (...args) => {
          let url = null;

          if (
            args[0] &&
            typeof args[0] === "object" &&
            typeof args[0].url === "string"
          ) {
            url = args[0].url;
          } else if (
            typeof args[1] === "string"
          ) {
            url = args[1];
          }

          if (
            url &&
            isMoodlePdf(url)
          ) {
            log(
              `did-navigate PDF fallback: ${url}`
            );

            routePdf(wc, url);
          }
        }
      );
    }

    /*
     * Attach to WebContents that already exist.
     */
    for (
      const wc of
      webContents.getAllWebContents()
    ) {
      attach(wc);
    }

    /*
     * Attach to newly-created ones.
     */
    app.on(
      "web-contents-created",
      (_event, wc) => {
        attach(wc);
      }
    );

    /*
     * Terminal Browser can create WebContents before our
     * event handler sees them, so periodically check too.
     */
    const timer = setInterval(() => {
      for (
        const wc of
        webContents.getAllWebContents()
      ) {
        attach(wc);
      }
    }, 250);

    app.on("before-quit", () => {
      clearInterval(timer);
      server.close();
    });
  });
});
