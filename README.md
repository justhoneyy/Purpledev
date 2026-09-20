# purple dev — site + admin panel

A portfolio site with a private admin panel. Everything is in a few files:

```
server.js      Express API, Google sign-in, PostgreSQL (tables are created automatically)
index.html     the public site (loads its content from the API)
admin.html     the admin panel, served only at /admin
package.json   dependencies
render.yaml    one-click Render setup (web service + database)
```

## What the admin panel does

Open `https://your-site/admin` and sign in with Google.

- **Projects**: add, edit, delete, reorder, hide as draft. Photos, videos (upload, YouTube, Vimeo or .mp4 link), live site link (with in-page preview), GitHub link, tech stack, client, year, category.
- **Team**: add, edit, delete, reorder, show or hide. Photo, name, role, card colour, LinkedIn, GitHub.
- **Social links**: 15 platforms, reorder, show or hide. First three appear in the header, all appear in the contact section.
- **Site content**: brand name, hero paragraph, contact email, location, availability message.
- **Messages**: everything sent through the contact form.
- **Admins and access**: the owner (`smartmind2910@gmail.com`) can add or remove other admin emails.

The old sample projects were removed from `index.html`. Only projects you add in the admin panel are shown.

## 1. Google sign-in setup (one time)

1. Open Google Cloud Console -> APIs & Services -> Credentials -> your OAuth client (type: Web application).
2. Under **Authorized JavaScript origins** add every address you use:
   - `https://YOUR-APP.onrender.com`
   - your custom domain, if any (`https://yourdomain.com`)
   - `http://localhost:3000` for local testing
   (No redirect URI is needed.)
3. OAuth consent screen -> **Publish app** (In production). While it is in "Testing", only listed test users can sign in.

## 2. Deploy on Render

**Option A: Blueprint (fastest)**
1. Push this folder to a GitHub repo.
2. Render dashboard -> New -> Blueprint -> select the repo -> Apply. It creates the database and the web service and wires them together.

**Option B: manual**
1. New -> PostgreSQL -> create it, then copy its **Internal Database URL**.
2. New -> Web Service -> select the repo. Runtime `Node`, build command `npm install`, start command `npm start`.
3. Environment variables:

| Variable | Value |
|---|---|
| `DATABASE_URL` | the Internal Database URL |
| `SESSION_SECRET` | any long random string |
| `NODE_ENV` | `production` |
| `GOOGLE_CLIENT_ID` | your Google client ID (already the default in code) |
| `DEFAULT_ADMIN_EMAIL` | `smartmind2910@gmail.com` (already the default) |
| `MAX_UPLOAD_MB` | optional, default `50` (largest video you can upload) |

Then open `https://YOUR-APP.onrender.com/admin`.

### Good to know
- **Free database:** Render's free PostgreSQL expires 30 days after creation and has no backups. For a real site use a paid Render database, or point `DATABASE_URL` at an external Postgres (Neon, Supabase, ...).
- **Free web service:** sleeps after 15 minutes without traffic; the next visit takes about a minute to wake it.
- **Uploads live in PostgreSQL** because Render's disk is wiped on every deploy. Images are shrunk in the browser before upload. Use YouTube or Vimeo links for long videos.
- Files nobody uses any more are cleaned up automatically after 24 hours.

## Run locally

```bash
npm install
# needs a local PostgreSQL; then either export the variables or put them in a .env file:
#   DATABASE_URL=postgres://user:pass@localhost:5432/purpledev
export DATABASE_URL=postgres://user:pass@localhost:5432/purpledev
npm start
```
Site: http://localhost:3000, admin: http://localhost:3000/admin

## Security notes
- Google ID tokens are verified on the server; only emails in the admins table get a session.
- The session is a signed, HttpOnly, SameSite cookie, and admin access is re-checked against the database on every request, so removing an admin takes effect immediately.
- Uploads are checked by their real file signature (not the file name). SVG uploads are not allowed.
- The contact form has a honeypot and a per-IP rate limit.
