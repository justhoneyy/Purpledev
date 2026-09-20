PRIVATE - do not upload this folder to a public GitHub repo (it is your readable code).

src/index.html, src/admin.html   your original, readable pages. Edit these when you want to change the design/logic.
build.mjs                        turns them into the protected files.

Rebuild after editing:
  npm i esbuild
  node build.mjs
Then copy   dist/index.html, dist/admin.html   and   dist/assets/*.js   into your website repo (replace the old ones).
server.js does not change.
