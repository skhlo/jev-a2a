// The data-path values of a board page, distinct and sorted. Run as a
// script, it lists the paths of the board design's v0.13 pages, the coverage
// set the board page is held to (design/v0.13-paths.txt); the board page test
// reads the rendered page with the same function and compares the paths
// with their indexes blanked, as the design's sample is larger than the
// fixture. The fourteen pages are jev-a2a/html/board-1440.html,
// board-1024.html, board-390.html, board-peek.html, board-choose.html,
// board-resolve.html, board-notices.html, board-sheet.html,
// board-sheet-tree.html, board-sheet-closed.html, board-help.html,
// board-usage.html, board-usage-390.html and board-usage-states.html in
// skhlo/designs at tag jev-a2a-v0.13 (commit
// 4a0b0ab27657d1834dccf2b7eae7cb9a548fca97). To list them again, in router/:
//
//   for page in board-1440 board-1024 board-390 board-peek board-choose \
//       board-resolve board-notices board-sheet board-sheet-tree \
//       board-sheet-closed board-help board-usage board-usage-390 \
//       board-usage-states; do
//     gh api "repos/skhlo/designs/contents/jev-a2a/html/$page.html?ref=4a0b0ab27657d1834dccf2b7eae7cb9a548fca97" \
//       -H 'Accept: application/vnd.github.raw' > "/tmp/$page.html"
//   done
//   pnpm exec node src/design-paths.ts /tmp/board-*.html > design/v0.13-paths.txt
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
