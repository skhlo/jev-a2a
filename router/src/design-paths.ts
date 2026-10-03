// The data-path values of a board page, distinct and sorted. Run as a
// script, it lists the paths of the board design's v0.6 pages, the coverage
// set the board page is held to (design/v0.6-paths.txt); the board page test
// reads the rendered page with the same function. The pages are
// jev-a2a/html/board-1440.html, board-peek.html and board-choose.html in
// skhlo/designs at tag jev-a2a-v0.6. To list them again, in router/:
//
//   for page in board-1440 board-peek board-choose; do
//     gh api "repos/skhlo/designs/contents/jev-a2a/html/$page.html?ref=a2af1919f6724c201bdf029131d8c4db985ce3b3" \
//       -H 'Accept: application/vnd.github.raw' > "/tmp/$page.html"
//   done
//   pnpm exec node src/design-paths.ts /tmp/board-*.html > design/v0.6-paths.txt
import { readFileSync } from "node:fs";

const unescape = (value: string): string =>
  value
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

// Every distinct data-path in the page's markup. Scripts, styles and
// comments are not markup: a script that builds a selector names no slot.
export function dataPaths(html: string): string[] {
  const markup = html.replace(
    /<script\b[^]*?<\/script>|<style\b[^]*?<\/style>|<!--[^]*?-->/g,
    "",
  );
  const paths = [...markup.matchAll(/\sdata-path="([^"]*)"/g)].map((m) =>
    unescape(m[1] ?? ""),
  );
  return [...new Set(paths)].sort();
}

if (import.meta.main)
  process.stdout.write(
    dataPaths(
      process.argv
        .slice(2)
        .map((page) => readFileSync(page, "utf8"))
        .join("\n"),
    )
      .map((path) => `${path}\n`)
      .join(""),
  );
